// The indexer's and keeper's state: one JSON file in SA_DATA_DIR, as the bounty program's campaign
// store keeps its ledger. Every change is one transaction: the next state is written to
// state.json.tmp, flushed, and renamed over state.json, so a process killed at any point leaves
// either the old state or the new one, never half of one. A file lock (writer.lock, holding the
// writer's pid) keeps one writer per folder; a lock whose process is gone is reclaimed. The state
// names the deployment it indexes, and a folder of another deployment is refused rather than
// mixed with it.
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

function acquireLock(file) {
  try {
    return fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  // reclaim a dead writer's lock, one reclaimer at a time, checking it is still the same file
  const reclaim = `${file}.reclaim`;
  try {
    fs.mkdirSync(reclaim);
  } catch (err) {
    if (err.code === 'EEXIST') throw new StoreError('WRITER_ACTIVE', 'another process is reclaiming the state folder\'s lock');
    throw err;
  }
  try {
    const before = fs.statSync(file);
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid) || fs.statSync(file).ino !== before.ino) {
      throw new StoreError('WRITER_ACTIVE', `the state folder is in use by process ${pid}`);
    }
    fs.unlinkSync(file);
    return fs.openSync(file, 'wx', 0o600);
  } finally {
    fs.rmdirSync(reclaim);
  }
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
    this.fd = acquireLock(this.lockFile);
    fs.writeSync(this.fd, String(process.pid));
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
    if (this.fd === null) throw new StoreError('STORE_CLOSED', 'the store is closed');
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
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
    fs.rmSync(this.lockFile, { force: true });
  }
}
