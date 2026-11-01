// StakeAttestation, the record (build node P2e). Design: verdikta-arbiter
// docs/development/stake-attestation-design.md §4.1 (what the record is) and §13.4 (record and
// lookup); the build plan's decisions override it where they differ
// (stake-attestation/docs/BUILD_PLAN.md).
//
// recordByHash(artifactHash) (the lens, answered at the contract's address) returns, for one
// artifact hash: every listing of it with its state, terms, money and lineage (`listings`, and
// `active`, the ids of those not Closed); the history summed over them (claims committed while
// staked, pending, settled by outcome, released, undisclosed, unrevealed, no verdict, disputes
// and their results; and `later`: late claims, their outcomes and expiries); the valid findings
// (class, paid, owed, revealed-at, settled-at, bcid, dispute result; late ones marked); and the
// bad-disclosure flags (each flagged claim's state and outcome, from which a reader sees a flag
// the reveal refuted). Facts only: labels (scanned, staked, under-staked, invited, lapsed, false
// flag) are computed off-chain (P4b1). recordPage(artifactHash, listingOffset, listingLimit,
// itemOffset, itemLimit) pages it for a long history.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { codeReview } = require("@verdikta/common");
const H = require("./helpers/claims");

const {
  ListingState, Outcome, ClaimState, DisputeResult, DAY, FIX, GRACE, DISPUTE, REVEAL,
  BCID, JUSTIFICATION, TOP, AWARDS, BOND, FEE, V, ARCHIVE,
  params, freshCommit, atCommit, deploy, eventsOf, blockTime,
  listAs, openListing, commitAs, claimAs, revealAs, revealedClaim, judgeAs, afterDisputeWindow,
  disputeAs, judgeDisputeAs, lateClaimAs, recordOf, listingIn, outcomesOf, lateOutcomesOf, findingIds, flagIds,
} = H;
const { ZeroAddress, ZeroHash, MaxUint256 } = ethers;

const LISTING_PERIOD = 30n * DAY;
const cidOf = (i) => `Qm${"R".repeat(41)}${String(i).padStart(3, "0")}`;
const hashOf = async (sa, id) => (await sa.getListing(id)).artifactHash;
// A decoded record as nested plain arrays, for deep equality between two decodings.
const plain = (v) => (v instanceof ethers.Result ? [...v].map(plain) : v);

// A claim on `listingId` taken to the end: released if its fix window is open, revealed, judged
// `vector`, and settled (after the dispute window for a valid outcome). `flag`: the maker flags
// it first (the listing needs a disclosure grace).
async function settledClaim(sa, aggregator, maker, hunter, listingId, vector, { bcid, flag = false } = {}) {
  const { claimId } = await claimAs(sa, hunter, listingId);
  if (flag) await sa.connect(maker).flagBadDisclosure(claimId);
  if ((await sa.claimState(claimId)) === ClaimState.Committed) await sa.connect(maker).release(claimId);
  await revealAs(sa, hunter, claimId, { bcid: bcid ?? BCID });
  await judgeAs(sa, aggregator, hunter, claimId, vector);
  await afterDisputeWindow(sa, claimId);
  await sa.settle(claimId);
  return claimId;
}

const emptyHistory = (h) => {
  for (const k of ["claims", "pending", "released", "undisclosed", "unrevealed", "noVerdict", "disputes",
    "disputesHeld", "disputesOverturned", "disputesNoVerdict", "lateClaims", "lateExpired"]) {
    expect(h[k], k).to.equal(0n);
  }
  expect(outcomesOf(h)).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n]);
  expect(lateOutcomesOf(h)).to.deep.equal([0n, 0n, 0n, 0n, 0n, 0n]);
};

