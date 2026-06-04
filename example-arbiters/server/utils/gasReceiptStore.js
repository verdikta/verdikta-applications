/**
 * Gas Receipt Store
 *
 * Persistent, write-once cache of the gas an arbiter spent on each commit /
 * reveal transaction. Gas consumption lives on the transaction *receipt*
 * (`gasUsed`, `effectiveGasPrice`) — never on the event/log — so the
 * oracle-health scan would otherwise need one extra RPC round-trip per
 * commit/reveal every time it runs. A receipt for a confirmed tx is immutable,
 * so we fetch it once and persist it; subsequent scans only fetch receipts for
 * tx hashes not already on disk, turning an O(all-history) cost into O(new).
 *
 * One JSON file per network at `server/data/{network}/gasReceipts.json`,
 * matching the existing per-network data convention. Keyed by tx hash. BigInt
 * fields (wei / gas units) are stored as decimal strings for JSON safety.
 *
 *   {
 *     "lastScannedBlock": 46529402,
 *     "updatedAt": 1779848153911,
 *     "receipts": {
 *       "0xabc…": {
 *         kind: "commit" | "reveal",
 *         operator: "0x…",          // lowercased
 *         gasUsed: "123456",         // gas units
 *         effectiveGasPrice: "…",    // wei per gas (EIP-1559)
 *         gasCostWei: "…",           // gasUsed × effectiveGasPrice
 *         blockNumber: 123,
 *         timestamp: 1700000000,     // block timestamp (seconds), for daily buckets
 *         completedRound: false      // reveal tx that also triggered aggregation (outlier)
 *       }
 *     }
 *   }
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DATA_ROOT = path.join(__dirname, '..', 'data');
const FILE_NAME = 'gasReceipts.json';

// One store per network, lazily loaded and reused across requests.
const _instances = {};

class GasReceiptStore {
  /**
   * @param {string} networkKey canonical network key ('base' | 'base-sepolia').
   */
  constructor(networkKey) {
    this.networkKey = networkKey;
    this.filePath = path.join(DATA_ROOT, networkKey, FILE_NAME);
    this.receipts = {};            // txHashLower → record
    this.lastScannedBlock = 0;     // highest block whose window has been fully swept
    this._dirty = false;
    this._loaded = false;
  }

  /** Cached per-network singleton. */
  static forNetwork(networkKey) {
    if (!_instances[networkKey]) _instances[networkKey] = new GasReceiptStore(networkKey);
    return _instances[networkKey];
  }

  /** Load from disk once (idempotent). Missing/corrupt file → empty store. */
  load() {
    if (this._loaded) return this;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.receipts = parsed.receipts || {};
      this.lastScannedBlock = parsed.lastScannedBlock || 0;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('gasReceiptStore: could not read store, starting empty', {
          network: this.networkKey, file: this.filePath, msg: err.message,
        });
      }
      this.receipts = {};
      this.lastScannedBlock = 0;
    }
    this._loaded = true;
    return this;
  }

  /** True if a receipt for this tx hash is already cached. */
  has(txHash) {
    return Object.prototype.hasOwnProperty.call(this.receipts, txHash.toLowerCase());
  }

  /** The cached record for a tx hash, or undefined. */
  get(txHash) {
    return this.receipts[txHash.toLowerCase()];
  }

  /**
   * Cache a receipt record (in memory; call flush() to persist). BigInt gas
   * fields are coerced to decimal strings and gasCostWei is derived here so the
   * math stays in one place. No-op if the tx is already cached.
   *
   * @param {string} txHash
   * @param {{ kind: 'commit'|'reveal', operator: string, gasUsed: bigint|string,
   *   effectiveGasPrice: bigint|string, blockNumber: number, timestamp: number,
   *   completedRound?: boolean }} fields
   */
  set(txHash, fields) {
    const key = txHash.toLowerCase();
    if (this.has(key)) return this.receipts[key];
    const gasUsed = BigInt(fields.gasUsed);
    const effectiveGasPrice = BigInt(fields.effectiveGasPrice);
    const record = {
      kind: fields.kind,
      operator: fields.operator ? fields.operator.toLowerCase() : null,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      gasCostWei: (gasUsed * effectiveGasPrice).toString(),
      blockNumber: fields.blockNumber,
      timestamp: fields.timestamp,
      completedRound: Boolean(fields.completedRound),
    };
    this.receipts[key] = record;
    this._dirty = true;
    return record;
  }

  /** Mark a cached reveal as the round-completing (aggregation-triggering) tx. */
  markCompletedRound(txHash) {
    const rec = this.get(txHash);
    if (rec && !rec.completedRound) {
      rec.completedRound = true;
      this._dirty = true;
    }
  }

  /** Advance the high-water scanned block (persisted with the next flush). */
  setLastScannedBlock(block) {
    if (block > this.lastScannedBlock) {
      this.lastScannedBlock = block;
      this._dirty = true;
    }
  }

  /** All cached records as an array (for aggregation). */
  all() {
    return Object.values(this.receipts);
  }

  /** Number of cached receipts. */
  get size() {
    return Object.keys(this.receipts).length;
  }

  /**
   * Atomically persist to disk if there are unsaved changes. Writes to a temp
   * file then renames so a crash mid-write can't corrupt the store.
   */
  flush() {
    if (!this._dirty) return;
    const payload = {
      lastScannedBlock: this.lastScannedBlock,
      updatedAt: Date.now(),
      receipts: this.receipts,
    };
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.filePath);
      this._dirty = false;
    } catch (err) {
      logger.warn('gasReceiptStore: flush failed', {
        network: this.networkKey, file: this.filePath, msg: err.message,
      });
    }
  }
}

module.exports = GasReceiptStore;
