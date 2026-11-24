// Display helpers for v2 rounds (item 12): nextAction labels, a job's decision settings, ETH formatting.
import { ethers } from 'ethers';
import { CLASS_PRESETS, MAX_ROUNDS, RERUN_WINDOW_SECONDS } from '../../../shared/classPresets.js';

export { MAX_ROUNDS, RERUN_WINDOW_SECONDS };

/** Human labels for the lens's nextAction values. */
export const ROUND_ACTION_LABELS = {
  START: 'Start evaluation',
  AWAIT_SLOT: 'Wait for a free evaluation slot',
  AWAIT_CREATOR: 'Creator review window',
  DRAW: 'Draw jury',
  CLOSE_COMMITS: 'Advance round (close commits)',
  PROMOTE: 'Advance round (promote)',
  AWAIT_ORACLE: 'Jury working',
  AWAIT_EARLIER: 'Waiting for an earlier submission',
  FINALIZE: 'Finalize',
  CLOSE_FAILED: 'Close failed round',
  RERUN: 'Re-run',
  AWAIT_EXPIRY: 'Wait for the re-run window to close',
  EXPIRE_RERUN: 'Expire re-run',
  RECOVER_REFUND: 'Recover prepay',
  DONE: 'Done',
  DEAD: 'Cannot proceed',
};

/** A jury { K, M, N, P, timeout } as numbers, or null (records from before item 15 stored an index). */
export function juryOf(j) {
  if (!j || typeof j !== 'object' || !(Number(j.K) > 0)) return null;
  return { K: Number(j.K), M: Number(j.M), N: Number(j.N), P: Number(j.P), timeout: Number(j.timeout) };
}

const sameJury = (a, b) => Boolean(a && b) && ['K', 'M', 'N', 'P', 'timeout'].every((f) => Number(a[f]) === Number(b[f]));

/**
 * The job's v2 decision settings ({ jury, quota, forfeitLine, bondWei, K, N, className }), tolerant
 * of both record shapes. The jury is the bounty's own { K, M, N, P, timeout } (getBounty's
 * juryK..juryTimeout); the class name comes from bountyClass, or the preset with the same jury.
 */
export function jobDecision(job) {
  const d = job?.decisionSettings || {};
  const jury = juryOf(d.jury ?? job?.jury);
  const quota = d.quota ?? job?.quota;
  const forfeitLine = d.forfeitLine ?? job?.forfeitLine;
  const bondWei = String(d.bondWei ?? d.bond ?? job?.bondWei ?? '0');
  const preset = (d.bountyClass && CLASS_PRESETS.find((c) => c.key === d.bountyClass))
    || CLASS_PRESETS.find((c) => sameJury(c.jury, jury) && c.key !== 'bondless-small');
  return {
    jury,
    quota: quota != null ? Number(quota) : null,
    forfeitLine: forfeitLine != null ? Number(forfeitLine) : null,
    bondWei,
    K: jury?.K ?? preset?.jury.K ?? null,
    N: jury?.N ?? (d.N != null ? Number(d.N) : preset?.jury.N ?? null),
    className: preset?.name ?? null,
  };
}

export function fmtEth(wei, digits = 6) {
  try {
    const n = Number(ethers.formatEther(BigInt(wei || 0)));
    return n === 0 ? '0' : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  } catch {
    return '?';
  }
}

