import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Interface, Transaction, Wallet, ZeroAddress, parseEther } from 'ethers';
import { deployments, iface, erc20, ownerAddress, ownerTransferTokens, verifyOwnerTransfer, verifySignedOwnerTransfer } from '../_transaction-guards.js';
import { loadOwnerAddress, confirmOwnerChange, setOwnerAddress, recordedOwnerAddress, withdrawToOwner } from '../_owner.js';
import { runWithdraw } from '../withdraw_to_owner.js';

const scripts = fileURLToPath(new URL('..', import.meta.url));
const bot = new Wallet('0x' + '33'.repeat(32)); // Synthetic offline key, never funded.
const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
const link = ownerTransferTokens.base.LINK.address, d = deployments.base;
const l1Oracle = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
// The value cap is 1 wei on purpose: withdrawals to the owner are not limited by it.
const policy = { maxValueWei: '1', maxTotalWei: '10000000000000000', maxGasLimit: '100000', maxFeePerGasWei: '1000000000', maxPriorityFeePerGasWei: '100000000' };

async function tempDir(t, prefix) {
  const dir = await mkdtemp(`${tmpdir()}/${prefix}`); t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('owner transfers: ETH only to the owner, LINK only as an exact transfer to the owner', async () => {
  assert.equal(ownerAddress(owner.toUpperCase().replace('0X', '0x')), owner);
  for (const bad of [ZeroAddress, '0x123', '', null, '0x8ba1f109551bd432803012645Ac136ddd64DBA72']) assert.throws(() => ownerAddress(bad));
  const eth = { to: owner, value: 5n, data: '0x', chainId: 8453 }, expectEth = { network: 'base', owner, asset: 'ETH', amount: 5n };
  assert.deepEqual(verifyOwnerTransfer(eth, expectEth), eth);
  for (const bad of [{ ...eth, to: other }, { ...eth, value: 6n }, { ...eth, data: '0x00' }, { ...eth, chainId: 84532 }]) assert.throws(() => verifyOwnerTransfer(bad, expectEth));
  assert.throws(() => verifyOwnerTransfer({ ...eth, value: 0n }, { ...expectEth, amount: 0n }), /positive/);
  const data = erc20.encodeFunctionData('transfer', [owner, 7n]), tok = { to: link, value: 0n, data, chainId: 8453 }, expectLink = { network: 'base', owner, asset: 'LINK', amount: 7n };
  assert.equal(verifyOwnerTransfer(tok, expectLink).data, data);
  for (const bad of [{ ...tok, to: other }, { ...tok, value: 1n }, { ...tok, data: erc20.encodeFunctionData('transfer', [other, 7n]) }, { ...tok, data: new Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [owner, 7n]) }]) {
    assert.throws(() => verifyOwnerTransfer(bad, expectLink));
  }
  assert.throws(() => verifyOwnerTransfer(tok, { ...expectLink, asset: 'USDC' }), /No reviewed USDC token/);
  assert.throws(() => verifyOwnerTransfer({ ...tok, chainId: 84532, to: ownerTransferTokens['base-sepolia'].LINK.address }, expectLink));
});

test('a signed withdrawal is checked for signer and gas caps, but not the value cap', async () => {
  const tx = { type: 2, chainId: 8453, nonce: 0, gasLimit: 21000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, to: owner, value: parseEther('1'), data: '0x' };
  const expected = { network: 'base', owner, asset: 'ETH', amount: parseEther('1') }, raw = await bot.signTransaction(tx);
  assert.equal(verifySignedOwnerTransfer(raw, expected, bot.address, policy).to, owner);
  assert.throws(() => verifySignedOwnerTransfer(raw, expected, other, policy), /wrong signer/);
  for (const change of [{ gasLimit: 100001n }, { maxFeePerGas: 1000000001n }, { maxPriorityFeePerGas: 11n }, { type: 0, gasPrice: 10n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }]) {
    assert.throws(() => verifySignedOwnerTransfer(signed({ ...tx, ...change }), expected, bot.address, policy));
  }
  assert.throws(() => verifySignedOwnerTransfer(raw, expected, bot.address, { ...policy, maxTotalWei: '1000' }), /total cap/);
  assert.throws(() => verifySignedOwnerTransfer(raw, { ...expected, owner: other }, bot.address, policy), /destination/);
});
function signed(tx) { const t = Transaction.from(tx); t.signature = bot.signingKey.sign(t.unsignedHash); return t.serialized; }

