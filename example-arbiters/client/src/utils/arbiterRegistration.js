/**
 * Shared helpers for arbiter registration and management: input parsing and
 * validation, the portable JSON descriptor (download + import), and the pure
 * view logic for exits and statuses. Used by the exit / re-register modal, the
 * Register-an-arbiter section, the per-arbiter "Backup JSON" action and My Arbiters.
 *
 * The descriptor holds exactly what the v2 keeper's
 * registerArbiter(oracle, jobId, fee, classes, chainHead) needs (the site always
 * sends chainHead 0), plus network/keeper routing. v2 keeps an arbiter's scores
 * and offenses under its key, so re-registering the same (oracle, jobId) brings
 * its reputation back rather than resetting it.
 */

import { ethers } from 'ethers';

export const DESCRIPTOR_TYPE = 'verdikta-arbiter-registration';
export const DESCRIPTOR_VERSION = 2;
const UINT64_MAX = (1n << 64n) - 1n;

/** Parse the classes field ("128, 129") into a validated number[] (1–5 unique uint64s). */
export function parseClasses(text) {
  const parts = String(text).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const nums = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return { error: `"${p}" is not a whole number` };
    const n = Number(p);
    if (!Number.isSafeInteger(n)) return { error: `"${p}" is out of range` };
    if (!nums.includes(n)) nums.push(n);
  }
  if (nums.length === 0) return { error: 'Enter at least one class' };
  if (nums.length > 5) return { error: 'At most 5 classes are allowed' };
  return { classes: nums };
}

/** Parse an ETH fee decimal string into { wei (bigint), display } or { error }. The keeper stores a uint64. */
export function parseFee(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { error: 'Enter a fee' };
  try {
    const wei = ethers.parseEther(t);
    if (wei <= 0n) return { error: 'Fee must be greater than 0' };
    if (wei > UINT64_MAX) return { error: 'Fee is too large (the keeper stores at most ~18.4 ETH)' };
    return { wei, display: t };
  } catch {
    return { error: 'Invalid fee amount' };
  }
}

export const isValidAddress = (a) => {
  try {
    return ethers.isAddress(a);
  } catch {
    return false;
  }
};

/** A Chainlink job id is a 32-byte hex string (0x + 64 hex chars). */
export const isValidJobId = (j) => typeof j === 'string' && ethers.isHexString(j, 32);

/** Order-insensitive equality for two class arrays. */
export const sameSet = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  const x = [...a].sort((m, n) => m - n);
  const y = [...b].sort((m, n) => m - n);
  return x.every((v, i) => v === y[i]);
};

/** Build the portable descriptor object for one arbiter. */
export function buildDescriptor({ network, keeperAddress, operator, owner, jobId, fee, classes }) {
  return {
    type: DESCRIPTOR_TYPE,
    version: DESCRIPTOR_VERSION,
    _readme:
      'Editable fields: operator, jobId, fee (ETH decimal), classes (1-5 integers). ' +
      'Importing this on the My Arbiters "Register an arbiter" section registers it with the v2 ' +
      'ReputationKeeper, staking the current stake requirement. The site registers with an empty ' +
      'hash-chain head, so the arbiter stays frozen until its node health job re-syncs. ' +
      'A previously registered (operator, jobId) keeps its scores and offenses.',
    network,
    keeperAddress,
    operator,
    owner,
    jobId,
    fee, // ETH decimal string
    classes, // number[]
    exportedAt: new Date().toISOString(),
  };
}

export function serializeDescriptor(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * Validate + normalize an imported descriptor into the registration fields.
 * Accepts version 1 (v1 keeper backups: same fields) and 2; strict about the
 * fields registerArbiter needs. Throws Error with a user-facing message on bad input.
 */
export function parseDescriptor(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!obj || typeof obj !== 'object') throw new Error('JSON is not an object.');
  if (obj.version != null && Number(obj.version) > DESCRIPTOR_VERSION) {
    throw new Error(`Descriptor version ${obj.version} is newer than this site understands (${DESCRIPTOR_VERSION}).`);
  }

  if (!isValidAddress(obj.operator)) throw new Error('Missing or invalid "operator" address.');
  if (!isValidJobId(obj.jobId)) throw new Error('Missing or invalid "jobId" (expected 0x + 64 hex chars).');

  const feeP = parseFee(obj.fee != null ? String(obj.fee) : '');
  if (feeP.error) throw new Error(`Invalid "fee": ${feeP.error}`);

  const clsRaw = Array.isArray(obj.classes) ? obj.classes.join(',') : String(obj.classes ?? '');
  const clsP = parseClasses(clsRaw);
  if (clsP.error) throw new Error(`Invalid "classes": ${clsP.error}`);

  return {
    operator: obj.operator,
    jobId: obj.jobId,
    fee: feeP.display,
    classes: clsP.classes,
    network: obj.network || null,
    // A v1 descriptor names the v1 keeper, which this site no longer writes to.
    keeperAddress: Number(obj.version) >= 2 ? obj.keeperAddress || null : null,
    owner: obj.owner || null,
    legacy: !(Number(obj.version) >= 2),
  };
}

