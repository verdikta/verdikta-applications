// Pure transaction validation. No wallet, environment, API, or signing imports.
import { Interface, getAddress, ZeroAddress, parseEther, keccak256, Transaction } from 'ethers';
import abi from './bounty-escrow.abi.json' with { type: 'json' };
import deployments from './deployments.json' with { type: 'json' };
export { abi, deployments };
export const iface = new Interface(abi);
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
  const oracle = { maxOracleFee: uint(o.maxOracleFee, 'oracle fee'), alpha: uint(o.alpha, 'alpha', 1000n), estimatedBaseCost: uint(o.estimatedBaseCost, 'base cost'), maxFeeBasedScaling: uint(o.maxFeeBasedScaling, 'scaling', 1000n) };
  if (!oracle.maxOracleFee || oracle.estimatedBaseCost >= oracle.maxOracleFee || !oracle.maxFeeBasedScaling) throw new Error('Invalid oracle settings');
  const hours = Number(config.submissionWindowHours);
  if (!Number.isSafeInteger(hours) || hours <= 0 || !Number.isSafeInteger(hours * 3600) || BigInt(hours * 3600) <= window + 2n) throw new Error('Submission window must be whole hours');
  if (window % 3600n !== 0n) throw new Error('Creator assessment window must be whole hours');
  return { params: { requestedClass, threshold, targetHunter, creatorDeterminationPayment: creator, arbiterDeterminationPayment: arbiter, creatorAssessmentWindowSize: window, oracle }, value };
}
export function bindCreation(config, response, { recovery = false, apiCreatedAt } = {}) {
  const { params, value } = creationTerms(config);
  const job = response.job;
  if (!recovery && (job?.onChain || job?.txHash || response.message?.startsWith('Reusing existing job'))) throw new Error('Existing creation detected; reconcile its identity instead of funding a duplicate');
  if (!response.success || !job || job.jobId == null || !response.onChain?.transaction) throw new Error('API creation response drift');
  if (!/^[A-Za-z0-9]{46,100}$/.test(job.evaluationCid || '')) throw new Error('Invalid evaluation CID');
  const deadline = uint(job.submissionCloseTime, 'server deadline', (1n << 64n) - 1n);
  const opened = uint(job.submissionOpenTime, 'server open time');
  if (deadline - opened !== BigInt(Number(config.submissionWindowHours) * 3600)) throw new Error('Server deadline window drift');
  if (!recovery) {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const drift = opened - (apiCreatedAt == null ? now : uint(apiCreatedAt, 'local API creation time'));
    if (deadline - now <= params.creatorAssessmentWindowSize + 302n) throw new Error('Server deadline leaves less than five minutes for submissions before the assessment window');
    if (drift < -900n || drift > 900n) throw new Error('Server open time differs from the local clock at API creation by more than 15 minutes');
  }
  if (Number(job.threshold) !== Number(config.threshold)) throw new Error('Server threshold drift');
  return { params: { ...params, evaluationCid: job.evaluationCid, submissionDeadline: deadline }, value, transaction: response.onChain.transaction };
}
export function verifyTransaction(tx, { network, method, args, value = 0n, maxValueWei }) {
  const deployment = deployments[network];
  if (!deployment || Number(tx?.chainId) !== deployment.chainId) throw new Error('Transaction chain mismatch');
  if (getAddress(tx.to) !== getAddress(deployment.address)) throw new Error('Transaction destination mismatch');
  if (uint(tx.value, 'transaction value') !== BigInt(value)) throw new Error('Transaction value mismatch');
  if (maxValueWei == null || BigInt(value) > uint(maxValueWei, 'value cap')) throw new Error('Transaction exceeds value cap');
  // Exact re-encoding also rejects unexpected selectors, argument drift and trailing data.
  if (!method || !Array.isArray(args) || tx.data?.toLowerCase() !== iface.encodeFunctionData(method, args).toLowerCase()) throw new Error('Transaction calldata/ABI drift');
  return { to: deployment.address, data: tx.data, value: BigInt(value), chainId: deployment.chainId };
}
export async function verifyDeployment(network, provider, docs) {
  const d = deployments[network];
  if (!d || Number((await provider.getNetwork()).chainId) !== d.chainId || Number(docs?.contract?.chainId) !== d.chainId) throw new Error('Deployment chain mismatch');
  if (getAddress(docs.contract.address) !== getAddress(d.address)) throw new Error('Live destination drift; maintainer review required');
  const code = await provider.getCode(d.address);
  if (code === '0x' || keccak256(code) !== d.codeHash) throw new Error('Live contract bytecode drift');
  for (const name of ['createBounty', 'prepareSubmission', 'requiredPrepay']) {
    const signature = docs.contract.functions?.[name]?.signature;
    if (!signature || new Interface([`function ${signature}`]).getFunction(name).selector !== iface.getFunction(name).selector) throw new Error('Live ABI selector drift');
  }
  return d.address;
}

export function verifyCreatedBounty(bounty, expected, creator) {
  if (getAddress(bounty.creator) !== getAddress(creator)) throw new Error('Created bounty creator mismatch');
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'oracle') {
      for (const [field, term] of Object.entries(value)) if (BigInt(bounty.oracle[field]) !== term) throw new Error(`Created bounty oracle ${field} mismatch`);
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
