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
/** The repository the tests list by default. */
export const REPO_URL = 'https://github.com/acme/vault';
/** A fresh commit on `repo`'s main (a bare repository in the stack's mirror folder) whose file names `maker`. */
export async function provenCommit(stack, { repo = REPO_URL, maker = stack.accounts.maker } = {}) {
  const { makeRepo, proofFile } = await fromServer('test/helpers/gitRepo.js');
  return makeRepo(stack.mirrorDir, repo).commit({ file: proofFile(maker) });
}
export const readStack = () => JSON.parse(fs.readFileSync(STACK_FILE, 'utf8'));
export const fromServer = (rel) => import(pathToFileURL(path.join(SERVER, rel)).href);

/**
 * The builder stand-in's mode for the next builds: accepted, refused-source or error; `scan` adds
 * its scan settings (scanMode, the canary `mark` every finding carries).
 */
export function setBuilderMode(stack, mode, scan = {}) {
  fs.writeFileSync(stack.builderConfig, JSON.stringify({ mode, record: stack.builderRecord, ...scan }));
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
 * window.__testWallet lets a test switch the account (emitting accountsChanged, as a wallet
 * does) and make the eth_calls that follow the next transaction fail, as a flaky RPC would.
 */
export async function installWallet(page, stack, account = stack.accounts.maker) {
  await page.addInitScript(({ rpcUrl, chainId: configured, account: first }) => {
    let id = 0;
    let from = first;
    let chainId = configured;
    let switchAllowed = false;
    let failCallsAfterSend = 0;
    let failing = 0;
    const listeners = new Map();
    const emit = (event, value) => { for (const fn of listeners.get(event) ?? []) fn(value); };
    window.__testWallet = {
      setAccount(a) {
        from = a;
        emit('accountsChanged', [a]);
      },
      failCallsAfterNextSend(n) {
        failCallsAfterSend = n;
      },
      // another network: it answers eth_chainId and, unless `allowSwitch`, refuses to switch back
      setChain(n, { allowSwitch = false } = {}) {
        chainId = n;
        switchAllowed = allowSwitch;
        emit('chainChanged', `0x${n.toString(16)}`);
      },
    };
    window.ethereum = {
      isVerdiktaTestWallet: true,
      async request({ method, params = [] }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [from];
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'wallet_switchEthereumChain') {
          if (!switchAllowed) throw Object.assign(new Error('test wallet: switch refused'), { code: 4001 });
          chainId = parseInt(params[0].chainId, 16);
          emit('chainChanged', params[0].chainId);
          return null;
        }
        if (chainId !== configured && method !== 'eth_accounts') throw Object.assign(new Error('test wallet: on another network'), { code: -32603 });
        if (method === 'eth_call' && failing > 0) {
          failing -= 1;
          throw Object.assign(new Error('test wallet: RPC unavailable'), { code: -32603 });
        }
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
        if (method === 'eth_sendTransaction' && failCallsAfterSend) {
          failing = failCallsAfterSend;
          failCallsAfterSend = 0;
        }
        return body.result;
      },
      on(event, fn) {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeListener(event, fn) {
        listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
      },
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
     * An Open listing made the way the site makes one: the repository names the maker at the commit,
     * the maker's wallet signs the request, the server validates and pins it (the request from the
     * server's own test fixtures), the maker sends list() with the server's arguments and fund() with
     * the fee and the CRITICAL award; and it waits for the site to count it.
     */
    async openListing({ recipient, spec = {}, stake = {}, allowlist = [], maker: makerAddress = stack.accounts.maker, baseCommit = null, escrow = null, deploymentProof = null }) {
      const { draftSpec, knownIssues } = await fromServer('test/helpers/fixtures.js');
      // a fresh commit by default, on the repository's main, whose file names the maker: a maker has
      // one listing per version that is not closed
      const repoUrl = spec.repo ?? REPO_URL;
      const commit = baseCommit ?? await provenCommit(stack, { repo: repoUrl, maker: makerAddress });
      const draft = draftSpec({ disclosureKey: recipient, baseCommit: commit, ...spec });
      draft.stake = { ...draft.stake, ...stake };
      const body = { spec: draft, knownIssues: knownIssues(), allowlist, maker: makerAddress, ...(deploymentProof ? { deploymentProof } : {}) };
      const post = (path, b) => fetch(`${stack.apiUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      const c = await post('/api/listings/challenge', body);
      expect(c.status, await c.clone().text()).toBe(200);
      const challenge = await c.json();
      const signature = await (await provider.getSigner(makerAddress)).signMessage(challenge.message);
      const res = await post('/api/listings', { ...body, auth: { nonce: challenge.nonce, signature } });
      expect(res.status).toBe(202);
      let view = await res.json();
      for (let i = 0; i < 400 && !['ready', 'refused', 'error'].includes(view.status); i++) {
        await new Promise((r) => setTimeout(r, 50));
        view = await (await fetch(`${stack.apiUrl}/api/listings/${view.id}`)).json();
      }
      expect(view.status, JSON.stringify(view.error)).toBe('ready');
      const { params, listingCid, disputeCid, knownIssueIds } = view.list;
      const maker = await as(makerAddress);
      const rc = await (await maker.list(params, listingCid, disputeCid, knownIssueIds)).wait();
      const listingId = events(rc, 'Listed')[0].args.listingId;
      const fee = await sa.feeDue(listingId);
      await (await maker.fund(listingId, fee, { value: fee + (escrow ?? BigInt(params.awards[3])) })).wait();
      const artifactHash = (await sa.getListing(listingId)).artifactHash;
      await this.counted(artifactHash, listingId);
      return { listingId, view, artifactHash };
    },

    /** Waits for the site to count a listing: its archive read, its proof checked. */
    async counted(artifactHash, listingId) {
      await this.until(async () => {
        const res = await fetch(`${stack.apiUrl}/api/records/${artifactHash}`);
        return res.ok && (await res.json()).record.listings.some((l) => l.listingId === String(listingId));
      }, { timeoutMs: 45_000, what: `listing ${listingId} counted` });
    },

    /** Waits for the site to show a listing apart, as not counted; returns its row. */
    async notCounted(artifactHash, listingId) {
      let row = null;
      await this.until(async () => {
        const res = await fetch(`${stack.apiUrl}/api/records/${artifactHash}`);
        if (!res.ok) return false;
        row = (await res.json()).notCounted.listings.find((l) => l.listingId === String(listingId) && !['ARCHIVE_UNAVAILABLE', 'NOT_CHECKED_YET'].includes(l.reason));
        return Boolean(row);
      }, { timeoutMs: 45_000, what: `listing ${listingId} apart` });
      return row;
    },

    /** The server's list() arguments sent from another wallet, and funded: list() takes any CID. */
    async replay(view, from) {
      const { params, listingCid, disputeCid, knownIssueIds } = view.list;
      const wallet = await as(from);
      const rc = await (await wallet.list(params, listingCid, disputeCid, knownIssueIds)).wait();
      const listingId = events(rc, 'Listed')[0].args.listingId;
      const fee = await sa.feeDue(listingId);
      await (await wallet.fund(listingId, fee, { value: fee + BigInt(params.awards[3]) * 50n })).wait();
      return { listingId };
    },

    /**
     * A hunter's claim: encrypt `archive` to `recipient`, commit sha256(`commitArchive`) and
     * sha256(ciphertext), then (once the commit is mined, erratum E5) put `served` (the ciphertext
     * unless given) on the gateway under the ciphertext's CID and disclose that CID.
     */
    async claim({ listingId, archive, recipient, commitArchive = archive, served = null, disclose = true, late = false }) {
      const { rawCid } = await fromServer('src/pinning/cid.js');
      const keys = disclosure.generateDisclosureSecrets();
      const ciphertext = disclosure.encryptForDisclosure(archive, recipient, keys);
      const archiveHash = disclosure.disclosureSha256(commitArchive);
      const ciphertextSha256 = disclosure.disclosureSha256(ciphertext);
      const hunter = await as(stack.accounts.hunter);
      const price = await sa.commitPrice(listingId);
      const rc = await (await hunter[late ? 'lateClaim' : 'commit'](listingId, archiveHash, ciphertextSha256, { value: price })).wait();
      const claimId = events(rc, late ? 'LateClaim' : 'Committed')[0].args.claimId;
      if (!disclose) return { claimId, ciphertext, archiveHash, ciphertextSha256, cid: null, keys, archive };
      const cid = rawCid(ciphertext);
      const put = await fetch(`${stack.gatewayUrl}/ipfs/${cid}`, { method: 'PUT', body: served ?? ciphertext });
      expect(put.status).toBe(201);
      await (await hunter.disclose(claimId, cid)).wait();
      return { claimId, ciphertext, archiveHash, ciphertextSha256, cid, keys, archive };
    },

    /** The hunter's reveal (design §13.2, erratum E3): the plaintext pinned, the two keys sent, the prepay topped up. */
    async reveal({ claimId, keys, archive }) {
      const { rawCid } = await fromServer('src/pinning/cid.js');
      const bcid = rawCid(archive);
      const put = await fetch(`${stack.gatewayUrl}/ipfs/${bcid}`, { method: 'PUT', body: Buffer.from(archive) });
      expect(put.status).toBe(201);
      const hunter = await as(stack.accounts.hunter);
      const topUp = await sa.revealTopUp(claimId);
      await (await hunter.reveal(claimId, bcid, keys.contentKey, keys.ephemeralKey, { value: topUp, gasLimit: REQUEST_GAS })).wait();
      return { bcid, requestId: (await sa.getClaim(claimId)).requestId };
    },

    /** A claim committed, disclosed, released by the maker when its fix window is open, and revealed. */
    async revealedClaim({ listingId, recipient, label = 'claim', late = false }) {
      const archive = archiveBytes(label);
      const c = await this.claim({ listingId, archive, recipient, late });
      const { revealableAt } = await sa.claimTimes(c.claimId);
      if (BigInt(await this.now()) < revealableAt) await (await (await as(stack.accounts.maker)).release(c.claimId)).wait();
      const r = await this.reveal(c);
      return { ...c, ...r };
    },

    /** The jury's vector for `outcome` arrives at the mock aggregator for the claim's open round. */
    async verdict(claimId, outcome, { dispute = false, justification = JUSTIFICATION_CID } = {}) {
      const c = await sa.getClaim(claimId);
      const vector = OUTCOMES.map((o) => (o === outcome ? 1_000_000n : 0n));
      const agg = new Contract(stack.aggregator, stack.aggregatorAbi, await provider.getSigner(stack.accounts.owner));
      await (await agg.scriptResult(dispute ? c.disputeRequestId : c.requestId, vector, justification)).wait();
    },

    /** An arbiter's justification upload on the gateway stand-in: its CID. */
    async upload(bytes) {
      const { rawCid } = await fromServer('src/pinning/cid.js');
      const cid = rawCid(bytes);
      const put = await fetch(`${stack.gatewayUrl}/ipfs/${cid}`, { method: 'PUT', body: bytes });
      expect(put.status).toBe(201);
      return cid;
    },

    /** The request the mock aggregator received: its CIDs and addendum. */
    async request(requestId) {
      const agg = new Contract(stack.aggregator, stack.aggregatorAbi, provider);
      return { cids: [...await agg.getRequestCids(requestId)], addendum: (await agg.requestParams(requestId)).addendum };
    },

    /** Waits until `check()` is true (the site's keeper acts on its own schedule). */
    async until(check, { timeoutMs = 30_000, what = 'the chain' } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        if (await check()) return;
        if (Date.now() > end) throw new Error(`${what}: not reached in ${timeoutMs} ms`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },

    /** Waits for the keeper to finalize the claim's round: Judged (or later). */
    async judged(claimId) {
      await this.until(async () => (await sa.getClaim(claimId)).judgedAt !== 0n, { what: `claim ${claimId} judged` });
    },

    /** Moves the clock past `at` (seconds) and waits for the keeper to settle the claim. */
    async settledAfter(claimId) {
      const at = await sa.settleableAt(claimId);
      const now = BigInt(await this.now());
      if (at > now) await this.increaseTime(Number(at - now) + 1);
      await this.until(async () => (await sa.getClaim(claimId)).settledAt !== 0n, { what: `claim ${claimId} settled` });
    },
  };
}

export const OUTCOMES = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
// reveal and dispute forward exactly SUBMISSION_GAS to the request and need about 10.3M left
const REQUEST_GAS = 12_000_000n;
// a CID the mock aggregator returns as the justification (never fetched)
const JUSTIFICATION_CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

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
