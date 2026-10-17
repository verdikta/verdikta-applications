// Why a website bounty create failed, and what to tell the person.
//
// The create flow is: create the API job, then connect -> staticCall (pre-check)
// -> send (wallet signs and broadcasts) -> wait (mined) -> link (PATCH bountyId).
// classifyCreateFailure() turns whatever was thrown at `step` into a small
// record the page shows and reports to POST /api/jobs/:jobId/create-attempt.
// Pure: no imports, so node --test can load it.

export const CREATE_STEPS = ['connect', 'staticCall', 'send', 'wait', 'link'];

const MAX_TEXT = 500;
const clip = (s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, MAX_TEXT) : undefined);

// Every error object reachable from `error`: ethers wraps the wallet's RPC error
// in info.error or error, our own rethrows keep the original in cause, and
// axios errors carry the server's body in response.data.
function errorChain(error) {
  const out = [];
  const seen = new Set();
  const visit = (e, depth) => {
    if (!e || typeof e !== 'object' || seen.has(e) || depth > 6) return;
    seen.add(e);
    out.push(e);
    visit(e.cause, depth + 1);
    visit(e.error, depth + 1);
    visit(e.info?.error, depth + 1);
    visit(e.data?.originalError, depth + 1);
  };
  visit(error, 0);
  return out;
}

const firstOf = (chain, pick) => {
  for (const e of chain) {
    const v = pick(e);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/**
 * @param {unknown} error   what was thrown
 * @param {string}  step    one of CREATE_STEPS: how far the flow got
 * @param {{ chainId?: number, expectedChainId?: number }} [ctx]
 * @returns {{ step, category, code, rpcCode, reason, message, walletMessage }}
 */
export function classifyCreateFailure(error, step, { chainId, expectedChainId } = {}) {
  const chain = errorChain(error);
  const top = chain[0] || {};
  const codes = chain.map((e) => e.code).filter((c) => c !== undefined && c !== null);
  const code = codes.find((c) => typeof c === 'string');
  const rpcCode = codes.find((c) => typeof c === 'number');
  const messages = chain.flatMap((e) => [e.shortMessage, e.message]).filter((m) => typeof m === 'string');
  const allText = [typeof error === 'string' ? error : '', ...messages].join(' | ');
  const has = (re) => re.test(allText);

  // The revert reason ethers decoded, or the server's error for the link step.
  const reason = clip(firstOf(chain, (e) => (e.code === 'CALL_EXCEPTION' ? e.reason : undefined))
    ?? firstOf(chain, (e) => e.response?.data?.error)
    ?? (step === 'staticCall' && !code && !rpcCode ? top.message : undefined));
  const message = clip(top.shortMessage || top.message || (typeof error === 'string' ? error : '')) || 'Unknown error';
  // The wallet's own words: the JSON-RPC error (numeric code) if there is one,
  // else a nested error's short message. Never an ethers `.message`, which
  // appends the whole request payload.
  const walletMessage = clip(
    (firstOf(chain, (e) => (typeof e.code === 'number' && typeof e.message === 'string' ? e.message : undefined))
      ?? firstOf(chain.slice(1), (e) => {
        const m = e.shortMessage || e.message;
        return typeof m === 'string' && m !== top.message ? m : undefined;
      }))?.replace(/^ethers-user-denied:\s*/, ''));

  const isCode = (c) => codes.includes(c);
  let category = 'unknown';
  if (step === 'link') category = 'link_failed';
  else if (isCode('ACTION_REJECTED') || isCode(4001) || has(/user (rejected|denied)|rejected by user/i)) category = 'rejected_in_wallet';
  else if (isCode(-32002) || has(/already pending|already processing/i)) category = 'wallet_prompt_pending';
  else if (isCode('VERDIKTA_TIMEOUT')) category = 'wallet_timeout';
  else if (isCode('INSUFFICIENT_FUNDS') || has(/insufficient funds/i)) category = 'insufficient_funds';
  else if ((chainId && expectedChainId && Number(chainId) !== Number(expectedChainId))
    || isCode('VERDIKTA_WRONG_NETWORK')
    || (isCode('BAD_DATA') && firstOf(chain, (e) => (e.code === 'BAD_DATA' ? e.value : undefined)) === '0x')
    || has(/network changed/i)) category = 'wrong_network';
  else if (isCode('CALL_EXCEPTION')) category = step === 'wait' ? 'reverted_onchain' : 'contract_would_revert';
  else if (step === 'staticCall' && !code && !rpcCode) category = 'contract_would_revert';
  else if (isCode(-32603) || isCode('UNKNOWN_ERROR') || rpcCode !== undefined || code) category = 'wallet_or_rpc_error';

  return {
    step,
    category,
    code: code !== undefined ? String(code).slice(0, 100) : undefined,
    rpcCode,
    reason,
    message,
    walletMessage,
  };
}

/**
 * One message for the person: which step failed and whether money moved.
 * @param {ReturnType<typeof classifyCreateFailure>} f
 * @param {{ txHash?: string, networkName?: string, chainId?: number }} [ctx]
 */
export function describeCreateFailure(f, { txHash, networkName = 'Base', chainId } = {}) {
  const tx = txHash ? ` (${txHash})` : '';
  if (f.category === 'link_failed') {
    return `Your bounty was created on-chain${tx}, but the site could not record it. Do not create it again: reload in a minute, or check the transaction on Basescan.`;
  }
  if (f.category === 'reverted_onchain') {
    return `The transaction${tx} was mined but the contract rejected it${f.reason ? `: ${f.reason}` : ''}. Only gas was charged; the bounty amount stayed in your wallet.`;
  }
  if (txHash) {
    return `The transaction was sent${tx} but the site could not confirm it. Do not create it again: check the hash on Basescan.`;
  }
  switch (f.category) {
    case 'rejected_in_wallet':
      return 'Your wallet did not send the transaction (it was rejected in the wallet). Nothing was charged. Click Create Bounty to try again.';
    case 'insufficient_funds':
      return `Your wallet has too little ETH on ${networkName} for this bounty plus gas. Nothing was charged.`;
    case 'contract_would_revert':
      return `The contract would reject this bounty${f.reason ? `: ${f.reason}` : ''}. Nothing was sent or charged.`;
    case 'wrong_network':
      return `Your wallet is not on ${networkName}${chainId ? ` (it is on chain ${chainId})` : ''}. Switch networks in the wallet and try again. Nothing was charged.`;
    case 'wallet_prompt_pending':
      return 'Your wallet already has a request waiting. Open the wallet from its toolbar icon, finish or reject that request, then try again. Nothing was charged.';
    case 'wallet_timeout':
      return 'Your wallet did not answer. Open it from its toolbar icon to look for a waiting request. If it shows no new transaction, nothing was charged.';
    case 'wallet_or_rpc_error':
      return `Your wallet could not send the transaction: ${f.walletMessage || f.message}. If it shows no new transaction, nothing was charged.`;
    default:
      return `Creating the bounty failed at the ${f.step} step: ${f.message}. If your wallet shows no new transaction, nothing was charged.`;
  }
}

/**
 * What the account at `code` (eth_getCode) is. EIP-7702 accounts carry the
 * delegation designator 0xef0100 followed by the 20-byte delegate address.
 */
export function accountTypeFromCode(code) {
  if (typeof code !== 'string') return { accountType: 'unknown' };
  const c = code.toLowerCase();
  if (c === '0x' || c === '0x0') return { accountType: 'eoa' };
  if (c.startsWith('0xef0100') && c.length === 48) return { accountType: 'eip7702', delegate: `0x${c.slice(8)}` };
  return { accountType: 'contract' };
}