test('the owner address is read from the stable file only; an exported override stops the withdrawal', async t => {
  const dir = await tempDir(t, 'verdikta-owner-'), file = `${dir}/.env`;
  const load = async (text, env = {}) => { await writeFile(file, text); return loadOwnerAddress({ file, env }); };
  assert.equal(await load(`VERDIKTA_NETWORK=base\nOFFBOT_ADDRESS=${owner}\n`), owner);
  assert.equal(await load(`OFFBOT_ADDRESS=${owner}\n`, { OFFBOT_ADDRESS: owner.toUpperCase().replace('0X', '0x') }), owner);
  assert.equal(await load(`OFFBOT_ADDRESS=${owner}\nexport OFFBOT_ADDRESS=${owner} # same value twice\n`), owner);
  await assert.rejects(load(`OFFBOT_ADDRESS=${owner}\n`, { OFFBOT_ADDRESS: other }), /differs from the owner address recorded/);
  await assert.rejects(load(`OFFBOT_ADDRESS=${owner}\nOFFBOT_ADDRESS=${other}\n`), /more than once/);
  await assert.rejects(load(`OFFBOT_ADDRESS=${ZeroAddress}\n`), /zero placeholder/);
  await assert.rejects(load('# OFFBOT_ADDRESS=0x1111111111111111111111111111111111111111\n'), /No owner withdrawal address is recorded/);
  await assert.rejects(load('OFFBOT_ADDRESS=0x8ba1f109551bd432803012645Ac136ddd64DBA72\n'), /Invalid owner address/);
  await assert.rejects(loadOwnerAddress({ file: `${dir}/missing.env`, env: {} }), /No owner withdrawal address is recorded/);
  assert.equal(recordedOwnerAddress(`OFFBOT_ADDRESS=${ZeroAddress}`), '');
});

