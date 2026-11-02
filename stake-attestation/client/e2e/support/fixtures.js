// What the Playwright tests share: the stack (stack.mjs wrote .e2e/stack.json), the chain from
// the test's side (the hunter's commit and disclose, the maker's listing, time), the injected
// test wallet, a recorder of every request the browser makes, and the screenshots for the PR.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { test as base, expect } from '@playwright/test';
import { Contract, JsonRpcProvider } from 'ethers';
import disclosure from '@verdikta/common/src/codeReview/disclosure.js';
import codec from '@verdikta/common/src/codeReview/disclosureCodec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '..', '..');
const SERVER = path.resolve(CLIENT, '..', 'server');
export const STACK_FILE = path.join(CLIENT, '.e2e', 'stack.json');
const SCREENSHOTS = path.join(CLIENT, 'test-results', 'screenshots');

export { expect };
export const readStack = () => JSON.parse(fs.readFileSync(STACK_FILE, 'utf8'));
const fromServer = (rel) => import(pathToFileURL(path.join(SERVER, rel)).href);

/** The builder stand-in's mode for the next builds: accepted, refused-source or error. */
export function setBuilderMode(stack, mode) {
  fs.writeFileSync(stack.builderConfig, JSON.stringify({ mode, record: stack.builderRecord }));
}

/**
 * A screenshot for the PR, written only when SA_SCREENSHOTS is set (they are committed). Fields
 * that hold a private key (data-private) are masked, though every key here is made for the run.
 */
export async function shot(page, name, { target = null } = {}) {
  if (!process.env.SA_SCREENSHOTS) return;
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
  const o = { path: path.join(SCREENSHOTS, `${name}.png`), mask: [page.locator('[data-private]')] };
  await (target ? target.screenshot(o) : page.screenshot({ ...o, fullPage: true }));
}

/**
 * A browser wallet for tests: an EIP-1193 provider on window.ethereum that forwards every call to
 * the local Hardhat node, whose accounts are unlocked. No extension and no key in the page.
 */
export async function installWallet(page, stack, account = stack.accounts.maker) {
  await page.addInitScript(({ rpcUrl, chainId, account: from }) => {
    let id = 0;
    window.ethereum = {
      isVerdiktaTestWallet: true,
      async request({ method, params = [] }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [from];
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'wallet_switchEthereumChain') return null;
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        const body = await res.json();
        if (body.error) {
          const err = new Error(body.error.message);
          err.code = body.error.code;
          err.data = body.error.data;
          throw err;
        }
        return body.result;
      },
      on() {},
      removeListener() {},
    };
  }, { rpcUrl: stack.rpcUrl, chainId: stack.chainId, account });
}

/** Every request the browser context makes (URL, headers, body) and every WebSocket frame. */
export function recordRequests(context) {
  const requests = [];
  const frames = [];
  context.on('request', (req) => {
    requests.push({ req, url: req.url(), method: req.method(), body: req.postDataBuffer() ?? Buffer.alloc(0) });
  });
  context.on('page', (p) => watchSockets(p, frames));
  for (const p of context.pages()) watchSockets(p, frames);
  return {
    requests,
    frames,
    /** Resolves every request's full header set (lazy in Playwright). */
    async settle() {
      for (const r of requests) r.headers = await r.req.allHeaders().catch(() => ({}));
      return requests;
    },
  };
}

function watchSockets(page, frames) {
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => frames.push(String(f.payload)));
    ws.on('framereceived', () => {});
  });
}

/**
 * Every encoding of an age identity's secret a careless client might put on the wire: the
 * identity string in both cases, the 32 bytes in hex (with and without 0x, both cases), base64
 * and base64url (padded or not), and the raw bytes.
 */
export function secretForms(identity) {
  const bytes = Buffer.from(codec.decodeIdentity(identity));
  const hex = bytes.toString('hex');
  const b64 = bytes.toString('base64');
  const b64url = bytes.toString('base64url');
  const text = [identity, identity.toLowerCase(), hex, hex.toUpperCase(), b64, b64.replace(/=+$/, ''), b64url];
  return { bytes, text: [...new Set(text)] };
}

/** Where any of the forms occurs in a string or a buffer, or null. */
export function findSecret(forms, value) {
  if (value === undefined || value === null) return null;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (buf.indexOf(forms.bytes) !== -1) return 'raw bytes';
  const strings = [buf.toString('utf8'), buf.toString('latin1')];
  try {
    strings.push(decodeURIComponent(buf.toString('utf8')));
  } catch {
    // not URI-encoded text
  }
  for (const s of strings) for (const f of forms.text) if (s.includes(f)) return f.slice(0, 18);
  return null;
}

