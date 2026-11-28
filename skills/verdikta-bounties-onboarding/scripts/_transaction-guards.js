// Pure transaction validation. No wallet, environment, API, or signing imports.
import { Interface, getAddress, ZeroAddress, parseEther, keccak256, Transaction } from 'ethers';
import abi from './bounty-escrow.abi.json' with { type: 'json' };
import deployments from './deployments.json' with { type: 'json' };
import presets from './_class-presets.cjs';
export { abi, deployments, presets };
export const iface = new Interface(abi);
// The two round steps that go to the escrow's aggregator (escrow.aggregator(), one for every jury size), not the escrow.
// Gas only, anyone may send.
export const aggregatorIface = new Interface(['function closeCommits(bytes32 aggId)', 'function promote(bytes32 aggId)']);
export const AGGREGATOR_METHODS = Object.freeze(['closeCommits', 'promote']);
/**
 * The reviewed BountyEscrow v2 deployment for a network. Until a maintainer records one in deployments.json (address +
 * runtime codeHash), every escrow script stops here: this version never reads, signs for or falls back to the v1 escrow.
 * The API origin (reviewedApiOrigin) and owner withdrawals need no escrow and keep working.
 */
export function escrowDeployment(network) {
  const d = deployments[network];
  if (!d) throw new Error(`Unsupported network ${network}`);
  if (d.status === 'NOT_DEPLOYED' || !d.address || !d.codeHash) {
    throw new Error(`BountyEscrow v2 is not deployed on ${network} yet: scripts/deployments.json holds a placeholder (no reviewed address or codeHash). Nothing was read, signed or sent. A maintainer must update deployments.json with the reviewed v2 deployment (address, runtime codeHash) first; this version never uses the v1 escrow`);
  }
  return d;
}
export const escrowAddress = (network) => getAddress(escrowDeployment(network).address);
// The bot API key and bounty data go only to the API origin reviewed for each network in deployments.json.
// An unset URL means that origin; any other URL is refused, so a changed .env cannot redirect the key.
export function reviewedApiOrigin(network, configured) {
  const docsUrl = deployments[network]?.docsUrl;
  if (!docsUrl) throw new Error(`No reviewed API origin for network ${network}`);
  const origin = docsUrl.replace(/\/api\/docs$/, '');
  if (configured && configured.trim().replace(/\/+$/, '') !== origin) throw new Error(`Use the reviewed network API origin ${origin}; refusing ${configured}`);
  return origin;
}
export const uint = (value, name, max = (1n << 256n) - 1n) => {
  if (!['string', 'number', 'bigint'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error(`${name} must be an exact integer`);
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`${name} must be an unsigned integer`);
  const n = BigInt(value);
  if (n > max) throw new Error(`${name} exceeds range`);
  return n;
};
export function targetFor(config) {
  if (config.procurementMode === 'OPEN') {
    if (config.targetHunter && getAddress(config.targetHunter) !== ZeroAddress) throw new Error('OPEN cannot specify a supplier');
    return ZeroAddress;
  }
  if (config.procurementMode !== 'TARGETED' || !config.targetHunter) throw new Error('Explicit OPEN or TARGETED procurementMode required');
  const target = getAddress(config.targetHunter);
  if (target === ZeroAddress) throw new Error('TARGETED requires a nonzero supplier');
  return target;
}
export function creationTerms(config) {
  if (typeof config.bountyAmount !== 'string' || ['creatorDeterminationPayment','arbiterDeterminationPayment'].some(k => config[k] != null && typeof config[k] !== 'string')) throw new Error('ETH amounts must be decimal strings');
  const targetHunter = targetFor(config);
  const requestedClass = uint(config.classId, 'classId', (1n << 64n) - 1n);
  const threshold = uint(config.threshold, 'threshold', 100n);
  const window = uint(config.creatorAssessmentWindowSeconds ?? 0, 'creator assessment window', (1n << 64n) - 1n);
  const creator = parseEther(String(config.creatorDeterminationPayment ?? config.bountyAmount));
  const arbiter = parseEther(String(config.arbiterDeterminationPayment ?? config.bountyAmount));
  if (creator <= 0n || arbiter <= 0n || creator >= 1n << 128n || arbiter >= 1n << 128n) throw new Error('Invalid determination payment');
  if (window === 0n && creator !== arbiter) throw new Error('No-window payments must be equal');
  const value = creator > arbiter ? creator : arbiter;
  if (parseEther(String(config.bountyAmount)) !== value) throw new Error('bountyAmount must equal maximum determination payment');
  const o = config.oracle;
  if (!o) throw new Error('Explicit oracle settings required');
  const decision = decisionTerms(config);
  const oracle = { maxOracleFee: uint(o.maxOracleFee, 'oracle fee'), alpha: uint(o.alpha, 'alpha', 1000n), estimatedBaseCost: uint(o.estimatedBaseCost, 'base cost'), maxFeeBasedScaling: uint(o.maxFeeBasedScaling, 'scaling', 1000n), minOracleFee: decision.minOracleFee, withBeacons: decision.withBeacons };
  if (!oracle.maxOracleFee || oracle.estimatedBaseCost >= oracle.maxOracleFee || !oracle.maxFeeBasedScaling) throw new Error('Invalid oracle settings');
  // A whole-hour window, or an exact deadline for terms that name a date (a wager's settlement deadline).
  let submissionDeadline = null;
  if (config.submissionDeadline != null) {
    if (config.submissionWindowHours != null) throw new Error('Use submissionDeadline or submissionWindowHours, not both');
    submissionDeadline = exactDeadline(config.submissionDeadline);
  } else {
    const hours = Number(config.submissionWindowHours);
    if (!Number.isSafeInteger(hours) || hours <= 0 || !Number.isSafeInteger(hours * 3600) || BigInt(hours * 3600) <= window + 2n) throw new Error('Submission window must be whole hours');
  }
  if (window % 3600n !== 0n) throw new Error('Creator assessment window must be whole hours');
  const { jury, quota, forfeitLine, bond } = decision;
  return { params: { requestedClass, threshold, targetHunter, creatorDeterminationPayment: creator, arbiterDeterminationPayment: arbiter, creatorAssessmentWindowSize: window, oracle, jury, quota, forfeitLine, bond }, value, submissionDeadline, decision };
}
const UINT96 = (1n << 96n) - 1n;
export const JURY_FIELDS = Object.freeze(['K', 'M', 'N', 'P', 'timeout']);
/**
 * The v2 decision settings (item 12's rule, item 15's size classes): the bounty's own jury { K, M, N, P, timeout }
 * (sent with every request to the escrow's one aggregator), pass quota Q, forfeit line R <= Q, hunter bond (wei), fee
 * floor oracle.minOracleFee (wei) and oracle.withBeacons. They start from a size-class preset (_class-presets.cjs, the
 * site's and API's): config.bountyClass, else the smallest class offered for bountyAmount at config.ethUsd, else
 * Bondless Small. Any of jury (an object with any of K, M, N, P, timeout, each over the preset's), quota, forfeitLine,
 * bond, oracle.minOracleFee and oracle.withBeacons in the config overrides the preset (through toBountyParams). A preset's USD bond or fee floor converts only at an
 * owner-reviewed config.ethUsd; without one, give the wei amount. Everything is sent to the API explicitly, so the
 * server never picks a class or an ETH price for this bounty.
 */
export function decisionTerms(config) {
  let key = config.bountyClass;
  if (key == null) {
    const ethUsd = config.ethUsd == null ? null : Number(config.ethUsd);
    key = ethUsd > 0 ? presets.presetForBounty(Number(config.bountyAmount) * ethUsd)?.key : 'bondless-small';
  }
  const preset = presets.presetByKey(key);
  if (!preset) throw new Error(`bountyClass must be one of ${presets.CLASS_PRESETS.map((c) => c.key).join(', ')}`);
  const o = config.oracle || {};
  const priced = (value, usd, name) => {
    if (value != null) return uint(value, name, UINT96);
    if (!usd) return 0n;
    if (!(Number(config.ethUsd) > 0)) throw new Error(`The ${preset.name} preset's ${name} is $${usd}: give ${name === 'bond' ? 'bond' : 'oracle.minOracleFee'} in wei, or an owner-reviewed ethUsd to convert it`);
    return presets.usdToWei(usd, config.ethUsd);
  };
  const juryOverride = config.jury;
  if (juryOverride != null && (typeof juryOverride !== 'object' || Array.isArray(juryOverride))) {
    throw new Error('jury is the bounty\'s own jury { K, M, N, P, timeout } (an aggregator index is no longer used): give an object, or leave it out for the preset\'s');
  }
  const unknown = Object.keys(juryOverride ?? {}).filter((k) => !JURY_FIELDS.includes(k));
  if (unknown.length) throw new Error(`jury has unknown field(s) ${unknown.join(', ')}: use ${JURY_FIELDS.join(', ')}`);
  // The creator's jury, Q and R over the preset's. The bond and fee floor are priced below, so any price serves here.
  const merged = presets.toBountyParams(preset.key, Number(config.ethUsd) > 0 ? config.ethUsd : 1, {
    jury: juryOverride ? { ...preset.jury, ...Object.fromEntries(Object.entries(juryOverride).filter(([, v]) => v != null)) } : undefined,
    quota: config.quota, forfeitLine: config.forfeitLine,
  });
  const jury = Object.fromEntries(JURY_FIELDS.map((f) => [f, uint(merged.jury[f], `jury.${f}`, f === 'timeout' ? (1n << 40n) - 1n : 255n)]));
  const quota = uint(merged.quota, 'quota', 255n), forfeitLine = uint(merged.forfeitLine, 'forfeitLine', 255n);
  // BountyEscrow.createBounty's jury rule (the aggregator's structural one); its live limits are checked per request.
  const { K, M, N, P } = jury;
  if (!(P >= 1n && P <= N && N <= M && M <= K && 2n * M > K && N <= 40n && (P !== 1n || N === 1n))) throw new Error(`jury ${K}/${M}/${N}/${P} must satisfy K >= M >= N >= P >= 1, 2M > K, N <= 40 and P >= 2 unless N = 1 (contract: "bad jury")`);
  if (jury.timeout < 1n) throw new Error('jury.timeout must be a positive number of seconds');
  if (quota < 1n || forfeitLine > quota) throw new Error('quota must be at least 1 and forfeitLine at most quota');
  if (quota > N) throw new Error(`quota ${quota} exceeds the jury's N (${N}) (contract: "bad quota")`);
  const withBeacons = o.withBeacons ?? preset.withBeacons;
  if (typeof withBeacons !== 'boolean') throw new Error('oracle.withBeacons must be true or false');
  return { bountyClass: preset.key, className: preset.name, jury, quota, forfeitLine, bond: priced(config.bond, preset.bondUsd, 'bond'), minOracleFee: priced(o.minOracleFee, preset.feeFloorUsd, 'fee floor'), withBeacons };
}
/** The /jobs/create fields for decisionTerms: every one explicit (wei as decimal strings). */
export function decisionBody(decision) {
  return { bountyClass: decision.bountyClass, jury: Object.fromEntries(JURY_FIELDS.map((f) => [f, Number(decision.jury[f])])), quota: Number(decision.quota), forfeitLine: Number(decision.forfeitLine), bond: decision.bond.toString(), oracleMinOracleFee: decision.minOracleFee.toString(), oracleWithBeacons: decision.withBeacons };
}
// Unix seconds, or ISO-8601 UTC ending in Z ("2026-10-22T00:00:00Z"). The server encodes this second exactly.
export function exactDeadline(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return BigInt(ms / 1000);
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^[0-9]+$/.test(value))) {
    const seconds = uint(value, 'submission deadline', (1n << 64n) - 1n);
    if (seconds >= 100000000000n) throw new Error('submissionDeadline looks like milliseconds; use unix seconds');
    return seconds;
  }
  throw new Error('submissionDeadline must be unix seconds or an ISO-8601 UTC time such as 2026-10-22T00:00:00Z');
}
export function bindCreation(config, response, { recovery = false, apiCreatedAt } = {}) {
  const { params, value, submissionDeadline: exact } = creationTerms(config);
  const job = response.job;
  if (!recovery && (job?.onChain || job?.txHash || response.message?.startsWith('Reusing existing job'))) throw new Error('Existing creation detected; reconcile its identity instead of funding a duplicate');
  if (!response.success || !job || job.jobId == null || !response.onChain?.transaction) throw new Error('API creation response drift');
  if (!/^[A-Za-z0-9]{46,100}$/.test(job.evaluationCid || '')) throw new Error('Invalid evaluation CID');
  const deadline = uint(job.submissionCloseTime, 'server deadline', (1n << 64n) - 1n);
  const opened = uint(job.submissionOpenTime, 'server open time');
  if (exact != null) { if (deadline !== exact) throw new Error('Server deadline differs from the exact submissionDeadline'); }
  else if (deadline - opened !== BigInt(Number(config.submissionWindowHours) * 3600)) throw new Error('Server deadline window drift');
  if (!recovery) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const drift = opened - (apiCreatedAt == null ? now : uint(apiCreatedAt, 'local API creation time'));
    if (deadline - now <= params.creatorAssessmentWindowSize + 302n) throw new Error('Server deadline leaves less than five minutes for submissions before the assessment window');
    if (drift < -900n || drift > 900n) throw new Error('Server open time differs from the local clock at API creation by more than 15 minutes');
  }
  if (Number(job.threshold) !== Number(config.threshold)) throw new Error('Server threshold drift');
  return { params: { ...params, evaluationCid: job.evaluationCid, submissionDeadline: deadline }, value, transaction: response.onChain.transaction };
}
// aggregator: for closeCommits / promote only, the aggregator as the reviewed escrow names it (escrow.aggregator()).
export function verifyTransaction(tx, { network, method, args, value = 0n, maxValueWei, aggregator = null }) {
  const deployment = escrowDeployment(network);
  if (Number(tx?.chainId) !== deployment.chainId) throw new Error('Transaction chain mismatch');
  const onAggregator = AGGREGATOR_METHODS.includes(method);
  if (onAggregator && !aggregator) throw new Error(`${method} goes to the bounty's aggregator; its address from escrow.aggregator() is required`);
  const to = getAddress(onAggregator ? aggregator : deployment.address);
  if (getAddress(tx.to) !== to) throw new Error('Transaction destination mismatch');
  if (uint(tx.value, 'transaction value') !== BigInt(value) || (onAggregator && BigInt(value) !== 0n)) throw new Error('Transaction value mismatch');
  if (maxValueWei == null || BigInt(value) > uint(maxValueWei, 'value cap')) throw new Error('Transaction exceeds value cap');
  // Exact re-encoding also rejects unexpected selectors, argument drift and trailing data.
  if (!method || !Array.isArray(args) || tx.data?.toLowerCase() !== (onAggregator ? aggregatorIface : iface).encodeFunctionData(method, args).toLowerCase()) throw new Error('Transaction calldata/ABI drift');
  return { to, data: tx.data, value: BigInt(value), chainId: deployment.chainId };
}
export async function verifyDeployment(network, provider, docs) {
  const d = escrowDeployment(network);
  if (Number((await provider.getNetwork()).chainId) !== d.chainId || Number(docs?.contract?.chainId) !== d.chainId) throw new Error('Deployment chain mismatch');
  if (getAddress(docs.contract.address) !== getAddress(d.address)) throw new Error('Live destination drift; maintainer review required');
  const code = await provider.getCode(d.address);
  if (code === '0x' || keccak256(code) !== d.codeHash) throw new Error('Live contract bytecode drift');
  // The v2 createBounty struct and startValue: a site still documenting the v1 escrow fails here.
  for (const name of DOCUMENTED_FUNCTIONS) {
    const signature = docs.contract.functions?.[name]?.signature;
    if (!signature || new Interface([`function ${signature}`]).getFunction(name).selector !== iface.getFunction(name).selector) throw new Error('Live ABI selector drift');
  }
  return d.address;
}

