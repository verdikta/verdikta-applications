/* global BigInt */
/* utils/timeoutUtils.js */
import { id as keccakId } from 'ethers';

/**
 * Driving a v2 aggregator round from the user's wallet, and closing it when it fails.
 *
 * In v2 a request only escrows the prepay. The round then needs outside calls to move on,
 * and this page makes them with the user's wallet (each one is a wallet transaction the
 * user confirms). Anyone may make every one of these calls:
 *
 *   phase 1 draw      drawJury(aggId) from block B+2 (B = the request's block). Within
 *                     30 s of the request only the requester earns the draw reward
 *                     (2 x the per-arbiter fee, credited to ethOwed); after that whoever
 *                     draws earns it. An undrawn round never times out: drawJury reverts
 *                     DrawExpired a day after the request, and the round can then only be
 *                     cancelled, its prepay going to the treasury.
 *   phase 2 beacons   (withBeacons) the first drawJury started the beacon stage, with no
 *                     reward; a second drawJury draws once the beacon quorum is in (the
 *                     30 s priority then runs from the quorum), or ends the round if the
 *                     quorum was missed (prepay to the treasury).
 * The jury (K drawn, M promoted, N counted, P clustered, and the timeout) is the request's
 * own: getJury(aggId) returns it (readJury below). The round's deadline is its timeout
 * after the draw.
 *
 *   phase 3 commit    the arbiters commit. The window closes by itself at M+ commits;
 *                     otherwise closeCommits(aggId) closes it after T+ with >= M commits.
 *   phase 4 closing   promote(aggId) from the close block + 2. The caller earns 1 x fee.
 *   phase 5 reveal    the N-th reveal finalizes the round.
 *   phase 6 final     getEvaluation is valid: the result.
 *   7 settled, 8 failed, 9 cancelled.
 *
 * After the round's deadline settle(aggId) fails an unfinished round. The unspent prepay
 * is credited to the requester, except when the round had M commits but was never
 * promoted (closed and not promoted, or never closed), when the beacon quorum was missed,
 * and for a cancelled round: then it goes to the treasury.
 *
 * Every transaction is simulated first with estimateGas (free, from the user's address),
 * and only one that will succeed is sent.
 *
 * driveRound() resolves to one of (call it again to pick a round up: a retry, a reload):
 *   { status: 'fulfilled', round }
 *       A result exists and checkForResult() has pushed it into the page.
 *   { status: 'failed', round, failedPhase, settledBy: 'user' | 'other', txHash?, refund }
 *       No result. refund is { amount, toRequester } read from RequesterRefunded, or null
 *       when it could not be read.
 *   { status: 'cancelled', round }
 *       Never drawn; the prepay went to the treasury.
 *   { status: 'expired', round, reason: 'close-missed' | 'promote-missed' | 'draw-expired' | 'seed-expired' }
 *       The round can no longer finish and nothing the user can send gets the prepay back.
 *   { status: 'stalled', round, step, reason, errorMessage?, txHash? }
 *       The round is open and waits for `step` ('draw' | 'beacon-draw' | 'close' |
 *       'promote' | 'settle', or null when the page could not tell), which was not made.
 *       reason: 'declined' | 'no-wallet' | 'send-failed' | 'tx-failed' | 'check-failed'.
 */

export const PHASE = {
  NONE: 0,
  DRAW: 1,
  BEACONS: 2,
  COMMIT: 3,
  CLOSING: 4,
  REVEAL: 5,
  FINAL: 6,
  SETTLED: 7,
  FAILED: 8,
  CANCELLED: 9,
};

export const PHASE_NAMES = {
  0: 'unknown',
  1: 'draw',
  2: 'beacons',
  3: 'commit',
  4: 'closing',
  5: 'reveal',
  6: 'final',
  7: 'settled',
  8: 'failed',
  9: 'cancelled',
};

