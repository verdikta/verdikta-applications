// A StakeAttestation deployment on the in-process Hardhat network and the steps of a listing's
// and a claim's life, for the indexer, keeper, feed, record and badge tests (node P4b1). Listings
// are built as the listing flow builds them: the builder stand-in's files, the listing and dispute
// archives (buildListingArchives), pinned to the mock store, and list()'s arguments from
// listArguments. The site under test reads the chain through an ethers provider over the
// in-process network and the archives from the mock store: no live RPC, no IPFS, no secret. The
// keeper's key is derived at run time from Hardhat's own test mnemonic.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';

import { buildListingArchives } from '../../src/listing/archives.js';
import { listArguments } from '../../src/listing/listParams.js';
import { createMockPinner, rawCid } from '../../src/pinning/index.js';
import { createSite } from '../../src/site/index.js';
import { deployStakeAttestation, hardhat } from './chain.js';
import { draftSpec, fakeBuilder, testConfig } from './fixtures.js';
import { quietLogger } from './http.js';

export const OUTCOMES = Object.freeze(['INVALID', 'DUPLICATE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const SCALE = 1_000_000;
export const vector = (outcome) => OUTCOMES.map((o) => (o === outcome ? SCALE : 0));
export const JUSTIFICATION = rawCid(Buffer.from('the justification'));
export const CK = `0x${'11'.repeat(16)}`;
export const EK = `0x${'22'.repeat(32)}`;
export const HOUR = 3600;
export const DAY = 86400;
const REVEAL_GAS = 12_000_000n;

const randomHash = () => `0x${crypto.randomBytes(32).toString('hex')}`;
let commitCounter = 0;
/** A fresh 40-hex commit per call, so one maker can hold many listings. */
export const freshCommit = () => `${(++commitCounter).toString(16).padStart(8, '0')}${crypto.randomBytes(16).toString('hex')}`;

export function tmpDir(prefix = 'sa-site-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** The provider the site reads with: ethers over the in-process network, no caching. */
export function inProcessProvider(hre) {
  return new ethers.BrowserProvider(hre.network.provider, 31337, { cacheTimeout: -1, staticNetwork: true });
}

/** A fresh deployment and everything a test drives it with. */
export async function chainContext() {
  const hre = await hardhat();
  const d = await deployStakeAttestation(hre);
  const signers = await hre.ethers.getSigners();
  const address = await d.sa.getAddress();
  const fromBlock = await hre.ethers.provider.getBlockNumber();
  const accounts = hre.network.config.accounts;
  // the keeper signs with its own key, as in production: Hardhat's 10th account, derived here
  const keyOf = (index) => ethers.HDNodeWallet.fromPhrase(accounts.mnemonic, accounts.passphrase ?? '', `${accounts.path}/${index}`).privateKey;
  return {
    hre,
    ...d,
    signers,
    other: signers[4],
    hunters: signers.slice(5, 9),
    keeperAddress: signers[9].address,
    keeperKey: keyOf(9),
    keyOf,
    address,
    fromBlock,
    provider: inProcessProvider(hre),
    pinner: createMockPinner(),
    builder: fakeBuilder(),
  };
}

export const rpc = (ctx, method, params = []) => ctx.hre.network.provider.send(method, params);
// evm_mine one block at a time: hardhat_mine reserves a run of blocks lazily, and an eth_call at
// a reserved block fails inside Hardhat (EDR: Header(ExcessBlobGasNotSet)).
export async function mine(ctx, blocks = 1) {
  for (let i = 0; i < blocks; i += 1) await rpc(ctx, 'evm_mine');
}
export const automine = (ctx, on) => rpc(ctx, 'evm_setAutomine', [on]);
export async function increaseTime(ctx, seconds) {
  await rpc(ctx, 'evm_increaseTime', [Number(seconds)]);
  await mine(ctx);
}
export async function latestTimestamp(ctx) {
  return (await ctx.hre.ethers.provider.getBlock('latest')).timestamp;
}

function eventArgs(ctx, rc, name) {
  for (const log of rc.logs) {
    if (log.address.toLowerCase() !== ctx.address.toLowerCase()) continue;
    const parsed = ctx.sa.interface.parseLog(log);
    if (parsed?.name === name) return parsed.args;
  }
  throw new Error(`no ${name} event`);
}

/**
 * Builds, pins and lists a listing, and funds it unless `fund` is false. The stake defaults to a
 * fix window and a disclosure grace of 0, so a disclosed claim reveals at once.
 */
export async function listing(ctx, { maker = ctx.maker, spec = {}, stake = {}, fund = true, allowlist = [], escrowWei, oracle } = {}) {
  const base = draftSpec();
  const draft = {
    ...base,
    baseCommit: freshCommit(),
    ...spec,
    stake: { ...base.stake, fixWindowDays: 0, disclosureGraceHours: 0, ...stake },
  };
  delete draft.stake.knownIssues;
  const built = await ctx.builder.build({ draft, knownIssues: null });
  const archives = buildListingArchives(built.files);
  const listingCid = await ctx.pinner.pin(archives.listing.bytes, { name: 'listing.zip' });
  const disputeCid = await ctx.pinner.pin(archives.dispute.bytes, { name: 'dispute.zip' });
  const args = listArguments({
    spec: archives.spec,
    knownIssues: null,
    allowlist,
    oracle: oracle ?? testConfig().oracle,
    listingCid,
    disputeCid,
  });
  const rc = await (await ctx.sa.connect(maker).list(args.params, listingCid, disputeCid, args.knownIssueIds)).wait();
  const listingId = eventArgs(ctx, rc, 'Listed').listingId;
  if (fund) await fundListing(ctx, listingId, { maker, escrowWei: escrowWei ?? BigInt(args.params.awards[3]) });
  return { listingId, artifactHash: args.artifactHash, spec: archives.spec, listingCid, disputeCid, params: args.params };
}

export async function fundListing(ctx, listingId, { maker = ctx.maker, escrowWei } = {}) {
  const fee = await ctx.sa.feeDue(listingId);
  const escrow = escrowWei ?? (await ctx.sa.getListing(listingId)).awards[3];
  await (await ctx.sa.connect(maker).fund(listingId, fee, { value: fee + escrow })).wait();
}

/** commit (or lateClaim): two hashes, the bond and the live prepay. */
export async function commit(ctx, hunter, listingId, { late = false } = {}) {
  const price = await ctx.sa.commitPrice(listingId);
  const rc = await (await ctx.sa.connect(hunter)[late ? 'lateClaim' : 'commit'](listingId, randomHash(), randomHash(), { value: price })).wait();
  return eventArgs(ctx, rc, late ? 'LateClaim' : 'Committed').claimId;
}

export const ciphertextCidOf = (claimId) => rawCid(Buffer.from(`ciphertext of claim ${claimId}`));
export const bcidOf = (claimId) => rawCid(Buffer.from(`archive of claim ${claimId}`));

export async function disclose(ctx, hunter, claimId) {
  await (await ctx.sa.connect(hunter).disclose(claimId, ciphertextCidOf(claimId))).wait();
}

/** reveal, topping the prepay up to the live fee; returns the request id. */
export async function reveal(ctx, hunter, claimId) {
  const topUp = await ctx.sa.revealTopUp(claimId);
  await (await ctx.sa.connect(hunter).reveal(claimId, bcidOf(claimId), CK, EK, { value: topUp, gasLimit: REVEAL_GAS })).wait();
  return (await ctx.sa.getClaim(claimId)).requestId;
}

/** commit, disclose and reveal on a listing whose fix window is 0. */
export async function revealedClaim(ctx, hunter, listingId, opts = {}) {
  const claimId = await commit(ctx, hunter, listingId, opts);
  await disclose(ctx, hunter, claimId);
  await reveal(ctx, hunter, claimId);
  return claimId;
}

/** The jury's verdict arrives at the (mock) aggregator for the claim's open round. */
export async function verdict(ctx, claimId, outcome, { dispute = false } = {}) {
  const c = await ctx.sa.getClaim(claimId);
  await (await ctx.aggregator.scriptResult(dispute ? c.disputeRequestId : c.requestId, vector(outcome).map(BigInt), JUSTIFICATION)).wait();
}

export async function finalize(ctx, claimId, caller = ctx.other) {
  await (await ctx.sa.connect(caller).finalize(claimId)).wait();
}

export async function settle(ctx, claimId, caller = ctx.other) {
  await (await ctx.sa.connect(caller).settle(claimId)).wait();
}

/** finalize with `outcome`, then settle once the claim may settle (after the dispute window for a valid one). */
export async function judgeAndSettle(ctx, claimId, outcome) {
  await verdict(ctx, claimId, outcome);
  await finalize(ctx, claimId);
  const at = Number(await ctx.sa.settleableAt(claimId));
  const now = await latestTimestamp(ctx);
  if (now < at) await increaseTime(ctx, at - now);
  await settle(ctx, claimId);
}

export async function dispute(ctx, claimId, maker = ctx.maker) {
  const { listingId } = await ctx.sa.getClaim(claimId);
  const fee = await ctx.sa.disputeFee(listingId);
  await (await ctx.sa.connect(maker).dispute(claimId, rawCid(Buffer.from(`statement for ${claimId}`)), { value: fee, gasLimit: REVEAL_GAS })).wait();
}

/** The env the site reads: the deployment, no confirmations, small chunks; `over` wins. */
export function siteEnv(ctx, dir, over = {}) {
  return {
    SA_CONTRACT_ADDRESS: ctx.address,
    SA_FROM_BLOCK: String(ctx.fromBlock),
    SA_CONFIRMATIONS: '0',
    SA_DATA_DIR: dir,
    SA_KEEPER_PRIVATE_KEY: ctx.keeperKey,
    ...over,
  };
}

/**
 * The site (indexer, keeper, feed, record, badge) over the in-process chain. `env` adds to or
 * overrides siteEnv; `provider` replaces the in-process provider (a wrapper that fails on cue);
 * `keeperHooks.beforeBroadcast` runs between recording a transaction and broadcasting it.
 */
export function siteFor(ctx, { dir = tmpDir(), env = {}, provider = ctx.provider, fetchArchive, logger = quietLogger(), keeperHooks } = {}) {
  const fullEnv = siteEnv(ctx, dir, env);
  const config = testConfig(fullEnv);
  const site = createSite({
    config,
    provider,
    env: fullEnv,
    fetchArchive: fetchArchive ?? (async (cid) => {
      const bytes = ctx.pinner.get(cid);
      if (!bytes) throw new Error(`${cid} is not pinned`);
      return bytes;
    }),
    logger,
    keeperHooks,
  });
  site.dir = dir;
  site.logger = logger;
  return site;
}

/**
 * Every transaction the keeper's address sent from `fromBlock`, mined, with its function name
 * (finalize, settle, expire, or a 0-value self-send that cancels a stale one) and its status.
 */
export async function keeperTransactions(ctx, fromBlock = ctx.fromBlock) {
  const p = ctx.hre.ethers.provider;
  const latest = await p.getBlockNumber();
  const out = [];
  for (let n = fromBlock; n <= latest; n += 1) {
    const block = await p.getBlock(n, true);
    for (const tx of block.prefetchedTransactions) {
      if (tx.from !== ctx.keeperAddress) continue;
      const rc = await p.getTransactionReceipt(tx.hash);
      let fn = 'cancel';
      if (tx.to === ctx.address) {
        const parsed = ctx.sa.interface.parseTransaction({ data: tx.data });
        fn = `${parsed.name}(${parsed.args.map(String).join(',')})`;
      } else if (tx.to !== ctx.keeperAddress || tx.value !== 0n) {
        fn = 'other';
      }
      out.push({ fn, nonce: tx.nonce, status: rc.status, block: n, hash: tx.hash });
    }
  }
  return out;
}

/** The keeper's transactions waiting in the in-process mempool. */
export async function pendingKeeperTransactions(ctx) {
  const block = await rpc(ctx, 'eth_getBlockByNumber', ['pending', true]);
  return block.transactions.filter((t) => t.from.toLowerCase() === ctx.keeperAddress.toLowerCase());
}
