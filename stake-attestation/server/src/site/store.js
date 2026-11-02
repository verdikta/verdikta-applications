// The indexer's and keeper's state: one JSON file in SA_DATA_DIR, as the bounty program's campaign
// store keeps its ledger. Every change is one transaction: the next state is written to
// state.json.tmp, flushed, and renamed over state.json, so a process killed at any point leaves
// either the old state or the new one, never half of one. A file lock (writer.lock, holding the
// writer's pid) keeps one writer per folder; a lock whose process is gone is reclaimed. The state
// names the deployment it indexes, and a folder of another deployment is refused rather than
// mixed with it. The lock is created with the writer's pid already in it, so no crash leaves a
// lock nobody can tell is stale.
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

/** Whether a lock file names a running process (a missing, empty or garbled one does not). */
function heldByLiveProcess(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 && alive(pid);
}

/**
 * Takes the folder's writer lock. A lock whose process is gone is reclaimed, one reclaimer at a
 * time (writer.lock.reclaim, itself reclaimed when its process is gone), and only after checking
 * again under the reclaim lock that its process is still gone.
 */
function acquireLock(file) {
  const reclaim = `${file}.reclaim`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      createExclusive(file, String(process.pid));
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (heldByLiveProcess(file)) throw new StoreError('WRITER_ACTIVE', `the state folder is in use by process ${fs.readFileSync(file, 'utf8').trim()}`);
    try {
      createExclusive(reclaim, String(process.pid));
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (heldByLiveProcess(reclaim)) throw new StoreError('WRITER_ACTIVE', 'another process is reclaiming the state folder\'s lock');
      fs.rmSync(reclaim, { force: true }); // left by a reclaimer that died
      continue;
    }
    try {
      if (!heldByLiveProcess(file)) fs.rmSync(file, { force: true });
    } finally {
      fs.rmSync(reclaim, { force: true });
    }
  }
  throw new StoreError('WRITER_ACTIVE', 'the state folder\'s lock could not be taken');
}

function emptyState(identity) {
  return {
    version: STATE_VERSION,
    identity,
    cursor: null, // { number, hash, timestamp }: the last block read, every event up to it stored
    checkpoints: [], // blocks read, oldest first, within the reorg window: where a rollback can stop
    events: [], // { name, blockNumber, blockHash, logIndex, txHash, timestamp, args }, in chain order
    archives: {}, // listingCid -> what the listing archive says (image, scope), or why it could not be read
    keeper: { inflight: null, last: null },
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
    this.lockFile = path.join(dir, 'writer.lock');
    acquireLock(this.lockFile);
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
    try {
      if (fs.readFileSync(this.lockFile, 'utf8').trim() === String(process.pid)) fs.rmSync(this.lockFile, { force: true });
    } catch { /* gone already */ }
  }
}