export const DOCUMENTED_FUNCTIONS = Object.freeze(['createBounty', 'prepareSubmission', 'requiredPrepay', 'startValue']);

export function verifyCreatedBounty(bounty, expected, creator) {
  if (getAddress(bounty.creator) !== getAddress(creator)) throw new Error('Created bounty creator mismatch');
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'oracle') {
      for (const [field, term] of Object.entries(value)) {
        const live = bounty.oracle[field];
        if (typeof term === 'boolean' ? Boolean(live) !== term : BigInt(live) !== term) throw new Error(`Created bounty oracle ${field} mismatch`);
      }
    } else if (key === 'jury') {
      // getBounty stores the jury flat: juryK, juryM, juryN, juryP, juryTimeout
      for (const [field, term] of Object.entries(value)) {
        const live = bounty[`jury${field[0].toUpperCase()}${field.slice(1)}`];
        if (live == null || BigInt(live) !== BigInt(term)) throw new Error(`Created bounty jury ${field} mismatch`);
      }
    } else if (key === 'targetHunter') {
      if (getAddress(bounty[key]) !== getAddress(value)) throw new Error('Created bounty target mismatch');
    } else if (typeof value === 'bigint' ? BigInt(bounty[key]) !== value : bounty[key] !== value) throw new Error(`Created bounty ${key} mismatch`);
  }
}

