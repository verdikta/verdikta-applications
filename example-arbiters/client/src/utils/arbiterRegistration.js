/**
 * Shared helpers for arbiter registration: input parsing/validation, the
 * portable JSON descriptor (download + import), used by the Restart modal, the
 * Register-from-scratch section, and the per-arbiter "Backup JSON" action.
 *
 * The descriptor holds exactly what registerOracle(oracle, jobId, fee, classes)
 * needs, plus network/keeper routing and an informational reputation snapshot.
 * Re-registering ALWAYS resets reputation to zero — the snapshot is not
 * restorable, it's there for record-keeping.
 */

import { ethers } from 'ethers';

/** Parse the classes field ("128, 129") into a validated number[] (1–5 unique ints). */
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

/** Parse a LINK fee decimal string into { wei (bigint), display } or { error }. */
export function parseFee(text) {
  const t = String(text ?? '').trim();
  if (t === '') return { error: 'Enter a fee' };
  try {
    const wei = ethers.parseEther(t);
    if (wei <= 0n) return { error: 'Fee must be greater than 0' };
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
export function buildDescriptor({ network, keeperAddress, operator, owner, jobId, fee, classes, reputation }) {
  return {
    type: 'verdikta-arbiter-registration',
    version: 1,
    _readme:
      'Editable fields: operator, jobId, fee (LINK decimal), classes (1–5 integers). ' +
      'Importing this on the My Arbiters "Register an arbiter" section re-registers it. ' +
      'Re-registering resets on-chain reputation to zero; reputationSnapshot is informational only.',
    network,
    keeperAddress,
    operator,
    owner,
    jobId,
    fee, // LINK decimal string
    classes, // number[]
    reputationSnapshot: reputation || null,
    exportedAt: new Date().toISOString(),
  };
}

export function serializeDescriptor(obj) {
  return JSON.stringify(obj, null, 2);
}

/**
 * Validate + normalize an imported descriptor into the registration fields.
 * Lenient about type/version, strict about the fields registerOracle needs.
 * Throws Error with a user-facing message on bad input.
 */
export function parseDescriptor(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (!obj || typeof obj !== 'object') throw new Error('JSON is not an object.');

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
    keeperAddress: obj.keeperAddress || null,
    owner: obj.owner || null,
  };
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
