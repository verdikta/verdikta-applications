// Node P25: a maker whose wallet has code. The testnet maker's account holds an EIP-7702 delegation designator
// (0xef0100 and a delegate's address), so eth_getCode answers something other than 0x, and its owner signs with the
// account's own key (EIP-191 personal_sign). Every check of a maker's signature the server makes takes that
// signature as ordinary ECDSA: the control proof's signatureCheck recovers it before it reads any code, so no
// isValidSignature is asked and the result says it is no contract's; the wallet sign-in, which the listing request
// and the maker's scan go through, reads no chain at all. The key is made here, and the chain is a stub that records
// every read.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Interface, Wallet, getAddress } from 'ethers';
import { LIST_ACTION } from '@verdikta/stake-attestation-shared/auth-message';

import { createWalletAuth } from '../src/auth/walletAuth.js';
import { EIP1271_MAGIC, checkDeploymentProof } from '../src/control/deployment.js';
import { controlMessage, controlProof } from '../src/control/facts.js';
import { fakeBuilder, listingRequest } from './helpers/fixtures.js';
import { startApi } from './helpers/http.js';

const CHAIN_ID = 84532;
const BLOCK = 100;
const DEPLOYMENT = getAddress('0x00000000000000000000000000000000000c0de1');
const STAKE = getAddress('0x00000000000000000000000000000000000057ac');
const OWNER_SELECTOR = new Interface(['function owner() view returns (address)']).getFunction('owner').selector;
// isValidSignature(bytes32,bytes)'s selector is EIP-1271's magic value
const IS_VALID_SIGNATURE = EIP1271_MAGIC;

/** 0xef0100 and a 20-byte delegate: what eth_getCode answers for an account with a 7702 delegation. */
const designator = () => `0xef0100${Wallet.createRandom().address.slice(2).toLowerCase()}`;

/**
 * The listing's chain: `delegated` holds a 7702 designator, the deployment has code and answers owner() with
 * `owner`, and isValidSignature answers `contractAnswer`. Every read is kept in `reads`.
 */
function chainStub({ delegated, code = designator(), owner = delegated, contractAnswer = '0x' }) {
  const reads = [];
  return {
    reads,
    code,
    send: async (method) => { reads.push({ send: method }); return `0x${CHAIN_ID.toString(16)}`; },
    getBlockNumber: async () => { reads.push({ getBlockNumber: true }); return BLOCK; },
    getCode: async (address) => {
      reads.push({ getCode: address });
      if (address === delegated) return code;
      return address === DEPLOYMENT ? '0x6080604052' : '0x';
    },
    call: async ({ to, data }) => {
      reads.push({ call: to, selector: data.slice(0, 10) });
      if (data.startsWith(OWNER_SELECTOR)) return `0x${'0'.repeat(24)}${owner.slice(2).toLowerCase()}`;
      if (data.startsWith(IS_VALID_SIGNATURE)) return contractAnswer;
      return '0x';
    },
    getTransaction: async (hash) => { reads.push({ getTransaction: hash }); return null; },
    getTransactionReceipt: async (hash) => { reads.push({ getTransactionReceipt: hash }); return null; },
  };
}

const askedIsValidSignature = (reads) => reads.some((r) => r.selector === IS_VALID_SIGNATURE);
const readCodeOf = (reads, address) => reads.some((r) => r.getCode === address);

