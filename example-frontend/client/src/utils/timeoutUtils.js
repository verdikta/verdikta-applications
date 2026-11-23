/* global BigInt */
/* utils/timeoutUtils.js */
import { id as keccakId } from 'ethers';

/**
 * Waiting for an evaluation, and closing the round on-chain when none arrives.
 *
 * A request prepays the worst-case fee, and the aggregator credits the unspent part
 * back only when the round ends. A round that gets too few answers never ends by
 * itself: someone has to call finalizeEvaluationTimeout(requestId) once the
 * aggregator's responseTimeoutSeconds has passed. Anyone may make that call. Here the
 * user's wallet makes it, because the user is the one waiting for the refund.
 *
 * Both functions resolve to one of:
 *   { status: 'fulfilled' }
 *       A result exists and checkForResult() has pushed it into the page.
 *   { status: 'timed-out', round: 'closed', closedBy: 'user', txHash, refundWei }
 *       No result. This wallet's transaction closed the round. refundWei is the
 *       prepay credit the round returned (0n when nothing was left, null when the
 *       receipt could not be read).
 *   { status: 'timed-out', round: 'closed', closedBy: 'other' }
 *       No result. Another account had already closed the round.
 *   { status: 'timed-out', round: 'open', reason, errorMessage?, txHash? }
 *       No result, and the round is still open. reason is one of
 *       'declined' | 'not-timed-out-yet' | 'no-wallet' | 'send-failed' |
 *       'tx-failed' | 'check-failed'.
 */

export const POLL_INTERVAL_MS = 5_000;

// The local clock starts when the request is confirmed, a little after the block that
// holds it, and the newest block can be a few seconds old. The margin keeps the page
// from asking for a transaction the chain would still reject as too early.
export const SAFETY_MARGIN_MS = 3_000;

// Gas for finalizeEvaluationTimeout(). The call updates the reputation score of every
// arbiter that did not answer, so it is not cheap. On forks of Base mainnet and Base
// Sepolia on 2026-11-22 (6 arbiters polled, none answered) it used between 1.44 and
// 1.89 million gas in ten runs, the node's estimate was up to 2.15 million, and a
// limit of 900,000 ran out of gas. Those score updates run inside try/catch, where a
// limit that is only just enough can let an update fail quietly, so the page sends the
// estimate plus 50% and never less than the floor.
export const FINALIZE_GAS_FLOOR = 3_000_000n;

export function finalizeGasLimit(estimate) {
  const padded = (BigInt(estimate) * 3n) / 2n;
  return padded > FINALIZE_GAS_FLOOR ? padded : FINALIZE_GAS_FLOOR;
}

const AGGREGATOR_ERRORS = ['AggregationComplete', 'NotTimedOut', 'UnknownRequest'];
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
    if (fields.some((text) => text.toLowerCase().includes(selector) || text.includes(name))) {
      return name;
    }
  }
  return null;
}

