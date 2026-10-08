'use strict';
const fs = require('fs');
const path = require('path');
const { emptyExceptions } = require('./exceptions');
const CLAIM_KEYS = [
  'identities',
  'wallets',
  'attempts',
  'audit',
  'verifiedClaims',
  'appliedReleases',
];
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
function acquireLock(filename, isAlive = pidAlive) {
  try {
    return fs.openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // Serialize stale-lock reclamation, and compare inode identity before deleting.
  const reclaimDirectory = `${filename}.reclaim`;
  fs.mkdirSync(reclaimDirectory);
  try {
    const previous = fs.statSync(filename);
    const pid = Number(fs.readFileSync(filename, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid))
      throw new Error('CAMPAIGN_WRITER_ACTIVE');
    if (fs.statSync(filename).ino !== previous.ino)
      throw new Error('CAMPAIGN_WRITER_ACTIVE');
    fs.unlinkSync(filename);
    return fs.openSync(filename, 'wx', 0o600);
  } finally {
    fs.rmdirSync(reclaimDirectory);
  }
}
class Store {
  constructor(directory, policyHash, options = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'ledger.json');
    this.lock = path.join(directory, 'writer.lock');
    this.claimFile = path.join(directory, 'claims.json');
    this.fd = acquireLock(this.lock, options.isAlive);
    this.lockInode = fs.fstatSync(this.fd).ino;
    fs.writeSync(this.fd, String(process.pid));
    try {
      this.state = fs.existsSync(this.file)
        ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
        : {
            version: 2,
            policyHash,
            chain: {
              logs: [],
              coverage: null,
              checkedAt: 0,
              error: 'NOT_INDEXED',
            },
            bounties: [],
            history: { creators: {}, hunters: {} },
            exceptions: emptyExceptions(),
            evidenceCache: {},
          };
      for (const field of CLAIM_KEYS)
        this.state[field] ??= field === 'audit' ? [] : {};
      if (fs.existsSync(this.claimFile)) {
        const claims = JSON.parse(fs.readFileSync(this.claimFile, 'utf8'));
        if (claims.policyHash !== policyHash)
          throw new Error('Campaign claims policy mismatch');
        for (const field of CLAIM_KEYS) this.state[field] = claims[field];
      }
      if (this.state.version !== 2 || this.state.policyHash !== policyHash)
        throw new Error(
          'Campaign policy/state mismatch; explicit migration required',
        );
    } catch (error) {
      this.close();
      throw error;
    }
  }
  transact(update) {
    const next = structuredClone(this.state);
    const result = update(next);
    if (result?.then) throw new Error('Store transactions must be synchronous');
    this.write(
      this.file,
      Object.fromEntries(
        Object.entries(next).filter(([field]) => !CLAIM_KEYS.includes(field)),
      ),
    );
    this.state = next;
    return result;
  }
  transactClaims(update) {
    const claims = Object.fromEntries(
      CLAIM_KEYS.map((field) => [field, structuredClone(this.state[field])]),
    );
    const result = update({ ...this.state, ...claims });
    this.write(this.claimFile, {
      policyHash: this.state.policyHash,
      ...claims,
    });
    Object.assign(this.state, claims);
    return result;
  }
  write(file, value) {
    try {
      this.writeAtomic(file, value);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  writeAtomic(file, value) {
    const temporary = `${file}.tmp`;
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
  close() {
    if (this.fd === null) return;
    fs.closeSync(this.fd);
    this.fd = null;
    if (
      fs.existsSync(this.lock) &&
      fs.statSync(this.lock).ino === this.lockInode
    )
      fs.unlinkSync(this.lock);
  }
}
module.exports = { Store, acquireLock, pidAlive };