/** The calls this page may send for a round, and the contract function behind each. */
export const STEP_FUNCTIONS = {
  draw: 'drawJury',
  'beacon-draw': 'drawJury',
  close: 'closeCommits',
  promote: 'promote',
  settle: 'settle',
};

// Waiting for the arbiters: one read every 5 s.
export const POLL_INTERVAL_MS = 5_000;
// Waiting for a block (B+2, C+2) or the beacon quorum: the 30 s draw priority is short.
export const FAST_POLL_MS = 2_000;
// How long a call the page expects to succeed may keep failing its dry run (node lag,
// a clock behind) before the page stops and says so.
export const STUCK_MS = 120_000;
// How long the beacon stage may take before the page stops waiting (the contract's
// beacon deadline is 120 s after the stage starts; a call after it ends the round).
export const BEACON_WAIT_MS = 300_000;
// Consecutive failed reads of the round before the page gives up.
export const MAX_READ_FAILURES = 6;
// drawJury refuses more than a day after the request (DRAW_GRACE).
export const DRAW_GRACE_SECONDS = 24 * 60 * 60;

// Gas. Measured on the dispatcher's v2 test network (Hardhat, 300 arbiters, K = 6 and 8,
// test/gas.test.js, 2026-11-23): drawJury 2.35-2.86 million (dispatches K requests),
// drawJury starting the beacon stage 0.39 million, promote 0.74-0.76 million, settle
// 0.25-0.26 million. Unlike v1's finalizeEvaluationTimeout, these calls revert with
// OutOfGas when the gas left cannot cover a guarded inner call (the keeper's selection
// and scoring, each dispatch), so a limit at the node's estimate cannot make them fail
// quietly and no fixed floor is needed. The estimate is padded by half, because the
// keeper's state (and so the work) can change between the estimate and the block.
export function stepGasLimit(estimate) {
  return (BigInt(estimate) * 3n) / 2n;
}

const AGGREGATOR_ERRORS = [
  'BadInput',
  'BadJury',
  'InsufficientPayment',
  'BadSelectionCount',
  'UnknownRequest',
  'WrongPhase',
  'TooEarly',
  'NotDue',
  'SeedExpired',
  'DrawExpired',
  'OutOfGas',
  'NothingOwed',
  'EthTransferFailed',
];
const ERROR_SELECTORS = Object.fromEntries(
  AGGREGATOR_ERRORS.map((name) => [name, keccakId(`${name}()`).slice(0, 10)])
);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the wallet reports that the user refused the request. */
export function isUserRejection(error) {
  const codes = [error?.code, error?.info?.error?.code, error?.error?.code];
  if (codes.includes('ACTION_REJECTED') || codes.includes(4001)) return true;
  return /user rejected|user denied|rejected the request/i.test(String(error?.message || ''));
}

/**
 * Name of the aggregator's custom error behind a failed call, or null.
 * ethers fills error.revert when the ABI lists the error; wallets and RPC nodes do
 * not all hand the revert data over in the same place, so the selector and the name
 * are also looked for in the usual fields.
 */
export function revertName(error) {
  if (!error) return null;
  if (AGGREGATOR_ERRORS.includes(error.revert?.name)) return error.revert.name;

  const fields = [
    error.data,
    error.info?.error?.data,
    error.info?.error?.data?.data,
    error.error?.data,
    error.error?.data?.data,
    error.reason,
    error.shortMessage,
    error.message,
    error.info?.error?.message,
  ].filter((value) => typeof value === 'string');

  for (const name of AGGREGATOR_ERRORS) {
    const selector = ERROR_SELECTORS[name];
    if (fields.some((text) => text.toLowerCase().includes(selector) || new RegExp(`\\b${name}\\b`).test(text))) {
      return name;
    }
  }
  return null;
}

export function describeError(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || 'unknown error');
}