function describeError(error) {
  return String(error?.shortMessage || error?.reason || error?.message || error || 'unknown error');
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

/** Prepay credit a successful finalizeEvaluationTimeout receipt returned to the requester. */
function refundFromReceipt(receipt, contractInterface, requestId) {
  if (!receipt?.logs || !contractInterface) return null;
  try {
    for (const log of receipt.logs) {
      let parsed = null;
      try {
        parsed = contractInterface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        parsed = null;
      }
      if (
        parsed?.name === 'RequesterRefunded' &&
        String(parsed.args.aggRequestId).toLowerCase() === String(requestId).toLowerCase()
      ) {
        return parsed.args.amount;
      }
    }
    return 0n; // the round closed without a refund event: nothing was left to return
  } catch {
    return null;
  }
}

/**
 * Close a round that has passed the aggregator's timeout, with the user's wallet.
 *
 * @param {object}   p
 * @param {object}   p.readContract      aggregator bound to any provider (reads and the free dry run)
 * @param {Function} p.getWriteContract  async () => aggregator bound to the user's signer
 * @param {string}   p.requestId
 * @param {Function} p.checkForResult    async () => true once a result exists and is shown
 * @param {Function} [p.setTransactionStatus]
 */
export async function closeTimedOutRound({
  readContract,
  getWriteContract,
  requestId,
  checkForResult,
  setTransactionStatus,
  notTimedOutRetryMs = POLL_INTERVAL_MS,
  notTimedOutMaxWaitMs = 60_000,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const fulfilled = { status: 'fulfilled' };
  const closedByOther = { status: 'timed-out', round: 'closed', closedBy: 'other' };
  const open = (reason, error, extra = {}) => ({
    status: 'timed-out',
    round: 'open',
    reason,
    ...(error ? { errorMessage: describeError(error) } : {}),
    ...extra,
  });

  // What the chain says about a round that may have ended: a result, a failed round
  // that someone else closed, or (null) still open.
  const settled = async () => {
    if (await hasResult(checkForResult)) return fulfilled;
    try {
      if (await readContract.isFailed(requestId)) return closedByOther;
    } catch (error) {
      console.warn('Could not read isFailed():', describeError(error));
    }
    return null;
  };

  // The aggregator answered "AggregationComplete": the round has ended, either with a
  // result or as failed. Read which, allowing for a node that is one block behind.
  const completedRound = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await settled();
      if (outcome) return outcome;
      await sleep(2_000);
    }
    return closedByOther;
  };

  /* 1. Free dry run: would the call succeed right now, and how much gas does it need?
        Never ask the wallet to sign a transaction that is known to revert. */
  const giveUpAt = now() + notTimedOutMaxWaitMs;
  let gasLimit;
  for (;;) {
    try {
      gasLimit = finalizeGasLimit(await readContract.finalizeEvaluationTimeout.estimateGas(requestId));
      break;
    } catch (error) {
      const name = revertName(error);
      if (name === 'AggregationComplete') return completedRound();
      if (name === 'NotTimedOut') {
        // The chain's clock is behind the page's. Keep looking for a result meanwhile.
        if (await hasResult(checkForResult)) return fulfilled;
        if (now() >= giveUpAt) return open('not-timed-out-yet');
        setTransactionStatus?.('Waiting for the network to reach the timeout...');
        await sleep(notTimedOutRetryMs);
        continue;
      }
      const outcome = await settled();
      return outcome || open('check-failed', error);
    }
  }

  /* 2. The user's wallet. */
  let writeContract;
  try {
    writeContract = await getWriteContract();
  } catch (error) {
    return open('no-wallet', error);
  }

  /* 3. Send. Fees are left to the wallet: values computed when the request was sent
        can be several minutes old by now. */
  setTransactionStatus?.(
    'No result arrived in time. Confirm the transaction in your wallet to close the round and release your prepayment...'
  );
  let tx;
  try {
    tx = await writeContract.finalizeEvaluationTimeout(requestId, { gasLimit });
  } catch (error) {
    if (isUserRejection(error)) return open('declined');
    if (revertName(error) === 'AggregationComplete') return completedRound();
    return open('send-failed', error);
  }

  /* 4. Wait for it to be mined. */
  setTransactionStatus?.('Closing the round on the blockchain...');
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (error) {
    if (error?.code === 'TRANSACTION_REPLACED' && error.reason === 'repriced' && error.receipt?.status === 1) {
      receipt = error.receipt; // the user sped the transaction up in the wallet
    } else {
      // Mined but reverted (the round ended first), or cancelled in the wallet.
      const outcome = await settled();
      return outcome || open('tx-failed', error, { txHash: tx.hash });
    }
  }
  if (!receipt || receipt.status === 0) {
    const outcome = await settled();
    return outcome || open('tx-failed', null, { txHash: tx.hash });
  }

  // The call finishes a round normally when enough answers had arrived after all.
  if (await hasResult(checkForResult)) return fulfilled;

  return {
    status: 'timed-out',
    round: 'closed',
    closedBy: 'user',
    txHash: receipt.hash || tx.hash,
    refundWei: refundFromReceipt(receipt, readContract.interface, requestId),
  };
}

/**
 * Poll for a result for as long as the aggregator's own timeout, then close the round.
 *
 * @param {object}   p                         as closeTimedOutRound(), plus:
 * @param {number}   p.responseTimeoutSeconds  the aggregator's responseTimeoutSeconds()
 * @param {number}   [p.pollIntervalMs]
 * @param {number}   [p.safetyMarginMs]
 */
export async function waitForFulfilOrTimeout({
  readContract,
  getWriteContract,
  requestId,
  checkForResult,
  responseTimeoutSeconds,
  setTransactionStatus,
  pollIntervalMs = POLL_INTERVAL_MS,
  safetyMarginMs = SAFETY_MARGIN_MS,
  now = Date.now,
  sleep = defaultSleep,
  ...closeOptions
}) {
  const timeoutMs = Number(responseTimeoutSeconds) * 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid response timeout: ${responseTimeoutSeconds}`);
  }

  setTransactionStatus?.('Waiting for evaluation results...');
  const deadline = now() + timeoutMs + safetyMarginMs;
  for (;;) {
    if (await hasResult(checkForResult)) return { status: 'fulfilled' };
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return closeTimedOutRound({
    readContract,
    getWriteContract,
    requestId,
    checkForResult,
    setTransactionStatus,
    now,
    sleep,
    ...closeOptions,
  });
}
