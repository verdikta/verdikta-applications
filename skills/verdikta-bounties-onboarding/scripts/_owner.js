// Owner withdrawals. Onboarding records the owner address (OFFBOT_ADDRESS in the stable configuration file) and it is
// the only destination: no option names another. It is read from that file, never from an exported variable, so a
// one-off override cannot redirect funds. The owner changes it with `node onboard.js --set-owner` in a terminal.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { Contract, Interface, Transaction, getAddress, formatEther, formatUnits } from 'ethers';
import { abi, deployments, erc20, ownerAddress, ownerTransferFields, ownerTransferTokens, verifySignedOwnerTransfer } from './_transaction-guards.js';

export const OWNER_ENV = 'OFFBOT_ADDRESS';
export const SET_OWNER = 'node onboard.js --set-owner';
// The file _env.js loads and onboarding writes.
export const ownerConfigFile = () => path.join(os.homedir(), '.config', 'verdikta-bounties', '.env');

function assigned(text) {
  const values = String(text).split(/\r?\n/).map(line => dotenv.parse(line)[OWNER_ENV]).filter(v => v !== undefined).map(v => v.trim());
  return { values, distinct: new Set(values.map(v => v.toLowerCase())).size };
}

// The recorded owner address, or '' when none (or only the zero placeholder or an invalid value) is recorded.
export function recordedOwnerAddress(text) {
  const { values, distinct } = assigned(text);
  try { return distinct === 1 ? ownerAddress(values[0]) : ''; } catch { return ''; }
}

export async function loadOwnerAddress({ file = ownerConfigFile(), env = process.env } = {}) {
  const { values, distinct } = assigned(await fs.readFile(file, 'utf8').catch(() => ''));
  const record = `The owner records one with \`${SET_OWNER}\` in their own terminal.`;
  if (distinct === 0) throw new Error(`No owner withdrawal address is recorded in ${file}. ${record}`);
  if (distinct > 1) throw new Error(`${file} sets ${OWNER_ENV} more than once with different values. ${record}`);
  let owner;
  try { owner = ownerAddress(values[0]); } catch (error) { throw new Error(`${error.message} (${OWNER_ENV} in ${file}). ${record}`); }
  const exported = env[OWNER_ENV];
  if (exported != null && exported.trim().toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`${OWNER_ENV} in the environment (${exported}) differs from the owner address recorded in ${file} (${owner}). Withdrawals go only to the recorded address: unset the variable, or the owner changes the record with \`${SET_OWNER}\`.`);
  }
  return owner;
}

// Checks a new owner address. Replacing a recorded one needs a terminal and the owner's confirmation.
export async function confirmOwnerChange({ ask, isTTY, recorded, next, log = console.log }) {
  const address = ownerAddress(next);
  if (!recorded || address === recorded) return address;
  if (!isTTY) throw new Error(`The recorded owner withdrawal address is ${recorded}. Only the owner can change it, in a terminal: run \`${SET_OWNER}\` yourself.`);
  log(`Changing the owner withdrawal address from ${recorded} to ${address}. Withdrawals will go only to the new address.`);
  if ((await ask(`Type the last 6 characters of ${address} to confirm: `)).trim().toLowerCase() !== address.slice(-6).toLowerCase()) throw new Error('Not confirmed; the owner address is unchanged.');
  return address;
}