// Used both immediately after local signing and before rebroadcasting saved bytes.
export function verifySignedTransaction(raw, expected, creator, policy, hash) {
  const tx = Transaction.from(raw);
  if (!tx.isSigned() || getAddress(tx.from) !== getAddress(creator)) throw new Error('Saved transaction has wrong creator or no signature');
  if (hash && tx.hash !== hash) throw new Error('Saved transaction hash mismatch');
  verifyTransaction(tx, { ...expected, maxValueWei: policy.maxValueWei });
  if (tx.type !== 2 || tx.gasLimit > uint(policy.maxGasLimit, 'gas cap') ||
      tx.maxFeePerGas > uint(policy.maxFeePerGasWei, 'fee cap') ||
      tx.maxPriorityFeePerGas > uint(policy.maxPriorityFeePerGasWei, 'priority cap') ||
      tx.maxPriorityFeePerGas > tx.maxFeePerGas || tx.accessList?.length) throw new Error('Saved transaction exceeds gas/fee policy or changes transaction type');
  if (tx.value + tx.gasLimit * tx.maxFeePerGas > uint(policy.maxTotalWei, 'total cap')) throw new Error('Saved transaction exceeds total cap');
  return tx;
}

// Clearing before a close. closeExpiredBounty reverts "active evaluation - finalize first" while any submission is on
// the pending list (a round in flight, or awaiting a re-run), and in a wager only the opponent can submit, so a claim
// nobody resolved would hold the creator's refund. The creator of an open bounty past its deadline may resolve those
// claims with exactly these gas-only calls, none of which can change who wins: finalizeSubmission for a stored result
// that does not pass (past the deadline a soft fail cannot re-run, so it fails with the bond returned; a hard fail
// forfeits the bond to the creator), closeFailedRound for a round with no result that can get none, expireRerun for a
// re-run that can no longer happen. A close never finalizes a passing result (that pays the claimant).
export const CLEARING_METHODS = Object.freeze(['finalizeSubmission', 'closeFailedRound', 'expireRerun']);
/** getOracleResult().outcome (BountyRules.Outcome). */
export const OUTCOMES = Object.freeze(['NOT_READY', 'NO_RESULT', 'PASS', 'SOFT_FAIL', 'HARD_FAIL']);
export const outcomeName = (outcome) => OUTCOMES[Number(outcome)] ?? `UNKNOWN(${outcome})`;
/**
 * When a round that is still moving will have a result or can be closed (unix seconds), or null: its deadline once
 * drawn (settle is due after it), else a day after the request (an undrawn round can be cancelled by then).
 */
