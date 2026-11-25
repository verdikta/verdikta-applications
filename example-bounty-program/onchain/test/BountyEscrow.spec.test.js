// Documented promises as executable properties (round-2 security review, specification direction).
// A seeded random walk drives several bounties on the mock aggregator through every public call
// (prepare, start, draw, commits, promote, reveals, finalize, closeFailedRound, rerun, expireRerun,
// creator approval, settle, cancelUnsealed, close, time). After every step it checks:
//   P1  ETH conservation: the escrow holds exactly the open bounties' payouts, the bonds held and the
//       pull ledger (CLAUDE.md / NatSpec: every prepay leftover is passed straight on to its funder).
//   P2  nextAction soundness: "always the call that will succeed now" (CLAUDE.md, agents.txt, the
//       lens NatSpec): each label's call, sent now by a party the docs name, does not revert.
//   P3  the bond: forfeited only on a hard fail (< R scores at the threshold), returned otherwise
//       (agents.txt "Bond"), and never held by a resolved submission.
//   P4  liveness: past every deadline, following nextAction alone resolves every submission and
//       closeExpiredBounty then returns the payout ("it always resolves ... all permissionless").
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { mergedAbi } = require("../deploy/helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function mkCid(label) {
  let out = "Qm";
  let h = 7;
  for (let i = 0; out.length < 46; i++) {
    h = (h * 31 + (label.charCodeAt(i % label.length) || 0) + i) >>> 0;
    out += B58[h % B58.length];
  }
  return out;
}
const EVAL_CID = mkCid("spec-eval");
const FEE = ethers.parseEther("0.00002");
const BOUNTY = ethers.parseEther("1");
const JUST = "QmSpecJustification";
const S = { Prepared: 0, PendingVerdikta: 1, Failed: 2, PassedPaid: 3, PassedUnpaid: 4, PendingCreatorApproval: 5, AwaitingRerun: 6 };

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)] };
}

const ok = async (p) => { try { await p; return true; } catch (e) { return e; } };
const reason = (e) => (e && (e.reason || e.shortMessage || e.message || String(e))).slice(0, 140);