describe('the control proof\'s signatureCheck, for a wallet with a 7702 designator', () => {
  test('the stub says what the chain says of the testnet maker: the wallet has code, a designator', async () => {
    const wallet = Wallet.createRandom();
    const chain = chainStub({ delegated: wallet.address });
    assert.match(await chain.getCode(wallet.address, BLOCK), /^0xef0100[0-9a-f]{40}$/);
  });

  test('its own key\'s signature is ordinary ECDSA: valid, no contract\'s, its code never read, no isValidSignature', async () => {
    const wallet = Wallet.createRandom();
    const chain = chainStub({ delegated: wallet.address });
    const message = 'Verdikta stake attestation: any message';
    const r = await controlProof.signatureCheck(chain, { message, signer: wallet.address, signature: await wallet.signMessage(message), blockTag: BLOCK });
    assert.deepEqual(r, { valid: true, contract: false });
    assert.deepEqual(chain.reads, [], 'ECDSA first: nothing on the chain is read');
  });

  test('a signature its key did not make goes to EIP-1271, as for any signer with code: unchanged', async () => {
    const wallet = Wallet.createRandom();
    const message = 'Verdikta stake attestation: any message';
    const signature = await Wallet.createRandom().signMessage(message);

    const no = chainStub({ delegated: wallet.address, contractAnswer: `0x${'0'.repeat(64)}` });
    assert.deepEqual(await controlProof.signatureCheck(no, { message, signer: wallet.address, signature, blockTag: BLOCK }), { valid: false, contract: true });
    assert.ok(readCodeOf(no.reads, wallet.address));
    assert.ok(askedIsValidSignature(no.reads));

    const yes = chainStub({ delegated: wallet.address, contractAnswer: `${EIP1271_MAGIC}${'0'.repeat(56)}` });
    assert.deepEqual(await controlProof.signatureCheck(yes, { message, signer: wallet.address, signature, blockTag: BLOCK }), { valid: true, contract: true });
  });
});

describe('a contract listing whose owner is a wallet with a 7702 designator', () => {
  test('the owner signs the listing\'s message with its own key: it counts as the owner\'s, contractSigner false, no isValidSignature', async () => {
    const wallet = Wallet.createRandom();
    const chain = chainStub({ delegated: wallet.address });
    const message = controlMessage({ maker: wallet.address, artifactHash: `0x${'ab'.repeat(32)}`, chainId: String(CHAIN_ID), address: DEPLOYMENT, stakeChainId: CHAIN_ID, stakeContract: STAKE });
    const r = await checkDeploymentProof(chain, { message, chainId: String(CHAIN_ID), address: DEPLOYMENT, signer: wallet.address, signature: await wallet.signMessage(message), creationTx: null });
    assert.deepEqual(r, { ok: true, role: 'owner', contractSigner: false, block: BLOCK });
    assert.equal(askedIsValidSignature(chain.reads), false, 'no EIP-1271 call');
    assert.equal(readCodeOf(chain.reads, wallet.address), false, 'ECDSA first: the wallet\'s code is never read');
    assert.ok(readCodeOf(chain.reads, DEPLOYMENT), 'the deployment\'s code is read, as for any listing');
  });
});

describe('the site\'s sign-in, for a wallet with a 7702 designator', () => {
  // the sign-in takes no chain: what code the wallet holds cannot reach it, and these show it takes such a wallet's
  // signature as any wallet's
  test('the maker signs a challenge for each action with its own key: accepted, as its own address', async () => {
    const wallet = Wallet.createRandom();
    const auth = createWalletAuth();
    for (const [action, resource] of [
      ['read-scan', `listing:${'0'.repeat(32)}`],
      ['pin-dispute', 'claim:1'],
      [LIST_ACTION, `list-request:${crypto.createHash('sha256').update('a request').digest('hex')}`],
    ]) {
      const c = auth.challenge({ action, resource, address: wallet.address });
      const r = auth.verify({ action, resource, nonce: c.nonce, signature: await wallet.signMessage(c.message) });
      assert.deepEqual(r, { ok: true, address: wallet.address, issuedAt: c.issuedAt, expiresAt: c.expiresAt }, action);
    }
  });

  describe('the listing request, through the API', () => {
    const servers = [];
    after(() => Promise.all(servers.map((s) => s.close())));

    test('a repository listing naming that wallet as its maker, signed with its key: the request is taken and built', async () => {
      const wallet = Wallet.createRandom();
      const builder = fakeBuilder();
      const s = await startApi({ builder });
      servers.push(s);
      const res = await s.submit(listingRequest({ maker: wallet.address }), { wallet });
      const json = await res.json();
      assert.equal(res.status, 202, JSON.stringify(json));
      const view = await s.settle(json.id);
      assert.equal(view.status, 'ready', JSON.stringify(view.error));
      assert.equal(builder.calls.length, 1);
      assert.equal(builder.calls[0].maker, wallet.address);
    });
  });
});