export function roundSettlesBy(result) {
  const deadline = Number(result?.deadline ?? 0), requested = Number(result?.requestTime ?? 0);
  if (deadline > 0) return deadline + 1;
  return requested > 0 ? requested + 86400 + 1 : null;
}
/** Throws unless signer created the bounty, it is open and chainNow (latest block time) is at or past its deadline. */
export function assertClearable({ bounty, signer, chainNow }) {
  if (getAddress(bounty.creator) !== getAddress(signer)) throw new Error(`Only the bounty's creator ${getAddress(bounty.creator)} clears its claims before a close; this wallet is ${getAddress(signer)}`);
  if (Number(bounty.status) !== 0) throw new Error('The bounty is no longer open');
  if (BigInt(chainNow) < BigInt(bounty.submissionDeadline)) throw new Error(`The bounty's deadline ${new Date(Number(bounty.submissionDeadline) * 1000).toISOString()} has not passed: it cannot be closed, or its claims cleared, before then`);
}
/**
 * The clearing call for one pending submission: { method } (one of CLEARING_METHODS), { wait, retryAfter } (its round
 * is still moving) or { stop } (the close cannot go ahead). next = nextAction(), result = getOracleResult() (v2 struct).
 * v1's "FINALIZE without a stored result" no longer exists: a round with no result that can get none is CLOSE_FAILED.
 */