describe("StakeAttestation: the record (P2e, design §4.1, §13.4)", function () {
  // ------------------------------------------------------------------ listings
  describe("listings, terms, money and lineage", function () {
    it("an unknown hash has an empty record", async function () {
      const { sa } = await loadFixture(deploy);
      const h = ethers.keccak256(ethers.toUtf8Bytes("never listed"));
      const r = await sa.recordByHash(h);
      expect(r.artifactHash).to.equal(h);
      expect(r.listingCount).to.equal(0n);
      expect([r.active.length, r.listings.length, r.findings.length, r.flags.length]).to.deep.equal([0, 0, 0, 0]);
      expect([r.findingCount, r.flagCount]).to.deep.equal([0n, 0n]);
      emptyHistory(r.history);
    });

    it("returns each listing's state, kind, terms, money and times; active names those not Closed", async function () {
      const { sa, maker, other, hunters } = await loadFixture(deploy);
      const artifact = { kind: 1n, repo: H.REPO, baseCommit: freshCommit(), chainId: 8453n, addr: hunters[9].address };
      const p = params({ artifact, allowlist: [hunters[0].address], valueAtRiskUsd: 250_000n });
      const listed = await listAs(sa, maker, p);
      const listedAt = (await sa.getListing(listed)).listedAt;
      let r = await sa.recordByHash(await hashOf(sa, listed));
      expect(r.kind).to.equal(1n);
      expect(r.listingCount).to.equal(1n);
      expect([...r.active]).to.deep.equal([listed]);
      let lr = r.listings[0];
      expect([lr.listingId, lr.maker, lr.state]).to.deep.equal([listed, maker.address, ListingState.Listed]);
      expect([lr.openedAt, lr.fundedUntil, lr.lapsed]).to.deep.equal([0n, 0n, false]);

      const fee = await sa.feeDue(listed);
      const fundRc = await (await sa.connect(maker).fund(listed, fee, { value: fee + TOP + 5n })).wait();
      const openedAt = await blockTime(fundRc);
      // The same hash listed by a second maker: one record, two listings.
      const second = await openListing(sa, other, p);
      r = await sa.recordByHash(await hashOf(sa, listed));
      expect(r.listingCount).to.equal(2n);
      expect([...r.active]).to.deep.equal([listed, second]);
      lr = listingIn(r, listed);
      expect(lr.state).to.equal(ListingState.Open);
      expect(lr.invited).to.equal(true);
      expect(lr.artifactChainId).to.equal(8453n);
      expect(lr.artifactAddress).to.equal(hunters[9].address);
      expect([lr.listedAt, lr.openedAt, lr.fundedUntil]).to.deep.equal([listedAt, openedAt, openedAt + LISTING_PERIOD]);
      expect([lr.rolledAt, lr.closedAt]).to.deep.equal([0n, 0n]);
      expect([...lr.awards]).to.deep.equal(AWARDS);
      expect(lr.lowestClassCounted).to.equal(Outcome.MEDIUM);
      expect([lr.bondWei, lr.escrowWei, lr.owedWei, lr.valueAtRiskUsd]).to.deep.equal([BOND, TOP + 5n, 0n, 250_000n]);
      expect([lr.predecessor, lr.predecessorHash, lr.successor, lr.successorHash]).to.deep.equal([0n, ZeroHash, 0n, ZeroHash]);
      expect(listingIn(r, second).maker).to.equal(other.address);

      // Lapsed once the paid period ends (the feed drops it; the record keeps it).
      await time.increaseTo(openedAt + LISTING_PERIOD);
      expect(listingIn(await sa.recordByHash(await hashOf(sa, listed)), listed).lapsed).to.equal(true);

      // Closed: the badge ends, the listing stays on the record with its close time.
      const closeRc = await (await sa.connect(maker).close(listed)).wait();
      r = await sa.recordByHash(await hashOf(sa, listed));
      expect([...r.active]).to.deep.equal([second]);
      lr = listingIn(r, listed);
      expect([lr.state, lr.closedAt, lr.escrowWei]).to.deep.equal([ListingState.Closed, await blockTime(closeRc), 0n]);
    });

    it("lineage: a roll-forward links both records, the predecessor's successor hash and the successor's predecessor hash", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const a = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const b = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const c = await openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      const [ha, hb, hc] = [await hashOf(sa, a), await hashOf(sa, b), await hashOf(sa, c)];
      const rolledAt = await blockTime(await (await sa.connect(maker).rollForward(a, b)).wait());
      await sa.connect(maker).rollForward(b, c);

      const ra = (await sa.recordByHash(ha)).listings[0];
      expect([ra.state, ra.rolledAt]).to.deep.equal([ListingState.Rolled, rolledAt]);
      expect([ra.predecessor, ra.predecessorHash, ra.successor, ra.successorHash]).to.deep.equal([0n, ZeroHash, b, hb]);
      const rb = (await sa.recordByHash(hb)).listings[0];
      expect([rb.predecessor, rb.predecessorHash, rb.successor, rb.successorHash]).to.deep.equal([a, ha, c, hc]);
      const rc = await sa.recordByHash(hc);
      expect([...rc.active]).to.deep.equal([c]); // the badge moved to the latest version
      expect([rc.listings[0].predecessor, rc.listings[0].predecessorHash]).to.deep.equal([b, hb]);
      expect((await sa.recordByHash(ha)).active.length).to.equal(1); // Rolled is not Closed: it still settles claims
    });
  });

  // ------------------------------------------------------------------ history
  describe("the history", function () {
    it("counts every way a claim ends: outcomes, released, undisclosed, unrevealed, no verdict, disputes held / overturned / without a verdict, pending", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }), { escrow: 3n * TOP });
      const h = hunters;
      // INVALID, released.
      await settledClaim(sa, aggregator, maker, h[0], id, V.INVALID, { bcid: cidOf(1) });
      // Undisclosed.
      const u = await commitAs(sa, h[1], id);
      await time.setNextBlockTimestamp(u.at + H.HOUR);
      await sa.connect(other).expire(u.claimId);
      // Unrevealed (released, never revealed).
      const n = await claimAs(sa, h[2], id);
      const relRc = await (await sa.connect(maker).release(n.claimId)).wait();
      await time.setNextBlockTimestamp((await blockTime(relRc)) + REVEAL);
      await sa.connect(other).expire(n.claimId);
      // No verdict: a failed round never re-triggered.
      const f = await claimAs(sa, h[3], id);
      await sa.connect(maker).release(f.claimId);
      await revealAs(sa, h[3], f.claimId, { bcid: cidOf(4) });
      await time.increase(300);
      const failRc = await (await sa.finalize(f.claimId)).wait();
      await time.setNextBlockTimestamp((await blockTime(failRc)) + REVEAL);
      await sa.connect(other).expire(f.claimId);
      // Disputes: held, overturned, no verdict.
      const disputed = [];
      for (const [i, [first, panel]] of [[V.HIGH, V.HIGH], [V.CRITICAL, V.MEDIUM], [V.MEDIUM, null]].entries()) {
        const { claimId } = await claimAs(sa, h[4 + i], id);
        await sa.connect(maker).release(claimId);
        await revealAs(sa, h[4 + i], claimId, { bcid: cidOf(5 + i) });
        await judgeAs(sa, aggregator, other, claimId, first);
        await disputeAs(sa, maker, claimId);
        if (panel) await judgeDisputeAs(sa, aggregator, other, claimId, panel);
        else {
          await time.increase(300); // the dispute round times out: the first verdict stands
          await sa.finalize(claimId);
        }
        await sa.settle(claimId);
        disputed.push(claimId);
      }
      // Pending: committed and disclosed, not released.
      await claimAs(sa, h[7], id);

      const r = await recordOf(sa, id);
      for (const hist of [r.history, listingIn(r, id).history]) {
        expect(hist.claims).to.equal(8n);
        expect(hist.pending).to.equal(1n);
        expect(outcomesOf(hist)).to.deep.equal([1n, 0n, 0n, 2n, 1n, 0n]); // INVALID; MEDIUM (overturned), MEDIUM (stood); HIGH (held)
        expect(hist.released).to.equal(6n);
        expect([hist.undisclosed, hist.unrevealed, hist.noVerdict]).to.deep.equal([1n, 1n, 1n]);
        expect([hist.disputes, hist.disputesHeld, hist.disputesOverturned, hist.disputesNoVerdict]).to.deep.equal([3n, 1n, 1n, 1n]);
        expect([hist.lateClaims, hist.lateExpired]).to.deep.equal([0n, 0n]);
      }
      // The valid findings, in settlement order, with their dispute results.
      expect(findingIds(r)).to.deep.equal(disputed);
      expect([...r.findings].map((x) => x.dispute)).to.deep.equal([DisputeResult.Held, DisputeResult.Overturned, DisputeResult.NoVerdict]);
      expect([...r.findings].map((x) => x.outcome)).to.deep.equal([Outcome.HIGH, Outcome.MEDIUM, Outcome.MEDIUM]);
      expect([...r.findings].map((x) => x.paidWei)).to.deep.equal([AWARDS[2], AWARDS[1], AWARDS[1]]);
    });

    it("sums the history over every listing of the hash, Closed included, and keeps each listing's own", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const p = params({ artifact: atCommit(freshCommit()) });
      const first = await openListing(sa, maker, p);
      await settledClaim(sa, aggregator, maker, hunters[0], first, V.INVALID);
      await settledClaim(sa, aggregator, maker, hunters[1], first, V.LOW, { bcid: cidOf(1) });
      await sa.connect(maker).close(first);
      const again = await openListing(sa, maker, p); // the same maker lists the hash again
      await settledClaim(sa, aggregator, maker, hunters[2], again, V.DUPLICATE);
      const third = await openListing(sa, other, p, { escrow: 2n * TOP }); // and another maker
      await settledClaim(sa, aggregator, other, hunters[3], third, V.MEDIUM, { bcid: cidOf(2) });
      await claimAs(sa, hunters[4], third);

      const r = await recordOf(sa, first);
      expect(r.listingCount).to.equal(3n);
      expect([...r.active]).to.deep.equal([again, third]);
      expect([...r.listings].map((l) => l.listingId)).to.deep.equal([first, again, third]);
      expect(outcomesOf(r.history)).to.deep.equal([1n, 1n, 1n, 1n, 0n, 0n]);
      expect([r.history.claims, r.history.pending]).to.deep.equal([5n, 1n]);
      expect(outcomesOf(listingIn(r, first).history)).to.deep.equal([1n, 0n, 1n, 0n, 0n, 0n]);
      expect(outcomesOf(listingIn(r, again).history)).to.deep.equal([0n, 1n, 0n, 0n, 0n, 0n]);
      expect(outcomesOf(listingIn(r, third).history)).to.deep.equal([0n, 0n, 0n, 1n, 0n, 0n]);
      expect([...r.findings].map((f) => [f.listingId, f.bcid])).to.deep.equal([[first, cidOf(1)], [third, cidOf(2)]]);
    });
  });

  // ------------------------------------------------------------------ findings, flags, later
  describe("findings, flags and the later history", function () {
    it("valid findings carry class, paid, owed, revealed-at, settled-at, bcid and hunter; INVALID and DUPLICATE are counts only", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker); // escrow = the top award
      await settledClaim(sa, aggregator, maker, hunters[0], id, V.INVALID);
      await settledClaim(sa, aggregator, maker, hunters[1], id, V.DUPLICATE);
      // Both committed before the first payout leaves the listing Depleted.
      const high = (await claimAs(sa, hunters[2], id)).claimId;
      const crit = (await claimAs(sa, hunters[3], id)).claimId;
      for (const [claimId, hunter, v, bcid] of [[high, hunters[2], V.HIGH, cidOf(1)], [crit, hunters[3], V.CRITICAL, cidOf(2)]]) {
        await revealAs(sa, hunter, claimId, { bcid });
        await judgeAs(sa, aggregator, hunter, claimId, v);
        await afterDisputeWindow(sa, claimId);
        await sa.settle(claimId);
      }
      const r = await recordOf(sa, id);
      expect(r.findingCount).to.equal(2n);
      const [a, b] = r.findings;
      const ch = await sa.getClaim(high);
      expect([a.claimId, a.listingId, a.hunter, a.outcome, a.late]).to.deep.equal([high, id, hunters[2].address, Outcome.HIGH, false]);
      expect([a.paidWei, a.owedWei, a.revealedAt, a.settledAt, a.bcid]).to.deep.equal([AWARDS[2], 0n, ch.revealedAt, ch.settledAt, cidOf(1)]);
      expect(a.dispute).to.equal(DisputeResult.None);
      // The second ran the escrow short: paid what was left, the rest owed (shown on the record).
      expect([b.claimId, b.outcome, b.paidWei, b.owedWei]).to.deep.equal([crit, Outcome.CRITICAL, TOP - AWARDS[2], AWARDS[2]]);
      expect(listingIn(r, id).owedWei).to.equal(AWARDS[2]);
      // A top-up pays it; the finding shows it paid.
      await sa.connect(maker).fund(id, 0n, { value: AWARDS[2] });
      const after = (await recordOf(sa, id)).findings[1];
      expect([after.paidWei, after.owedWei]).to.deep.equal([TOP, 0n]);
    });

    it("bad-disclosure flags: every flagged claim in flag order, with its state and outcome, late ones marked", async function () {
      const { sa, aggregator, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }));
      const a = await settledClaim(sa, aggregator, maker, hunters[0], id, V.INVALID, { flag: true });
      const b = await settledClaim(sa, aggregator, maker, hunters[1], id, V.DUPLICATE, { flag: true });
      await settledClaim(sa, aggregator, maker, hunters[2], id, V.DUPLICATE); // not flagged
      const pending = await claimAs(sa, hunters[3], id);
      await sa.connect(maker).flagBadDisclosure(pending.claimId);
      let r = await recordOf(sa, id);
      expect(r.flagCount).to.equal(3n);
      expect(flagIds(r)).to.deep.equal([a, b, pending.claimId]);
      expect([...r.flags].map((f) => [f.state, f.outcome, f.late])).to.deep.equal([
        [ClaimState.Settled, Outcome.INVALID, false],
        [ClaimState.Settled, Outcome.DUPLICATE, false], // judged, so the disclosure verified: a false flag
        [ClaimState.Committed, Outcome.INVALID, false],
      ]);
      expect(r.flags[2].disclosedAt).to.equal(pending.disclosedAt);
      expect(r.flags[0].revealedAt).to.equal((await sa.getClaim(a)).revealedAt);
      expect(r.flags[0].judgedAt).to.equal((await sa.getClaim(a)).judgedAt);

      // A late claim's flag is listed too, marked late.
      await time.setNextBlockTimestamp(pending.disclosedAt + FIX);
      await revealAs(sa, hunters[3], pending.claimId);
      await judgeAs(sa, aggregator, hunters[3], pending.claimId, V.INVALID);
      await sa.settle(pending.claimId);
      await sa.connect(maker).close(id);
      const late = await lateClaimAs(sa, hunters[4], id);
      await sa.connect(maker).flagBadDisclosure(late.claimId);
      r = await recordOf(sa, id);
      expect(flagIds(r)).to.deep.equal([a, b, pending.claimId, late.claimId]);
      expect(r.flags[3].late).to.equal(true);
    });

    it("later: late claims are counted by outcome and expiry under later only, and a valid one is a finding marked late", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      await settledClaim(sa, aggregator, maker, hunters[0], id, V.MEDIUM, { bcid: cidOf(1) });
      await sa.connect(maker).close(id);
      const before = (await recordOf(sa, id)).history;

      const late = [];
      for (const [i, v] of [V.CRITICAL, V.INVALID, V.DUPLICATE].entries()) {
        const { claimId } = await lateClaimAs(sa, hunters[1 + i], id);
        await revealAs(sa, hunters[1 + i], claimId, { bcid: cidOf(2 + i) });
        await judgeAs(sa, aggregator, other, claimId, v);
        await afterDisputeWindow(sa, claimId);
        await sa.settle(claimId);
        late.push(claimId);
      }
      const undisclosed = await H.lateAs(sa, hunters[5], id);
      await time.setNextBlockTimestamp(undisclosed.at + H.HOUR);
      await sa.connect(other).expire(undisclosed.claimId);
      const pending = await lateClaimAs(sa, hunters[6], id);

      const r = await recordOf(sa, id);
      const hist = r.history;
      expect(hist.lateClaims).to.equal(5n);
      expect(lateOutcomesOf(hist)).to.deep.equal([1n, 1n, 0n, 0n, 0n, 1n]);
      expect(hist.lateExpired).to.equal(1n);
      // The stake's own history is untouched.
      for (const k of ["claims", "pending", "undisclosed", "unrevealed", "noVerdict", "released", "disputes"]) {
        expect(hist[k], k).to.equal(before[k]);
      }
      expect(outcomesOf(hist)).to.deep.equal(outcomesOf(before));
      expect([...r.findings].map((f) => [f.bcid, f.late])).to.deep.equal([[cidOf(1), false], [cidOf(2), true]]);
      expect(r.findings[1].claimId).to.equal(late[0]);
      expect(r.findings[1].paidWei).to.equal(0n);
      expect((await sa.getClaim(pending.claimId)).late).to.equal(true);
    });
  });

  // ------------------------------------------------------------------ catalogue fixture
  describe("catalogue fixtures (verdikta-common data/code-review-fixtures.v1.json)", function () {
    it("bad-disclosure-flag-then-verified-reveal: the maker flagged inside disclosureGraceHours; the reveal passes both commitment checks; the claim proceeds to judgement and the flag stays on the record as a false flag", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const { identity, recipient } = codeReview.generateDisclosureKeyPair();
      const disclosureKey = ethers.hexlify(codeReview.parseDisclosureKey(recipient));
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE, disclosureKey }));

      // The hunter encrypts the archive to the listing's key and commits both hashes.
      const plaintext = ethers.toUtf8Bytes("a claim archive the maker says does not decrypt");
      const secrets = codeReview.generateDisclosureSecrets();
      const ciphertext = codeReview.encryptForDisclosure(plaintext, recipient, secrets);
      const archive = codeReview.disclosureSha256(plaintext);
      const ct = codeReview.disclosureSha256(ciphertext);
      const { claimId, disclosedAt } = await claimAs(sa, hunter, id, { archive, ct });

      // The maker flags it inside the grace: a statement, not a verdict.
      await time.setNextBlockTimestamp(disclosedAt + GRACE - 1n);
      await expect(sa.connect(maker).flagBadDisclosure(claimId)).to.emit(sa, "Flagged").withArgs(claimId, id);
      expect((await sa.getClaim(claimId)).flaggedBadDisclosure).to.equal(true);

      // The reveal passes both commitment checks, from public data only.
      await time.setNextBlockTimestamp(disclosedAt + FIX);
      const { requestId } = await revealAs(sa, hunter, claimId, { ck: secrets.contentKey, ek: secrets.ephemeralKey });
      const parsed = codeReview.parseDisclosureLine((await aggregator.requestParams(requestId)).addendum);
      expect(parsed.ok).to.equal(true);
      const gate = codeReview.verifyDisclosure({
        plaintext, ciphertext, disclosureKey: ethers.getBytes((await sa.getListing(id)).disclosureKey), ...parsed.fields,
      });
      expect(gate).to.include({ ok: true, gate: "disclosure" });
      expect(ethers.hexlify(codeReview.decryptDisclosure(ciphertext, identity))).to.equal(ethers.hexlify(plaintext));

      // The claim proceeds to judgement.
      await judgeAs(sa, aggregator, other, claimId, V.MEDIUM);
      expect((await sa.getClaim(claimId)).state).to.equal(ClaimState.Judged);
      let r = await recordOf(sa, id);
      expect(r.flagCount).to.equal(1n);
      expect([r.flags[0].claimId, r.flags[0].state, r.flags[0].outcome]).to.deep.equal([claimId, ClaimState.Judged, Outcome.MEDIUM]);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.changeEtherBalance(hunter, AWARDS[1] + BOND);

      // The flag stays on the record, beside the valid verdict that refutes it.
      r = await recordOf(sa, id);
      expect(flagIds(r)).to.deep.equal([claimId]);
      expect([r.flags[0].state, r.flags[0].outcome, r.flags[0].late]).to.deep.equal([ClaimState.Settled, Outcome.MEDIUM, false]);
      expect(findingIds(r)).to.deep.equal([claimId]);
      expect((await sa.getClaim(claimId)).flaggedBadDisclosure).to.equal(true);
    });
  });

  // ------------------------------------------------------------------ paging and plumbing
  describe("paging and access", function () {
    it("recordPage pages the listings and the items; the pages add up to recordByHash", async function () {
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const p = params({ artifact: atCommit(freshCommit()), fixWindow: FIX, disclosureGrace: GRACE });
      const ids = [await openListing(sa, maker, p, { escrow: 3n * TOP })];
      for (let i = 0; i < 3; i++) await settledClaim(sa, aggregator, maker, hunters[i], ids[0], V.LOW, { bcid: cidOf(i), flag: i !== 1 });
      await sa.connect(maker).close(ids[0]);
      ids.push(await openListing(sa, other, p, { escrow: 3n * TOP })); // no claims
      ids.push(await openListing(sa, maker, p, { escrow: 3n * TOP }));
      for (let i = 3; i < 5; i++) await settledClaim(sa, aggregator, maker, hunters[i], ids[2], V.MEDIUM, { bcid: cidOf(i), flag: true });

      const h = await hashOf(sa, ids[0]);
      const full = await sa.recordByHash(h);
      expect(full.listingCount).to.equal(3n);
      expect([full.findingCount, full.flagCount]).to.deep.equal([5n, 4n]);
      expect([...full.findings].map((f) => f.bcid)).to.deep.equal([0, 1, 2, 3, 4].map(cidOf));

      // recordByHash is recordPage over everything.
      const all = await sa.recordPage(h, 0n, MaxUint256, 0n, MaxUint256);
      expect(plain(all)).to.deep.equal(plain(full));

      // Items page across listings: [2, 4) of the findings spans the first and third listings.
      const mid = await sa.recordPage(h, 0n, 3n, 2n, 2n);
      expect([...mid.findings].map((f) => f.bcid)).to.deep.equal([cidOf(2), cidOf(3)]);
      expect([...mid.findings].map((f) => f.listingId)).to.deep.equal([ids[0], ids[2]]);
      expect([...mid.flags].map((f) => f.claimId)).to.deep.equal([full.flags[2].claimId, full.flags[3].claimId]);
      expect([mid.findingCount, mid.flagCount]).to.deep.equal([5n, 4n]); // totals over the listing page
      // Concatenated item pages are the whole list.
      const paged = [];
      for (let off = 0n; off < full.findingCount; off += 2n) paged.push(...(await sa.recordPage(h, 0n, 3n, off, 2n)).findings);
      expect(paged.map((f) => f.claimId)).to.deep.equal(findingIds(full));

      // A listing page sums its own listings only.
      const last = await sa.recordPage(h, 1n, 2n, 0n, MaxUint256);
      expect([...last.listings].map((l) => l.listingId)).to.deep.equal([ids[1], ids[2]]);
      expect([...last.active]).to.deep.equal([ids[1], ids[2]]);
      expect(outcomesOf(last.history)).to.deep.equal([0n, 0n, 0n, 2n, 0n, 0n]);
      expect([last.findingCount, last.flagCount]).to.deep.equal([2n, 2n]);
      expect(last.listingCount).to.equal(3n); // always the hash's total
      const first = await sa.recordPage(h, 0n, 1n, 0n, MaxUint256);
      expect(outcomesOf(first.history)).to.deep.equal([0n, 0n, 3n, 0n, 0n, 0n]);
      expect([...first.active]).to.deep.equal([]); // the first listing closed

      // Out of range and empty pages.
      const none = await sa.recordPage(h, 3n, 10n, 0n, 10n);
      expect([none.listings.length, none.findings.length, none.flags.length]).to.deep.equal([0, 0, 0]);
      expect([none.findingCount, none.listingCount]).to.deep.equal([0n, 3n]);
      const zero = await sa.recordPage(h, 0n, 3n, 0n, 0n);
      expect([zero.findings.length, zero.flags.length, zero.listings.length]).to.deep.equal([0, 0, 3]);
      const past = await sa.recordPage(h, 0n, 3n, 9n, 5n);
      expect([past.findings.length, past.flags.length]).to.deep.equal([0, 0]);
    });

    it("answers at the contract's address and at the lens's own; recordData is the record ABI-encoded", async function () {
      const { sa, aggregator, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      await settledClaim(sa, aggregator, maker, hunter, id, V.MEDIUM, { bcid: cidOf(1) });
      const h = await hashOf(sa, id);
      const viaHost = await sa.recordByHash(h);
      const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
      expect(plain(await lens.recordByHash(h))).to.deep.equal(plain(viaHost));
      expect(viaHost.findings[0].bcid).to.equal(cidOf(1));
      const raw = await sa.recordData(h, 0n, MaxUint256, 0n, MaxUint256);
      const type = sa.interface.getFunction("recordByHash").outputs[0];
      const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode([type], raw);
      expect(plain(decoded)).to.deep.equal(plain(viaHost));
      // The lens holds no state: its own storage is empty, so it can only read through the host.
      expect(await ethers.provider.getStorage(await sa.lens(), 0)).to.equal(ZeroHash);
    });

    it("gas on a long history: a few hundred claims on one hash", async function () {
      if (hre.__SOLIDITY_COVERAGE_RUNNING) this.skip(); // coverage instruments every step: no gas figure
      this.timeout(600_000);
      const { sa, aggregator, maker, other, hunters } = await loadFixture(deploy);
      const N = 300;
      const id = await openListing(sa, maker, params({ fixWindow: FIX, disclosureGrace: GRACE }), { escrow: 20n * TOP });
      // 300 claims: a third valid (LOW pays nothing below the counted class; MEDIUM is paid), a
      // third DUPLICATE, a third INVALID; every fifth flagged by the maker.
      const plan = (i) => (i % 3 === 0 ? (i % 2 === 0 ? V.LOW : V.MEDIUM) : i % 3 === 1 ? V.DUPLICATE : V.INVALID);
      for (let i = 0; i < N; i++) {
        const hunter = hunters[i % hunters.length];
        // The valid claims' dispute windows add up to months: keep the listing period paid.
        if (await sa.isLapsed(id)) await sa.connect(maker).renew(id, { value: H.LISTING_FEE });
        const { claimId } = await claimAs(sa, hunter, id);
        if (i % 5 === 0) await sa.connect(maker).flagBadDisclosure(claimId);
        await sa.connect(maker).release(claimId);
        await sa.connect(hunter).reveal(claimId, cidOf(i), H.CK, H.EK, { value: 0n });
        const { requestId } = await sa.getClaim(claimId);
        await aggregator.scriptResult(requestId, plan(i).map(BigInt), JUSTIFICATION);
        await sa.connect(other).finalize(claimId);
        if (plan(i) === V.LOW || plan(i) === V.MEDIUM) await time.increase(DISPUTE);
        await sa.connect(other).settle(claimId);
      }
      const h = await hashOf(sa, id);
      const full = await sa.recordByHash(h);
      expect(full.history.claims).to.equal(BigInt(N));
      expect(full.findingCount).to.equal(100n);
      expect(full.flagCount).to.equal(60n);
      expect(outcomesOf(full.history)).to.deep.equal([100n, 100n, 50n, 50n, 0n, 0n]);

      const gasOf = (data) => ethers.provider.estimateGas({ to: sa.target, data });
      const enc = (fn, args) => sa.interface.encodeFunctionData(fn, args);
      const gFull = await gasOf(enc("recordByHash", [h]));
      const gPage = await gasOf(enc("recordPage", [h, 0n, MaxUint256, 0n, 50n]));
      const gHead = await gasOf(enc("recordPage", [h, 0n, MaxUint256, 0n, 0n]));
      console.log(`      recordByHash, ${N} claims (100 findings, 60 flags): ${gFull} gas; a 50-item page: ${gPage}; no items: ${gHead}`);
      // An RPC's eth_call cap is commonly 50M (geth's default) and Hardhat's 30M block limit:
      // a few hundred claims fit in one call with room to spare, and pages stay small.
      expect(gFull).to.be.lessThan(10_000_000n);
      expect(gPage).to.be.lessThan(5_000_000n);
      expect(gHead).to.be.lessThan(500_000n);
    });
  });
});
