/**
 * Pending "exit, then register again later" tracker (localStorage-backed).
 *
 * v2 has no in-place reset: the classes an arbiter serves are fixed at
 * registration, and the keeper keeps a key's scores and offenses for good. To
 * change classes (or to come back after a break) the owner exits — requestExit,
 * then completeExit once the unbonding period (2 days by default) has passed,
 * which refunds the stake — and registers the same (oracle, jobId) again.
 *
 * The gap between those steps is days long and spans page loads, so we record
 * the planned re-registration (fee, classes) when the exit is requested, mark it
 * when the exit completes, and clear it once the arbiter is registered again (or
 * the owner dismisses it). After completeExit the arbiter disappears from the
 * owned-arbiters listing, so this entry is the only on-page trace of it. Stored
 * data is non-sensitive (addresses + public registration params).
 */

// v1 entries (key 'verdikta.pendingResets.v1') described v1 deregistrations and
// are ignored: they cannot be resumed against the v2 keeper.
const KEY = 'verdikta.pendingReregistrations.v2';

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

/**
 * Record a planned re-registration when the exit is requested (replaces any prior
 * entry for the same arbiter). `exitAt` is when completeExit becomes possible.
 */
export function markExitRequested({ network, owner, keeperAddress, oracle, jobId, fee, classes, exitAt }) {
  const list = readAll().filter((e) => !sameId(e, network, oracle, jobId));
  list.push({ network, owner, keeperAddress, oracle, jobId, fee, classes, exitAt: exitAt || null, stage: 'exiting', ts: Date.now() });
  writeAll(list);
}

/** The exit completed (stake refunded): the arbiter now waits only for registration. */
export function markExitCompleted({ network, owner, keeperAddress, oracle, jobId, fee, classes }) {
  const list = readAll();
  const e = list.find((x) => sameId(x, network, oracle, jobId));
  if (e) {
    e.stage = 'exited';
    if (fee != null) e.fee = fee;
    if (classes != null) e.classes = classes;
  } else {
    list.push({ network, owner, keeperAddress, oracle, jobId, fee, classes, exitAt: null, stage: 'exited', ts: Date.now() });
  }
  writeAll(list);
}

/** Update the planned fee/classes of an entry (edited in the modal before registering). */
export function updatePlannedParams({ network, oracle, jobId, fee, classes }) {
  const list = readAll();
  const e = list.find((x) => sameId(x, network, oracle, jobId));
  if (!e) return;
  e.fee = fee;
  e.classes = classes;
  writeAll(list);
}

/** Drop an entry once re-registration completes (or the user dismisses it). */
export function clearPendingReset({ network, oracle, jobId }) {
  writeAll(readAll().filter((e) => !sameId(e, network, oracle, jobId)));
}

/** The entry for one arbiter, or null. */
export function getPendingReset(network, oracle, jobId) {
  return readAll().find((e) => sameId(e, network, oracle, jobId)) || null;
}

/** Pending entries for a network + owner (owner matched case-insensitively). */
export function getPendingResets(network, owner) {
  if (!owner) return [];
  return readAll().filter(
    (e) => e.network === network && e.owner.toLowerCase() === String(owner).toLowerCase()
  );
}