/** The test's side of the chain: the merged ABI at the StakeAttestation address. */
export function chainOf(stack) {
  const provider = new JsonRpcProvider(stack.rpcUrl, stack.chainId, { staticNetwork: true, pollingInterval: 100 });
  const sa = new Contract(stack.contract, stack.abi, provider);
  const as = async (addr) => sa.connect(await provider.getSigner(addr));
  const events = (rc, name) => rc.logs.map((l) => { try { return sa.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name);

  return {
    provider,
    sa,
    as,
    async now() {
      return (await provider.getBlock('latest')).timestamp;
    },
    async increaseTime(seconds) {
      await provider.send('evm_increaseTime', [seconds]);
      await provider.send('evm_mine', []);
    },

    /**
     * An Open listing made the way the site makes one: the server validates and pins it (the
     * request from the server's own test fixtures), the maker sends list() with the server's
     * arguments and fund() with the fee and the CRITICAL award.
     */
    async openListing({ recipient, spec = {}, allowlist = [] }) {
      const { draftSpec, knownIssues } = await fromServer('test/helpers/fixtures.js');
      // a fresh commit: a maker has one listing per version that is not closed
      const baseCommit = crypto.randomBytes(20).toString('hex');
      const body = { spec: draftSpec({ disclosureKey: recipient, baseCommit, ...spec }), knownIssues: knownIssues(), allowlist };
      const res = await fetch(`${stack.apiUrl}/api/listings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(202);
      let view = await res.json();
      for (let i = 0; i < 400 && !['ready', 'refused', 'error'].includes(view.status); i++) {
        await new Promise((r) => setTimeout(r, 50));
        view = await (await fetch(`${stack.apiUrl}/api/listings/${view.id}`)).json();
      }
      expect(view.status, JSON.stringify(view.error)).toBe('ready');
      const { params, listingCid, disputeCid, knownIssueIds } = view.list;
      const maker = await as(stack.accounts.maker);
      const rc = await (await maker.list(params, listingCid, disputeCid, knownIssueIds)).wait();
      const listingId = events(rc, 'Listed')[0].args.listingId;
      const fee = await sa.feeDue(listingId);
      await (await maker.fund(listingId, fee, { value: fee + BigInt(params.awards[3]) })).wait();
      return { listingId, view };
    },

    /**
     * A hunter's claim: encrypt `archive` to `recipient`, commit sha256(`commitArchive`) and
     * sha256(ciphertext), then (once the commit is mined, erratum E5) put `served` (the ciphertext
     * unless given) on the gateway under the ciphertext's CID and disclose that CID.
     */
    async claim({ listingId, archive, recipient, commitArchive = archive, served = null, disclose = true }) {
      const { rawCid } = await fromServer('src/pinning/cid.js');
      const keys = disclosure.generateDisclosureSecrets();
      const ciphertext = disclosure.encryptForDisclosure(archive, recipient, keys);
      const archiveHash = disclosure.disclosureSha256(commitArchive);
      const ciphertextSha256 = disclosure.disclosureSha256(ciphertext);
      const hunter = await as(stack.accounts.hunter);
      const price = await sa.commitPrice(listingId);
      const rc = await (await hunter.commit(listingId, archiveHash, ciphertextSha256, { value: price })).wait();
      const claimId = events(rc, 'Committed')[0].args.claimId;
      if (!disclose) return { claimId, ciphertext, archiveHash, ciphertextSha256, cid: null };
      const cid = rawCid(ciphertext);
      const put = await fetch(`${stack.gatewayUrl}/ipfs/${cid}`, { method: 'PUT', body: served ?? ciphertext });
      expect(put.status).toBe(201);
      await (await hunter.disclose(claimId, cid)).wait();
      return { claimId, ciphertext, archiveHash, ciphertextSha256, cid };
    },
  };
}

/** A claim archive's bytes: a stand-in ZIP (the check compares hashes, it does not unpack). */
export function archiveBytes(label) {
  return new Uint8Array(Buffer.from(`PK\u0003\u0004 stand-in claim archive: ${label} ${Math.random()}`, 'latin1'));
}

export { disclosure };

export const test = base.extend({
  stack: [async ({}, use) => use(readStack()), { scope: 'worker' }],
  chain: [async ({ stack }, use) => {
    const chain = chainOf(stack);
    await use(chain);
    chain.provider.destroy();
  }, { scope: 'worker' }],
});
