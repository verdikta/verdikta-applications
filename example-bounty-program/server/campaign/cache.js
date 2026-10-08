'use strict';
class EvidenceError extends Error {
  constructor(code, terminal, cid) {
    super(code);
    this.terminal = terminal;
    this.cid = cid;
  }
}
function evidenceError(code, terminal = true, cid) {
  return new EvidenceError(code, terminal, cid);
}
const isEvidenceError = (error) => error instanceof EvidenceError;
class EvidenceCache {
  constructor(state = {}, clock = () => Math.floor(Date.now() / 1000)) {
    this.state = state;
    this.clock = clock;
    this.buffers = new Map();
  }
  async fetch(cid, fetcher) {
    if (this.buffers.has(cid)) return this.buffers.get(cid);
    const record = (this.state[cid] ??= { checks: {} });
    if (
      record.fetchFailure &&
      (record.fetchFailure.terminal ||
        this.clock() < record.fetchFailure.nextRetry)
    ) {
      throw evidenceError(
        record.fetchFailure.code,
        record.fetchFailure.terminal,
        cid,
      );
    }
    try {
      const buffer = await fetcher(cid);
      delete record.fetchFailure;
      this.buffers.set(cid, buffer);
      // Bounded byte cache; successful parsed evidence persists in checks below.
      while (this.buffers.size > 64)
        this.buffers.delete(this.buffers.keys().next().value);
      return buffer;
    } catch (error) {
      const failures = (record.fetchFailure?.failures || 0) + 1;
      record.fetchFailure = {
        code: error.terminal ? error.message : 'GATEWAY_UNAVAILABLE',
        terminal: error.terminal === true,
        failures,
        nextRetry:
          this.clock() + Math.min(3600, 300 * 2 ** Math.min(failures - 1, 4)),
      };
      throw evidenceError(
        record.fetchFailure.code,
        record.fetchFailure.terminal,
        cid,
      );
    }
  }
  async check(cid, context, validate) {
    const record = (this.state[cid] ??= { checks: {} });
    const cached = record.checks[context];
    if (cached?.value) return structuredClone(cached.value);
    if (cached?.terminal) throw evidenceError(cached.code, true, cid);
    try {
      const value = await validate();
      record.checks[context] = { value };
      return structuredClone(value);
    } catch (error) {
      if (isEvidenceError(error) && error.terminal === true)
        record.checks[context] = { terminal: true, code: error.message };
      throw error;
    }
  }
}
module.exports = { EvidenceCache, evidenceError, isEvidenceError };