export function clearingCall({ bounty, signer, chainNow, submissionId, next, result }) {
  assertClearable({ bounty, signer, chainNow });
  const id = `Submission ${submissionId}`;
  const passed = () => `${id} passed its evaluation (${result?.passCount ?? '?'} juror score(s) at or above threshold ${bounty.threshold}, quota ${bounty.quota ?? '?'}): finalizing it pays the claimant, so this bounty cannot be closed`;
  switch (next) {
    case 'CLOSE_FAILED': return { method: 'closeFailedRound' };
    case 'EXPIRE_RERUN': return { method: 'expireRerun' };
    case 'FINALIZE': {
      const outcome = outcomeName(result?.outcome);
      if (!result?.hasResult) return { stop: `${id}: nextAction is FINALIZE but its round reports no result; inspect it before closing` };
      if (outcome === 'PASS') return { stop: passed() };
      if (!['SOFT_FAIL', 'HARD_FAIL', 'NO_RESULT'].includes(outcome)) return { stop: `${id}: unexpected outcome ${outcome}` };
      return { method: 'finalizeSubmission', outcome };
    }
    case 'AWAIT_EARLIER': return { stop: passed() };
    case 'DRAW': case 'CLOSE_COMMITS': case 'PROMOTE': case 'AWAIT_ORACLE':
      return { wait: `${id} is still being evaluated (${next === 'AWAIT_ORACLE' ? 'its jury is working' : `its round waits for ${next}, which anyone may send with claim_bounty.js`})`, retryAfter: roundSettlesBy(result) };
    default: return { stop: `${id}: unexpected next action ${next}` };
  }
}