describe("BountyEscrow: documented promises as properties (seeded random walk)", function () {
  this.timeout(600000);

  async function setup() {
    const signers = await ethers.getSigners();
    const [owner, creator, h1, h2, h3, other] = signers;
    const agg = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
    const deployed = await (await ethers.getContractFactory("BountyEscrow")).deploy(await agg.getAddress());
    const escrow = new ethers.Contract(await deployed.getAddress(), mergedAbi(), owner);
    return { agg, escrow, owner, creator, hunters: [h1, h2, h3], other, actors: [owner, creator, h1, h2, h3, other] };
  }

  async function createBounty(f, r, i) {
    const now = await time.latest();
    const windowed = r.next() < 0.25;
    const jury = r.pick([{ K: 6, M: 5, N: 4, P: 3, timeout: 300 }, { K: 4, M: 3, N: 3, P: 2, timeout: 400 }]);
    const quota = 1 + r.int(jury.N);
    const p = {
      evaluationCid: EVAL_CID, requestedClass: 128, threshold: 70,
      submissionDeadline: now + 3600 + r.int(3 * 86400),
      targetHunter: ethers.ZeroAddress,
      creatorDeterminationPayment: windowed ? BOUNTY / 2n : BOUNTY,
      arbiterDeterminationPayment: BOUNTY,
      creatorAssessmentWindowSize: windowed ? 600 : 0,
      oracle: { maxOracleFee: FEE, alpha: 500, estimatedBaseCost: 0, maxFeeBasedScaling: 1, minOracleFee: 0, withBeacons: r.next() < 0.2 },
      jury, quota, forfeitLine: r.int(quota + 1), bond: r.next() < 0.7 ? ethers.parseEther("0.003") : 0n,
    };
    await f.escrow.connect(f.creator).createBounty(p, { value: BOUNTY });
    return { id: BigInt(i), p };
  }

  // the parties the docs name for each label, and the call they send
  async function labelCall(f, b, sid, label) {
    const s = await f.escrow.getSubmission(b, sid);
    const hunter = f.actors.find((a) => a.address === s.hunter);
    const sender = (s.status === BigInt(S.PendingCreatorApproval)) ? f.other : hunter;
    switch (label) {
      case "START": return f.escrow.connect(sender).startPreparedSubmission.staticCall(b, sid, { value: await f.escrow.startValue(b) });
      case "DRAW": return f.escrow.connect(f.other).drawJury.staticCall(b, sid);
      case "CLOSE_COMMITS": return f.agg.connect(f.other).closeCommits.staticCall(s.verdiktaAggId);
      case "PROMOTE": return f.agg.connect(f.other).promote.staticCall(s.verdiktaAggId);
      case "FINALIZE": return f.escrow.connect(f.other).finalizeSubmission.staticCall(b, sid);
      case "CLOSE_FAILED": return f.escrow.connect(f.other).closeFailedRound.staticCall(b, sid);
      case "RERUN": return f.escrow.connect(hunter).rerunSubmission.staticCall(b, sid, { value: await f.escrow.requiredPrepay(b) });
      case "EXPIRE_RERUN": return f.escrow.connect(f.other).expireRerun.staticCall(b, sid);
      case "RECOVER_REFUND": return f.escrow.connect(f.other).recoverLeftoverEth.staticCall(b, sid);
      default: return null;   // AWAIT_*, DONE, DEAD: nothing to send
    }
  }
  async function labelSend(f, b, sid, label) {
    const s = await f.escrow.getSubmission(b, sid);
    const hunter = f.actors.find((a) => a.address === s.hunter);
    const sender = (s.status === BigInt(S.PendingCreatorApproval)) ? f.other : hunter;
    switch (label) {
      case "START": return f.escrow.connect(sender).startPreparedSubmission(b, sid, { value: await f.escrow.startValue(b) });
      case "DRAW": return f.escrow.connect(f.other).drawJury(b, sid);
      case "CLOSE_COMMITS": return f.agg.connect(f.other).closeCommits(s.verdiktaAggId);
      case "PROMOTE": return f.agg.connect(f.other).promote(s.verdiktaAggId);
      case "FINALIZE": return f.escrow.connect(f.other).finalizeSubmission(b, sid);
      case "CLOSE_FAILED": return f.escrow.connect(f.other).closeFailedRound(b, sid);
      case "EXPIRE_RERUN": return f.escrow.connect(f.other).expireRerun(b, sid);
      case "RECOVER_REFUND": return f.escrow.connect(f.other).recoverLeftoverEth(b, sid);
      default: return null;
    }
  }

  async function checkInvariants(f, bounties, log, step) {
    // P1: conservation
    let owed = 0n;
    for (const b of bounties) {
      const bb = await f.escrow.getBounty(b.id);
      if (bb.status === 0n) owed += bb.payoutWei;
      const n = await f.escrow.submissionCount(b.id);
      for (let i = 0n; i < n; i++) {
        const s = await f.escrow.getSubmission(b.id, i);
        owed += s.bondHeld;
        // P3b: a resolved submission holds no bond
        if ([S.Failed, S.PassedPaid, S.PassedUnpaid].includes(Number(s.status)) && s.bondHeld !== 0n) log.push(`step ${step}: P3 resolved ${b.id}/${i} still holds bond ${s.bondHeld}`);
      }
    }
    for (const a of f.actors) owed += await f.escrow.withdrawable(a.address);
    const bal = await ethers.provider.getBalance(await f.escrow.getAddress());
    if (bal !== owed) log.push(`step ${step}: P1 escrow balance ${bal} != owed ${owed}`);
    // P2: every label's call succeeds now
    for (const b of bounties) {
      const n = await f.escrow.submissionCount(b.id);
      for (let i = 0n; i < n; i++) {
        const label = await f.escrow.nextAction(b.id, i);
        const p = await labelCall(f, b.id, i, label);
        if (p === null) continue;
        const r = await ok(p);
        if (r !== true) log.push(`step ${step}: P2 ${b.id}/${i} nextAction ${label} but the call reverts: ${reason(r)}`);
      }
    }
  }

  async function randomStep(f, r, bounties, cids) {
    const b = r.pick(bounties);
    const n = Number(await f.escrow.submissionCount(b.id));
    const sid = n ? BigInt(r.int(n)) : 0n;
    const s = n ? await f.escrow.getSubmission(b.id, sid) : null;
    const aggId = s ? s.verdiktaAggId : ethers.ZeroHash;
    const who = r.pick(f.hunters);
    const tryIt = (p) => ok(p);
    // Half the steps follow the lens (as an agent would) and play the arbiters, so walks reach
    // passes, re-runs and payout-priority waits instead of dying at the first deadline.
    if (s && r.next() < 0.5) {
      const label = await f.escrow.nextAction(b.id, sid);
      if (label === "RERUN") {
        const from = r.next() < 0.8 ? f.actors.find((a) => a.address === s.hunter) : f.other;
        return tryIt(f.escrow.connect(from).rerunSubmission(b.id, sid, { value: await f.escrow.requiredPrepay(b.id) }));
      }
      if (label === "AWAIT_ORACLE" && s.status === BigInt(S.PendingVerdikta)) {
        const [ph] = await f.agg.getRoundInfo(aggId);
        const [K, M, N] = (await f.agg.getJury(aggId)).map(Number);
        if (ph === 1n || ph === 4n) return mine(2);
        if (ph === 2n) return tryIt(f.agg.scriptBeacons(aggId, 2, false));
        if (ph === 3n) return tryIt(f.agg.scriptCommits(aggId, M + Math.ceil((K - M) / 2) - Number((await f.agg.getRoundInfo(aggId))[10])));
        if (ph === 5n) {
          const k = r.int(N + 1);
          return tryIt(f.agg.scriptReveals(aggId, Array.from({ length: N }, (_, i) => (i < k ? [100_000n, 900_000n] : [600_000n, 400_000n])), JUST));
        }
      }
      const sent = await ok(labelSend(f, b.id, sid, label));
      if (sent === true || label.startsWith("AWAIT") || label === "DONE" || label === "DEAD") return sent;
    }
    const x = r.int(20);
    switch (x) {
      case 0: case 1: {   // prepare (a copy of an existing CID sometimes)
        const cid = r.next() < 0.3 && cids.length ? r.pick(cids) : mkCid(`work-${cids.length}-${r.int(1e9)}`);
        cids.push(cid);
        return tryIt(f.escrow.connect(who).prepareSubmission(b.id, EVAL_CID, cid));
      }
      case 2: case 3: {   // start, by the hunter or anyone
        if (!s) return;
        const from = r.next() < 0.7 ? f.actors.find((a) => a.address === s.hunter) : f.other;
        return tryIt(f.escrow.connect(from).startPreparedSubmission(b.id, sid, { value: await f.escrow.startValue(b.id) }));
      }
      case 4: return s && tryIt(f.escrow.connect(f.other).drawJury(b.id, sid));
      case 5: return s && tryIt(f.agg.scriptCommits(aggId, 1 + r.int(4)));
      case 6: return s && tryIt(f.agg.connect(f.other).closeCommits(aggId));
      case 7: return s && tryIt(f.agg.connect(f.other).promote(aggId));
      case 8: case 9: {   // the N reveals, a random number of them passing
        if (!s) return;
        const [, , N] = (await f.agg.getJury(aggId)).map(Number);
        if (!N) return;
        const k = r.int(N + 1);
        const reveals = Array.from({ length: N }, (_, i) => (i < k ? [100_000n, 900_000n] : [600_000n, 400_000n]));
        return tryIt(f.agg.scriptReveals(aggId, reveals, JUST));
      }
      case 10: return s && tryIt(f.agg.scriptBeacons(aggId, r.int(3), r.next() < 0.3));
      case 11: return s && tryIt(f.escrow.connect(f.other).finalizeSubmission(b.id, sid));
      case 12: return s && tryIt(f.escrow.connect(f.other).closeFailedRound(b.id, sid));
      case 13: {
        if (!s) return;
        const from = r.next() < 0.8 ? f.actors.find((a) => a.address === s.hunter) : f.other;
        return tryIt(f.escrow.connect(from).rerunSubmission(b.id, sid, { value: await f.escrow.requiredPrepay(b.id) }));
      }
      case 14: return s && tryIt(f.escrow.connect(f.other).expireRerun(b.id, sid));
      case 15: return s && tryIt(f.escrow.connect(f.creator).creatorApproveSubmission(b.id, sid));
      case 16: return tryIt(f.escrow.connect(f.other).closeExpiredBounty(b.id));
      case 17: return s && tryIt(r.next() < 0.5 ? f.agg.settle(aggId) : f.agg.cancelUnsealed(aggId));
      case 18: return mine(1 + r.int(3));
      default: {
        const dt = r.pick([1, 20, 31, 156, 156, 301, 301, 700, 2 * 3600 + 1, 86400 + 1]);
        await time.increase(dt);
        if (r.next() < 0.05) await mine(8200);   // past the 8,191-block seed history
      }
    }
  }

  // agents.txt / CLAUDE.md: nextAction is "always the call that will succeed now". promote reads
  // blockhash(C+1), which the aggregator can read for 8,191 blocks only (SeedExpired after it), while a
  // round's deadline may be up to a day away: the lens must not keep answering PROMOTE then.
  it("PROMOTE only while promote can still read blockhash(C+1); after it the round waits for its deadline", async function () {
    const f = await setup();
    await f.agg.setLimits(50, 86400);
    const now = await time.latest();
    const jury = { K: 6, M: 5, N: 4, P: 3, timeout: 20000 };
    await f.escrow.connect(f.creator).createBounty({
      evaluationCid: EVAL_CID, requestedClass: 128, threshold: 70, submissionDeadline: now + 86400,
      targetHunter: ethers.ZeroAddress, creatorDeterminationPayment: BOUNTY, arbiterDeterminationPayment: BOUNTY,
      creatorAssessmentWindowSize: 0,
      oracle: { maxOracleFee: FEE, alpha: 500, estimatedBaseCost: 0, maxFeeBasedScaling: 1, minOracleFee: 0, withBeacons: false },
      jury, quota: 3, forfeitLine: 1, bond: 0,
    }, { value: BOUNTY });
    const [h] = f.hunters;
    await f.escrow.connect(h).prepareSubmission(0, EVAL_CID, mkCid("promote-late"));
    await f.escrow.connect(h).startPreparedSubmission(0, 0, { value: await f.escrow.startValue(0) });
    const aggId = (await f.escrow.getSubmission(0, 0)).verdiktaAggId;
    await mine(2);
    await f.escrow.drawJury(0, 0);
    await f.agg.scriptCommits(aggId, 6);                       // M+ = 6: the commit phase closes
    await mine(2);
    expect(await f.escrow.nextAction(0, 0)).to.equal("PROMOTE");
    await mine(8191);                                          // blockhash(C+1) leaves the history
    await expect(f.agg.promote(aggId)).to.be.revertedWithCustomError(f.agg, "SeedExpired");
    expect(await f.escrow.nextAction(0, 0)).to.equal("AWAIT_ORACLE");
    const [, , , , , , , , deadline] = await f.agg.getRoundInfo(aggId);
    await time.increaseTo(deadline + 1n);
    expect(await f.escrow.nextAction(0, 0)).to.equal("CLOSE_FAILED");
    await expect(f.escrow.closeFailedRound(0, 0)).to.emit(f.escrow, "RerunAwaited");
  });

  // The mock follows the real AggregatorLib.payPool (dispatcher 988632f): a draw pays the pool's eighth
  // only up to its own base fees, so a cheap draw cannot take a large pool's eighth.
  it("the mock caps a draw's pool payout at that draw's base fees, as the real aggregator does", async function () {
    const f = await setup();
    const now = await time.latest();
    await f.escrow.connect(f.creator).createBounty({
      evaluationCid: EVAL_CID, requestedClass: 128, threshold: 70, submissionDeadline: now + 3 * 86400,
      targetHunter: ethers.ZeroAddress, creatorDeterminationPayment: BOUNTY, arbiterDeterminationPayment: BOUNTY,
      creatorAssessmentWindowSize: 0,
      oracle: { maxOracleFee: FEE, alpha: 500, estimatedBaseCost: 0, maxFeeBasedScaling: 1, minOracleFee: 0, withBeacons: false },
      jury: { K: 6, M: 5, N: 4, P: 3, timeout: 300 }, quota: 3, forfeitLine: 1, bond: 0,
    }, { value: BOUNTY });
    const [h] = f.hunters;
    for (let i = 0; i < 4; i++) {   // four rounds nobody drew: each prepay (18 fees) goes to the pool
      await f.escrow.connect(h).prepareSubmission(0, EVAL_CID, mkCid(`pool-${i}`));
      await f.escrow.connect(h).startPreparedSubmission(0, i, { value: await f.escrow.startValue(0) });
    }
    await mine(8200);
    for (let i = 0; i < 4; i++) await f.escrow.closeFailedRound(0, i);
    const pool = await f.agg.ethOwed(ethers.ZeroAddress);
    expect(pool).to.equal(4n * 18n * FEE);
    await f.escrow.connect(h).prepareSubmission(0, EVAL_CID, mkCid("pool-draw"));
    await f.escrow.connect(h).startPreparedSubmission(0, 4, { value: await f.escrow.startValue(0) });
    await mine(2);
    const aggId = (await f.escrow.getSubmission(0, 4)).verdiktaAggId;
    await expect(f.escrow.drawJury(0, 4)).to.emit(f.agg, "PoolPayment").withArgs(aggId, anyValue, 6n * FEE);   // not pool / 8 = 9 fees
    expect(await f.agg.ethOwed(ethers.ZeroAddress)).to.equal(pool - 6n * FEE);
  });

  const SEEDS = (process.env.SPEC_SEEDS || "11,23,37,59").split(",").map(Number);
  const STEPS = Number(process.env.SPEC_STEPS || 160);

  for (const seed of SEEDS) {
    it(`seed ${seed}: conservation, nextAction soundness, the bond rule, and liveness`, async function () {
      const f = await setup();
      const r = rng(seed);
      const bounties = [];
      for (let i = 0; i < 3; i++) bounties.push(await createBounty(f, r, i));
      const cids = [];
      const log = [];
      const stats = { ok: 0, reverted: 0 };
      for (let step = 0; step < STEPS; step++) {
        const res = await randomStep(f, r, bounties, cids);
        if (res === true) stats.ok++; else if (res) stats.reverted++;
        if (step % 4 === 3) await checkInvariants(f, bounties, log, step);
      }
      // P4: liveness past every deadline, following nextAction alone
      const last = Math.max(...bounties.map((b) => b.p.submissionDeadline));
      if ((await time.latest()) < last) await time.increaseTo(last + 1);
      for (let pass = 0; pass < 40; pass++) {
        let moved = false;
        for (const b of bounties) {
          const n = await f.escrow.submissionCount(b.id);
          for (let i = 0n; i < n; i++) {
            const label = await f.escrow.nextAction(b.id, i);
            if (["DONE", "DEAD"].includes(label)) continue;
            if (label === "AWAIT_ORACLE" || label === "AWAIT_EARLIER" || label === "AWAIT_EXPIRY" || label === "AWAIT_SLOT" || label === "AWAIT_CREATOR") continue;
            const res = await ok(labelSend(f, b.id, i, label));
            if (res !== true) log.push(`liveness: ${b.id}/${i} ${label} reverts: ${reason(res)}`);
            else moved = true;
          }
        }
        if (!moved) { await time.increase(3600); await mine(8200); }
        // done when nothing but DONE / DEAD remains
        let open = 0;
        for (const b of bounties) {
          const n = await f.escrow.submissionCount(b.id);
          for (let i = 0n; i < n; i++) if (!["DONE", "DEAD"].includes(await f.escrow.nextAction(b.id, i))) open++;
        }
        if (!open) break;
      }
      for (const b of bounties) {
        const n = await f.escrow.submissionCount(b.id);
        for (let i = 0n; i < n; i++) {
          const label = await f.escrow.nextAction(b.id, i);
          if (!["DONE", "DEAD"].includes(label)) log.push(`liveness: ${b.id}/${i} stuck at ${label} (status ${(await f.escrow.getSubmission(b.id, i)).status})`);
        }
        const bb = await f.escrow.getBounty(b.id);
        if (bb.status === 0n) {
          const res = await ok(f.escrow.connect(f.other).closeExpiredBounty(b.id));
          if (res !== true) log.push(`liveness: bounty ${b.id} cannot close: ${reason(res)}`);
        }
      }
      await checkInvariants(f, bounties, log, "end");
      // P3a: a forfeit only on a hard fail (the stored passCount below R), to the creator
      for (const ev of await f.escrow.queryFilter(f.escrow.filters.BondForfeited())) {
        const [bid, sid, to] = ev.args;
        const s = await f.escrow.getSubmission(bid, sid);
        const bb = await f.escrow.getBounty(bid);
        if (!(s.passCount < bb.forfeitLine) || to !== bb.creator) log.push(`P3 bond of ${bid}/${sid} forfeited with passCount ${s.passCount} >= R ${bb.forfeitLine}`);
      }
      const bal = await ethers.provider.getBalance(await f.escrow.getAddress());
      let ledger = 0n;
      for (const a of f.actors) ledger += await f.escrow.withdrawable(a.address);
      if (bal !== ledger) log.push(`end: escrow keeps ${bal - ledger} wei nobody can claim`);
      if (process.env.SPEC_VERBOSE) {
        const st = [];
        for (const b of bounties) { const n = await f.escrow.submissionCount(b.id); for (let i = 0n; i < n; i++) st.push(Number((await f.escrow.getSubmission(b.id, i)).status) + '/' + (await f.escrow.getSubmission(b.id, i)).rounds); }
        console.log(`seed ${seed}: ${stats.ok} calls landed, ${stats.reverted} reverted; bounties ${(await Promise.all(bounties.map((b) => f.escrow.getBounty(b.id)))).map((x) => x.status).join(',')}; status/rounds ${st.join(' ')}`);
      }
      if (log.length) console.log(`seed ${seed}:\n  ` + [...new Set(log)].slice(0, 40).join("\n  "));
      expect(log, "property violations").to.deep.equal([]);
    });
  }
});
