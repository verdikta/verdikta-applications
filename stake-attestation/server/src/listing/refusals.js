// Refused listing attempts, counted by reason for /api/status (owner decision Q34: the counts are what
// the owner revisits the rule with before mainnet). A count is a code from a fixed set and a number:
// never an address, a repository or anything else of the request. A reason that is not a plain code
// counts as OTHER, and so does a reason past the bound, so what a client sends can neither put text in
// the counts nor grow them.
//
// With a deployment configured they live beside the site's state, in a small file of their own in
// SA_DATA_DIR, replaced atomically on each refused attempt, so a refused request never costs a write
// of the whole state; without one they live as long as the listing flow's jobs do, in memory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REFUSALS_FILE = 'refused-listings.json';
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_REASONS = 128;
const OTHER = 'OTHER';

function read(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!doc || !Number.isSafeInteger(doc.total) || doc.total < 0 || !doc.byReason || typeof doc.byReason !== 'object') return null;
  const byReason = {};
  for (const [k, v] of Object.entries(doc.byReason)) if (CODE.test(k) && Number.isSafeInteger(v) && v > 0) byReason[k] = v;
  return { total: doc.total, byReason };
}

export class RefusalCounter {
  #total = 0;

  #byReason = new Map();

  #file;

  /** @param {{ file?: string|null }} [o] - where the counts are kept; none: in memory */
  constructor({ file = null } = {}) {
    this.#file = file;
    const kept = file ? read(file) : null;
    if (kept) {
      this.#total = kept.total;
      for (const [k, v] of Object.entries(kept.byReason)) this.#byReason.set(k, v);
    }
  }

  /** One refused attempt, and each distinct reason it was refused for. */
  count(reasons) {
    this.#total += 1;
    const distinct = new Set(reasons.map((r) => (typeof r === 'string' && CODE.test(r) ? r : OTHER)));
    for (const r of distinct) {
      const key = this.#byReason.has(r) || this.#byReason.size < MAX_REASONS ? r : OTHER;
      this.#byReason.set(key, (this.#byReason.get(key) ?? 0) + 1);
    }
    this.#write();
  }

  /** @returns {{ total: number, byReason: Record<string, number> }} */
  view() {
    return { total: this.#total, byReason: Object.fromEntries([...this.#byReason].sort(([a], [b]) => (a < b ? -1 : 1))) };
  }

  #write() {
    if (!this.#file) return;
    const tmp = `${this.#file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    // a count that cannot be written never fails the refusal it counts
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(this.view()));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.#file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
}

export const refusalsFileIn = (dir) => path.join(dir, REFUSALS_FILE);
