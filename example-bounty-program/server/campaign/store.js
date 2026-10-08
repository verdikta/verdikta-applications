'use strict';
// One writer per local persistent directory. No shared/NFS storage or multi-worker deployment.
// The lock is intentionally never auto-stolen after a crash. Operator verifies the process is dead.
const fs = require('fs');
const path = require('path');
const CLAIM_KEYS = ['identities','wallets','conflicts','attempts','audit'];
class Store {
  constructor(directory, policyHash) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'ledger.json'); this.lock = path.join(directory, 'writer.lock');
    this.claimFile = path.join(directory, 'claims.json');
    this.fd = fs.openSync(this.lock, 'wx', 0o600);
    fs.writeSync(this.fd, String(process.pid));
    try {
      this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {
        version: 1, policyHash, identities: {}, wallets: {}, conflicts: {}, attempts: {}, audit: [],
        chain: { logs: [], coverage: {}, checkedAt: 0, error: 'NOT_INDEXED' }, bounties: [], history: { creators: {}, hunters: {} }
      };
      for (const k of CLAIM_KEYS) this.state[k] ??= k === 'audit' ? [] : {};
      if (fs.existsSync(this.claimFile)) {
        const claims = JSON.parse(fs.readFileSync(this.claimFile, 'utf8'));
        if (claims.policyHash !== policyHash) throw new Error('Claims policy mismatch');
        for (const k of CLAIM_KEYS) this.state[k] = claims[k];
      }
      if (this.state.version !== 1 || this.state.policyHash !== policyHash) throw new Error('Campaign policy/state mismatch; explicit migration required');
    } catch (e) { this.close(); throw e; }
  }
  transact(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    if (result?.then) throw new Error('Store transactions must be synchronous');
    const ledger = Object.fromEntries(Object.entries(next).filter(([k]) => !CLAIM_KEYS.includes(k)));
    this.write(this.file, ledger);
    this.state = next; return result;
  }
  transactClaims(fn) {
    const claims = Object.fromEntries(CLAIM_KEYS.map(k => [k, structuredClone(this.state[k])]));
    const view = { ...this.state, ...claims };
    const result = fn(view);
    this.write(this.claimFile, { policyHash:this.state.policyHash, ...claims });
    Object.assign(this.state, claims);
    return result;
  }
  write(file, value) {
    try { this.writeAtomic(file, value); } catch (e) { this.failed=true; throw e; }
  }
  writeAtomic(file, value) {
    const bytes = JSON.stringify(value);
    if (file === this.claimFile && bytes.length > 16 * 1024 * 1024) throw new Error('CLAIM_STORAGE_CAPACITY');
    const temporary = `${file}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  close() { if (this.fd !== null) { fs.closeSync(this.fd); fs.unlinkSync(this.lock); this.fd = null; } }
}
module.exports = { Store };