test('recording an owner address is free the first time; changing it needs a terminal and confirmation', async t => {
  const logs = [], log = line => logs.push(line), answers = list => async () => list.shift();
  assert.equal(await confirmOwnerChange({ ask: answers([]), isTTY: false, recorded: '', next: owner.toLowerCase(), log }), owner);
  await assert.rejects(confirmOwnerChange({ ask: answers([]), isTTY: false, recorded: owner, next: other, log }), /Only the owner can change it/);
  await assert.rejects(confirmOwnerChange({ ask: answers(['nope']), isTTY: true, recorded: owner, next: other, log }), /Not confirmed/);
  assert.equal(await confirmOwnerChange({ ask: answers([other.slice(-6)]), isTTY: true, recorded: owner, next: other, log }), other);
  assert.equal(await confirmOwnerChange({ ask: answers([]), isTTY: false, recorded: owner, next: owner, log }), owner);

  const dir = await tempDir(t, 'verdikta-set-owner-'), file = `${dir}/config/.env`;
  await assert.rejects(setOwnerAddress({ ask: answers([owner]), isTTY: false, file, log }), /yourself in a terminal/);
  await assert.rejects(stat(file));
  assert.equal(await setOwnerAddress({ ask: answers([owner]), isTTY: true, file, log }), owner);
  assert.equal(await readFile(file, 'utf8'), `OFFBOT_ADDRESS=${owner}\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await setOwnerAddress({ ask: answers(['']), isTTY: true, file, log }), owner);
  await writeFile(file, `VERDIKTA_NETWORK=base\nOFFBOT_ADDRESS=${owner}\nexport OFFBOT_ADDRESS=${owner}\nBOT_NAME=x\n`);
  assert.equal(await setOwnerAddress({ ask: answers([other, other.slice(-6)]), isTTY: true, file, log }), other);
  assert.equal(await readFile(file, 'utf8'), `VERDIKTA_NETWORK=base\nOFFBOT_ADDRESS=${other}\nOFFBOT_ADDRESS=${other}\nBOT_NAME=x\n`);
  assert.equal(await loadOwnerAddress({ file, env: {} }), other);
});

function chain({ balance = parseEther('1'), linkBalance = 0n, owed = 0n, pending = 0, codes = {}, decimals = 18n, chainId = 8453n } = {}) {
  const sent = [], confirms = [], logs = [];
  const provider = {
    getNetwork: async () => ({ chainId }),
    getTransactionCount: async (_, tag) => 7 + (tag === 'pending' ? pending : 0),
    getBalance: async () => balance,
    getCode: async address => codes[address.toLowerCase()] ?? (address.toLowerCase() === link.toLowerCase() ? '0x1234' : '0x'),
    getFeeData: async () => ({ maxFeePerGas: 11000000n, maxPriorityFeePerGas: 1000000n }),
    estimateGas: async () => 40000n,
    call: async ({ to, data }) => {
      if (to.toLowerCase() === '0x420000000000000000000000000000000000000f') return l1Oracle.encodeFunctionResult('getL1Fee', [1000000000n]);
      if (to.toLowerCase() === d.address.toLowerCase()) return iface.encodeFunctionResult('withdrawable', [owed]);
      const fn = erc20.parseTransaction({ data }).name;
      return erc20.encodeFunctionResult(fn, [fn === 'decimals' ? decimals : linkBalance]);
    },
    broadcastTransaction: async raw => { sent.push(Transaction.from(raw)); return { hash: Transaction.from(raw).hash, wait: async () => ({ status: 1 }) }; },
  };
  const signer = { provider, getAddress: async () => bot.address, signTransaction: tx => bot.signTransaction(tx) };
  const opts = { network: 'base', owner, policy, confirm: async review => { confirms.push(review); }, log: line => logs.push(line) };
  return { signer, provider, opts, sent, confirms, logs };
}

test('withdraw --all sends the balance minus capped gas and the L1 fee reserve to the owner', async () => {
  const c = chain({ owed: parseEther('0.002') });
  assert.equal(await withdrawToOwner(c.signer, { ...c.opts, amount: 'all', dryRun: true }), null);
  assert.equal(c.sent.length + c.confirms.length, 0);
  assert.ok(c.logs.some(line => /escrow also holds 0\.002 ETH/.test(line)));
  await withdrawToOwner(c.signer, { ...c.opts, amount: 'all' });
  assert.equal(c.confirms.length, 1); assert.equal(c.sent.length, 1);
  const tx = c.sent[0], fees = 21000n * 11000000n + 2n * 1000000000n;
  assert.equal(tx.to, owner); assert.equal(tx.from, bot.address); assert.equal(tx.data, '0x'); assert.equal(tx.chainId, 8453n);
  assert.equal(tx.value, parseEther('1') - fees); assert.equal(tx.gasLimit, 21000n); assert.equal(tx.nonce, 7);
  assert.equal(tx.maxFeePerGas, 11000000n); assert.equal(tx.maxPriorityFeePerGas, 1000000n);
  assert.match(c.confirms[0][0], new RegExp(`to the owner address ${owner}`));
});

test('withdraw a fixed amount, LINK, or to a contract wallet; refuse what cannot be paid or checked', async () => {
  const fixed = chain();
  await withdrawToOwner(fixed.signer, { ...fixed.opts, amount: parseEther('0.25') });
  assert.equal(fixed.sent[0].value, parseEther('0.25'));
  const safe = chain({ codes: { [owner]: '0x6080' } });
  await withdrawToOwner(safe.signer, { ...safe.opts, amount: parseEther('0.25') });
  assert.equal(safe.sent[0].gasLimit, 50000n);
  const tokens = chain({ linkBalance: 123n });
  await withdrawToOwner(tokens.signer, { ...tokens.opts, asset: 'LINK', amount: 'all' });
  assert.equal(tokens.sent[0].to, link); assert.equal(tokens.sent[0].value, 0n);
  assert.equal(tokens.sent[0].data, erc20.encodeFunctionData('transfer', [owner, 123n]));
  const refusals = [
    [{}, { amount: parseEther('2') }, /exceeds the wallet balance/],
    [{}, { amount: parseEther('1') }, /Not enough ETH for this amount plus fees/],
    [{ balance: 100n }, { amount: 'all' }, /Not enough ETH/],
    [{ balance: 0n }, { amount: 'all' }, /holds no ETH/],
    [{ pending: 1 }, { amount: 'all' }, /unconfirmed transactions/],
    [{ chainId: 84532n }, { amount: 'all' }, /RPC chain does not match/],
    [{}, { amount: 'all', owner: bot.address }, /is this bot wallet/],
    [{}, { amount: 'all', policy: { ...policy, maxGasLimit: '20000' } }, /Gas limit exceeds owner cap/],
    [{ linkBalance: 5n, decimals: 6n }, { asset: 'LINK', amount: 'all' }, /does not match the reviewed token/],
    [{ linkBalance: 5n, codes: { [link.toLowerCase()]: '0x' } }, { asset: 'LINK', amount: 'all' }, /does not match the reviewed token/],
    [{ linkBalance: 5n, balance: 0n }, { asset: 'LINK', amount: 'all' }, /Not enough ETH for the fees/],
    [{}, { asset: 'USDC', amount: 'all' }, /Withdrawable assets on base: ETH, LINK/],
  ];
  for (const [state, change, error] of refusals) {
    const c = chain(state);
    await assert.rejects(withdrawToOwner(c.signer, { ...c.opts, ...change }), error);
    assert.equal(c.sent.length + c.confirms.length, 0, String(error));
  }
  const broken = chain();
  broken.provider.broadcastTransaction = async () => { throw new Error('network down'); };
  await assert.rejects(withdrawToOwner(broken.signer, { ...broken.opts, amount: 'all' }), /Broadcast uncertain for 0x[0-9a-f]{64}/);
});

test('the command has no destination option and reads the recorded address before unlocking the wallet', async () => {
  const calls = [];
  const lib = { getNetwork: () => 'base', providerFor: () => ({ destroy() {} }), loadSpendPolicy: async () => policy, isDryRun: () => true, confirmSpendOrExit: async () => {},
    loadWallet: async () => { calls.push('wallet'); return { connect: () => ({}) }; } };
  const owners = { SET_OWNER: 'node onboard.js --set-owner', loadOwnerAddress: async () => { calls.push('owner'); return owner; }, withdrawToOwner: async (_, o) => { calls.push(o); return null; } };
  for (const argv of [['--all', '--to', other], ['--all', `--to=${other}`], ['--amount', '1', '--destination', other], ['--all', '--owner', other]]) {
    await assert.rejects(runWithdraw(lib, owners, argv), /option: withdrawals go only to the owner address recorded at onboarding/);
  }
  for (const argv of [[], ['--all', '--amount', '1'], ['--amount', '-1'], ['--amount', 'abc'], ['--all', '--asset', 'USDC'], ['--all', '--extra']]) await assert.rejects(runWithdraw(lib, owners, argv), /Usage:|Unknown argument/);
  await assert.rejects(runWithdraw(lib, owners, ['--amount', '0']), /must be positive/);
  assert.equal(calls.length, 0);
  await runWithdraw(lib, owners, ['--amount', '0.5', '--asset', 'link', '--dry-run']);
  assert.deepEqual(calls.slice(0, 2), ['owner', 'wallet']);
  assert.equal(calls[2].amount, parseEther('0.5')); assert.equal(calls[2].asset, 'LINK'); assert.equal(calls[2].owner, owner);
  await assert.rejects(runWithdraw(lib, { ...owners, loadOwnerAddress: async () => { throw new Error('No owner withdrawal address is recorded'); } }, ['--all']), /No owner withdrawal address/);
  assert.equal(calls.filter(c => c === 'wallet').length, 1);
});

test('from the command line: no record or an exported override stops before the password; --set-owner refuses a pipe', async t => {
  const dir = await tempDir(t, 'verdikta-owner-cli-'), config = `${dir}/.config/verdikta-bounties`;
  await mkdir(config, { recursive: true });
  const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: scripts, encoding: 'utf8', timeout: 20000, input: '', env: { HOME: dir, PATH: process.env.PATH, ...env } });
  await writeFile(`${config}/.env`, 'VERDIKTA_NETWORK=base-sepolia\n', { mode: 0o600 });
  let r = run(['withdraw_to_owner.js', '--all', '--dry-run']);
  assert.equal(r.status, 1); assert.match(r.stderr, /No owner withdrawal address is recorded/);
  const text = `VERDIKTA_NETWORK=base-sepolia\nOFFBOT_ADDRESS=${owner}\n`;
  await writeFile(`${config}/.env`, text, { mode: 0o600 });
  r = run(['withdraw_to_owner.js', '--all', '--dry-run'], { OFFBOT_ADDRESS: other });
  assert.equal(r.status, 1); assert.match(r.stderr, /differs from the owner address recorded/);
  r = run(['withdraw_to_owner.js', '--all', '--to', other]);
  assert.equal(r.status, 1); assert.match(r.stderr, /There is no --to option/);
  r = run(['onboard.js', '--set-owner']);
  assert.equal(r.status, 1); assert.match(r.stderr, /yourself in a terminal/);
  assert.equal(await readFile(`${config}/.env`, 'utf8'), text);
});
