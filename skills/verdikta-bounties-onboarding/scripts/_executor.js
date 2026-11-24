import fs from 'node:fs/promises';
import { Contract, getAddress } from 'ethers';
import { abi, deployments, escrowDeployment, verifyDeployment, verifyTransaction, verifySignedTransaction, uint, AGGREGATOR_METHODS } from './_transaction-guards.js';
const approvedProviders = new WeakMap();
let reservedWei = 0n;
// closeFailedRound settles (or cancels) the round on the aggregator inside a try/catch: one outcome per juror plus the
// prepay refund, well over 1.5M gas on a large jury. Below what settle needs, the inner call runs out of gas, the catch
// swallows it and the transaction fails with no revert reason, although estimateGas passed (the server sizes it the same
// way: RESOLVE_GAS_LIMIT_FALLBACK). So its limit never drops below this floor; unused gas is not charged.
export const MIN_GAS_LIMIT = Object.freeze({ closeFailedRound: 2_500_000n });
// The live value each payable call must attach: a first start takes the prepay plus the hunter bond, a re-run the prepay.
const LIVE_VALUE = Object.freeze({ startPreparedSubmission: 'startValue', rerunSubmission: 'requiredPrepay' });
export async function preflightDeployment(network, provider, baseUrl) {
  const d = escrowDeployment(network);
  if (`${baseUrl.replace(/\/+$/, '')}/api/docs` !== d.docsUrl) throw new Error('Use the reviewed network API origin');
  const res = await fetch(d.docsUrl, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw new Error('Live docs unavailable');
  let text = '';
  for await (const chunk of res.body) { text += new TextDecoder().decode(chunk); if (text.length > 1000000) throw new Error('Docs too large'); }
  const address = await verifyDeployment(network, provider, JSON.parse(text));
  approvedProviders.set(provider, { network });
  return address;
}
export async function loadSpendPolicy() {
  const file = process.env.VERDIKTA_SPEND_POLICY;
  if (!file) throw new Error('Set VERDIKTA_SPEND_POLICY to an owner-reviewed policy file; --yes cannot bypass caps');
  const p = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const field of ['maxValueWei','maxTotalWei','maxGasLimit','maxFeePerGasWei','maxPriorityFeePerGasWei']) uint(p[field], field);
  if (!BigInt(p.maxGasLimit) || !BigInt(p.maxFeePerGasWei) || BigInt(p.maxPriorityFeePerGasWei) > BigInt(p.maxFeePerGasWei)) throw new Error('Invalid gas policy');
  return Object.fromEntries(['maxValueWei', 'maxTotalWei', 'maxGasLimit', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei'].map(key => [key, p[key]]));
}
// round = { bountyId, submissionId } for closeCommits / promote: they go to the escrow's aggregator, which is read here
// from the reviewed escrow (aggregator()), with the round's aggregation id, never taken from the caller or the API.
export async function execute(signer, method, tx, { network, args, exactValueWei = 0n, policy, dryRun = false, confirm, onBroadcast, onSigned, review = [], round = null }) {
  if (approvedProviders.get(signer.provider)?.network !== network) throw new Error('Deployment preflight required before signing');
  // Re-check live chain/code/docs even for the second transaction of a lifecycle.
  await preflightDeployment(network, signer.provider, deployments[network].docsUrl.replace(/\/api\/docs$/, ''));
  const escrow = new Contract(escrowDeployment(network).address, abi, signer.provider);
  if (LIVE_VALUE[method]) {
    const live = await escrow[LIVE_VALUE[method]](args[0]);
    if (BigInt(exactValueWei) !== live) throw new Error(`${method === 'rerunSubmission' ? 'Prepay' : 'Start value (prepay + bond)'} changed; stop and review a fresh transaction`);
  }
  let aggregator = null;
  if (AGGREGATOR_METHODS.includes(method)) {
    if (round?.bountyId == null || round?.submissionId == null) throw new Error(`${method} needs the bounty and submission whose round it moves`);
    const [address, submission] = await Promise.all([escrow.aggregator(), escrow.getSubmission(round.bountyId, round.submissionId)]);
    if (String(args[0]).toLowerCase() !== String(submission.verdiktaAggId).toLowerCase()) throw new Error(`${method}: the aggregation id is not this submission's current round`);
    aggregator = getAddress(address);
  }
  const base = verifyTransaction(tx, { network, method, args, value: exactValueWei, maxValueWei: policy.maxValueWei, aggregator });
  const estimate = await signer.estimateGas(base);
  let gasLimit = (estimate * 125n + 99n) / 100n;
  if (tx.gasLimit != null && uint(tx.gasLimit, 'API gas') > gasLimit) gasLimit = BigInt(tx.gasLimit);
  if (MIN_GAS_LIMIT[method] && gasLimit < MIN_GAS_LIMIT[method]) gasLimit = MIN_GAS_LIMIT[method];
  // Name the limit this call needs and the file that caps it, so the owner can decide (an evaluation start on a
  // two-juror class used 3.26M gas on Base Sepolia, with a 4.15M limit).
  if (gasLimit > BigInt(policy.maxGasLimit)) throw new Error(`Gas limit exceeds owner cap: ${method} needs a gas limit of ${gasLimit}, and maxGasLimit is ${policy.maxGasLimit} in the spend policy ${process.env.VERDIKTA_SPEND_POLICY || '(VERDIKTA_SPEND_POLICY)'}. Nothing was signed. Ask the owner to raise maxGasLimit to at least ${gasLimit} (see references/commission.md, spend policy) or stop`);
  const maxFeePerGas = BigInt(policy.maxFeePerGasWei), maxPriorityFeePerGas = BigInt(policy.maxPriorityFeePerGasWei);
  const reserve = base.value + gasLimit * maxFeePerGas;
  if (reservedWei + reserve > BigInt(policy.maxTotalWei)) throw new Error(`Run total exceeds owner cap: ${method} reserves ${reserve} wei (value + gas limit ${gasLimit} x maxFeePerGasWei ${maxFeePerGas}), ${reservedWei} wei are already reserved in this run, and maxTotalWei is ${policy.maxTotalWei} in the spend policy ${process.env.VERDIKTA_SPEND_POLICY || '(VERDIKTA_SPEND_POLICY)'}. Nothing was signed. Ask the owner to raise maxTotalWei to at least ${reservedWei + reserve} (see references/commission.md, spend policy) or stop`);
  console.log(JSON.stringify({ method, review, ...base, gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxExecutionCostWei: reserve, policy }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  if (dryRun) return null;
  await confirm([...review, 'Review exact destination, chain, value, calldata and caps above. Base L1 data fees are additional; keep a funded reserve.']);
  const populated = await signer.populateTransaction({ ...base, type: 2, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
  const rawTransaction = await signer.signTransaction(populated);
  const signed = verifySignedTransaction(rawTransaction, { network, method, args, value: exactValueWei, aggregator }, await signer.getAddress(), policy);
  // Save recoverable signed bytes BEFORE transport, including insufficient-funds errors.
  if (onSigned) await onSigned({ rawTransaction, hash: signed.hash });
  reservedWei += reserve;
  console.log(`Signed transaction ${signed.hash}; retain this hash and recovery state. Do not recreate the job.`);
  let sent;
  try { sent = await signer.provider.broadcastTransaction(rawTransaction); }
  catch (error) { throw new Error(`Broadcast uncertain for ${signed.hash}; ${onSigned ? 'use saved state to resume the same transaction' : 'retain this hash and reconcile chain state before retrying'}: ${error.message}`, { cause: error }); }
  if (sent.hash !== signed.hash) throw new Error(`RPC returned a different hash; recover ${signed.hash} from saved state`);
  if (onBroadcast) await onBroadcast(sent.hash);
  const receipt = await sent.wait();
  if (receipt?.status !== 1) throw new Error(`Transaction not confirmed successful: ${sent.hash}`);
  return receipt;
}
