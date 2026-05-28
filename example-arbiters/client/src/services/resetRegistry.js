/**
 * Pending "reset reputation" tracker (localStorage-backed).
 *
 * Resetting an arbiter is a multi-tx flow (approve → deregister → re-register).
 * The risky gap is after deregister: the (oracle, jobId) is delisted on-chain
 * and disappears from the owned-arbiters listing. If the user closes the tab or
 * the re-register tx fails there, the arbiter is offline with no on-page record
 * of how to restore it.
 *
 * We record an entry the moment deregister succeeds — holding exactly what
 * registerOracle needs (oracle, jobId, fee, classes) — and clear it once
 * re-register succeeds (or the user abandons it). My Arbiters reads these to
 * show a resume banner. Stored data is non-sensitive (addresses + public
 * registration params).
 */

const KEY = 'verdikta.pendingResets.v1';

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable / full — resume is best-effort, so swallow */
  }
}

const sameId = (e, network, oracle, jobId) =>
  e.network === network &&
  e.oracle.toLowerCase() === oracle.toLowerCase() &&
  e.jobId.toLowerCase() === jobId.toLowerCase();

/** Record a deregistered arbiter awaiting re-registration (replaces any prior entry for the same id). */
export function markDeregistered({ network, owner, keeperAddress, oracle, jobId, fee, classes }) {
  const list = readAll().filter((e) => !sameId(e, network, oracle, jobId));
  list.push({ network, owner, keeperAddress, oracle, jobId, fee, classes, ts: Date.now() });
  writeAll(list);
}

/** Drop a reset entry once re-registration completes (or the user dismisses it). */
export function clearPendingReset({ network, oracle, jobId }) {
  writeAll(readAll().filter((e) => !sameId(e, network, oracle, jobId)));
}

/** Pending resets for a network + owner (owner matched case-insensitively). */
export function getPendingResets(network, owner) {
  if (!owner) return [];
  return readAll().filter(
    (e) => e.network === network && e.owner.toLowerCase() === String(owner).toLowerCase()
  );
}