/** getRoundInfo() as plain numbers (times in seconds, amounts in wei). */
export function parseRoundInfo(info) {
  const n = (v) => Number(v ?? 0);
  const b = (v) => BigInt(v ?? 0);
  return {
    phase: n(info[0]),
    requestBlock: n(info[1]),
    sealedHash: info[2],
    closeBlock: n(info[3]),
    received: b(info[4]),
    baseFees: b(info[5]),
    bonuses: b(info[6]),
    rewards: b(info[7]),
    deadline: n(info[8]),
    windowEnd: n(info[9]),
    commits: n(info[10]),
    requestTime: n(info[11]),
  };
}

export async function readRound(readContract, aggId) {
  return parseRoundInfo(await readContract.getRoundInfo(aggId));
}

/** getJury() as plain numbers, or null for an unknown round (all zero). */
export function parseJury(j) {
  if (!j) return null;
  const jury = { K: Number(j[0]), M: Number(j[1]), N: Number(j[2]), P: Number(j[3]), timeout: Number(j[4]) };
  return jury.K > 0 ? jury : null;
}

/** The jury the round was requested with: { K, M, N, P, timeout }, or null. */
export async function readJury(readContract, aggId) {
  return parseJury(await readContract.getJury(aggId));
}

/** checkForResult() must never end the wait by throwing: a failed read is "no result yet". */
async function hasResult(checkForResult) {
  try {
    return (await checkForResult()) === true;
  } catch (error) {
    console.warn('Could not read the evaluation:', describeError(error));
    return false;
  }
}

function parseLogs(logs, contractInterface) {
  const out = [];
  for (const log of logs || []) {
    try {
      const parsed = contractInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed) out.push(parsed);
    } catch {
      // another contract's log
    }
  }
  return out;
}

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The draw reward a drawJury receipt credited to its sender (0n for none), or null. */
export function drawRewardFromReceipt(receipt, contractInterface, aggId) {
  if (!receipt?.logs || !contractInterface) return null;
  const drawn = parseLogs(receipt.logs, contractInterface).find(
    (p) => p.name === 'JuryDrawn' && sameId(p.args.aggRequestId, aggId)
  );
  return drawn ? drawn.args.reward : null;
}

/**
 * Where the round's unspent prepay went: { amount, toRequester }, from RequesterRefunded
 * in the given receipt or, failing that, from the chain's logs. null when unknown.
 */
export async function findRefund({ readContract, aggId, account, receipt, fromBlock }) {
  const toResult = (parsedArgs) => ({
    amount: parsedArgs.amount,
    toRequester: !!account && sameId(parsedArgs.requester, account),
  });
  if (receipt?.logs && readContract?.interface) {
    const refunded = parseLogs(receipt.logs, readContract.interface).find(
      (p) => p.name === 'RequesterRefunded' && sameId(p.args.aggRequestId, aggId)
    );
    if (refunded) return toResult(refunded.args);
  }
  try {
    if (typeof readContract?.queryFilter !== 'function' || !readContract.filters?.RequesterRefunded) return null;
    const events = await readContract.queryFilter(readContract.filters.RequesterRefunded(aggId), fromBlock || 0);
    const last = events?.[events.length - 1];
    return last?.args ? toResult(last.args) : null;
  } catch (error) {
    console.warn('Could not read the refund event:', describeError(error));
    return null;
  }
}

/**
 * Simulate one call, and send it with the user's wallet only if the simulation passed.
 * Resolves to { ok: true, receipt, txHash } or { ok: false, reason, revert?, error?, txHash? }
 * where reason is 'revert' (the dry run reverted: nothing was sent), 'no-wallet',
 * 'declined', 'send-failed' or 'tx-failed'.
 */
