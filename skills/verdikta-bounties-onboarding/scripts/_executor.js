import fs from 'node:fs/promises';
import { Contract } from 'ethers';
import { abi, deployments, verifyDeployment, verifyTransaction, verifySignedTransaction, uint } from './_transaction-guards.js';
const approvedProviders = new WeakMap();
let reservedWei = 0n;
export async function preflightDeployment(network, provider, baseUrl) {
  const d = deployments[network];
  if (!d || `${baseUrl.replace(/\/+$/, '')}/api/docs` !== d.docsUrl) throw new Error('Use the reviewed network API origin');
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
export async function execute(signer, method, tx, { network, args, exactValueWei = 0n, policy, dryRun = false, confirm, onBroadcast, onSigned, review = [] }) {
  if (approvedProviders.get(signer.provider)?.network !== network) throw new Error('Deployment preflight required before signing');
  // Re-check live chain/code/docs even for the second transaction of a lifecycle.
  await preflightDeployment(network, signer.provider, deployments[network].docsUrl.replace(/\/api\/docs$/, ''));
  if (method === 'startPreparedSubmission') {
    const live = await new Contract(deployments[network].address, abi, signer.provider).requiredPrepay(args[0]);
    if (BigInt(exactValueWei) !== live) throw new Error('Prepay changed; stop and review a fresh start transaction');
  }
  const base = verifyTransaction(tx, { network, method, args, value: exactValueWei, maxValueWei: policy.maxValueWei });
  const estimate = await signer.estimateGas(base);
  let gasLimit = (estimate * 125n + 99n) / 100n;
  if (tx.gasLimit != null && uint(tx.gasLimit, 'API gas') > gasLimit) gasLimit = BigInt(tx.gasLimit);
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
  const signed = verifySignedTransaction(rawTransaction, { network, method, args, value: exactValueWei }, await signer.getAddress(), policy);
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