// Owner withdrawals: the only transactions not sent to the escrow. ETH goes straight to the owner address recorded at
// onboarding; LINK (left in older wallets by the retired swap) only as an exact transfer to it from the reviewed token.
export const ownerTransferTokens = {
  base: { LINK: { address: '0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196', decimals: 18 } },
  'base-sepolia': { LINK: { address: '0xE4aB69C077896252FAFBD49EFD26B5D171A32410', decimals: 18 } },
};
export const erc20 = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function transfer(address to, uint256 amount) returns (bool)']);
export function ownerAddress(value) {
  let address;
  try { address = getAddress(String(value ?? '').trim()); } catch { throw new Error(`Invalid owner address: ${value}`); }
  if (address === ZeroAddress) throw new Error('The owner address is the zero placeholder; no owner is recorded');
  return address;
}
// Needs only the network's chainId: withdrawals to the owner work before the v2 escrow is deployed.
export function ownerTransferFields({ network, owner, asset, amount }) {
  const deployment = deployments[network], recipient = ownerAddress(owner), value = uint(amount, 'withdrawal amount');
  if (!deployment) throw new Error(`Unsupported network ${network}`);
  if (value === 0n) throw new Error('Withdrawal amount must be positive');
  const token = asset === 'ETH' ? null : ownerTransferTokens[network]?.[asset];
  if (asset !== 'ETH' && !token) throw new Error(`No reviewed ${asset} token on ${network}`);
  return token
    ? { to: token.address, value: 0n, data: erc20.encodeFunctionData('transfer', [recipient, value]), chainId: deployment.chainId }
    : { to: recipient, value, data: '0x', chainId: deployment.chainId };
}
export function verifyOwnerTransfer(tx, expected) {
  const fields = ownerTransferFields(expected);
  if (Number(tx?.chainId) !== fields.chainId) throw new Error('Transaction chain mismatch');
  if (getAddress(tx.to) !== getAddress(fields.to)) throw new Error('Transaction destination mismatch');
  if (uint(tx.value, 'transaction value') !== fields.value) throw new Error('Transaction value mismatch');
  if ((tx.data || '0x').toLowerCase() !== fields.data.toLowerCase()) throw new Error('Transaction calldata mismatch');
  return fields;
}
// No value cap: the funds return to the owner. Gas, fee and total-execution caps still apply.
export function verifySignedOwnerTransfer(raw, expected, from, policy) {
  const tx = Transaction.from(raw);
  if (!tx.isSigned() || getAddress(tx.from) !== getAddress(from)) throw new Error('Signed withdrawal has the wrong signer or no signature');
  verifyOwnerTransfer(tx, expected);
  if (tx.type !== 2 || tx.gasLimit > uint(policy.maxGasLimit, 'gas cap') ||
      tx.maxFeePerGas > uint(policy.maxFeePerGasWei, 'fee cap') ||
      tx.maxPriorityFeePerGas > uint(policy.maxPriorityFeePerGasWei, 'priority cap') ||
      tx.maxPriorityFeePerGas > tx.maxFeePerGas || tx.accessList?.length) throw new Error('Signed withdrawal exceeds gas/fee policy or changes transaction type');
  if (tx.gasLimit * tx.maxFeePerGas > uint(policy.maxTotalWei, 'total cap')) throw new Error('Signed withdrawal exceeds total cap');
  return tx;
}