// `onboard.js --set-owner`: shows the recorded address and records a new one. Only in a terminal, never through a pipe.
export async function setOwnerAddress({ ask, isTTY, file = ownerConfigFile(), log = console.log }) {
  if (!isTTY) throw new Error(`Run \`${SET_OWNER}\` yourself in a terminal: the owner address decides where withdrawals go, so it is not set through a pipe or by an agent.`);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const recorded = recordedOwnerAddress(text);
  log(recorded ? `Owner withdrawal address: ${recorded}` : 'No usable owner withdrawal address is recorded.');
  const answer = (await ask(`New owner withdrawal address 0x…${recorded ? ' (Enter keeps it)' : ''}: `)).trim();
  if (!answer && recorded) { log('Unchanged.'); return recorded; }
  const next = await confirmOwnerChange({ ask, isTTY, recorded, next: answer, log });
  if (next === recorded) { log('Unchanged.'); return recorded; }
  const line = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${OWNER_ENV}[ \\t]*=.*$`, 'gm');
  const body = line.test(text) ? text.replace(line, `${OWNER_ENV}=${next}`) : `${text.trimEnd()}${text.trim() ? '\n' : ''}${OWNER_ENV}=${next}`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${body.trimEnd()}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  log(`Recorded ${next} in ${file}. withdraw_to_owner.js sends only to this address.`);
  return next;
}

const L1_ORACLE = '0x420000000000000000000000000000000000000F'; // Base (OP Stack) GasPriceOracle predeploy
const l1Oracle = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const min = (...values) => values.reduce((a, b) => (b < a ? b : a));

// Base also charges an L1 data fee outside gasLimit * maxFeePerGas; reserve twice the oracle's estimate.
async function l1FeeReserve(provider, tx) {
  const data = l1Oracle.encodeFunctionData('getL1Fee', [Transaction.from(tx).unsignedSerialized]);
  return l1Oracle.decodeFunctionResult('getL1Fee', await provider.call({ to: L1_ORACLE, data }))[0] * 2n;
}

// amount: a positive bigint in the asset's base units, or 'all'. For ETH, 'all' leaves only the fee reserve behind.
export async function withdrawToOwner(signer, { network, owner, asset = 'ETH', amount, policy, dryRun = false, confirm, log = console.log }) {
  const deployment = deployments[network], provider = signer.provider;
  if (!deployment) throw new Error(`Unsupported network ${network}`);
  if ((await provider.getNetwork()).chainId !== BigInt(deployment.chainId)) throw new Error(`RPC chain does not match ${network}`);
  const from = getAddress(await signer.getAddress()), recipient = ownerAddress(owner);
  if (from === recipient) throw new Error(`The recorded owner address is this bot wallet; the owner records their own wallet with \`${SET_OWNER}\``);
  const token = asset === 'ETH' ? null : ownerTransferTokens[network]?.[asset];
  if (asset !== 'ETH' && !token) throw new Error(`Withdrawable assets on ${network}: ETH, ${Object.keys(ownerTransferTokens[network] ?? {}).join(', ')}`);
  const [nonce, pendingNonce, ethBalance] = await Promise.all([provider.getTransactionCount(from, 'latest'), provider.getTransactionCount(from, 'pending'), provider.getBalance(from)]);
  if (pendingNonce !== nonce) throw new Error('This wallet has unconfirmed transactions; wait for them (or reconcile saved state) before withdrawing');
  let balance = ethBalance;
  if (token) {
    const contract = new Contract(token.address, erc20, provider);
    if (await provider.getCode(token.address) === '0x' || await contract.decimals() !== BigInt(token.decimals)) throw new Error(`The ${asset} contract on ${network} does not match the reviewed token`);
    balance = await contract.balanceOf(from);
  } else {
    const owed = await new Contract(deployment.address, abi, provider).withdrawable(from).catch(() => 0n);
    if (owed > 0n) log(`The escrow also holds ${formatEther(owed)} ETH for this wallet; \`node recover_funds.js --withdraw\` moves it into the wallet first.`);
  }
  const units = v => `${token ? formatUnits(v, token.decimals) : formatEther(v)} ${asset}`;
  const all = amount === 'all', requested = all ? balance : amount;
  if (requested <= 0n) throw new Error(`This wallet holds no ${asset}`);
  if (requested > balance) throw new Error(`Requested ${units(requested)} exceeds the wallet balance of ${units(balance)}`);
  const fees = await provider.getFeeData(), feeCap = BigInt(policy.maxFeePerGasWei), tipCap = BigInt(policy.maxPriorityFeePerGasWei);
  const maxFeePerGas = min(feeCap, fees.maxFeePerGas ?? feeCap), maxPriorityFeePerGas = min(tipCap, fees.maxPriorityFeePerGas ?? tipCap, maxFeePerGas);
  const draft = ownerTransferFields({ network, owner: recipient, asset, amount: requested });
  // A value transfer to an account without code costs exactly 21000 gas; anything else is estimated with a margin.
  const gasLimit = !token && await provider.getCode(recipient) === '0x' ? 21000n : (await provider.estimateGas({ ...draft, from }) * 125n + 99n) / 100n;
  if (gasLimit > BigInt(policy.maxGasLimit)) throw new Error('Gas limit exceeds owner cap');
  if (gasLimit * maxFeePerGas > BigInt(policy.maxTotalWei)) throw new Error('Withdrawal gas exceeds owner total cap');
  const base = { type: 2, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas };
  const feeReserve = gasLimit * maxFeePerGas + await l1FeeReserve(provider, { ...base, ...draft });
  const value = !token && all ? balance - feeReserve : requested;
  if (value <= 0n || (token ? 0n : value) + feeReserve > ethBalance) throw new Error(`Not enough ETH for ${token ? 'the fees' : 'this amount plus fees'}: balance ${formatEther(ethBalance)} ETH, fees up to ${formatEther(feeReserve)} ETH`);
  const expected = { network, owner: recipient, asset, amount: value };
  const tx = { ...base, ...ownerTransferFields(expected) };
  const review = [
    `Withdraw ${units(value)} from bot wallet ${from} to the owner address ${recipient}.`,
    'That is the address recorded at onboarding; check that it is the owner\'s own wallet.',
    `Fees: at most ${formatEther(feeReserve)} ETH (capped gas plus twice Base's L1 data-fee estimate)${!token && all ? '; the unused part stays in the wallet' : ''}.`,
  ];
  log(JSON.stringify({ action: 'withdrawToOwner', network, asset, owner: recipient, from, ...tx, maxFeesWei: feeReserve, policy }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  if (dryRun) { for (const line of review) log(line); return null; }
  await confirm(review);
  const raw = await signer.signTransaction(tx);
  const signed = verifySignedOwnerTransfer(raw, expected, from, policy);
  log(`Signed withdrawal ${signed.hash}; keep this hash.`);
  let sent;
  try { sent = await provider.broadcastTransaction(raw); }
  catch (error) { throw new Error(`Broadcast uncertain for ${signed.hash}; look it up before retrying: ${error.message}`, { cause: error }); }
  if (sent.hash !== signed.hash) throw new Error(`RPC returned a different hash; look up ${signed.hash}`);
  const receipt = await sent.wait();
  if (receipt?.status !== 1) throw new Error(`Withdrawal not confirmed successful: ${sent.hash}`);
  log(`Withdrew ${units(value)} to ${recipient} in ${sent.hash}.`);
  return receipt;
}
