/* utils/timeoutUtils.js */

/**
 * Races (a) normal polling vs. (b) a one-shot on-chain timeout.
 * Resolves to { status: 'fulfilled' | 'timed-out' }.
 *
 * All setter callbacks come from RunQuery so that UI state is updated
 * exactly the same way in either path.
 */
export async function waitForFulfilOrTimeout({
  contract,
  requestId,
  pollCallbacks,
  feeOverrides,
  setTransactionStatus,
  responseTimeoutSeconds = 300,         // keep the same default as the contract
  safetyMarginMs = 2_000                // small safety margin to ensure polling times out first
}) {

  // a flag indicating normal completion and no need for an active timeout transaction to be sent.
  let cancelled = false;

  /* --- A. Existing polling promise --- */
  const pollPromise = pollCallbacks.pollForEvaluationResults(
    contract,
    requestId,
    pollCallbacks.setTransactionStatus,
    pollCallbacks.setOutcomes,
    pollCallbacks.setJustification,
    pollCallbacks.setResultCid,
    pollCallbacks.setResultTimestamp,
    pollCallbacks.setOutcomeLabels
  ).then(result => {                       
    cancelled = true;         // cancel the timeout
    console.log('🔄 Polling completed with result:', result);
    return result ?? { status: 'fulfilled' };
  });

  /* --- B. One-shot timer that fires finalizeEvaluationTimeout() --- */
  const timeoutPromise = new Promise(async (resolve) => {
    const waitMs = responseTimeoutSeconds * 1_000 + safetyMarginMs;
    await new Promise(r => setTimeout(r, waitMs));

    if (cancelled) {
      console.log('⏹️ Timeout cancelled - polling completed first');
      return; // Polling finished first — don't actively timeout on chain
    }

    try {
      console.log('⏰ Triggering on-chain timeout after', waitMs, 'ms');
      setTransactionStatus?.('Triggering on-chain timeout…');
      const tx = await contract.finalizeEvaluationTimeout(requestId, feeOverrides);
      await tx.wait();
      console.log('✅ On-chain timeout successful');
      resolve({ status: 'timed-out' });
    } catch (e) {
      // If the oracle already answered, finalizeEvaluationTimeout will revert
      // with either "complete" or "not timed-out".  Treat that as fulfilled.
      console.log('❌ On-chain timeout failed (oracle may have answered):', e.message);
      resolve({ status: 'fulfilled' });
    }
  });

  /* --- Who wins the race? --- */
  return Promise.race([pollPromise, timeoutPromise]);
}

