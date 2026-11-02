// Node P8, acceptance 2: a contract listing proves control of the deployment with a signature over
// the maker's address and the artifact, from its deployer or current owner, checked on the
// listing's chain (EIP-1271 where the owner is a contract). A repository proof alone does not
// count. Replays, look-alike signers and addresses in other forms get no "yes".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { controlMessage } from '../src/control/facts.js';
import { fakeBuilder } from './helpers/fixtures.js';
import { makeRepo, proofFile } from './helpers/gitRepo.js';
import { startApi } from './helpers/http.js';
import { chainContext, freshCommit, listing, mine, siteFor, tmpDir } from './helpers/scenario.js';

const CHAIN_ID = 31337;

describe('a contract listing\'s control fact', () => {
  let ctx;
  let site;
  let api;
  let owner;
  let deployer;
  let stranger;
  let clock;

  const deploy = async (name, from, ...args) => {
    const c = await (await ctx.hre.ethers.getContractFactory(name, from)).deploy(...args);
    await c.waitForDeployment();
    return { contract: c, address: await c.getAddress(), creationTx: c.deploymentTransaction().hash };
  };
  const contractListing = async (address, { maker = ctx.maker, chainId = CHAIN_ID, commit = freshCommit() } = {}) => listing(ctx, {
    maker,
    spec: { baseCommit: commit, artifact: { kind: 'contract', address, chainId } },
    stake: { valueAtRiskUsd: undefined },
  });
  const messageOf = (l, maker, address, over = {}) => controlMessage({
    maker,
    artifactHash: l.artifactHash,
    chainId: String(CHAIN_ID),
    address,
    stakeChainId: CHAIN_ID,
    stakeContract: ctx.address,
    ...over,
  });
  const post = (l, body) => api.post(`/api/records/${l.artifactHash}/listings/${l.listingId}/control-proof`, body);
  const fact = async (l) => (await site.record(l.artifactHash)).control[l.listingId];
  const refused = async (res, status, code) => {
    const body = await res.json();
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(body.error, code);
    return body;
  };

  before(async () => {
    ctx = await chainContext();
    [owner, deployer, stranger] = [ctx.signers[10], ctx.signers[11], ctx.signers[12]];
    clock = Date.now();
    site = siteFor(ctx, { now: () => clock, env: { SA_CONTROL_RECHECK_MS: '1000', SA_MAX_STALENESS_SECONDS: '100000000' } });
    api = await startApi({ builder: fakeBuilder(), site });
  });
  after(async () => {
    await api?.close();
    site?.close();
  });

  test('before any signature it is "no", and the record states the exact message to sign', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    await site.sync();
    const c = await fact(l);
    assert.equal(c.subject, 'deployment');
    assert.equal(c.controls, 'no');
    assert.equal(c.statement, 'staker controls the deployment: no');
    assert.equal(c.reason, 'NO_SIGNATURE');
    assert.equal(c.deployment.message, messageOf(l, ctx.maker.address, address));
    assert.equal(c.deployment.chainId, String(CHAIN_ID));
    assert.equal(c.deployment.address, address);
    assert.equal(c.deployment.signer, null);
    assert.match((await site.badge(l.artifactHash)).message, /staker controls the deployment: no$/);
  });

  test('yes: the current owner signs; the record shows the signature, the signer, its role and the block, so anyone can re-check', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    await site.sync();
    const message = (await fact(l)).deployment.message;
    const signature = await owner.signMessage(message);
    const res = await post(l, { signer: owner.address, signature });
    assert.equal(res.status, 200);
    const c = (await res.json()).control;
    assert.equal(c.controls, 'yes');
    assert.equal(c.statement, 'staker controls the deployment: yes');
    assert.equal(c.reason, null);
    assert.equal(c.deployment.signer, owner.address);
    assert.equal(c.deployment.signature, signature);
    assert.equal(c.deployment.role, 'owner');
    assert.ok(c.deployment.block > 0);
    assert.equal(ethers.verifyMessage(c.deployment.message, c.deployment.signature), owner.address, 'it re-checks from the record alone');
    assert.equal((await fact(l)).controls, 'yes');
    assert.match((await site.badge(l.artifactHash)).message, /staker controls the deployment: yes$/);
    const live = await api.get(`/api/records/${l.artifactHash}`);
    assert.equal((await live.json()).control[l.listingId].deployment.signature, signature);
  });

  test('yes: the deployer signs and names its creation transaction, also with no owner()', async () => {
    const { address, creationTx } = await deploy('MockOwnerless', deployer);
    const l = await contractListing(address);
    await site.sync();
    const signature = await deployer.signMessage((await fact(l)).deployment.message);
    await refused(await post(l, { signer: deployer.address, signature }), 422, 'SIGNER_NOT_CONTROLLER');
    const res = await post(l, { signer: deployer.address, signature, creationTx });
    assert.equal(res.status, 200);
    const c = (await res.json()).control;
    assert.equal(c.controls, 'yes');
    assert.equal(c.deployment.role, 'deployer');
    assert.equal(c.deployment.creationTx, creationTx);
  });

  test('a stranger gets no "yes": own signature, another\'s address, another contract\'s creation', async () => {
    const { address, creationTx } = await deploy('MockOwned', deployer, owner.address);
    const other = await deploy('MockOwned', stranger, stranger.address);
    const l = await contractListing(address, { maker: stranger });
    await site.sync();
    const message = (await fact(l)).deployment.message;
    // the stranger signs for itself
    await refused(await post(l, { signer: stranger.address, signature: await stranger.signMessage(message) }), 422, 'SIGNER_NOT_CONTROLLER');
    // the stranger signs, and names the owner
    await refused(await post(l, { signer: owner.address, signature: await stranger.signMessage(message) }), 422, 'SIGNATURE_INVALID');
    // the stranger deployed something else: a creation transaction of another contract
    await refused(await post(l, { signer: stranger.address, signature: await stranger.signMessage(message), creationTx: other.creationTx }), 422, 'SIGNER_NOT_CONTROLLER');
    // the real creation transaction, signed by someone else
    await refused(await post(l, { signer: stranger.address, signature: await stranger.signMessage(message), creationTx }), 422, 'SIGNER_NOT_CONTROLLER');
    // a transaction that created nothing
    const tx = await (await stranger.sendTransaction({ to: stranger.address, value: 0n })).wait();
    await refused(await post(l, { signer: stranger.address, signature: await stranger.signMessage(message), creationTx: tx.hash }), 422, 'SIGNER_NOT_CONTROLLER');
    assert.equal((await fact(l)).controls, 'no');
    assert.equal((await fact(l)).deployment.signer, null, 'nothing refused was stored');
  });

  test('a signature cannot be replayed for another listing: another maker, artifact, chain or stake deployment', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const commit = freshCommit();
    const mine = await contractListing(address, { commit });
    const theirs = await contractListing(address, { maker: stranger, commit });
    const otherCommit = await contractListing(address, { maker: stranger, commit: freshCommit() });
    await site.sync();
    assert.equal(mine.artifactHash, theirs.artifactHash);
    const signed = await owner.signMessage(messageOf(mine, ctx.maker.address, address));
    assert.equal((await post(mine, { signer: owner.address, signature: signed })).status, 200);

    // the owner named the maker: the stranger's listing of the same hash gets nothing from it
    await refused(await post(theirs, { signer: owner.address, signature: signed }), 422, 'SIGNATURE_INVALID');
    assert.equal((await fact(theirs)).controls, 'no');
    assert.equal((await fact(mine)).controls, 'yes');
    // signed for this maker and another hash
    const forOther = await owner.signMessage(messageOf(otherCommit, stranger.address, address));
    await refused(await post(theirs, { signer: owner.address, signature: forOther }), 422, 'SIGNATURE_INVALID');
    // the right maker and hash, another chain or another stake deployment
    for (const over of [{ chainId: '1' }, { stakeChainId: 8453 }, { stakeContract: address }]) {
      const s = await owner.signMessage(messageOf(theirs, stranger.address, address, over));
      await refused(await post(theirs, { signer: owner.address, signature: s }), 422, 'SIGNATURE_INVALID');
    }
    // something else entirely
    await refused(await post(theirs, { signer: owner.address, signature: await owner.signMessage('x') }), 422, 'SIGNATURE_INVALID');
    assert.equal((await fact(otherCommit)).controls, 'no');
  });

  test('an address in another case is the same address; a bad checksum or another format is refused', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    await site.sync();
    const signature = await owner.signMessage((await fact(l)).deployment.message);
    const lower = owner.address.toLowerCase();
    const flipped = `0x${[...owner.address.slice(2)].map((ch, i) => (i === [...owner.address.slice(2)].findIndex((x) => /[a-fA-F]/.test(x)) ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join('')}`;
    await refused(await post(l, { signer: flipped, signature }), 400, 'BAD_SIGNER');
    await refused(await post(l, { signer: ethers.getIcapAddress(owner.address), signature }), 400, 'BAD_SIGNER');
    await refused(await post(l, { signer: lower.slice(2), signature }), 400, 'BAD_SIGNER');
    await refused(await post(l, { signer: `0x${lower.slice(2).toUpperCase()}`, signature }), 400, 'BAD_SIGNER');
    const res = await post(l, { signer: lower, signature });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).control.deployment.signer, owner.address, 'stored and shown in checksummed form');
  });

  test('EIP-1271: an owner that is a contract answers for the signature on the listing\'s chain', async () => {
    const wallet = await deploy('MockContractWallet', deployer, owner.address, 0);
    const { address } = await deploy('MockOwned', deployer, wallet.address);
    const l = await contractListing(address);
    await site.sync();
    const message = (await fact(l)).deployment.message;
    const good = await owner.signMessage(message);

    // every way a contract can fail to say yes
    for (const mode of [1, 2, 3, 4, 5]) {
      await (await wallet.contract.setMode(mode)).wait();
      await refused(await post(l, { signer: wallet.address, signature: good }), 422, 'SIGNATURE_INVALID');
    }
    await (await wallet.contract.setMode(0)).wait();
    // the contract's key did not sign this
    await refused(await post(l, { signer: wallet.address, signature: await stranger.signMessage(message) }), 422, 'SIGNATURE_INVALID');
    const res = await post(l, { signer: wallet.address, signature: good });
    assert.equal(res.status, 200);
    const c = (await res.json()).control;
    assert.equal(c.controls, 'yes');
    assert.equal(c.deployment.role, 'owner');
    assert.equal(c.deployment.contractSigner, true);

    // the contract stops saying yes: the next check takes it back
    await (await wallet.contract.setMode(1)).wait();
    clock += 1001;
    await mine(ctx);
    await site.sync();
    await site.controlIdle();
    const later = await fact(l);
    assert.equal(later.controls, 'no');
    assert.equal(later.reason, 'SIGNATURE_INVALID');
    await (await wallet.contract.setMode(0)).wait();
  });

  test('ownership moves on: a former owner\'s signature stops counting at the next check; a deployer\'s stays', async () => {
    const owned = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(owned.address);
    const byDeployer = await deploy('MockOwned', deployer, owner.address);
    const d = await contractListing(byDeployer.address);
    await site.sync();
    await post(l, { signer: owner.address, signature: await owner.signMessage((await fact(l)).deployment.message) });
    await post(d, { signer: deployer.address, signature: await deployer.signMessage((await fact(d)).deployment.message), creationTx: byDeployer.creationTx });
    assert.equal((await fact(l)).controls, 'yes');
    assert.equal((await fact(d)).controls, 'yes');

    await (await owned.contract.connect(owner).transferOwnership(stranger.address)).wait();
    await (await byDeployer.contract.connect(owner).transferOwnership(stranger.address)).wait();
    await site.sync();
    await site.controlIdle();
    assert.equal((await fact(l)).controls, 'yes', 'not before the recheck time');
    clock += 1001;
    await site.sync();
    await site.controlIdle();
    const later = await fact(l);
    assert.equal(later.controls, 'no');
    assert.equal(later.reason, 'SIGNER_NOT_CONTROLLER');
    assert.equal(later.deployment.signer, owner.address, 'what was checked stays on the record');
    assert.equal((await fact(d)).controls, 'yes');
    assert.equal((await fact(d)).deployment.role, 'deployer');

    // the new owner's signature replaces it
    const next = await stranger.signMessage((await fact(l)).deployment.message);
    assert.equal((await post(l, { signer: stranger.address, signature: next })).status, 200);
    assert.equal((await fact(l)).deployment.signer, stranger.address);
  });

  test('a refused proof never takes away one on file', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    await site.sync();
    const signature = await owner.signMessage((await fact(l)).deployment.message);
    await post(l, { signer: owner.address, signature });
    await refused(await post(l, { signer: stranger.address, signature: await stranger.signMessage('nope') }), 422, 'SIGNATURE_INVALID');
    assert.equal((await fact(l)).controls, 'yes');
    assert.equal((await fact(l)).deployment.signature, signature);
  });

  test('a repository proof alone does not count for a contract: the file is shown, the fact stays "no"', async () => {
    const mirrors = tmpDir('sa-mirrors-');
    const vault = makeRepo(mirrors, 'https://github.com/acme/vault');
    const commit = vault.commit({ file: proofFile(ctx.maker.address) });
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address, { commit });
    const local = siteFor(ctx, { checkRepository: null, env: { SA_CONTROL_GIT_MIRROR_DIR: mirrors } });
    try {
      for (let round = 0; round < 24; round += 1) {
        await local.sync();
        await local.controlIdle();
      }
      const c = (await local.record(l.artifactHash)).control[l.listingId];
      assert.equal(c.subject, 'deployment');
      assert.equal(c.controls, 'no');
      assert.equal(c.reason, 'NO_SIGNATURE');
      assert.equal(c.repository.controls, 'yes', 'the repository line says what the file says');
      assert.equal(c.repository.named, ctx.maker.address);
      assert.match((await local.badge(l.artifactHash)).message, /staker controls the deployment: no$/);
    } finally {
      local.close();
    }
  });

  test('a repository listing takes no signature; an unknown listing or a mismatched hash is 404; a malformed body is 400', async () => {
    const repo = await listing(ctx, { spec: { baseCommit: freshCommit() }, stake: { valueAtRiskUsd: undefined } });
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    await site.sync();
    const sig = `0x${'11'.repeat(65)}`;
    await refused(await post(repo, { signer: owner.address, signature: sig }), 409, 'NOT_A_CONTRACT_LISTING');
    await refused(await api.post(`/api/records/${l.artifactHash}/listings/999999/control-proof`, { signer: owner.address, signature: sig }), 404, 'LISTING_NOT_FOUND');
    await refused(await api.post(`/api/records/${repo.artifactHash}/listings/${l.listingId}/control-proof`, { signer: owner.address, signature: sig }), 404, 'LISTING_NOT_FOUND');
    await refused(await api.post(`/api/records/0x12/listings/${l.listingId}/control-proof`, { signer: owner.address, signature: sig }), 400, 'BAD_HASH');
    await refused(await post(l, { signer: owner.address }), 400, 'BAD_SIGNATURE');
    await refused(await post(l, { signer: owner.address, signature: 'zz' }), 400, 'BAD_SIGNATURE');
    await refused(await post(l, { signer: owner.address, signature: `0x${'ab'.repeat(5000)}` }), 400, 'BAD_SIGNATURE');
    await refused(await post(l, { signature: sig }), 400, 'BAD_SIGNER');
    await refused(await post(l, { signer: owner.address, signature: sig, creationTx: 'nope' }), 400, 'BAD_CREATION_TX');
    const notJson = await api.post(`/api/records/${l.artifactHash}/listings/${l.listingId}/control-proof`, 'not json');
    assert.equal(notJson.status, 400);
    const tooLarge = await api.post(`/api/records/${l.artifactHash}/listings/${l.listingId}/control-proof`, { signer: owner.address, signature: 'x'.repeat(40000) });
    assert.equal(tooLarge.status, 413);
  });

  test('no contract at the address is "no"', async () => {
    const empty = ethers.Wallet.createRandom().address;
    const l = await contractListing(empty);
    await site.sync();
    await refused(await post(l, { signer: owner.address, signature: await owner.signMessage((await fact(l)).deployment.message) }), 422, 'NO_CONTRACT_AT_ADDRESS');
    assert.equal((await fact(l)).controls, 'no');
  });

  test('an owner() that answers no address names nobody', async () => {
    const { address } = await deploy('MockBadOwner', deployer);
    const l = await contractListing(address);
    await site.sync();
    await refused(await post(l, { signer: owner.address, signature: await owner.signMessage((await fact(l)).deployment.message) }), 422, 'SIGNER_NOT_CONTROLLER');
  });

  test('checked on the listing\'s chain: a chain the site has no provider for, or one that answers another id, leaves "no"', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address, { chainId: 8453 });
    await site.sync();
    const message = controlMessage({ maker: ctx.maker.address, artifactHash: l.artifactHash, chainId: '8453', address, stakeChainId: CHAIN_ID, stakeContract: ctx.address });
    assert.equal((await fact(l)).deployment.message, message);
    assert.equal((await fact(l)).deployment.chainId, '8453');
    await refused(await post(l, { signer: owner.address, signature: await owner.signMessage(message) }), 503, 'CHAIN_NOT_CHECKED');
    assert.equal((await fact(l)).controls, 'no');

    // a provider for the chain id that is really another chain: its contract does not count
    const local = siteFor(ctx, { chainProviderFor: (id) => (id === 8453 ? ctx.provider : null) });
    try {
      await local.sync();
      await assert.rejects(
        local.submitControlProof(l.artifactHash, String(l.listingId), { signer: owner.address, signature: await owner.signMessage(message) }),
        (err) => err.code === 'CHAIN_NOT_CHECKED',
      );
    } finally {
      local.close();
    }
  });

  test('a chain that does not answer in time leaves "no" and a retry; it never holds up a sync', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    let t = Date.now();
    let mode = 'ok';
    const flaky = new Proxy(ctx.provider, {
      get(target, prop) {
        if (mode !== 'ok' && ['getCode', 'call', 'getTransaction', 'getTransactionReceipt'].includes(prop)) {
          return mode === 'hang' ? () => new Promise(() => {}) : async () => { throw new Error('rpc down'); };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const local = siteFor(ctx, { provider: flaky, now: () => t, env: { SA_CONTROL_RPC_TIMEOUT_MS: '200', SA_CONTROL_RETRY_MS: '1000', SA_CONTROL_RECHECK_MS: '5000', SA_MAX_STALENESS_SECONDS: '100000000' } });
    try {
      await local.sync();
      const message = (await local.record(l.artifactHash)).control[l.listingId].deployment.message;
      const body = { signer: owner.address, signature: await owner.signMessage(message) };

      mode = 'hang';
      await assert.rejects(local.submitControlProof(l.artifactHash, String(l.listingId), body), (err) => err.code === 'CHAIN_UNAVAILABLE' && err.status === 503);
      mode = 'ok';
      await local.submitControlProof(l.artifactHash, String(l.listingId), body);
      assert.equal((await local.record(l.artifactHash)).control[l.listingId].controls, 'yes');

      // the recheck meets a hung chain: the sync does not wait, the fact goes to "no" and comes back
      mode = 'hang';
      t += 5001;
      await local.sync();
      await local.controlIdle();
      const down = (await local.record(l.artifactHash)).control[l.listingId];
      assert.equal(down.controls, 'no');
      assert.equal(down.reason, 'CHAIN_UNAVAILABLE');
      assert.equal(down.nextCheckAt, Math.floor((t + 1000) / 1000));
      mode = 'ok';
      t += 1001;
      await local.sync();
      await local.controlIdle();
      assert.equal((await local.record(l.artifactHash)).control[l.listingId].controls, 'yes');
    } finally {
      local.close();
    }
  });

  test('a proof sent while an older one is being re-checked stands: the older check\'s answer does not overwrite it', async () => {
    const { address, contract } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    let t = Date.now();
    let hold = null;
    let held = 0;
    const gated = new Proxy(ctx.provider, {
      get(target, prop) {
        if (prop === 'getCode' && hold) {
          const gate = hold;
          hold = null;
          return async (...a) => { held += 1; await gate; return target.getCode(...a); };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const local = siteFor(ctx, { provider: gated, now: () => t, env: { SA_CONTROL_RECHECK_MS: '1000', SA_MAX_STALENESS_SECONDS: '100000000' } });
    try {
      await local.sync();
      const message = (await local.record(l.artifactHash)).control[l.listingId].deployment.message;
      await local.submitControlProof(l.artifactHash, String(l.listingId), { signer: owner.address, signature: await owner.signMessage(message) });

      // ownership moves on, and the re-check of the old proof is under way
      await (await contract.connect(owner).transferOwnership(stranger.address)).wait();
      let release;
      hold = new Promise((r) => { release = r; });
      t += 1001;
      await local.sync();
      while (!held) await new Promise((r) => setTimeout(r, 10));

      // the new owner's proof arrives and counts
      const c = await local.submitControlProof(l.artifactHash, String(l.listingId), { signer: stranger.address, signature: await stranger.signMessage(message) });
      assert.equal(c.controls, 'yes');
      assert.equal(c.deployment.signer, stranger.address);

      // the old proof's check ends with "no": it answers for the old proof, not this one
      release();
      await local.controlIdle();
      const after = (await local.record(l.artifactHash)).control[l.listingId];
      assert.equal(after.controls, 'yes');
      assert.equal(after.deployment.signer, stranger.address);
    } finally {
      local.close();
    }
  });

  test('a check past its deadline keeps its place until its read settles, and reads no more: slow checks cannot pile up', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    let release;
    let armed = false;
    const gate = new Promise((r) => { release = r; });
    let started = 0;
    let readsAfterGate = 0;
    const slow = new Proxy(ctx.provider, {
      get(target, prop) {
        if (armed && prop === 'getCode') return async () => { started += 1; await gate; return '0x60'; };
        if (armed && ['call', 'getTransaction', 'getTransactionReceipt'].includes(prop)) return async () => { readsAfterGate += 1; return '0x'; };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const local = siteFor(ctx, { provider: slow, env: { SA_CONTROL_RPC_TIMEOUT_MS: '100' } });
    try {
      await local.sync();
      const message = (await local.record(l.artifactHash)).control[l.listingId].deployment.message;
      const body = { signer: owner.address, signature: await owner.signMessage(message) };
      const id = String(l.listingId);
      armed = true;

      // four checks reach the hung read and are given up at the deadline, one batch after another
      for (let i = 0; i < 4; i += 1) {
        await assert.rejects(local.submitControlProof(l.artifactHash, id, body), (err) => err.code === 'CHAIN_UNAVAILABLE');
      }
      assert.equal(started, 4);
      // they are still running: no fifth starts, whatever the deadline said
      await assert.rejects(local.submitControlProof(l.artifactHash, id, body), (err) => err.code === 'TOO_MANY_PROOF_CHECKS' && err.status === 429);
      assert.equal(started, 4);

      // their reads settle: none reads on, and the places are free again
      armed = false;
      release();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(readsAfterGate, 0);
      const c = await local.submitControlProof(l.artifactHash, id, body);
      assert.equal(c.controls, 'yes');
    } finally {
      local.close();
    }
  });

  test('a check\'s reads are one at a time, so none is in flight once it settles: a failed receipt read leaves no transaction read running', async () => {
    const { address, creationTx } = await deploy('MockOwnerless', deployer);
    const l = await contractListing(address);
    let failing = false;
    let txReads = 0;
    const flaky = new Proxy(ctx.provider, {
      get(target, prop) {
        if (failing && prop === 'getTransactionReceipt') return async () => { throw new Error('rpc down'); };
        if (failing && prop === 'getTransaction') return async () => { txReads += 1; return new Promise(() => {}); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const local = siteFor(ctx, { provider: flaky });
    try {
      await local.sync();
      const message = (await local.record(l.artifactHash)).control[l.listingId].deployment.message;
      const body = { signer: deployer.address, signature: await deployer.signMessage(message), creationTx };
      failing = true;
      await assert.rejects(local.submitControlProof(l.artifactHash, String(l.listingId), body), (err) => err.code === 'CHAIN_UNAVAILABLE');
      assert.equal(txReads, 0);
      failing = false;
      assert.equal((await local.submitControlProof(l.artifactHash, String(l.listingId), body)).controls, 'yes');
    } finally {
      local.close();
    }
  });

  test('proof checks are bounded: a few at a time, the rest are told to come back', async () => {
    const { address } = await deploy('MockOwned', deployer, owner.address);
    const l = await contractListing(address);
    let release;
    let armed = false;
    const gate = new Promise((r) => { release = r; });
    const slow = new Proxy(ctx.provider, {
      get(target, prop) {
        if (prop === 'getCode' && armed) return async (...a) => { await gate; return target.getCode(...a); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const local = siteFor(ctx, { provider: slow, env: { SA_CONTROL_RPC_TIMEOUT_MS: '60000' } });
    try {
      await local.sync();
      const message = (await local.record(l.artifactHash)).control[l.listingId].deployment.message;
      const body = { signer: owner.address, signature: await owner.signMessage(message) };
      armed = true;
      const held = [];
      for (let i = 0; i < 4; i += 1) held.push(local.submitControlProof(l.artifactHash, String(l.listingId), body));
      await assert.rejects(local.submitControlProof(l.artifactHash, String(l.listingId), body), (err) => err.code === 'TOO_MANY_PROOF_CHECKS' && err.status === 429);
      release();
      await Promise.all(held);
    } finally {
      local.close();
    }
  });
});
