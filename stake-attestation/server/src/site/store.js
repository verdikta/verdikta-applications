// The indexer's and keeper's state: one JSON file in SA_DATA_DIR, as the bounty program's campaign
// store keeps its ledger. Every change is one transaction: the next state is written to
// state.json.tmp, flushed, and renamed over state.json, so a process killed at any point leaves
// either the old state or the new one, never half of one. The state names the deployment it
// indexes, and a folder of another deployment is refused rather than mixed with it.
//
// One writer per folder, by numbered lock files (writer.lock.<n>, each created atomically with
// its writer's pid already in it). A process may write only by creating the next number after the
// highest one, and only when the highest one's process is gone; creation fails if the number is
// taken, so of two processes racing for it exactly one wins, and a lock is kept only if it is
// still the highest once created (a process acting on a stale view of the folder backs off).
// Nobody ever removes a lock that may be live: a writer removes its own at close, and the numbers
// below its own, whose processes were all found gone before it could take its number. A crash at
// any point leaves at most a lock of a dead process, which the next start steps over.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_VERSION = 1;

export class StoreError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'StoreError';
    this.code = code;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/** Creates `file` holding `content`, or fails with EEXIST: the content is in place before the name is. */
function createExclusive(file, content) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

const LOCK = /^writer\.lock\.([0-9]{1,15})$/;

/** The lock numbers in the folder, ascending. */
function lockNumbers(dir) {
  return fs.readdirSync(dir).map((n) => LOCK.exec(n)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

/** The pid a lock names: a number, null for an empty or garbled one, undefined if it is gone. */
function lockHolder(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Tries to take lock number `observedTop + 1`, where `observedTop` is the highest number this
 * process saw held by a process that is gone (-1: none). The view may be stale by the time the
 * lock is created (numbers below a writer's are removed, so a low name can be free again), so a
 * lock is kept only if no higher number exists once it is created; otherwise it is removed again.
 * @returns {'taken'|'lost'} lost: another process holds that number or a higher one
 */
export function tryLock(dir, observedTop) {
  const file = path.join(dir, `writer.lock.${observedTop + 1}`);
  try {
    createExclusive(file, String(process.pid));
  } catch (err) {
    if (err.code === 'EEXIST') return 'lost';
    throw err;
  }
  if (lockNumbers(dir).at(-1) > observedTop + 1) {
    fs.rmSync(file, { force: true });
    return 'lost';
  }
  return 'taken';
}

/** Takes the folder's next writer lock; returns its file. */
function acquireLock(dir) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const taken = lockNumbers(dir);
    const top = taken.length ? taken.at(-1) : -1;
    if (top >= 0) {
      const holder = lockHolder(path.join(dir, `writer.lock.${top}`));
      if (holder === undefined) continue; // closed while we looked: look again
      if (holder !== null && alive(holder)) throw new StoreError('WRITER_ACTIVE', `the state folder is in use by process ${holder}`);
    }
    if (tryLock(dir, top) === 'lost') continue; // look again: the winner's lock decides
    for (const n of taken) fs.rmSync(path.join(dir, `writer.lock.${n}`), { force: true });
    return path.join(dir, `writer.lock.${top + 1}`);
  }
  throw new StoreError('WRITER_ACTIVE', 'the state folder\'s lock is contended');
}

function emptyState(identity) {
  return {
    version: STATE_VERSION,
    identity,
    cursor: null, // { number, hash, timestamp }: the last block read, every event up to it stored
    checkpoints: [], // blocks read, oldest first, within the reorg window: where a rollback can stop
    events: [], // { name, blockNumber, blockHash, logIndex, txHash, timestamp, args }, in chain order
    archives: {}, // listingCid -> what the listing archive says (image, scope), or why it could not be read
    keeper: { inflight: null, foreign: [], last: null },
  };
}

export class StateStore {
  /**
   * @param {string} dir
   * @param {{ chainId: number, address: string, fromBlock: number }} identity - the deployment
   */
  constructor(dir, identity) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.tmp = path.join(dir, 'state.json.tmp');
    this.lockFile = acquireLock(dir);
    this.locked = true;
    try {
      if (fs.existsSync(this.file)) {
        const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (state.version !== STATE_VERSION) throw new StoreError('STATE_VERSION', `state.json is version ${state.version}; this server reads ${STATE_VERSION}`);
        const id = state.identity ?? {};
        if (id.chainId !== identity.chainId || id.address !== identity.address || id.fromBlock !== identity.fromBlock) {
          throw new StoreError('STATE_IDENTITY_MISMATCH', `${dir} indexes ${id.address} on chain ${id.chainId} from block ${id.fromBlock}, not ${identity.address} on chain ${identity.chainId} from block ${identity.fromBlock}; use another SA_DATA_DIR`);
        }
        this.state = state;
      } else {
        this.state = emptyState(identity);
        this.#write(this.state);
      }
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Applies `update` to a copy of the state and commits it in one atomic write. */
  transact(update) {
    if (!this.locked) throw new StoreError('STORE_CLOSED', 'the store is closed');
    const next = structuredClone(this.state);
    const result = update(next);
    if (result && typeof result.then === 'function') throw new TypeError('store transactions are synchronous');
    this.#write(next);
    this.state = next;
    return result;
  }

  #write(state) {
    const fd = fs.openSync(this.tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(this.tmp, this.file);
    try {
      const dirFd = fs.openSync(this.dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch { /* not every platform syncs a directory */ }
  }

  close() {
    if (!this.locked) return;
    this.locked = false;
    fs.rmSync(this.lockFile, { force: true });
  }
}
