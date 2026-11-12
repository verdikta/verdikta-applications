// Acceptance 3 and 4 (node P4a): what the server returns for list() is what the contract takes,
// on the in-process Hardhat network with StakeAttestation from ../onchain (deployed as its own
// tests deploy it, against the mock aggregator) and mock pinning. The maker's wallet sends list()
// with the server's JSON as it is, then fund(); the listing opens, and what the contract stores
// is the archive's: the disclosure key, both CIDs, the known-issue ids, the award table, the
// windows and the record key.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ArchiveService, codeReview } from '../src/common.js';
import { LIST_LIMITS } from '../src/listing/listParams.js';
import { contractDraft, draftSpec, fakeBuilder, knownIssues, listingRequest } from './helpers/fixtures.js';
import { deployStakeAttestation, hardhat } from './helpers/chain.js';
import { startApi } from './helpers/http.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const archiveService = new ArchiveService({ fetchFromIPFS: async () => { throw new Error('no IPFS in tests'); } }, quiet);
const State = { Listed: 0n, Open: 1n };
const DAY = 86400n;
const HOUR = 3600n;

let hre;
let s;
let tmp;

before(async () => {
  hre = await hardhat();
  s = await startApi({ builder: fakeBuilder() });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-server-chain-'));
});
after(async () => {
  await s?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** The ready listing view for a request body. */
async function ready(body) {
  const res = await s.submit(body);
  assert.equal(res.status, 202);
  const view = await s.settle((await res.json()).id);
  assert.equal(view.status, 'ready', JSON.stringify(view.error));
  return view;
}

/** A member of a pinned archive, read from the mock store as the EA would extract it. */
async function archiveMember(cid, name) {
  const dir = fs.mkdtempSync(path.join(tmp, 'x-'));
  const root = await archiveService.extractArchive(s.pinner.get(cid), 'a.zip', dir);
  return fs.readFileSync(path.join(root, name));
}

async function listAndFund(view, signer, sa) {
  const { params, listingCid, disputeCid, knownIssueIds } = view.list;
  // the JSON as the server sent it: decimal strings for uint256 and uint64, hex for bytes32
  const rc = await (await sa.connect(signer).list(params, listingCid, disputeCid, knownIssueIds)).wait();
  const listed = rc.logs.map((l) => { try { return sa.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Listed');
  const listingId = listed.args.listingId;
  const l = await sa.getListing(listingId);
  assert.equal(l.state, State.Listed);
  const fee = await sa.feeDue(listingId);
  const escrow = BigInt(params.awards[3]);
  await (await sa.connect(signer).fund(listingId, fee, { value: fee + escrow })).wait();
  return { listingId, listed };
}

for (const [label, spec] of [['a repository listing', draftSpec()], ['a contract listing', contractDraft()]]) {
  describe(`${label}: list() and fund() with the server's arguments`, () => {
    let view;
    let deployment;
    let listingId;
    let listed;
    before(async () => {
      deployment = await deployStakeAttestation(hre);
      view = await ready(listingRequest({ spec, allowlist: [deployment.hunter.address.toLowerCase()] }));
      ({ listingId, listed } = await listAndFund(view, deployment.maker, deployment.sa));
    });

    test('the on-chain disclosureKey equals the listing archive\'s (and the dispute archive\'s)', async () => {
      const l = await deployment.sa.getListing(listingId);
      for (const cid of [view.archives.listing.cid, view.archives.dispute.cid]) {
        const archived = JSON.parse(await archiveMember(cid, 'code_review.json'));
        const bytes32 = `0x${Buffer.from(codeReview.parseDisclosureKey(archived.stake.disclosureKey)).toString('hex')}`;
        assert.equal(l.disclosureKey, bytes32);
        assert.equal(archived.stake.disclosureKey, spec.stake.disclosureKey, 'the maker\'s key, unchanged');
      }
    });

    test('the contract stores both CIDs, the archive\'s known-issue ids and the stake terms', async () => {
      const sa = deployment.sa;
      const l = await sa.getListing(listingId);
      assert.equal(l.listingCid, view.archives.listing.cid);
      assert.equal(l.disputeCid, view.archives.dispute.cid);
      const archived = JSON.parse(await archiveMember(view.archives.listing.cid, 'code_review.json'));
      const issues = archived.stake.knownIssues ? JSON.parse(await archiveMember(view.archives.listing.cid, archived.stake.knownIssues)) : [];
      assert.deepEqual([...l.knownIssueIds], issues.map((k) => `0x${k.id.slice(7)}`).sort());
      assert.deepEqual([...l.awards], codeReview.SEVERITY_CLASSES.map((c) => codeReview.awardsToWei(archived.stake.awards)[c]));
      assert.equal(l.bondWei, BigInt(archived.stake.bondWei));
      assert.equal(l.lowestClassCounted, BigInt(2 + codeReview.SEVERITY_CLASSES.indexOf(archived.stake.lowestClassCounted)));
      const eff = codeReview.effectiveStake(archived);
      assert.equal(l.fixWindow, BigInt(eff.fixWindowDays) * DAY);
      assert.equal(l.disputeWindow, BigInt(eff.disputeWindowHours) * HOUR);
      assert.equal(l.disclosureGrace, BigInt(eff.disclosureGraceHours) * HOUR);
      assert.equal(l.revealWindow, BigInt(eff.revealWindowDays) * DAY);
      assert.equal(l.valueAtRiskUsd, BigInt(archived.stake.valueAtRiskUsd ?? 0));
      assert.deepEqual([...l.allowlist], [deployment.hunter.address]);
      assert.equal(l.oracle.requestedClass, BigInt(codeReview.CODE_CLASSES['code-standard'].classId));
      assert.equal(l.oracle.maxOracleFee, BigInt(view.list.params.oracle.maxOracleFee));
      assert.equal(l.oracle.disputeMaxOracleFee, BigInt(view.list.params.oracle.disputeMaxOracleFee));
    });

    test('the record key is the server\'s artifactHash and the contract\'s artifactHashOf', async () => {
      const sa = deployment.sa;
      const l = await sa.getListing(listingId);
      assert.equal(l.artifactHash, view.artifactHash);
      assert.equal(listed.args.artifactHash, view.artifactHash);
      assert.equal(await sa.artifactHashOf(view.list.params.artifact), view.artifactHash);
      if (spec.artifact?.kind === 'contract') {
        assert.equal(l.artifactChainId, BigInt(spec.artifact.chainId));
        assert.equal(l.artifactAddress.toLowerCase(), spec.artifact.address.toLowerCase());
      }
    });

    test('fund() opens it, and the record (read through the lens, merged ABI) shows it', async () => {
      const sa = deployment.sa;
      const l = await sa.getListing(listingId);
      assert.equal(l.state, State.Open);
      assert.equal(l.escrowWei, BigInt(view.list.params.awards[3]));
      assert.equal(await sa.acceptsCommits(listingId), true);
      const record = await sa.recordByHash(view.artifactHash);
      assert.equal(record.listingCount, 1n);
      assert.deepEqual([...record.active], [listingId]);
      assert.equal(record.listings[0].listingId, listingId);
    });
  });
}

describe('one listing per hash and maker: the second list() of the same version reverts', () => {
  test('the contract, not the server, keeps that rule', async () => {
    const d = await deployStakeAttestation(hre);
    const view = await ready(listingRequest({ spec: draftSpec(), issues: knownIssues() }));
    await listAndFund(view, d.maker, d.sa);
    const { params, listingCid, disputeCid, knownIssueIds } = view.list;
    await assert.rejects(d.sa.connect(d.maker).list(params, listingCid, disputeCid, knownIssueIds), /active listing exists/);
  });
});

describe('the bounds the server checks before a build are the deployed contract\'s', () => {
  test('LIST_LIMITS equals StakeAttestation\'s constants', async () => {
    const { sa } = await deployStakeAttestation(hre);
    for (const [name, value] of Object.entries(LIST_LIMITS)) {
      assert.equal(await sa[name](), BigInt(value), name);
    }
  });
});