export async function sendStep({ step, readContract, getWriteContract, aggId, account, setTransactionStatus, prompt }) {
  const fn = STEP_FUNCTIONS[step];
  let gasLimit;
  try {
    const overrides = account ? { from: account } : {};
    gasLimit = stepGasLimit(await readContract[fn].estimateGas(aggId, overrides));
  } catch (error) {
    return { ok: false, reason: 'revert', revert: revertName(error), error };
  }

  let writeContract;
  try {
    writeContract = await getWriteContract();
  } catch (error) {
    return { ok: false, reason: 'no-wallet', error };
  }

  setTransactionStatus?.(prompt || `Confirm ${fn} in your wallet...`);
  let tx;
  try {
    // Fees are left to the wallet: values read when the request was sent may be stale.
    tx = await writeContract[fn](aggId, { gasLimit });
  } catch (error) {
    if (isUserRejection(error)) return { ok: false, reason: 'declined', error };
    return { ok: false, reason: 'send-failed', revert: revertName(error), error };
  }

  setTransactionStatus?.(`Waiting for ${fn} to be mined...`);
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (error) {
    if (error?.code === 'TRANSACTION_REPLACED' && error.reason === 'repriced' && error.receipt?.status === 1) {
      receipt = error.receipt; // the user sped the transaction up in the wallet
    } else {
      return { ok: false, reason: 'tx-failed', error, txHash: tx.hash };
    }
  }
  if (!receipt || receipt.status === 0) return { ok: false, reason: 'tx-failed', txHash: tx.hash };
  return { ok: true, receipt, txHash: receipt.hash || tx.hash };
}

/** What the page tells the user before each wallet prompt: what the call does, who earns what. */
export const STEP_PROMPTS = {
  draw:
    'Confirm drawJury in your wallet: it draws the jury. Drawn within 30 s of the request, the draw reward (2 x the per-arbiter fee) is added to your prepay credit.',
  'start-beacons':
    'Confirm drawJury in your wallet (1 of 2): it starts the beacon stage. No reward for this call.',
  'beacon-draw':
    'Confirm drawJury in your wallet (2 of 2): the beacon values are in, so it draws the jury. Within 30 s, the draw reward (2 x the per-arbiter fee) is added to your prepay credit.',
  close:
    'Confirm closeCommits in your wallet: the commit window is over and enough arbiters committed, so it closes the commit phase. No reward for this call.',
  promote:
    'Confirm promote in your wallet: it picks the commits to reveal. The promote reward (1 x the per-arbiter fee) is added to your prepay credit.',
  settle:
    'The round missed its deadline. Confirm settle in your wallet: it closes the round and returns the unspent prepay to your prepay credit.',
};

/**
 * Move a round from its current phase to its end with the user's wallet, polling between
 * steps. Safe to call again on a round that is already under way (see resumeRound).
 *
 * @param {object}   p
 * @param {object}   p.readContract      aggregator bound to any provider (reads and dry runs)
 * @param {Function} p.getWriteContract  async () => aggregator bound to the user's signer
 * @param {string}   p.aggId
 * @param {string}   p.account           the user's address (dry runs are made from it)
 * @param {boolean}  [p.withBeacons]     the request asked for beacons (only changes the prompt)
 * @param {Function} p.getHead           async () => ({ number, timestamp }) of the latest block
 * @param {Function} p.checkForResult    async () => true once a result exists and is shown
 * @param {Function} [p.onRound]         (round, head) after every read; round.jury is getJury(aggId) (null until read)
 * @param {Function} [p.onStep]          ({ step, txHash, rewardWei }) after every mined call
 * @param {Function} [p.setTransactionStatus]
 */
