/**
 * Reporter Delegation Store
 *
 * Lets an arbiter owner authorize a *different* address to post watchdog
 * events on its behalf (POST /api/alerts), without putting the owner key on
 * the node.
 *
 * Why this exists: ingest authenticates an event by recovering its EIP-191
 * signer and requiring it to equal the operator contract's on-chain `owner()`.
 * Operators commonly run their nodes with a separate ops wallet — the owner
 * key controls the wVDKA stake, the keeper exit and fee controls, and ETH earnings, so
 * copying it onto an internet-facing box just to send a health ping is a bad
 * trade. Those nodes sign with a key the server doesn't recognize and every
 * heartbeat is dropped with a 403, so the arbiter silently shows as "not
 * reporting".
 *
 * The fix keeps the trust root exactly where it was — only `owner()` can
 * authorize a reporter, proven by an owner signature — but moves *where* that
 * signature is produced. The owner signs a delegation in the browser on
 * /my-arbiters (MetaMask personal_sign; no transaction, no gas) and the site
 * POSTs it here to be stored. Ingest then accepts either the owner or a live
 * delegate. Nothing on the arbiter node changes: the watchdog keeps sending
 * the payload it sends today.
 *
 * Delegations are scoped to (owner, network), not to a single operator: one
 * ops wallet typically fronts an owner's whole fleet, and owner-scoping means
 * one signature also covers operators registered later. Ingest already
 * resolves `owner(operator)` for its own check, so the lookup is free.
 *
 * Bounded blast radius: a delegate can only assert *health status* for
 * operators its delegator already owns. It cannot fulfill requests, move
 * stake, or claim earnings. Delegations carry a hard expiry (the client
 * defaults to 90 days, DELEGATION_MAX_TTL_MS caps any request) and can be
 * revoked by a second owner signature, which leaves a tombstone so a replayed
 * `add` cannot resurrect the delegate.
 *
 * Pending reporters: because the node is never modified, an owner has no way
 * to discover *which* address to authorize. So a rejected-but-well-signed
 * event is recorded here as a "pending reporter" — someone holding key K
 * claims to run operator O — and surfaced on /my-arbiters as a one-click
 * Authorize prompt. The event signature is verified before this point, so an
 * entry proves possession of K; it is only ever an *offer*, and authorizing
 * still requires the owner's signature. Bounded per operator and expired on
 * read so it cannot grow without limit.
 *
 * One JSON file per network at `server/data/{network}/reporters.json`,
 * matching the alertStore / gasReceiptStore convention:
 *
 *   {
 *     "updatedAt": 1779848153911,
 *     "delegations": {
 *       "0xowner…(lower)": {
 *         "owner": "0xOwner…",              // original-case address
 *         "delegates": {
 *           "0xdelegate…(lower)": {
 *             "delegate": "0xDelegate…",
 *             "label": "mainnet node vmi2323504",
 *             "createdAt": ms, "issuedAt": ms, "expiresAt": ms
 *           }
 *         },
 *         "revoked": { "0xdelegate…(lower)": issuedAtMs }   // replay tombstones
 *       }
 *     },
 *     "pending": {
 *       "0xoperator…(lower)": [
 *         { "signer": "0x…", "hostname": "vps-1", "firstSeenAt": ms,
 *           "lastSeenAt": ms, "attempts": 12 }
 *       ]
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const FILE_NAME = 'reporters.json';

// Hard ceiling on how far out a delegation may be dated. Expiry is the only
// revocation that survives loss of this store, so it must stay bounded.
const DELEGATION_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// Pending-reporter bounds: at most N distinct keys remembered per operator,
// forgotten after TTL of silence. Keeps a spammer from growing the file.
const PENDING_PER_OPERATOR = 5;
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Repeat rejections from a known key only touch memory; disk is synced at most
// this often. New keys and delegation changes always flush immediately.
const PENDING_FLUSH_INTERVAL_MS = 60 * 1000;

// One store per network, lazily loaded and reused across requests.
const _instances = {};

class ReporterStore {
  /**
   * @param {string} networkKey canonical network key ('base' | 'base-sepolia').
   */
  constructor(networkKey) {
    this.networkKey = networkKey;
    this.filePath = path.join(DATA_ROOT, networkKey, FILE_NAME);
    this.delegations = {};   // ownerLower → { owner, delegates, revoked }
    this.pending = {};       // operatorLower → [entry]
    this._dirty = false;
    this._loaded = false;
    this._lastFlushAt = 0;
  }

  /** Cached per-network singleton. */
  static forNetwork(networkKey) {
    if (!_instances[networkKey]) _instances[networkKey] = new ReporterStore(networkKey);
    return _instances[networkKey];
  }

  /** Load from disk once (idempotent). Missing/corrupt file → empty store. */
  load() {
    if (this._loaded) return this;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.delegations = parsed.delegations || {};
      this.pending = parsed.pending || {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('reporterStore: could not read store, starting empty', {
          network: this.networkKey, file: this.filePath, msg: err.message,
        });
      }
      this.delegations = {};
      this.pending = {};
    }
    this._loaded = true;
    return this;
  }

  /** Owner record, created on demand. */
  _ownerRec(owner) {
    const key = owner.toLowerCase();
    if (!this.delegations[key]) {
      this.delegations[key] = { owner, delegates: {}, revoked: {} };
    }
    // Tolerate records written before `revoked` existed.
    if (!this.delegations[key].revoked) this.delegations[key].revoked = {};
    return this.delegations[key];
  }

  // --- Delegations ---------------------------------------------------------

  /**
   * May `delegate` report on behalf of `owner` right now? The single question
   * the ingest path asks.
   * @param {string} owner on-chain operator owner
   * @param {string} delegate recovered event signer
   * @param {number} [at] evaluation time (ms), defaults to now
   */
  isDelegate(owner, delegate, at = Date.now()) {
    const rec = this.delegations[String(owner).toLowerCase()];
    if (!rec) return false;
    const d = rec.delegates[String(delegate).toLowerCase()];
    return !!d && d.expiresAt > at;
  }

  /**
   * Active (unexpired) delegations for an owner, newest first. Expired entries
   * are dropped as a side effect so the file self-prunes.
   * @returns {Array<{delegate, label, createdAt, expiresAt}>}
   */
  listDelegates(owner) {
    const rec = this.delegations[String(owner).toLowerCase()];
    if (!rec) return [];
    const now = Date.now();
    for (const [k, d] of Object.entries(rec.delegates)) {
      if (d.expiresAt <= now) {
        delete rec.delegates[k];
        this._dirty = true;
      }
    }
    if (this._dirty) this.flush({ force: true });
    return Object.values(rec.delegates).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Record an owner-signed delegation. The route verifies the signature and
   * freshness; this enforces the replay tombstone and the TTL ceiling.
   * @param {{owner: string, delegate: string, label?: string,
   *   expiresAt: number, issuedAt: number}} params
   * @returns {{ ok: true, delegation: object } | { ok: false, error: string }}
   */
  addDelegate({ owner, delegate, label, expiresAt, issuedAt }) {
    const now = Date.now();
    if (!(expiresAt > now)) {
      return { ok: false, error: 'Delegation expiry is in the past' };
    }
    if (expiresAt > now + DELEGATION_MAX_TTL_MS) {
      return { ok: false, error: 'Delegation expiry is too far in the future (max 1 year)' };
    }
    const rec = this._ownerRec(owner);
    const key = String(delegate).toLowerCase();
    // A revocation invalidates every delegation signed at or before it, so a
    // captured older `add` cannot be replayed to undo the revoke.
    const tombstone = rec.revoked[key];
    if (tombstone && issuedAt <= tombstone) {
      return { ok: false, error: 'This delegation was signed before it was revoked; sign a new one' };
    }
    delete rec.revoked[key];
    rec.owner = owner;
    rec.delegates[key] = {
      delegate,
      label: label || null,
      createdAt: rec.delegates[key]?.createdAt || now,
      issuedAt,
      expiresAt,
    };
    this._dirty = true;
    this.flush({ force: true });
    return { ok: true, delegation: rec.delegates[key] };
  }

  /**
   * Revoke a delegation and leave a replay tombstone.
   * @returns {{ ok: true, existed: boolean }}
   */
  revokeDelegate({ owner, delegate, issuedAt }) {
    const rec = this._ownerRec(owner);
    const key = String(delegate).toLowerCase();
    const existed = !!rec.delegates[key];
    delete rec.delegates[key];
    rec.revoked[key] = Math.max(rec.revoked[key] || 0, issuedAt);
    this._dirty = true;
    this.flush({ force: true });
    return { ok: true, existed };
  }

  // --- Pending reporters ---------------------------------------------------

  /**
   * Note that a validly-signed event was rejected because its signer is not
   * the operator's owner or a delegate — i.e. a candidate to authorize.
   * De-duplicated by signer; bounded per operator (oldest sighting evicted).
   */
  recordPending({ operator, signer, hostname }) {
    const key = String(operator).toLowerCase();
    const now = Date.now();
    const list = this.pending[key] || (this.pending[key] = []);
    const existing = list.find((e) => e.signer.toLowerCase() === String(signer).toLowerCase());
    if (existing) {
      existing.lastSeenAt = now;
      existing.attempts += 1;
      if (hostname) existing.hostname = hostname;
      this._dirty = true;
      this.flush();              // throttled: a repeat sighting isn't urgent
      return;
    }
    list.push({ signer, hostname: hostname || null, firstSeenAt: now, lastSeenAt: now, attempts: 1 });
    // Keep the most recently active candidates.
    list.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    if (list.length > PENDING_PER_OPERATOR) list.length = PENDING_PER_OPERATOR;
    this._dirty = true;
    this.flush({ force: true });  // a new key is what the owner is waiting to see
  }

  /**
   * Pending candidates for the given operators, keyed by lowercased operator.
   * Entries silent for longer than the TTL are dropped as a side effect.
   * @param {string[]} operators
   */
  listPending(operators) {
    const now = Date.now();
    const out = {};
    for (const op of operators || []) {
      const key = String(op).toLowerCase();
      const list = this.pending[key];
      if (!list) continue;
      const live = list.filter((e) => now - e.lastSeenAt <= PENDING_TTL_MS);
      if (live.length !== list.length) {
        if (live.length) this.pending[key] = live;
        else delete this.pending[key];
        this._dirty = true;
      }
      if (live.length) out[key] = live;
    }
    if (this._dirty) this.flush({ force: true });
    return out;
  }

  /** Forget a candidate (called once it has been authorized). */
  clearPending(operator, signer) {
    const key = String(operator).toLowerCase();
    const list = this.pending[key];
    if (!list) return;
    const next = list.filter((e) => e.signer.toLowerCase() !== String(signer).toLowerCase());
    if (next.length === list.length) return;
    if (next.length) this.pending[key] = next;
    else delete this.pending[key];
    this._dirty = true;
    this.flush({ force: true });
  }

  /**
   * Drop pending candidates for `signer` across the given operators — called
   * once the signer has been authorized. Scoped to the delegating owner's own
   * operators: the same key may legitimately be pending for another owner's
   * operator, and that owner still needs to see its prompt.
   * @param {string} signer
   * @param {string[]} operators operators belonging to the authorizing owner
   */
  clearPendingForDelegate(signer, operators) {
    const target = String(signer).toLowerCase();
    const scope = new Set((operators || []).map((o) => String(o).toLowerCase()));
    for (const [op, list] of Object.entries(this.pending)) {
      if (!scope.has(op)) continue;
      const next = list.filter((e) => e.signer.toLowerCase() !== target);
      if (next.length === list.length) continue;
      if (next.length) this.pending[op] = next;
      else delete this.pending[op];
      this._dirty = true;
    }
    if (this._dirty) this.flush({ force: true });
  }

  /**
   * Atomically persist if there are unsaved changes. Writes to a temp file
   * then renames so a crash mid-write can't corrupt the store. Unforced calls
   * are throttled — repeat rejections fire every couple of minutes per node
   * and don't each need to reach disk.
   */
  flush({ force = false } = {}) {
    if (!this._dirty) return;
    const now = Date.now();
    if (!force && now - this._lastFlushAt < PENDING_FLUSH_INTERVAL_MS) return;
    const payload = { updatedAt: now, delegations: this.delegations, pending: this.pending };
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.filePath);
      this._dirty = false;
      this._lastFlushAt = now;
    } catch (err) {
      logger.warn('reporterStore: flush failed', {
        network: this.networkKey, file: this.filePath, msg: err.message,
      });
    }
  }
}

module.exports = ReporterStore;
module.exports.DELEGATION_MAX_TTL_MS = DELEGATION_MAX_TTL_MS;
