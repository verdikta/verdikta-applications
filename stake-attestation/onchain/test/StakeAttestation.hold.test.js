// StakeAttestation, the maker's hold (build node P39; owner decision of 2026-11-23, issue #226).
//
// A public fix is a public disclosure. To roll a stake forward the maker publishes the fixed commit,
// has it validated, lists it and funds it, and only then calls rollForward; until that call the old
// listing took commits, so anyone who read the fix could claim the bug on it. hold() is the first
// half of a roll forward: one call by the maker that stops new commits at once and leaves every
// pending claim alone.
//   - hold(listingId): the maker only, on an Open or a Depleted listing, once. It records the time
//     (heldAt) and emits Held. No delay and no resume: a hold ends in rollForward or in close,
//     whose conditions are what they were. Its refusals use reasons the contract already had:
//     "not maker", "not rollable" (neither Open nor Depleted: where a roll forward is refused
//     too) and "not accepting commits" (held already).
//   - While held the listing takes no commit (acceptsCommits is false) and takes a late claim, as a
//     Rolled listing does (decision D6: judged, recorded under `later`, no award).
//   - Nothing else reads the hold, so a claim committed before it keeps every path: its fix
//     window, its reveal in commit order, its rounds, its dispute and appeal, its award.
//   - Additive: no struct, event or function the contract had changes shape. The time is a mapping
//     of its own, read through heldAt, never a field of the Listing that getListing returns.
//     heldAt answers the time while the listing is on hold and 0 when it is not: never held, or
//     the hold has ended in a roll forward or a close.
//
// "Unchanged" is tested by difference. A path (a claim's life, written once) runs from one chain
// state with no hold, and again with the hold in each place it could fall after the claim's
// commit. Every transaction is mined at a stated second and the hold's place holds an empty
// transaction when the hold is not there, so the runs happen at the same times and in the same
// blocks, and everything the contract says afterwards must be equal: each step's events, the
// claims and the listing as stored, the lens's answers, the record, the money the contract holds.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers, network } = hre;
const { time, loadFixture, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");
const { mergedAbi } = require("../deploy/helpers");

const {
  ListingState, Outcome, ClaimState, Expiry, DisputeResult, DisputeKind, HOUR, DAY, FIX, GRACE, DISPUTE, REVEAL,
  CT_CID, JUSTIFICATION, STATEMENT_CID, ARCHIVE, CT, CK, EK, LISTING_FEE, TOP, AWARDS, BOND, FEE, V,
  params, freshCommit, atCommit, deploy, deployDefaults, eventsOf, blockTime,
  listAs, openListing, commitAs, claimAs, revealAs, judgeAs, afterDisputeWindow, lateClaimAs, recordOf,
} = H;

const LISTING_PERIOD = 30n * DAY;
const ROUND_TIMEOUT = 300n; // the mock aggregator's response timeout
const TICK = 10n;
const cidOf = (i) => `Qm${"H".repeat(42)}${String(i).padStart(2, "0")}`;
const archiveOf = (i) => ethers.sha256(ethers.toUtf8Bytes(`claim archive ${i}`));
const fresh = (overrides = {}) => params({ artifact: atCommit(freshCommit()), ...overrides });

// ---- plain values, for deep equality ----
const plain = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
// A decoded value as an object keyed by the ABI's component names (bigints as digit strings).
function objectOf(type, value) {
  if (type.baseType === "tuple") return Object.fromEntries(type.components.map((c, i) => [c.name, objectOf(c, value[i])]));
  if (type.baseType === "array") return [...value].map((v) => objectOf(type.arrayChildren, v));
  return typeof value === "bigint" ? value.toString() : value;
}
const named = (sa, fn, value) => objectOf(sa.interface.getFunction(fn).outputs[0], value);
// The contract's events in a receipt, as [name, args].
const logsOf = (sa, rc) => rc.logs
  .filter((l) => l.address.toLowerCase() === sa.target.toLowerCase())
  .map((l) => sa.interface.parseLog(l))
  .map((e) => (e ? [e.name, plain(e.args)] : ["?", []]));

// A listing a payout left below its top award: Depleted, with nothing owed, or with an award owed
// (both claims are committed first: a Depleted listing takes no commit).
async function depletedListing(f, { owed = false, p = fresh() } = {}) {
  const { sa, aggregator, maker, other, hunters } = f;
  const id = await openListing(sa, maker, p);
  const claims = [[await claimAs(sa, hunters[4], id, { archive: archiveOf(90) }), hunters[4], owed ? V.CRITICAL : V.HIGH]];
  if (owed) claims.push([await claimAs(sa, hunters[5], id, { archive: archiveOf(91) }), hunters[5], V.MEDIUM]);
  for (const [{ claimId }, hunter, vector] of claims) {
    await revealAs(sa, hunter, claimId, { bcid: cidOf(Number(claimId)) });
    await judgeAs(sa, aggregator, other, claimId, vector);
    await afterDisputeWindow(sa, claimId);
    await sa.settle(claimId);
  }
  const l = await sa.getListing(id);
  expect([l.state, l.owedWei > 0n]).to.deep.equal([ListingState.Depleted, owed]);
  return id;
}

// ---------------------------------------------------------------------------------------------
// A path's run. `places` says what goes in each place after the commits: the maker's hold in place
// `hold`, a roll forward in place `roll`, else an empty transaction. Returns what the contract
// says afterwards (`same`: what must not depend on the hold) and what it says of the hold.
// ---------------------------------------------------------------------------------------------
async function run(f, listingId, start, places, body) {
  const { sa, aggregator, maker, other } = f;
  const { hold = -1, roll = -1, successor = 0n } = places;
  let now = start;
  let placesSeen = 0;
  let placesOn = false;
  let heldAt = 0n;
  const steps = [];
  const claimIds = [];
  const hunterOf = new Map();
  const tick = async () => {
    now += TICK;
    await time.setNextBlockTimestamp(now);
  };
  const track = (claimId, hunter) => {
    claimIds.push(claimId);
    hunterOf.set(claimId, hunter);
    return claimId;
  };
  const w = {
    listingId,
    successor,
    // one transaction, mined at the next tick; its events and the contract's balance are observed
    async tx(label, send) {
      await tick();
      const rc = await (await send()).wait();
      steps.push([label, logsOf(sa, rc), String(await ethers.provider.getBalance(sa.target))]);
      if (placesOn) await w.place();
      return rc;
    },
    // a call the contract refuses, the same way in every run (nothing is mined)
    async refused(label, send, reason) {
      await tick();
      await expect(send(), label).to.be.revertedWith(reason);
      steps.push([label, `refused: ${reason}`, String(await ethers.provider.getBalance(sa.target))]);
    },
    // a place the hold could fall in
    async place() {
      await tick();
      const k = placesSeen++;
      if (k === hold) {
        const rc = await (await sa.connect(maker).hold(listingId)).wait();
        expect(rc.logs.length, "hold emits one event").to.equal(1);
        expect(logsOf(sa, rc), "hold emits Held with the listing and the time").to.deep.equal([["Held", plain([listingId, now])]]);
        expect(await sa.heldAt(listingId), "heldAt is the time of the hold").to.equal(now);
        heldAt = now;
      } else if (k === roll) {
        await (await sa.connect(maker).rollForward(listingId, successor)).wait();
      } else {
        await (await maker.sendTransaction({ to: maker.address })).wait();
      }
    },
    // the commits are in: from here on every step is followed by a place for the hold
    async committed() {
      placesOn = true;
      await w.place();
    },
    // no place after the steps from here on (the listing rolls or closes: a hold is refused then)
    noMorePlaces() {
      placesOn = false;
    },
    wait(seconds) {
      now += BigInt(seconds);
    },
    async commit(hunter) {
      const n = claimIds.length + 1;
      const value = await sa.commitPrice(listingId);
      const rc = await w.tx(`commit ${n}`, () => sa.connect(hunter).commit(listingId, archiveOf(n), CT, { value }));
      return track(eventsOf(sa, rc, "Committed")[0].args.claimId, hunter);
    },
    async late(hunter) {
      const n = claimIds.length + 1;
      const value = await sa.commitPrice(listingId);
      const rc = await w.tx(`late claim ${n}`, () => sa.connect(hunter).lateClaim(listingId, archiveOf(n), CT, { value }));
      return track(eventsOf(sa, rc, "LateClaim")[0].args.claimId, hunter);
    },
    disclose: (c) => w.tx(`disclose ${c}`, () => sa.connect(hunterOf.get(c)).disclose(c, CT_CID)),
    flag: (c) => w.tx(`flag ${c}`, () => sa.connect(maker).flagBadDisclosure(c)),
    release: (c) => w.tx(`release ${c}`, () => sa.connect(maker).release(c)),
    revealCall: (c, value) => sa.connect(hunterOf.get(c)).reveal(c, cidOf(Number(c)), CK, EK, { value }),
    async reveal(c) {
      const value = await sa.revealTopUp(c);
      return w.tx(`reveal ${c}`, () => w.revealCall(c, value));
    },
    // the round's result arrives at the aggregator: the claim round's, or the dispute panel's
    async result(c, vector) {
      const k = await sa.getClaim(c);
      const requestId = k.state === ClaimState.Disputed ? k.disputeRequestId : k.requestId;
      return w.tx(`result ${c}`, () => aggregator.scriptResult(requestId, vector.map(BigInt), JUSTIFICATION));
    },
    finalize: (c) => w.tx(`finalize ${c}`, () => sa.connect(other).finalize(c)),
    settle: (c, by = other) => w.tx(`settle ${c}`, () => sa.connect(by).settle(c)),
    expire: (c) => w.tx(`expire ${c}`, () => sa.connect(other).expire(c)),
    confirm: (c) => w.tx(`confirm ${c}`, () => sa.connect(other).confirm(c)),
    async retrigger(c) {
      const value = await sa.retriggerTopUp(c);
      return w.tx(`retrigger ${c}`, () => sa.connect(hunterOf.get(c)).retrigger(c, { value }));
    },
    async dispute(c) {
      const value = await sa.disputeFee(listingId);
      return w.tx(`dispute ${c}`, () => sa.connect(maker).dispute(c, STATEMENT_CID, { value }));
    },
    async appeal(c) {
      const value = await sa.disputeFee(listingId);
      return w.tx(`appeal ${c}`, () => sa.connect(hunterOf.get(c)).appeal(c, { value }));
    },
    topUp: (value) => w.tx(`top-up ${value}`, () => sa.connect(maker).fund(listingId, 0n, { value })),
    renew: () => w.tx("renew", () => sa.connect(maker).renew(listingId, { value: LISTING_FEE })),
    rollForward: () => w.tx("rollForward", () => sa.connect(maker).rollForward(listingId, successor)),
    close: () => w.tx("close", () => sa.connect(maker).close(listingId)),
  };
  await body(w);

  const listing = await sa.getListing(listingId);
  const claims = {};
  for (const id of claimIds) {
    claims[id] = {
      stored: named(sa, "getClaim", await sa.getClaim(id)),
      state: String(await sa.claimState(id)),
      times: plain(await sa.claimTimes(id)),
      settleableAt: String(await sa.settleableAt(id)),
      appealDeadline: String(await sa.appealDeadline(id)),
      disputeDeadline: String(await sa.disputeDeadline(id)),
      retriggerDeadline: String(await sa.retriggerDeadline(id)),
      confirmWindow: plain(await sa.confirmWindow(id)),
    };
  }
  const accounts = [maker, other, f.feeRecipient, ...f.hunters.slice(0, 4)];
  const withdrawable = [];
  for (const a of accounts) withdrawable.push(String(await sa.withdrawable(a.address)));
  return {
    places: placesSeen,
    claimIds,
    same: {
      steps,
      claims,
      listing: named(sa, "getListing", listing),
      record: named(sa, "recordByHash", await sa.recordByHash(listing.artifactHash)),
      findings: plain(await sa.validFindings(listingId)),
      lapsed: await sa.isLapsed(listingId),
      feeDue: String(await sa.feeDue(listingId)),
      balance: String(await ethers.provider.getBalance(sa.target)),
      withdrawable,
    },
    hold: {
      // the time the hold was sent at, and whether it has ended since (the listing rolled or closed)
      sentAt: heldAt,
      ended: listing.state !== ListingState.Open && listing.state !== ListingState.Depleted,
      heldAt: await sa.heldAt(listingId),
      acceptsCommits: await sa.acceptsCommits(listingId),
      acceptsLateClaims: await sa.acceptsLateClaims(listingId),
    },
  };
}

// The path with no hold, then with the hold in every place it has: every run must leave the same
// observation. Returns the run with no hold; the chain is left as the last held run left it.
// Under solidity-coverage only the first and the last place run (the coverage job's time limit).
async function everyHoldPlace(f, listingId, body, places = {}) {
  const { sa } = f;
  const start = BigInt(await time.latest()) + 1000n;
  const snap = await takeSnapshot();
  const open = await run(f, listingId, start, places, body);
  expect(open.places, "the path has a place for the hold").to.be.greaterThan(0);
  expect(open.hold.heldAt, "no hold: heldAt").to.equal(0n);
  const all = [...Array(open.places).keys()];
  const tried = hre.__SOLIDITY_COVERAGE_RUNNING ? [...new Set([0, open.places - 1])] : all;
  for (const k of tried) {
    await snap.restore();
    const held = await run(f, listingId, start, { ...places, hold: k }, body);
    const where = `the hold in place ${k + 1} of ${open.places}`;
    expect(held.same, where).to.deep.equal(open.same);
    expect(held.hold.sentAt > 0n, `${where}: it was sent`).to.equal(true);
    // heldAt stays the time of the hold while the listing is on hold, and is 0 once the hold has ended.
    expect(held.hold.heldAt, `${where}: heldAt`).to.equal(held.hold.ended ? 0n : held.hold.sentAt);
    expect(held.hold.acceptsCommits, `${where}: no commit`).to.equal(false);
    expect(held.hold.acceptsLateClaims, `${where}: late claims`).to.equal(true);
    await expect(sa.connect(f.hunters[6]).commit(listingId, ARCHIVE, CT, { value: await sa.commitPrice(listingId) }), where)
      .to.be.revertedWith("not accepting commits");
  }
  return open;
}

// The events of one step of a run, by its label.
const eventsIn = (r, label) => {
  const step = r.same.steps.find(([l]) => l === label);
  expect(step, `step "${label}"`).to.not.equal(undefined);
  return step[1];
};
const eventNames = (r, label) => eventsIn(r, label).map(([name]) => name);

describe("StakeAttestation: the maker's hold (P39)", function () {
  this.timeout(600_000);

  // ------------------------------------------------------------------ hold()
  describe("hold()", function () {
    it("the maker holds an Open listing: the time is recorded, Held is emitted, and the listing and its record read as before", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      const id = await openListing(sa, maker);
      await claimAs(sa, hunters[0], id); // a pending claim: the hold leaves it where it is
      const read = async () => ({
        listing: named(sa, "getListing", await sa.getListing(id)),
        record: named(sa, "recordByHash", await recordOf(sa, id)),
        balance: await ethers.provider.getBalance(sa.target),
      });
      const before = await read();
      expect(await sa.heldAt(id)).to.equal(0n);
      expect(await sa.acceptsCommits(id)).to.equal(true);
      expect(await sa.acceptsLateClaims(id)).to.equal(false);

      const tx = await sa.connect(maker).hold(id);
      const rc = await tx.wait();
      const at = await blockTime(rc);
      expect(rc.logs.length).to.equal(1);
      expect(logsOf(sa, rc)).to.deep.equal([["Held", [String(id), String(at)]]]);
      await expect(tx).to.emit(sa, "Held").withArgs(id, at);
      expect(await sa.heldAt(id)).to.equal(at);
      expect(await read()).to.deep.equal(before); // state Open, the same escrow, the same pending claim
      expect(before.listing.state).to.equal(String(ListingState.Open));
      expect(await sa.acceptsCommits(id)).to.equal(false);
      expect(await sa.acceptsLateClaims(id)).to.equal(true);
    });

    it("a Depleted listing can be held, with an award owed or with none", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker } = f;
      for (const owed of [false, true]) {
        const id = await depletedListing(f, { owed });
        const tx = await sa.connect(maker).hold(id);
        const at = await blockTime(await tx.wait());
        await expect(tx).to.emit(sa, "Held").withArgs(id, at);
        expect(await sa.heldAt(id)).to.equal(at);
        expect((await sa.getListing(id)).state).to.equal(ListingState.Depleted);
        expect(await sa.acceptsLateClaims(id)).to.equal(true);
      }
    });

    it("only the listing's maker: the contract's owner, the fee recipient, another maker, a hunter with a claim pending there and a stranger are refused", async function () {
      const f = await loadFixture(deploy);
      const { sa, owner, maker, other, feeRecipient, hunters } = f;
      const id = await openListing(sa, maker);
      const depleted = await depletedListing(f);
      await openListing(sa, other, fresh()); // `other` is a maker too, of another listing
      await commitAs(sa, hunters[0], id);
      for (const listing of [id, depleted]) {
        for (const [who, signer] of Object.entries({ owner, feeRecipient, other, hunter: hunters[0], stranger: hunters[7] })) {
          await expect(sa.connect(signer).hold(listing), `${who} on listing ${listing}`).to.be.revertedWith("not maker");
        }
        expect(await sa.heldAt(listing)).to.equal(0n);
        expect(await sa.acceptsLateClaims(listing)).to.equal(false);
      }
      expect(await sa.acceptsCommits(id)).to.equal(true);
    });

    it("only an Open or a Depleted listing: a Listed, a Rolled and a Closed one (closed after it opened, or never opened) are refused, and an id that is no listing", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const listed = await listAs(sa, maker, fresh());
      const rolled = await openListing(sa, maker, fresh());
      const successor = await openListing(sa, maker, fresh());
      await sa.connect(maker).rollForward(rolled, successor);
      const closed = await openListing(sa, maker, fresh());
      await sa.connect(maker).close(closed);
      const neverOpened = await listAs(sa, maker, fresh());
      await sa.connect(maker).close(neverOpened);
      for (const [state, id] of Object.entries({ listed, rolled, closed, neverOpened })) {
        await expect(sa.connect(maker).hold(id), state).to.be.revertedWith("not rollable");
        expect(await sa.heldAt(id), state).to.equal(0n);
      }
      await expect(sa.connect(maker).hold(0n)).to.be.revertedWith("bad listingId");
      await expect(sa.connect(maker).hold((await sa.listingCount()) + 1n)).to.be.revertedWith("bad listingId");
      // The successor is Open: its maker may hold it too.
      await expect(sa.connect(maker).hold(successor)).to.emit(sa, "Held");
    });

    it("one-way: a held listing is not held again; no renew, top-up or reopening moves or clears the time, and after a roll forward or a close there is nothing to hold", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker } = f;
      const open = await openListing(sa, maker, fresh());
      const depleted = await depletedListing(f);
      const at = {};
      for (const id of [open, depleted]) {
        at[id] = await blockTime(await (await sa.connect(maker).hold(id)).wait());
        await expect(sa.connect(maker).hold(id)).to.be.revertedWith("not accepting commits");
      }
      await sa.connect(maker).renew(open, { value: LISTING_FEE });
      await sa.connect(maker).fund(open, 0n, { value: 1n });
      await expect(sa.connect(maker).fund(depleted, 0n, { value: TOP })).to.emit(sa, "Reopened");
      expect((await sa.getListing(depleted)).state).to.equal(ListingState.Open);
      for (const id of [open, depleted]) {
        await expect(sa.connect(maker).hold(id)).to.be.revertedWith("not accepting commits");
        expect(await sa.heldAt(id)).to.equal(at[id]);
      }
      const successor = await openListing(sa, maker, fresh());
      await sa.connect(maker).rollForward(open, successor);
      await sa.connect(maker).close(depleted);
      // The hold has ended: the listing is Rolled or Closed, heldAt is 0, and it cannot be held again.
      for (const id of [open, depleted]) {
        await expect(sa.connect(maker).hold(id)).to.be.revertedWith("not rollable");
        expect(await sa.heldAt(id)).to.equal(0n);
        expect(await sa.acceptsCommits(id)).to.equal(false);
        expect(await sa.acceptsLateClaims(id)).to.equal(true);
      }
      // No function lifts a hold: of the names one could have, only hold, its view and release exist,
      // and release is a claim's fix window (P2b).
      const named = sa.interface.fragments
        .filter((x) => x.type === "function" && /^(hold|held|unhold|resume|release|lift|reopen)/i.test(x.name))
        .map((x) => `${x.name}:${x.stateMutability}`)
        .sort();
      expect(named).to.deep.equal(["heldAt:view", "hold:nonpayable", "release:nonpayable"]);
    });

    it("takes no ETH and moves none", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      expect(sa.interface.getFunction("hold").payable).to.equal(false);
      const data = sa.interface.encodeFunctionData("hold", [id]);
      await expect(maker.sendTransaction({ to: sa.target, data, value: 1n })).to.be.reverted;
      expect(await sa.heldAt(id)).to.equal(0n);
      await expect(sa.connect(maker).hold(id)).to.changeEtherBalances([maker, sa], [0n, 0n]);
    });

    it("takes effect at once: in one block, a commit mined before the hold stands and one mined after it is refused", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      const value = await sa.commitPrice(id);
      // Mined in the order of their tips; a gas limit is given so nothing is estimated beforehand.
      const fee = (tip) => ({
        maxPriorityFeePerGas: ethers.parseUnits(tip, "gwei"), maxFeePerGas: ethers.parseUnits("200", "gwei"), gasLimit: 3_000_000n,
      });
      let sent;
      await network.provider.send("evm_setAutomine", [false]);
      try {
        const before = await sa.connect(hunters[0]).commit(id, archiveOf(1), CT, { value, ...fee("3") });
        const hold = await sa.connect(maker).hold(id, fee("2"));
        const after = await sa.connect(hunters[1]).commit(id, archiveOf(2), CT, { value, ...fee("1") });
        await network.provider.send("evm_mine");
        sent = { before, hold, after };
      } finally {
        await network.provider.send("evm_setAutomine", [true]);
      }
      const rc = {};
      for (const [k, tx] of Object.entries(sent)) rc[k] = await ethers.provider.getTransactionReceipt(tx.hash);
      expect(new Set(Object.values(rc).map((r) => r.blockNumber)).size, "one block").to.equal(1);
      expect([rc.before.index, rc.hold.index, rc.after.index]).to.deep.equal([0, 1, 2]);
      expect([rc.before.status, rc.hold.status, rc.after.status]).to.deep.equal([1, 1, 0]);
      const l = await sa.getListing(id);
      expect([l.claimsCommitted, l.pendingClaims]).to.deep.equal([1n, 1n]);
      expect((await sa.getClaim(l.headClaim)).hunter).to.equal(hunters[0].address);
      expect(await sa.heldAt(id)).to.equal(await blockTime(rc.hold));
    });
  });

  // ------------------------------------------------------------------ the view and the ABI
  describe("heldAt and the ABI", function () {
    it("heldAt is the time of the hold while the listing is on hold, and 0 when it is not: never held, no such listing, or the hold ended in a roll forward or a close", async function () {
      const { sa, maker } = await loadFixture(deploy);
      const never = await openListing(sa, maker, fresh());
      const held = await openListing(sa, maker, fresh());
      const toRoll = await openListing(sa, maker, fresh());
      const toClose = await openListing(sa, maker, fresh());
      const successor = await openListing(sa, maker, fresh());
      const at = {};
      for (const id of [held, toRoll, toClose]) {
        at[id] = await blockTime(await (await sa.connect(maker).hold(id)).wait());
        expect(await sa.heldAt(id)).to.equal(at[id]);
      }
      await time.increase(DAY);
      for (const id of [held, toRoll, toClose]) expect(await sa.heldAt(id), "a day later").to.equal(at[id]);
      // The hold ends in a roll forward or in a close: the listing is Rolled or Closed, no longer held.
      const rolledAt = await blockTime(await (await sa.connect(maker).rollForward(toRoll, successor)).wait());
      const closedAt = await blockTime(await (await sa.connect(maker).close(toClose)).wait());
      const rolled = await sa.getListing(toRoll);
      const closed = await sa.getListing(toClose);
      expect([rolled.state, rolled.rolledAt]).to.deep.equal([ListingState.Rolled, rolledAt]);
      expect([closed.state, closed.closedAt]).to.deep.equal([ListingState.Closed, closedAt]);
      expect(await sa.heldAt(toRoll)).to.equal(0n);
      expect(await sa.heldAt(toClose)).to.equal(0n);
      expect(await sa.heldAt(held)).to.equal(at[held]);
      // The log keeps every hold's time.
      const logged = (await sa.queryFilter(sa.filters.Held())).map((e) => [e.args.listingId, e.args.heldAt]);
      expect(logged).to.deep.equal([held, toRoll, toClose].map((id) => [id, at[id]]));
      // Never a revert: 0 for a listing never held and for an id that is no listing.
      for (const id of [never, successor, 0n, (await sa.listingCount()) + 1n]) expect(await sa.heldAt(id), `listing ${id}`).to.equal(0n);
      // The lens reads it through the host: the same answers at its own address.
      const lens = await ethers.getContractAt("StakeAttestationLens", await sa.lens());
      expect([await lens.acceptsLateClaims(held), await lens.acceptsLateClaims(never)]).to.deep.equal([true, false]);
    });

    // The merged ABI as it was before the hold: at aa431ca, the 139 fragments of
    // server/src/chain/abi/StakeAttestation.json, each in ethers' full format (names, indexed flags,
    // mutability, tuple components), sorted and joined by newlines, keccak256.
    const ABI_BEFORE_HOLD = "0x0045577ab1303ede3d87ba25f474a47eb39fa98a130a73ad67364cb13bd80a42";
    const ADDED = [
      "event Held(uint256 indexed listingId, uint64 heldAt)",
      "function heldAt(uint256 listingId) view returns (uint64)",
      "function hold(uint256 listingId)",
    ];

    it("additive: every fragment the merged ABI had before the hold is unchanged, and the additions are hold, heldAt and Held", function () {
      const lines = mergedAbi(hre.artifacts).map((x) => ethers.Fragment.from(x).format("full"));
      for (const a of ADDED) expect(lines, a).to.include(a);
      const before = lines.filter((l) => !ADDED.includes(l)).sort();
      expect(before.length).to.equal(139);
      expect(ethers.id(before.join("\n"))).to.equal(ABI_BEFORE_HOLD);
    });

    it("the hold's time is no field of Listing, of the record or of a claim", async function () {
      const { sa } = await loadFixture(deploy);
      const fields = (type) => (type.baseType === "tuple"
        ? type.components.flatMap((c) => [c.name, ...fields(c)])
        : type.baseType === "array" ? fields(type.arrayChildren) : []);
      for (const fn of ["getListing", "getClaim", "recordByHash", "recordPage"]) {
        const names = fields(sa.interface.getFunction(fn).outputs[0]);
        expect(names.length, fn).to.be.greaterThan(10);
        expect(names.filter((n) => /held/i.test(n) && !/^(disputes|confirmations|appeals|lateAppeals)Held$/.test(n)), fn).to.deep.equal([]);
      }
    });

    it("only hold writes the time, and only acceptsCommits, lateClaim and the lens's acceptsLateClaims read it", function () {
      const source = (...p) => fs.readFileSync(path.join(__dirname, "..", "contracts", ...p), "utf8");
      // The functions of a source, by name, whose body names `word`.
      const functionsNaming = (text, word) => [...text.matchAll(/\n {4}function (\w+)\([\s\S]*?\n {4}\}/g)]
        .filter((m) => new RegExp(`\\b${word}\\b`).test(m[0]))
        .map((m) => m[1]);
      const host = source("StakeAttestation.sol");
      const logic = source("libraries", "ClaimLogic.sol");
      // The contract: hold hands the mapping (_heldAt) to ClaimLogic.hold, lateClaim reads it for
      // ClaimLogic.commit's `listingHeld`, acceptsCommits reads it, and the view heldAt answers
      // from it. commit passes `false`.
      expect(functionsNaming(host, "_heldAt")).to.deep.equal(["hold", "lateClaim", "acceptsCommits", "heldAt"]);
      expect(host).to.match(/msg\.value, false,\s*false\s*\);/);
      // The library: hold is the one function that takes the mapping, and writes it once; commit
      // is the one that takes `listingHeld`, and reads it only under `if (late)`.
      expect(functionsNaming(logic, "heldAt")).to.deep.equal(["hold"]);
      expect(`${host}\n${logic}`.match(/heldAt\[listingId\] = /g)).to.have.lengthOf(1);
      expect(functionsNaming(logic, "listingHeld")).to.deep.equal(["commit"]);
      expect(logic.match(/\blistingHeld\b(?=[,\n])/g)).to.have.lengthOf(2); // the parameter, and the late-claim check
      expect(functionsNaming(source("StakeAttestationLens.sol"), "heldAt")).to.deep.equal(["acceptsLateClaims"]);
      for (const lib of ["ClaimRules.sol", "RecordLogic.sol"]) expect(source("libraries", lib), lib).to.not.match(/\bheldAt\b|\blistingHeld\b/);
    });

    it("declares Held", async function () {
      const { sa } = await loadFixture(deploy);
      const held = sa.interface.getEvent("Held");
      expect(held.inputs.map((i) => `${i.type} ${i.indexed ? "indexed " : ""}${i.name}`)).to.deep.equal(["uint256 indexed listingId", "uint64 heldAt"]);
    });
  });

  // ------------------------------------------------------------------ no commit
  describe("a held listing takes no commit", function () {
    it("acceptsCommits is false and commit reverts as on any listing that takes none, whoever commits and whatever they pay; a renew and a top-up change nothing", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const invited = await openListing(sa, maker, fresh({ allowlist: [hunters[0].address] }), { escrow: 3n * TOP });
      const rolled = await openListing(sa, maker, fresh());
      const successor = await openListing(sa, maker, fresh());
      await sa.connect(maker).rollForward(rolled, successor);
      const price = await sa.commitPrice(invited);
      await expect(sa.connect(hunters[0]).commit.staticCall(invited, ARCHIVE, CT, { value: price })).to.not.be.rejected;

      await sa.connect(maker).hold(invited);
      const refusedAsOnRolled = "not accepting commits";
      await expect(sa.connect(hunters[0]).commit(rolled, ARCHIVE, CT, { value: price })).to.be.revertedWith(refusedAsOnRolled);
      const tries = async (when) => {
        expect(await sa.acceptsCommits(invited), when).to.equal(false);
        for (const value of [price, price + TOP]) {
          await expect(sa.connect(hunters[0]).commit(invited, ARCHIVE, CT, { value }), when).to.be.revertedWith(refusedAsOnRolled);
        }
        // The hold is checked before the allowlist: a hunter off it is told the same.
        await expect(sa.connect(hunters[1]).commit(invited, ARCHIVE, CT, { value: price }), when).to.be.revertedWith(refusedAsOnRolled);
      };
      await tries("held");
      await sa.connect(maker).renew(invited, { value: LISTING_FEE });
      await tries("renewed");
      await sa.connect(maker).fund(invited, 0n, { value: TOP });
      await tries("topped up");
      const l = await sa.getListing(invited);
      expect([l.state, l.claimsCommitted, l.pendingClaims, l.escrowWei]).to.deep.equal([ListingState.Open, 0n, 0n, 4n * TOP]);
      expect(await sa.isLapsed(invited)).to.equal(false);
      // commitPrice still quotes: it is what a late claim pays.
      expect(await sa.commitPrice(invited)).to.equal(price);
    });
  });

  // ------------------------------------------------------------------ late claims
  describe("a held listing takes late claims (decision D6)", function () {
    it("lateClaim and the lens's acceptsLateClaims agree in every state a listing can be in, held or not", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      const hunter = hunters[0];
      const holdIt = async (id) => {
        await sa.connect(maker).hold(id);
        return id;
      };
      const rolledFrom = async (id) => {
        await sa.connect(maker).rollForward(id, await openListing(sa, maker, fresh()));
        return id;
      };
      const closedFrom = async (id) => {
        await sa.connect(maker).close(id);
        return id;
      };
      const reopened = async (id) => {
        await sa.connect(maker).fund(id, 0n, { value: TOP });
        expect((await sa.getListing(id)).state).to.equal(ListingState.Open);
        return id;
      };
      const open = () => openListing(sa, maker, fresh());
      // The Depleted ones first: each settles a claim, which moves the clock by a dispute window.
      const depleted = [await depletedListing(f), await depletedListing(f, { owed: true }), await depletedListing(f),
        await depletedListing(f, { owed: true }), await depletedListing(f)];
      const cases = [
        // [what, listing, takes late claims]
        ["Listed", await listAs(sa, maker, fresh()), false],
        ["Open", await open(), false],
        ["Open, held", await holdIt(await open()), true],
        ["Depleted", depleted[0], false],
        ["Depleted, an award owed", depleted[1], false],
        ["Depleted, held", await holdIt(depleted[2]), true],
        ["Depleted with an award owed, held", await holdIt(depleted[3]), true],
        ["held while Depleted, then topped up to Open", await reopened(await holdIt(depleted[4])), true],
        ["Rolled", await rolledFrom(await open()), true],
        ["Rolled from a held listing", await rolledFrom(await holdIt(await open())), true],
        ["Closed after it opened", await closedFrom(await open()), true],
        ["Closed from a held listing", await closedFrom(await holdIt(await open())), true],
        ["Closed, never opened", await closedFrom(await listAs(sa, maker, fresh())), false],
      ];
      const check = async (when) => {
        for (const [what, id, takes] of cases) {
          const at = `${what}${when}`;
          expect(await sa.acceptsLateClaims(id), at).to.equal(takes);
          const call = sa.connect(hunter).lateClaim.staticCall(id, ARCHIVE, CT, { value: await sa.commitPrice(id) });
          if (takes) await expect(call, at).to.not.be.rejected;
          else await expect(call, at).to.be.revertedWith("not accepting late claims");
          expect(await sa.acceptsCommits(id), at).to.equal(what === "Open" && when === "");
        }
      };
      await check("");
      // Lapsed: an Open listing past its paid period takes neither, unless it is held.
      await time.increase(LISTING_PERIOD);
      expect(await sa.isLapsed(cases[1][1])).to.equal(true);
      expect(await sa.isLapsed(cases[2][1])).to.equal(true);
      await check(", lapsed");
      await expect(sa.acceptsLateClaims(99n)).to.be.revertedWith("bad listingId");
      await expect(sa.connect(hunter).lateClaim(99n, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("bad listingId");
    });

    it("a lapsed Open listing can be held, and then takes late claims", async function () {
      const { sa, maker, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker);
      await time.increase(LISTING_PERIOD);
      expect(await sa.isLapsed(id)).to.equal(true);
      await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("not accepting late claims");
      await expect(sa.connect(maker).hold(id)).to.emit(sa, "Held");
      await expect(sa.connect(hunter).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE })).to.emit(sa, "LateClaim");
    });

    it("a late claim on a held listing is a late claim on a Rolled one: the same events, the same stored claims, the same counts and the same payments", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      // Invited: a late claim is open to every hunter, on a held listing as on a Rolled one.
      const id = await openListing(sa, maker, fresh({ allowlist: [hunters[0].address] }), { escrow: 2n * TOP });
      const successor = await openListing(sa, maker, fresh());
      const ids = {};
      const body = async (w) => {
        ids.a = await w.commit(hunters[0]); // pending when the stake stops taking commits
        await w.committed(); // the one place: the hold in one run, the roll forward in the other
        w.noMorePlaces();
        await w.disclose(ids.a);
        ids.valid = await w.late(hunters[1]); // off the allowlist
        await w.disclose(ids.valid);
        ids.invalid = await w.late(hunters[2]);
        await w.disclose(ids.invalid);
        ids.silent = await w.late(hunters[3]); // never disclosed
        // Behind the pending claim in commit order.
        await w.refused(`reveal ${ids.valid}`, () => w.revealCall(ids.valid, 0n), "earlier claim unresolved");
        await w.reveal(ids.a);
        await w.result(ids.a, V.HIGH);
        await w.finalize(ids.a);
        w.wait(DISPUTE);
        await w.settle(ids.a); // its award, from the escrow
        await w.reveal(ids.valid);
        await w.result(ids.valid, V.CRITICAL);
        await w.finalize(ids.valid);
        w.wait(DISPUTE);
        await w.settle(ids.valid); // the bond back, no award
        await w.reveal(ids.invalid);
        await w.result(ids.invalid, V.INVALID);
        await w.finalize(ids.invalid);
        w.wait(DISPUTE);
        await w.settle(ids.invalid); // the bond to the maker
        await w.expire(ids.silent); // long past its disclose window
      };
      const start = BigInt(await time.latest()) + 1000n;
      const snap = await takeSnapshot();
      const rolled = await run(f, id, start, { roll: 0, successor }, body);
      await snap.restore();
      const held = await run(f, id, start, { hold: 0 }, body);

      // What a roll forward says of itself, and nothing else, is left out of the comparison.
      const comparable = (r) => {
        const o = JSON.parse(JSON.stringify(r.same));
        for (const c of Object.values(o.claims)) delete c.stored.disclosedAfterRoll; // each has its own window either way (fixWindow 0)
        for (const l of [o.listing, o.record.listings[0]]) for (const k of ["state", "rolledAt", "successor", "successorHash"]) delete l[k];
        return o;
      };
      expect(comparable(held)).to.deep.equal(comparable(rolled));
      expect([held.same.listing.state, rolled.same.listing.state]).to.deep.equal([String(ListingState.Open), String(ListingState.Rolled)]);

      // And what that is, read from the held listing.
      const l = await sa.getListing(id);
      expect(l.state).to.equal(ListingState.Open);
      expect(l.escrowWei).to.equal(2n * TOP - AWARDS[2]); // only the pending claim's award left it
      expect([l.claimsCommitted, l.pendingClaims, l.owedWei]).to.deep.equal([1n, 0n, 0n]);
      expect([l.lateClaims, l.lateExpired]).to.deep.equal([3n, 1n]);
      expect([...l.lateOutcomeCounts]).to.deep.equal([1n, 0n, 0n, 0n, 0n, 1n]);
      expect([...l.outcomeCounts]).to.deep.equal([0n, 0n, 0n, 0n, 1n, 0n]);
      expect(eventsIn(held, "late claim 2")).to.deep.equal([
        ["LateClaim", plain([ids.valid, id, hunters[1].address, archiveOf(2), CT, BOND, FEE])],
      ]);
      expect(eventsIn(held, `settle ${ids.valid}`)).to.deep.equal([
        ["Settled", plain([ids.valid, id, hunters[1].address, Outcome.CRITICAL, 0n, 0n])],
      ]);
      expect(eventsIn(held, `settle ${ids.invalid}`)).to.deep.equal([
        ["Settled", plain([ids.invalid, id, hunters[2].address, Outcome.INVALID, 0n, 0n])],
      ]);
      expect(eventsIn(held, `expire ${ids.silent}`)).to.deep.equal([["Expired", plain([ids.silent, id, Expiry.Undisclosed])]]);
      for (const k of ["valid", "invalid", "silent"]) {
        const c = await sa.getClaim(ids[k]);
        expect([c.late, c.paidWei, c.owedWei], k).to.deep.equal([true, 0n, 0n]);
      }
      expect((await sa.getClaim(ids.a)).late).to.equal(false);
      expect((await sa.getClaim(ids.a)).paidWei).to.equal(AWARDS[2]);
      // Published as any valid finding, marked late on the record.
      expect([...(await sa.validFindings(id))]).to.deep.equal([ids.a, ids.valid]);
      const record = await recordOf(sa, id);
      expect([...record.findings].map((x) => [x.claimId, x.late, x.paidWei])).to.deep.equal([[ids.a, false, AWARDS[2]], [ids.valid, true, 0n]]);
      expect([record.history.claims, record.history.lateClaims, record.history.pending]).to.deep.equal([1n, 3n, 0n]);
    });

    it("a late claim on a held listing has the listing's fix window from its disclosure; the maker may flag and release it; a roll forward ends that window as it ends a pending claim's", async function () {
      const { sa, maker, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, fresh({ fixWindow: FIX, disclosureGrace: GRACE }));
      const pending = await claimAs(sa, hunters[0], id);
      await sa.connect(maker).hold(id);

      const first = await lateClaimAs(sa, hunters[1], id, { archive: archiveOf(2) });
      const c = await sa.getClaim(first.claimId);
      expect([c.late, c.fixWindowEnd, c.disclosedAfterRoll]).to.deep.equal([true, first.disclosedAt + FIX, false]);
      expect((await sa.claimTimes(first.claimId)).revealableAt).to.equal(first.disclosedAt + FIX);
      await expect(sa.connect(maker).flagBadDisclosure(first.claimId)).to.emit(sa, "Flagged").withArgs(first.claimId, id);
      await expect(sa.connect(maker).release(first.claimId)).to.emit(sa, "Released").withArgs(first.claimId, id);
      expect(await sa.claimState(first.claimId)).to.equal(ClaimState.Revealable);
      expect((await sa.getListing(id)).releasedClaims).to.equal(0n); // the history's count is the stake's
      await expect(revealAs(sa, hunters[1], first.claimId)).to.be.revertedWith("earlier claim unresolved");

      // The roll forward: every claim disclosed by then is revealable at once, late or not.
      const second = await lateClaimAs(sa, hunters[2], id, { archive: archiveOf(3) });
      const successor = await openListing(sa, maker, fresh());
      const rolledAt = await blockTime(await (await sa.connect(maker).rollForward(id, successor)).wait());
      for (const claimId of [pending.claimId, second.claimId]) {
        expect((await sa.claimTimes(claimId)).revealableAt, `claim ${claimId}`).to.equal(rolledAt);
        expect(await sa.claimState(claimId)).to.equal(ClaimState.Revealable);
      }
      // One made after it has a window of its own, as on any Rolled listing.
      const third = await lateClaimAs(sa, hunters[3], id, { archive: archiveOf(4) });
      expect((await sa.getClaim(third.claimId)).disclosedAfterRoll).to.equal(true);
      expect((await sa.claimTimes(third.claimId)).revealableAt).to.equal(third.disclosedAt + FIX);
    });

    it("a pending late claim never holds close(): the escrow goes back whole, and the claim settles on the closed listing", async function () {
      const { sa, aggregator, maker, other, hunter } = await loadFixture(deploy);
      const id = await openListing(sa, maker, fresh(), { escrow: 3n * TOP });
      await sa.connect(maker).hold(id);
      const { claimId } = await lateClaimAs(sa, hunter, id);
      const l = await sa.getListing(id);
      expect([l.pendingClaims, l.lateClaims, l.headClaim]).to.deep.equal([0n, 1n, claimId]);
      const tx = sa.connect(maker).close(id);
      await expect(tx).to.emit(sa, "Closed").withArgs(id, maker.address, 3n * TOP);
      await expect(tx).to.changeEtherBalances([maker, sa], [3n * TOP, -3n * TOP]);
      await revealAs(sa, hunter, claimId);
      await judgeAs(sa, aggregator, other, claimId, V.CRITICAL);
      await afterDisputeWindow(sa, claimId);
      await expect(sa.settle(claimId)).to.changeEtherBalances([hunter, sa], [BOND, -BOND]);
      const after = await sa.getListing(id);
      expect([after.state, after.escrowWei, after.owedWei]).to.deep.equal([ListingState.Closed, 0n, 0n]);
    });
  });

  // ------------------------------------------------------------------ pending claims
  describe("a claim committed before the hold keeps every path", function () {
    it("disclose: within the disclose window, and the fix window runs from the disclosure", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh({ fixWindow: FIX, disclosureGrace: GRACE }));
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
      });
      const c = await f.sa.getClaim(a);
      expect(c.disclosedAt > 0n).to.equal(true);
      expect(c.fixWindowEnd).to.equal(c.disclosedAt + FIX);
      expect(eventsIn(open, `disclose ${a}`)).to.deep.equal([["Disclosed", plain([a, id, CT_CID, c.fixWindowEnd])]]);
      expect(await f.sa.claimState(a)).to.equal(ClaimState.Committed); // its fix window is open
    });

    it("flag: the maker flags its disclosure inside the grace", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh({ fixWindow: FIX, disclosureGrace: GRACE }));
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.flag(a);
      });
      expect(eventsIn(open, `flag ${a}`)).to.deep.equal([["Flagged", plain([a, id])]]);
      expect((await f.sa.getClaim(a)).flaggedBadDisclosure).to.equal(true);
      expect([...(await recordOf(f.sa, id)).flags].map((x) => x.claimId)).to.deep.equal([a]);
    });

    it("release: the maker waives its fix window and it reveals at once", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh({ fixWindow: FIX, disclosureGrace: GRACE }));
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.refused(`early reveal ${a}`, () => w.revealCall(a, 0n), "fix window open");
        await w.release(a);
        await w.reveal(a);
      });
      expect(eventsIn(open, `release ${a}`)).to.deep.equal([["Released", plain([a, id])]]);
      expect(eventNames(open, `reveal ${a}`)).to.deep.equal(["Revealed", "EvaluationRequested"]);
      const c = await f.sa.getClaim(a);
      expect([c.released, c.state]).to.deep.equal([true, ClaimState.Revealed]);
      expect((await f.sa.getListing(id)).releasedClaims).to.equal(1n);
    });

    it("reveal in commit order: the later claim waits for the earlier one to settle, then reveals", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh());
      let a;
      let b;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        b = await w.commit(f.hunters[1]);
        await w.committed();
        await w.disclose(b);
        await w.disclose(a);
        await w.refused(`reveal ${b} first`, () => w.revealCall(b, 0n), "earlier claim unresolved");
        await w.reveal(a);
        await w.refused(`reveal ${b} behind a revealed claim`, () => w.revealCall(b, 0n), "earlier claim unresolved");
        await w.result(a, V.MEDIUM);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.settle(a);
        await w.reveal(b);
      });
      expect(eventNames(open, `reveal ${a}`)).to.deep.equal(["Revealed", "EvaluationRequested"]);
      expect(eventNames(open, `reveal ${b}`)).to.deep.equal(["Revealed", "EvaluationRequested"]);
      const l = await f.sa.getListing(id);
      expect([l.headClaim, l.tailClaim, l.pendingClaims]).to.deep.equal([b, b, 1n]);
      expect((await f.sa.getClaim(b)).state).to.equal(ClaimState.Revealed);
    });

    it("judge: its round is read to a verdict, and a round with none is sent again", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh());
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.reveal(a);
        w.wait(ROUND_TIMEOUT);
        await w.finalize(a); // no result in time: the round failed
        await w.retrigger(a);
        await w.result(a, V.HIGH);
        await w.finalize(a);
      });
      const finalizes = open.same.steps.filter(([l]) => l === `finalize ${a}`).map(([, events]) => events.map(([name]) => name));
      expect(finalizes).to.deep.equal([["EvaluationFailed", "LeftoverRefunded"], ["Judged", "LeftoverRefunded"]]);
      expect(eventNames(open, `retrigger ${a}`)).to.deep.equal(["Retriggered", "EvaluationRequested"]);
      const c = await f.sa.getClaim(a);
      expect([c.state, c.outcome, [...c.vector]]).to.deep.equal([ClaimState.Judged, Outcome.HIGH, V.HIGH.map(BigInt)]);
    });

    it("dispute: the maker disputes its verdict, and the panel's outcome settles", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh(), { escrow: 2n * TOP });
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.reveal(a);
        await w.result(a, V.HIGH);
        await w.finalize(a);
        await w.dispute(a);
        await w.result(a, V.MEDIUM);
        await w.finalize(a);
        await w.settle(a);
      });
      expect(eventNames(open, `dispute ${a}`)).to.deep.equal(["Disputed"]);
      expect(eventsIn(open, `settle ${a}`)).to.deep.equal([
        ["Settled", plain([a, id, f.hunters[0].address, Outcome.MEDIUM, AWARDS[1], 0n])],
      ]);
      const c = await f.sa.getClaim(a);
      expect([c.dispute, c.disputeKind, c.disputedOutcome, c.outcome]).to.deep.equal([
        DisputeResult.Overturned, DisputeKind.Maker, Outcome.HIGH, Outcome.MEDIUM,
      ]);
      const l = await f.sa.getListing(id);
      expect([l.disputesFiled, l.disputesOverturned, l.escrowWei]).to.deep.equal([1n, 1n, 2n * TOP - AWARDS[1]]);
    });

    it("appeal: the hunter appeals its INVALID, and the panel's class is paid", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh(), { escrow: 2n * TOP });
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.reveal(a);
        await w.result(a, V.INVALID);
        await w.finalize(a);
        await w.appeal(a);
        await w.result(a, V.HIGH);
        await w.finalize(a);
        await w.settle(a);
      });
      expect(eventNames(open, `appeal ${a}`)).to.deep.equal(["Appealed"]);
      expect(eventsIn(open, `settle ${a}`)).to.deep.equal([
        ["Settled", plain([a, id, f.hunters[0].address, Outcome.HIGH, AWARDS[2], 0n])],
      ]);
      const c = await f.sa.getClaim(a);
      expect([c.dispute, c.disputeKind, c.outcome, c.paidWei]).to.deep.equal([DisputeResult.Overturned, DisputeKind.Appeal, Outcome.HIGH, AWARDS[2]]);
      const l = await f.sa.getListing(id);
      expect([l.appealsFiled, l.appealsOverturned]).to.deep.equal([1n, 1n]);
    });

    it("settle with an award: the bond and the award are paid from the escrow, and a payout below the top award makes it Depleted", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh());
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.reveal(a);
        await w.result(a, V.CRITICAL);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.settle(a);
      });
      expect(eventsIn(open, `settle ${a}`)).to.deep.equal([
        ["Depleted", plain([id, 0n])],
        ["Settled", plain([a, id, f.hunters[0].address, Outcome.CRITICAL, TOP, 0n])],
      ]);
      // The contract's balance fell by the bond and the award at that step: both left it, paid directly.
      const at = open.same.steps.findIndex(([l]) => l === `settle ${a}`);
      expect(BigInt(open.same.steps[at - 1][2]) - BigInt(open.same.steps[at][2])).to.equal(BOND + TOP);
      expect(await f.sa.withdrawable(f.hunters[0].address)).to.equal(0n);
      const c = await f.sa.getClaim(a);
      expect([c.state, c.paidWei, c.owedWei]).to.deep.equal([ClaimState.Settled, TOP, 0n]);
      const l = await f.sa.getListing(id);
      expect([l.state, l.escrowWei, l.pendingClaims]).to.deep.equal([ListingState.Depleted, 0n, 0n]);
    });

    it("confirm: an award above the listing's size is confirmed from the escrow, then paid (erratum E9)", async function () {
      const f = await loadFixture(deployDefaults); // the size is 0: every counted award is confirmed
      const id = await openListing(f.sa, f.maker, fresh(), { escrow: 2n * TOP });
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]);
        await w.committed();
        await w.disclose(a);
        await w.reveal(a);
        await w.result(a, V.HIGH);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.refused(`settle ${a} unconfirmed`, () => f.sa.settle(a), "awaiting confirmation");
        await w.confirm(a);
        await w.result(a, V.HIGH);
        await w.finalize(a);
        await w.settle(a);
      });
      expect(eventNames(open, `confirm ${a}`)).to.deep.equal(["ConfirmationRequested"]);
      expect(eventsIn(open, `settle ${a}`)).to.deep.equal([
        ["Settled", plain([a, id, f.hunters[0].address, Outcome.HIGH, AWARDS[2], 0n])],
      ]);
      const c = await f.sa.getClaim(a);
      expect([c.dispute, c.disputeKind, c.paidWei]).to.deep.equal([DisputeResult.Held, DisputeKind.Confirmation, AWARDS[2]]);
      const l = await f.sa.getListing(id);
      expect([l.confirmationRounds, l.confirmationsHeld]).to.deep.equal([1n, 1n]);
    });

    it("expire: undisclosed, unrevealed and after a failed round, each at its own deadline, the bond to the maker", async function () {
      const f = await loadFixture(deploy);
      const id = await openListing(f.sa, f.maker, fresh());
      let a;
      let b;
      let c;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(f.hunters[0]); // never disclosed
        b = await w.commit(f.hunters[1]); // disclosed, never revealed
        c = await w.commit(f.hunters[2]); // revealed; its round settles no verdict and is not sent again
        await w.committed();
        await w.disclose(b);
        await w.disclose(c);
        await w.refused(`expire ${a} early`, () => f.sa.expire(a), "disclose window open");
        w.wait(HOUR);
        await w.expire(a);
        await w.refused(`expire ${b} early`, () => f.sa.expire(b), "reveal window open");
        w.wait(REVEAL);
        await w.expire(b);
        await w.reveal(c);
        w.wait(ROUND_TIMEOUT);
        await w.finalize(c);
        w.wait(REVEAL);
        await w.expire(c);
      });
      expect(eventsIn(open, `expire ${a}`)).to.deep.equal([["Expired", plain([a, id, Expiry.Undisclosed])]]);
      expect(eventsIn(open, `expire ${b}`)).to.deep.equal([["Expired", plain([b, id, Expiry.Unrevealed])]]);
      expect(eventsIn(open, `expire ${c}`)).to.deep.equal([["Expired", plain([c, id, Expiry.RoundsFailed])]]);
      // Each expiry sent the bond out (to the maker), and the first two the prepay too (to the hunter).
      for (const [claimId, left] of [[a, BOND + FEE], [b, BOND + FEE], [c, BOND]]) {
        const at = open.same.steps.findIndex(([l]) => l === `expire ${claimId}`);
        expect(BigInt(open.same.steps[at - 1][2]) - BigInt(open.same.steps[at][2]), `claim ${claimId}`).to.equal(left);
      }
      const l = await f.sa.getListing(id);
      expect([l.undisclosedClaims, l.unrevealedClaims, l.noVerdictClaims, l.pendingClaims, l.headClaim]).to.deep.equal([1n, 1n, 1n, 0n, 0n]);
      expect(l.escrowWei).to.equal(TOP);
    });
  });

  // ------------------------------------------------------------------ the maker's other calls
  describe("rollForward, close, top-up and renew on a held listing", function () {
    it("rollForward from a held listing is rollForward from an Open one: the same event, lineage and reveal times, and its claims settle against it", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      const id = await openListing(sa, maker, fresh({ fixWindow: FIX, disclosureGrace: GRACE }));
      const successor = await openListing(sa, maker, fresh());
      let a;
      let b;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(hunters[0]);
        b = await w.commit(hunters[1]);
        await w.committed();
        await w.disclose(a);
        w.noMorePlaces();
        await w.rollForward();
        await w.disclose(b); // after the roll: a fix window of its own
        await w.reveal(a); // disclosed before it: revealable at once
        await w.result(a, V.MEDIUM);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.settle(a);
        await w.refused(`reveal ${b} in its window`, () => w.revealCall(b, 0n), "fix window open");
        w.wait(FIX);
        await w.reveal(b);
        await w.result(b, V.DUPLICATE);
        await w.finalize(b);
        await w.settle(b);
      }, { successor });
      const successorHash = (await sa.getListing(successor)).artifactHash;
      expect(eventsIn(open, "rollForward")).to.deep.equal([["RolledForward", plain([id, successor, successorHash])]]);
      const l = await sa.getListing(id);
      expect([l.state, l.successor, l.pendingClaims]).to.deep.equal([ListingState.Rolled, successor, 0n]);
      expect((await sa.getListing(successor)).predecessor).to.equal(id);
      expect(l.escrowWei).to.equal(TOP - AWARDS[1]);
      expect((await sa.getClaim(a)).disclosedAfterRoll).to.equal(false);
      expect((await sa.getClaim(b)).disclosedAfterRoll).to.equal(true);
      expect(await sa.acceptsCommits(successor)).to.equal(true); // the hold was the old listing's
      expect(await sa.heldAt(successor)).to.equal(0n);
    });

    it("rollForward from a held, Depleted listing: the pending claim's award is owed and a top-up of the Rolled listing pays it", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      const id = await openListing(sa, maker, fresh());
      const successor = await openListing(sa, maker, fresh());
      let a;
      let b;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(hunters[0]);
        b = await w.commit(hunters[1]);
        await w.committed();
        await w.disclose(a);
        await w.disclose(b);
        await w.reveal(a);
        await w.result(a, V.CRITICAL);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.settle(a); // the whole escrow: Depleted
        w.noMorePlaces();
        await w.rollForward();
        await w.reveal(b);
        await w.result(b, V.MEDIUM);
        await w.finalize(b);
        w.wait(DISPUTE);
        await w.settle(b); // nothing left: owed in full
        await w.topUp(AWARDS[1]);
      }, { successor });
      expect(eventNames(open, "rollForward")).to.deep.equal(["RolledForward"]);
      expect(eventsIn(open, `settle ${b}`)).to.deep.equal([
        ["Settled", plain([b, id, hunters[1].address, Outcome.MEDIUM, 0n, AWARDS[1]])],
      ]);
      expect(eventNames(open, `top-up ${AWARDS[1]}`)).to.deep.equal(["OwedPaid", "Funded"]);
      const l = await sa.getListing(id);
      expect([l.state, l.owedWei, l.escrowWei]).to.deep.equal([ListingState.Rolled, 0n, 0n]);
      expect(await sa.withdrawable(hunters[1].address)).to.equal(AWARDS[1]);
    });

    it("rollForward keeps its refusals on a held listing: only the maker, only to its own Open listing with no predecessor", async function () {
      const { sa, owner, maker, other, hunters } = await loadFixture(deploy);
      const id = await openListing(sa, maker, fresh());
      await claimAs(sa, hunters[0], id);
      await sa.connect(maker).hold(id);
      const successor = await openListing(sa, maker, fresh());
      const listedOnly = await listAs(sa, maker, fresh());
      const othersListing = await openListing(sa, other, fresh());
      for (const signer of [other, owner, hunters[0]]) {
        await expect(sa.connect(signer).rollForward(id, successor)).to.be.revertedWith("not maker");
      }
      await expect(sa.connect(maker).rollForward(id, id)).to.be.revertedWith("bad successor");
      await expect(sa.connect(maker).rollForward(id, listedOnly)).to.be.revertedWith("bad successor");
      await expect(sa.connect(maker).rollForward(id, othersListing)).to.be.revertedWith("bad successor");
      await expect(sa.connect(maker).rollForward(id, 99n)).to.be.revertedWith("bad listingId");
      await expect(sa.connect(maker).rollForward(id, successor)).to.emit(sa, "RolledForward");
      await expect(sa.connect(maker).rollForward(id, successor)).to.be.revertedWith("not rollable");
    });

    it("close from a held listing is close from an Open one: refused while a claim is pending or an award is owed, then what is left goes back", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      const id = await openListing(sa, maker, fresh());
      let a;
      let b;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(hunters[0]);
        b = await w.commit(hunters[1]);
        await w.committed();
        await w.disclose(a);
        await w.disclose(b);
        await w.reveal(a);
        await w.result(a, V.CRITICAL);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.settle(a); // the whole escrow
        await w.refused("close with a claim pending", () => sa.connect(maker).close(id), "claims pending");
        await w.reveal(b);
        await w.result(b, V.MEDIUM);
        await w.finalize(b);
        w.wait(DISPUTE);
        await w.settle(b); // owed in full
        await w.refused("close with an award owed", () => sa.connect(maker).close(id), "amount owed");
        await w.topUp(AWARDS[1] + 12345n); // pays the award; the rest is escrow
        await w.refused("close by another", () => sa.connect(f.other).close(id), "not maker");
        w.noMorePlaces();
        await w.close();
        await w.refused("close again", () => sa.connect(maker).close(id), "already closed");
      });
      expect(eventsIn(open, "close")).to.deep.equal([["Closed", plain([id, maker.address, 12345n])]]);
      const l = await sa.getListing(id);
      expect([l.state, l.escrowWei, l.owedWei, l.pendingClaims]).to.deep.equal([ListingState.Closed, 0n, 0n, 0n]);
      expect(l.closedAt > 0n).to.equal(true);
      // The maker may list the same artifact again; the new listing is not held.
      expect(await sa.activeListingOf(l.artifactHash, maker.address)).to.equal(0n);
    });

    it("a top-up and a renew leave the listing held, and a Depleted one topped up to the top award is Open again and still held", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunters } = f;
      const id = await openListing(sa, maker, fresh(), { escrow: TOP + 1n });
      let a;
      const open = await everyHoldPlace(f, id, async (w) => {
        a = await w.commit(hunters[0]);
        await w.committed();
        await w.topUp(7n);
        await w.renew();
        await w.disclose(a);
        await w.reveal(a);
        await w.result(a, V.HIGH);
        await w.finalize(a);
        w.wait(DISPUTE);
        await w.settle(a); // below the top award: Depleted
        await w.topUp(1n); // still short
        await w.renew(); // a Depleted listing renews too
        await w.topUp(AWARDS[2]); // back at the top award: Open
      });
      expect(eventNames(open, `settle ${a}`)).to.deep.equal(["Depleted", "Settled"]);
      expect(eventNames(open, "top-up 1")).to.deep.equal(["Funded"]);
      expect(eventNames(open, `top-up ${AWARDS[2]}`)).to.deep.equal(["Funded", "Reopened"]);
      expect(open.same.steps.filter(([l]) => l === "renew").map(([, e]) => e.map(([n]) => n))).to.deep.equal([
        ["ListingFeeAccrued", "Renewed"], ["ListingFeeAccrued", "Renewed"],
      ]);
      // The chain is as the last held run left it: Open, funded, inside its paid period, and held.
      const l = await sa.getListing(id);
      expect([l.state, l.escrowWei >= TOP, await sa.isLapsed(id)]).to.deep.equal([ListingState.Open, true, false]);
      expect((await sa.heldAt(id)) > 0n).to.equal(true);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      await expect(sa.connect(hunters[1]).commit(id, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("not accepting commits");
      await expect(sa.connect(hunters[1]).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE })).to.emit(sa, "LateClaim");
    });

    it("a listing held while Depleted and then topped up: Reopened is emitted, the state is Open, and it still takes no commit", async function () {
      const f = await loadFixture(deploy);
      const { sa, maker, hunter } = f;
      const id = await depletedListing(f);
      const at = await blockTime(await (await sa.connect(maker).hold(id)).wait());
      const short = TOP - (await sa.getListing(id)).escrowWei;
      const tx = sa.connect(maker).fund(id, 0n, { value: short });
      await expect(tx).to.emit(sa, "Reopened").withArgs(id, TOP);
      await expect(tx).to.not.emit(sa, "Held");
      const l = await sa.getListing(id);
      expect([l.state, l.escrowWei]).to.deep.equal([ListingState.Open, TOP]);
      expect(await sa.heldAt(id)).to.equal(at);
      expect(await sa.acceptsCommits(id)).to.equal(false);
      await expect(sa.connect(hunter).commit(id, ARCHIVE, CT, { value: BOND + FEE })).to.be.revertedWith("not accepting commits");
      expect(await sa.acceptsLateClaims(id)).to.equal(true);
    });
  });
});
