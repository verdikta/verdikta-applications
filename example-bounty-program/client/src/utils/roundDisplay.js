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

/** The job's v2 decision settings ({ jury, quota, forfeitLine, bondWei, N }), tolerant of both record shapes. */
export function jobDecision(job) {
  const d = job?.decisionSettings || {};
  const jury = Number(d.jury ?? job?.jury ?? 0);
  const quota = d.quota ?? job?.quota;
  const forfeitLine = d.forfeitLine ?? job?.forfeitLine;
  const bondWei = String(d.bondWei ?? d.bond ?? job?.bondWei ?? '0');
  // N is the jury aggregator's config; the presets carry it per jury (display only).
  const preset = (d.bountyClass && CLASS_PRESETS.find((c) => c.key === d.bountyClass)) || CLASS_PRESETS.find((c) => c.jury === jury && c.key !== 'bondless-small');
  return {
    jury,
    quota: quota != null ? Number(quota) : null,
    forfeitLine: forfeitLine != null ? Number(forfeitLine) : null,
    bondWei,
    N: d.N != null ? Number(d.N) : preset?.N ?? null,
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