/**
 * The keeper a resumed re-registration writes to. Always the live keeper the
 * server reports for this network: an entry saved in localStorage (or imported
 * from a descriptor) can name a keeper that has since been redeployed, and
 * approving wVDKA to it then staking there would lock the stake in a dead
 * contract. The stored address is only a fallback while the live one is unknown.
 */
export function keeperForResume(liveKeeper, storedKeeper) {
  if (isValidAddress(liveKeeper)) return liveKeeper;
  return isValidAddress(storedKeeper) ? storedKeeper : null;
}

/** Trigger a client-side download of `obj` as pretty-printed JSON. */
export function downloadJson(filename, obj) {
  const blob = new Blob([serializeDescriptor(obj)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Exit / status view logic (pure) -----------------------------------------

export const FLAG_EXITING = 8;
export const FLAG_PAUSED = 2;
export const FLAG_RESYNC = 64;

/** "2 d 3 h", "45 min", "30 s" — a compact, rounded-down duration. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  if (s >= 60) return `${Math.floor(s / 60)} min`;
  return `${s} s`;
}

/**
 * Where an arbiter is in the two-step exit, at `now` (unix seconds).
 * @param {{flags:number, exitAt:number, blockedUntil:number}} job
 * @returns {{ state: 'none'|'unbonding'|'blocked'|'ready', waitSeconds: number }}
 *   'unbonding': requestExit sent, completeExit allowed from exitAt;
 *   'blocked': unbonding is over but completeExit reverts until blockedUntil;
 *   'ready': completeExit can be sent now.
 */
export function exitView(job, now) {
  const flags = Number(job?.flags) || 0;
  if (!(flags & FLAG_EXITING)) return { state: 'none', waitSeconds: 0 };
  const exitAt = Number(job.exitAt) || 0;
  if (now < exitAt) return { state: 'unbonding', waitSeconds: exitAt - now };
  const blockedUntil = Number(job.blockedUntil) || 0;
  if (blockedUntil > now) return { state: 'blocked', waitSeconds: blockedUntil - now };
  return { state: 'ready', waitSeconds: 0 };
}

/** Labels and one-line explanations for the server's status buckets and reasons. */
export const STATUS_LABELS = {
  active: 'Active',
  new: 'New',
  atRisk: 'At risk',
  frozen: 'Frozen',
  blocked: 'Blocked',
  inactive: 'Inactive',
};

export const REASON_TEXT = {
  banned: 'Banned: reached the keeper\'s maximum offenses. It can never be selected again; exit to recover what is left of the stake.',
  blocked: 'Blocked: a score reached 0, so it is locked out of selection until the block ends.',
  exiting: 'Exiting: unbonding after requestExit. Not selected; complete the exit once the unbonding period ends.',
  paused: 'Paused by its owner: not selected until resumed.',
  understaked: 'Under-staked: its stake is below the keeper\'s requirement, so it is not selected. Top up the stake.',
  understakedUnflagged: 'Its stake is below the keeper\'s current requirement, but it is still selected: the keeper only re-checks the stake when it changes (a top-up or a burn). Top up before then.',
  feeAboveMax: 'Fee above the aggregator\'s maximum oracle fee: no request can select it. Lower the fee.',
  resyncing: 'Frozen until its node re-syncs: registered without a hash-chain head (or its chain was lost). The node\'s health job re-syncs on its own within a minute or so of running, then answers a health call.',
  frozen: 'Frozen: a health call went unanswered past the deadline. It is selectable again once its node answers.',
  callPending: 'A health call is waiting for its node\'s answer.',
  lowScore: 'A score is low: one far reveal (quality −major) or one failed round without a commit (timeliness −nocommit) would reach 0 and block it.',
  failMissRisk: 'Timeliness is at or below the keeper\'s fail penalty: one promoted miss in a failed round (−fail) would block it.',
  new: 'Not scored yet: both scores are still at their starting value.',
  unregistered: 'Not registered.',
};

/** The explanation lines for a job's status reasons, most severe first. */
export function reasonLines(reasons) {
  return (reasons || []).map((r) => REASON_TEXT[r]).filter(Boolean);
}