export async function driveRound({
  readContract,
  getWriteContract,
  aggId,
  account,
  withBeacons = false,
  getHead,
  checkForResult,
  onRound,
  onStep,
  setTransactionStatus,
  pollIntervalMs = POLL_INTERVAL_MS,
  fastPollMs = FAST_POLL_MS,
  stuckMs = STUCK_MS,
  beaconWaitMs = BEACON_WAIT_MS,
  now = Date.now,
  sleep = defaultSleep,
}) {
  let round = null;
  let lastPhase = PHASE.NONE;
  let readFailures = 0;
  let settleTx = null; // { txHash, receipt } of the user's settle, when it failed the round
  let lastReceipt = null; // the last call the user sent, for the refund lookup
  let stuck = null; // { key, since }: a dry run that keeps failing in the same phase
  let beaconSince = null;
  // The round's own jury (getJury): M is the commits closeCommits needs. Read again on
  // a later poll if the first read fails.
  let jury = null;
  const loadJury = async () => {
    if (jury) return;
    try {
      jury = await readJury(readContract, aggId);
    } catch {
      jury = null;
    }
  };
  await loadJury();

  const stalled = (step, reason, error, extra = {}) => ({
    status: 'stalled',
    round,
    step,
    reason,
    ...(error ? { errorMessage: describeError(error) } : {}),
    ...extra,
  });

  // A dry run failed in a way that waiting may fix. Wait, unless it has gone on too long.
  const waitOrGiveUp = async (key, step, error, ms = fastPollMs) => {
    if (!stuck || stuck.key !== key) stuck = { key, since: now() };
    if (now() - stuck.since >= stuckMs) return stalled(step, 'check-failed', error);
    await sleep(ms);
    return null;
  };

  // Simulate and send one step. Returns a final outcome, or null to go on polling.
  const runStep = async (step, prompt) => {
    const sent = await sendStep({
      step,
      readContract,
      getWriteContract,
      aggId,
      account,
      setTransactionStatus,
      prompt: prompt || STEP_PROMPTS[step],
    });
    if (sent.ok) {
      stuck = null;
      lastReceipt = sent.receipt;
      const rewardWei = step === 'draw' || step === 'beacon-draw'
        ? drawRewardFromReceipt(sent.receipt, readContract.interface, aggId)
        : null;
      if (step === 'settle') settleTx = { txHash: sent.txHash, receipt: sent.receipt };
      onStep?.({ step, txHash: sent.txHash, rewardWei });
      return null;
    }
    if (sent.reason === 'revert') {
      const name = sent.revert;
      if (name === 'DrawExpired') return { status: 'expired', round, reason: 'draw-expired' };
      if (name === 'SeedExpired') return { status: 'expired', round, reason: 'seed-expired' };
      if (['TooEarly', 'NotDue', 'WrongPhase'].includes(name)) {
        // The chain is a block or two behind the page, or another account moved the round.
        return waitOrGiveUp(`${step}:${round.phase}`, step, sent.error);
      }
      return stalled(step, 'check-failed', sent.error);
    }
    // Not sent, or sent and failed. Another account may have made the call first.
    try {
      const fresh = await readRound(readContract, aggId);
      if (fresh.phase !== round.phase) return null;
    } catch {
      // fall through: report what happened to the user's call
    }
    return stalled(step, sent.reason, sent.error, sent.txHash ? { txHash: sent.txHash } : {});
  };

  for (;;) {
    let head;
    try {
      [round, head] = await Promise.all([readRound(readContract, aggId), getHead()]);
      readFailures = 0;
      await loadJury();
      round.jury = jury;
    } catch (error) {
      readFailures += 1;
      if (readFailures >= MAX_READ_FAILURES) return stalled(null, 'check-failed', error);
      await sleep(fastPollMs);
      continue;
    }
    onRound?.(round, head);
    if (round.phase !== lastPhase && lastPhase !== PHASE.NONE) stuck = null;

    switch (round.phase) {
      case PHASE.NONE: {
        // The node has not seen the request's block yet.
        const out = await waitOrGiveUp('none', null, new Error('The round is not visible on the network yet.'));
        if (out) return out;
        break;
      }

      case PHASE.FINAL:
      case PHASE.SETTLED: {
        if (await hasResult(checkForResult)) return { status: 'fulfilled', round };
        const out = await waitOrGiveUp('result', null, new Error('The result could not be read.'));
        if (out) return out;
        break;
      }

      case PHASE.FAILED: {
        const refund = await findRefund({
          readContract,
          aggId,
          account,
          receipt: settleTx?.receipt || lastReceipt,
          fromBlock: round.requestBlock,
        });
        return {
          status: 'failed',
          round,
          failedPhase: lastPhase,
          settledBy: settleTx ? 'user' : 'other',
          ...(settleTx ? { txHash: settleTx.txHash } : {}),
          refund,
        };
      }

      case PHASE.CANCELLED:
        return { status: 'cancelled', round };

      case PHASE.DRAW: {
        if (head.timestamp > round.requestTime + DRAW_GRACE_SECONDS) {
          return { status: 'expired', round, reason: 'draw-expired' };
        }
        if (head.number < round.requestBlock + 2) {
          setTransactionStatus?.('Request confirmed. Waiting two blocks before the jury can be drawn...');
          await sleep(fastPollMs);
          break;
        }
        // With beacons this first drawJury starts the beacon stage (phase 2) instead.
        const out = await runStep('draw', withBeacons ? STEP_PROMPTS['start-beacons'] : undefined);
        if (out) return out;
        break;
      }

      case PHASE.BEACONS: {
        if (beaconSince === null) beaconSince = now();
        // The second drawJury succeeds once the beacon quorum is in (or its deadline passed).
        let estimateError = null;
        try {
          await readContract.drawJury.estimateGas(aggId, account ? { from: account } : {});
        } catch (error) {
          estimateError = error;
        }
        if (estimateError && revertName(estimateError) === 'TooEarly') {
          if (now() - beaconSince >= beaconWaitMs) return stalled('beacon-draw', 'check-failed', estimateError);
          setTransactionStatus?.('Waiting for the beacon values (up to 2 minutes)...');
          await sleep(fastPollMs);
          break;
        }
        const out = await runStep('beacon-draw');
        if (out) return out;
        break;
      }

      case PHASE.COMMIT: {
        if (round.deadline > 0 && head.timestamp > round.deadline) {
          // With M commits the window should have been closed: settling now sends the
          // unspent prepay to the treasury, so the page does not spend the user's gas on it.
          if (jury && round.commits >= jury.M) return { status: 'expired', round, reason: 'close-missed' };
          const out = await runStep('settle');
          if (out) return out;
          break;
        }
        if (head.timestamp > round.windowEnd) {
          // closeCommits succeeds only with at least M commits; with fewer, waiting is right.
          let canClose = true;
          try {
            await readContract.closeCommits.estimateGas(aggId, account ? { from: account } : {});
          } catch (error) {
            canClose = false;
          }
          if (canClose) {
            const out = await runStep('close');
            if (out) return out;
            break;
          }
        }
        setTransactionStatus?.(`Waiting for the arbiters to commit (${round.commits} so far)...`);
        await sleep(pollIntervalMs);
        break;
      }

      case PHASE.CLOSING: {
        if (round.deadline > 0 && head.timestamp > round.deadline) {
          // promote() now reverts, and settling sends the unspent prepay to the treasury.
          return { status: 'expired', round, reason: 'promote-missed' };
        }
        if (head.number < round.closeBlock + 2) {
          setTransactionStatus?.('The commit phase is closed. Waiting two blocks before promoting...');
          await sleep(fastPollMs);
          break;
        }
        const out = await runStep('promote');
        if (out) return out;
        break;
      }

      case PHASE.REVEAL: {
        if (round.deadline > 0 && head.timestamp > round.deadline) {
          const out = await runStep('settle');
          if (out) return out;
          break;
        }
        setTransactionStatus?.('Waiting for the arbiters to reveal their answers...');
        await sleep(pollIntervalMs);
        break;
      }

      default:
        return stalled(null, 'check-failed', new Error(`Unknown round phase ${round.phase}`));
    }
    lastPhase = round.phase;
  }
}
