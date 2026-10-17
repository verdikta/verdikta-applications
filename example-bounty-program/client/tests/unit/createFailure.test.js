import test from 'node:test';
import assert from 'node:assert/strict';
import { makeError } from 'ethers';
import { classifyCreateFailure, describeCreateFailure, accountTypeFromCode } from '../../src/utils/createFailure.js';

// Error shapes as ethers v6 builds them (makeError is what its providers call).
const rejected = () => makeError('user rejected action', 'ACTION_REJECTED', {
  action: 'sendTransaction', reason: 'rejected',
  info: { error: { code: 4001, message: 'ethers-user-denied: MetaMask Tx Signature: User denied transaction signature.' },
    payload: { method: 'eth_sendTransaction', params: [{ data: '0x61bdd800' }] } },
});
// contractService rethrows a rejection as its own Error, keeping the original.
const rejectedRethrown = () => Object.assign(new Error('Transaction rejected by user', { cause: rejected() }), { code: 'ACTION_REJECTED' });
const revert = () => makeError('execution reverted: "deadline in past"', 'CALL_EXCEPTION', {
  action: 'call', reason: 'deadline in past', data: '0x08c379a0', revert: { name: 'Error', signature: 'Error(string)', args: ['deadline in past'] },
});
const insufficient = () => makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', {
  info: { error: { code: -32000, message: 'insufficient funds for gas * price + value: have 1300000000000 want 4200000000000000' } },
});
const nonce = () => makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: -32603, message: 'nonce too high' } });
const badData = () => makeError('could not decode result data', 'BAD_DATA', { value: '0x', info: { method: 'createBounty' } });
const pending = () => Object.assign(new Error("Request of type 'eth_sendTransaction' already pending"), { code: -32002 });
const timeout = () => Object.assign(new Error('wallet request timed out after 60s'), { code: 'VERDIKTA_TIMEOUT' });
const axiosLink = () => Object.assign(new Error('Request failed with status code 503'), {
  isAxiosError: true, code: 'ERR_BAD_RESPONSE',
  response: { status: 503, data: { success: false, error: 'Receipt not found yet', code: 'ONCHAIN_TX_NOT_FOUND' } },
});

const TX = '0x' + 'ab'.repeat(32);

test('ACTION_REJECTED with info.error.code 4001 (raw and as contractService rethrows it)', () => {
  for (const err of [rejected(), rejectedRethrown()]) {
    const f = classifyCreateFailure(err, 'send');
    assert.equal(f.category, 'rejected_in_wallet');
    assert.equal(f.code, 'ACTION_REJECTED');
    assert.equal(f.rpcCode, 4001);
    // The wallet's words only: ethers' prefix stripped, no request payload.
    assert.equal(f.walletMessage, 'MetaMask Tx Signature: User denied transaction signature.');
    assert.match(describeCreateFailure(f), /rejected in the wallet\). Nothing was charged/);
  }
});

test('CALL_EXCEPTION "deadline in past": pre-check vs mined revert', () => {
  const pre = classifyCreateFailure(revert(), 'staticCall');
  assert.equal(pre.category, 'contract_would_revert');
  assert.equal(pre.reason, 'deadline in past');
  assert.equal(describeCreateFailure(pre), 'The contract would reject this bounty: deadline in past. Nothing was sent or charged.');
  // contractService turns a known revert into a friendly Error with the original as cause.
  const friendly = classifyCreateFailure(new Error('The deadline is in the past', { cause: revert() }), 'staticCall');
  assert.equal(friendly.category, 'contract_would_revert');
  assert.equal(friendly.reason, 'deadline in past');
  const mined = classifyCreateFailure(revert(), 'wait');
  assert.equal(mined.category, 'reverted_onchain');
  assert.match(describeCreateFailure(mined, { txHash: TX }), /mined but the contract rejected it: deadline in past\. Only gas was charged/);
});

test('INSUFFICIENT_FUNDS', () => {
  const f = classifyCreateFailure(insufficient(), 'send');
  assert.equal(f.category, 'insufficient_funds');
  assert.equal(f.rpcCode, -32000);
  assert.match(f.walletMessage, /have 1300000000000/);
  assert.match(describeCreateFailure(f, { networkName: 'Base Mainnet' }), /too little ETH on Base Mainnet for this bounty plus gas/);
});

test('UNKNOWN_ERROR wrapping -32603 "nonce too high" keeps the nested message', () => {
  const f = classifyCreateFailure(nonce(), 'send');
  assert.equal(f.category, 'wallet_or_rpc_error');
  assert.equal(f.code, 'UNKNOWN_ERROR');
  assert.equal(f.rpcCode, -32603);
  assert.equal(f.walletMessage, 'nonce too high');
  assert.match(describeCreateFailure(f), /could not send the transaction: nonce too high/);
});

test('BAD_DATA with value "0x" means no contract at that address on this chain', () => {
  const f = classifyCreateFailure(badData(), 'staticCall');
  assert.equal(f.category, 'wrong_network');
  assert.equal(classifyCreateFailure(new Error('x'), 'staticCall', { chainId: 1, expectedChainId: 8453 }).category, 'wrong_network');
  assert.match(describeCreateFailure(f, { networkName: 'Base Mainnet', chainId: 1 }), /not on Base Mainnet \(it is on chain 1\)/);
});

test('-32002 prompt already pending', () => {
  const f = classifyCreateFailure(pending(), 'connect');
  assert.equal(f.category, 'wallet_prompt_pending');
  assert.equal(f.rpcCode, -32002);
});

test('VERDIKTA_TIMEOUT', () => {
  const f = classifyCreateFailure(timeout(), 'connect');
  assert.equal(f.category, 'wallet_timeout');
  assert.equal(f.code, 'VERDIKTA_TIMEOUT');
});

test('a plain axios error from the link step', () => {
  const f = classifyCreateFailure(axiosLink(), 'link');
  assert.equal(f.category, 'link_failed');
  assert.equal(f.reason, 'Receipt not found yet');
  assert.match(describeCreateFailure(f, { txHash: TX }), new RegExp(`created on-chain \\(${TX}\\), but the site could not record it\\. Do not create it again`));
});

test('a hash in hand overrides "nothing was charged"', () => {
  const f = classifyCreateFailure(timeout(), 'wait');
  assert.match(describeCreateFailure(f, { txHash: TX }), /was sent \(0x(ab)+\) but the site could not confirm it\. Do not create it again/);
});

test('an unrecognised error says which step and keeps the raw text', () => {
  const f = classifyCreateFailure('boom', 'send');
  assert.equal(f.category, 'unknown');
  assert.equal(f.message, 'boom');
  assert.match(describeCreateFailure(f), /failed at the send step: boom/);
});

test('strings are clipped to 500 characters', () => {
  const f = classifyCreateFailure(makeError('x'.repeat(2000), 'UNKNOWN_ERROR', { error: { code: -32603, message: 'y'.repeat(2000) } }), 'send');
  assert.equal(f.message.length, 500);
  assert.equal(f.walletMessage.length, 500);
});

test('accountTypeFromCode recognises EIP-7702 delegation', () => {
  assert.deepEqual(accountTypeFromCode('0x'), { accountType: 'eoa' });
  assert.deepEqual(accountTypeFromCode('0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b'),
    { accountType: 'eip7702', delegate: '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b' });
  assert.deepEqual(accountTypeFromCode('0x6080604052'), { accountType: 'contract' });
  assert.deepEqual(accountTypeFromCode(undefined), { accountType: 'unknown' });
});
