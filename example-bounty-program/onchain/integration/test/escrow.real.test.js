// BountyEscrow (verdikta-applications `beacon`) against the REAL v2 ReputationAggregator /
// ReputationKeeper / JuryBeacons (verdikta-dispatcher `beacon`), driven through TestOperator.
// One chain, scenarios run in order (the arbiters' hash chains live in JS, so no snapshots).
// At every step the lens's nextAction is cross-checked: the named call must simulate OK, and for
// AWAIT_* / DONE every step call must revert.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");
const { RoundDriver } = require("./round");
const fs = require("fs");
const path = require("path");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function mkCid(label) {
  let out = "Qm", h = 11;
  for (let i = 0; out.length < 46; i++) { h = (h * 31 + (label.charCodeAt(i % label.length) || 0) + i) >>> 0; out += B58[h % B58.length]; }
  return out;
}
const CLS = 128;
const BOUNTY = ethers.parseEther("1");
const FEE = ethers.parseEther("0.00002");   // bounty fee ceiling (arbiters post 1e13)
const BOND = ethers.parseEther("0.005");
const PASS = 900_000n, FAIL = 400_000n;     // FUND scores; threshold 70
const HOUR = 3600;
// The juries (CreateParams.jury), all on ONE aggregator: the Small class preset, a 12-arbiter jury, and
// the Jumbo class preset (example-bounty-program/shared/classPresets.js).
const SMALL = { K: 6, M: 5, N: 4, P: 3, timeout: 300 };
const J12 = { K: 12, M: 10, N: 8, P: 4, timeout: 300 };
const JUMBO = { K: 50, M: 38, N: 27, P: 17, timeout: 600 };

function mergedAbi() {
  const rd = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".artifacts", ".contracts", "apps", `${n}.sol`, `${n}.json`))).abi;
  const key = (f) => `${f.type}:${f.name || ""}(${(f.inputs || []).map((i) => i.internalType || i.type).join(",")})`;
  const e = rd("BountyEscrow"), seen = new Set(e.map(key));
  return [...e, ...rd("BountyEscrowLens").filter((f) => f.type === "function" && !seen.has(key(f)))];
}

describe("BountyEscrow x real v2 aggregator", function () {
  let core, keeper, beacons, agg, escrow, arbs, history;
  let deployer, creator, hunter, other;
  const lensLog = [];      // [scenario, step, nextAction, consistent, note]
  const mismatches = [];
  const gas = {};          // label -> [{used, est}]
  const results = {};
  const minGas = {};

  const recGas = (label, rc, est) => (gas[label] = gas[label] || []).push({ used: Number(rc.gasUsed), est: est ? Number(est) : undefined });

  /** send with gasLimit = eth_estimateGas exactly (the tightest the server's estimate path can give) */
  async function sendExact(label, contract, fn, args, overrides = {}) {
    let est;
    try { est = await contract[fn].estimateGas(...args, overrides); }
    catch (e) {
      // estimate refused (over the 16,777,216 per-tx cap): send at the cap and record what it really uses
      console.log(`    [${label}] estimateGas failed: ${(e.shortMessage || e.message).slice(0, 120)}`);
      // smallest gasLimit at which the call succeeds (binary search with eth_call)
      let lo = 1_000_000, hi = 16_777_216;
      const okAt = async (g) => { try { await contract[fn].staticCall(...args, { ...overrides, gasLimit: g }); return true; } catch { return false; } };
      if (await okAt(hi)) {
        while (hi - lo > 5_000) { const mid = Math.floor((lo + hi) / 2); if (await okAt(mid)) hi = mid; else lo = mid; }
        console.log(`    [${label}] minimal gasLimit that succeeds: ${hi}`);
        minGas[label] = hi;
      } else console.log(`    [${label}] fails even at the 16,777,216 cap`);
      const rc = await (await contract[fn](...args, { ...overrides, gasLimit: 16_777_216 })).wait();
      recGas(label + " [estimate refused; sent at 16.78M cap]", rc);
      return rc;
    }
    const rc = await (await contract[fn](...args, { ...overrides, gasLimit: est })).wait();
    recGas(label, rc, est);
    return rc;
  }

  const drvFor = () => new RoundDriver({ agg, keeper, beacons, link: core.link }, arbs, hunter);
  const aggOf = async () => { expect(await escrow.aggregator()).to.equal(agg.target); return agg; };

  async function createBounty(o = {}) {
    const p = {
      evaluationCid: mkCid("eval" + Math.random()), requestedClass: o.cls ?? CLS, threshold: 70,
      submissionDeadline: (await time.latest()) + 7 * 24 * HOUR, targetHunter: ethers.ZeroAddress,
      creatorDeterminationPayment: BOUNTY, arbiterDeterminationPayment: BOUNTY, creatorAssessmentWindowSize: 0,
      oracle: { maxOracleFee: FEE, alpha: 500, estimatedBaseCost: 0, maxFeeBasedScaling: 1, minOracleFee: 0n, withBeacons: o.withBeacons ?? false },
      jury: o.jury ?? SMALL, quota: o.quota ?? 3, forfeitLine: o.forfeitLine ?? 2, bond: BOND,
    };
    const rc = await (await escrow.connect(creator).createBounty(p, { value: BOUNTY })).wait();
    const ev = rc.logs.map((l) => { try { return escrow.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "BountyCreated");
    return { b: ev.args.bountyId, evalCid: p.evaluationCid };
  }

  async function prepareStart(b, evalCid, label = "small", who = hunter) {
    const rc = await (await escrow.connect(who).prepareSubmission(b, evalCid, mkCid("hunter" + Math.random()))).wait();
    const ev = rc.logs.map((l) => { try { return escrow.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "SubmissionPrepared");
    const s = ev.args.submissionId, wallet = ev.args.evalWallet;
    const value = await escrow.startValue(b);
    await sendExact(`startPreparedSubmission (${label})`, escrow.connect(who), "startPreparedSubmission", [b, s], { value });
    const aggId = (await escrow.getSubmission(b, s)).verdiktaAggId;
    return { s, wallet, aggId };
  }

  /** nextAction, cross-checked against what actually simulates */
  async function lens(scn, step, b, s, expectAction) {
    const act = await escrow.nextAction(b, s);
    const agg = await aggOf();
    const aggId = (await escrow.getSubmission(b, s)).verdiktaAggId;
    const calls = {
      DRAW: () => escrow.connect(other).drawJury.staticCall(b, s),
      CLOSE_COMMITS: () => agg.connect(other).closeCommits.staticCall(aggId),
      PROMOTE: () => agg.connect(other).promote.staticCall(aggId),
      FINALIZE: () => escrow.connect(other).finalizeSubmission.staticCall(b, s),
      CLOSE_FAILED: () => escrow.connect(other).closeFailedRound.staticCall(b, s),
      EXPIRE_RERUN: () => escrow.connect(other).expireRerun.staticCall(b, s),
      RERUN: async () => escrow.connect(hunter).rerunSubmission.staticCall(b, s, { value: await escrow.requiredPrepay(b) }),
    };
    const why = async (f) => { try { await f(); return null; } catch (e) { return e.reason || e.shortMessage || (e.message || "").slice(0, 80); } };
    let ok = true, note = "";
    if (calls[act]) {
      const err = await why(calls[act]);
      if (err) { ok = false; note = `${act} reverts: ${err}`; }
    } else {
      for (const [k, f] of Object.entries(calls)) {
        if (aggId === ethers.ZeroHash && (k === "CLOSE_COMMITS" || k === "PROMOTE")) continue;
        const err = await why(f);
        if (!err) { ok = false; note += `${k} succeeds while lens says ${act}; `; }
      }
    }
    if (expectAction && act !== expectAction) { ok = false; note += `expected ${expectAction}`; }
    lensLog.push([scn, step, act, ok ? "ok" : "MISMATCH", note]);
    if (!ok) mismatches.push(`${scn} / ${step}: lens ${act} — ${note}`);
    return act;
  }

  /** escrow.drawJury, then map slots and answer every health call the draw sent */
  async function draw(round, b, s, label) {
    const rc = await sendExact(label, escrow.connect(other), "drawJury", [b, s]);
    round.rcpt = rc;
    for (const x of await round.drv._mapRequests(rc)) round.slots[x.slot] = { ...x, commitReq: x.req };
    await round.drv.answerAll(round);
    return rc;
  }

  /** plan the commits so that exactly `pw` of the N counted reveals are at PASS */
  function vectorsFor(nCommit, M, N, pw, oneNumber) {
    const extra = nCommit - M;
    const p = Math.min(nCommit, pw + extra), out = [];
    let f = N - pw + extra; if (p + f > nCommit) f = nCommit - p;
    const v = (x) => (oneNumber ? [x] : [1_000_000n - x, x]);
    for (let i = 0; i < nCommit; i++) out.push(i < nCommit - f ? { pass: true, vec: v(PASS) } : { pass: false, vec: v(FAIL) });
    return out;
  }

  /** commits -> (closeCommits) -> promote -> reveals, checking the lens at each step */
  async function runRound(scn, b, s, round, { pw, viaCloseCommits = false, oneNumber = false, mixLen = false }) {
    const agg = round.drv.agg;
    const [K, M, N] = (await agg.getJury(round.aggId)).map(Number);
    const mPlus = M + Math.ceil((K - M) / 2);
    const nCommit = viaCloseCommits ? M : mPlus;
    const plan = vectorsFor(nCommit, M, N, pw, oneNumber);
    if (mixLen) plan[0].vec = [plan[0].vec[plan[0].vec.length - 1]];   // one juror answers with one number
    const slots = Object.keys(round.slots).map(Number).sort((a, b2) => a - b2).slice(0, nCommit);
    for (let i = 0; i < nCommit; i++) { round.slots[slots[i]].pass = plan[i].pass; await round.drv.commit(round, slots[i], plan[i].vec); }
    if (viaCloseCommits) {
      await lens(scn, "M commits, before T+", b, s, "AWAIT_ORACLE");
      await time.increase(Number(await agg.tPlus()) + 1);
      await lens(scn, "M commits, after T+", b, s, "CLOSE_COMMITS");
      await round.drv.closeCommits(round);
    }
    await lens(scn, "closed, C+1", b, s);
    await mine(1);
    await lens(scn, "closed, C+2", b, s, "PROMOTE");
    await round.drv.promote(round, { by: other, waitBlocks: 0 });
    await lens(scn, "promoted", b, s, "AWAIT_ORACLE");
    const prom = round.drv.promotedSlots(round);
    const passS = prom.filter((x) => round.slots[x].pass), failS = prom.filter((x) => !round.slots[x].pass);
    const order = [...passS.slice(0, pw), ...failS.slice(0, N - pw)];
    if (order.length !== N) throw new Error(`plan failed: ${passS.length} pass / ${failS.length} fail promoted`);
    for (const x of order) await round.drv.reveal(round, x);
    expect((await agg.getRoundInfo(round.aggId))[0]).to.equal(6n);
  }

  before(async () => {
    [deployer, creator, hunter, , other] = await ethers.getSigners();
    core = await H.deployCore({ withAggregator: false });
    keeper = core.keeper;
    const aggLib = await (await ethers.getContractFactory("AggregatorLib")).deploy();
    const scoring = await (await ethers.getContractFactory("ScoringLib")).deploy();
    const F = await ethers.getContractFactory("ReputationAggregator", { libraries: { AggregatorLib: aggLib.target, ScoringLib: scoring.target } });
    // ONE aggregator serves every jury (item 15): each bounty's jury goes with its requests
    agg = await F.deploy(core.link.target, keeper.target);
    beacons = await (await ethers.getContractFactory("JuryBeacons")).deploy(keeper.target);
    await keeper.setApproved(agg.target, true);
    await keeper.setApproved(beacons.target, true);
    await beacons.setApproved(agg.target, true);
    await agg.setContracts(keeper.target, beacons.target);
    await agg.setLimits(50, 3600, 155);                                                 // dispatcher deploy/03_config.js
    expect(await agg.maxJury()).to.equal(50n);
    expect(await agg.maxTimeout()).to.equal(3600n);
    arbs = await H.registerArbiters(core, 26, { cls: CLS });
    arbs = arbs.concat(await H.registerArbiters(core, 64, { cls: CLS + 1 }));          // the K=50 jury's own class
    history = await H.installHistory();
    const E = await ethers.getContractFactory("BountyEscrow");
    const d = await E.deploy(agg.target);
    escrow = new ethers.Contract(d.target, mergedAbi(), deployer);
    const sz = async (a) => (await ethers.provider.getCode(a)).length / 2 - 1;
    console.log("sizes (bytes): escrow", await sz(d.target), "lens", await sz(await escrow.lens()), "aggregator", await sz(agg.target), "keeper", await sz(keeper.target));
  });

  // ------------------------------------------------------------------ 1. pass
  it("1. pass (3 of 4, via CLOSE_COMMITS): paid, bond back, leftover + draw reward to the funder", async () => {
    const scn = "1 pass";
    const { b, evalCid } = await createBounty();
    const { s, wallet, aggId } = await prepareStart(b, evalCid);
    const round = { aggId, slots: {}, drv: drvFor() };
    expect(await agg.getJury(aggId)).to.deep.equal([6n, 5n, 4n, 3n, 300n]);   // the bounty's Small jury
    await lens(scn, "started (block B)", b, s);
    await mine(1);
    await lens(scn, "B+1 mined", b, s, "DRAW");
    const drc = await draw(round, b, s, "drawJury (small K=6)");
    const jd = drc.logs.filter((l) => l.address === agg.target).map((l) => { try { return agg.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "JuryDrawn");
    expect(jd.args.drawer).to.equal(wallet);
    const drawReward = jd.args.reward;
    expect(drawReward).to.equal(2n * FEE);
    await lens(scn, "drawn", b, s, "AWAIT_ORACLE");
    await runRound(scn, b, s, round, { pw: 3, viaCloseCommits: true });
    await lens(scn, "N-th reveal in", b, s, "FINALIZE");
    const r = await escrow.getOracleResult(b, s);
    const hb = await ethers.provider.getBalance(hunter.address);
    const rc = await sendExact("finalizeSubmission (pass, K=6)", escrow.connect(other), "finalizeSubmission", [b, s]);
    const i = await agg.getRoundInfo(aggId);
    const leftover = i[4] - i[5] - i[6] - i[7];
    const delta = (await ethers.provider.getBalance(hunter.address)) - hb;
    const sub = await escrow.getSubmission(b, s);
    results[scn] = { status: sub.status, passCount: sub.passCount, acceptance: sub.acceptance, rejection: sub.rejection, outcome: r.outcome, delta, expected: BOUNTY + BOND + leftover + drawReward };
    expect(sub.status).to.equal(3n);
    expect(sub.passCount).to.equal(3n);
    expect(sub.bondHeld).to.equal(0n);
    expect(delta).to.equal(BOUNTY + BOND + leftover + drawReward);
    expect(await agg.ethOwed(wallet)).to.equal(0n);
    expect(await ethers.provider.getBalance(wallet)).to.equal(0n);
    await lens(scn, "finalized", b, s, "DONE");
    // settle later (keeper scoring) does not disturb the escrow
    await time.increase(301);
    await agg.connect(other).settle(aggId);
    await lens(scn, "round settled (7)", b, s, "DONE");
  });

  // ------------------------------------------------------------------ 2. soft fail, re-run, pass
  it("2. soft fail (2 of 4) -> AwaitingRerun -> rerun -> pass (4 of 4)", async () => {
    const scn = "2 soft->rerun";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    let round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await lens(scn, "B+1 mined", b, s, "DRAW");
    await draw(round, b, s, "drawJury (small K=6)");
    await runRound(scn, b, s, round, { pw: 2 });
    await lens(scn, "result (soft)", b, s, "FINALIZE");
    await sendExact("finalizeSubmission (soft fail -> rerun)", escrow.connect(other), "finalizeSubmission", [b, s]);
    let sub = await escrow.getSubmission(b, s);
    expect(sub.status).to.equal(6n);
    expect(sub.bondHeld).to.equal(BOND);
    await lens(scn, "awaiting rerun", b, s, "RERUN");
    const prepay = await escrow.requiredPrepay(b);
    await sendExact("rerunSubmission (small)", escrow.connect(hunter), "rerunSubmission", [b, s], { value: prepay });
    sub = await escrow.getSubmission(b, s);
    expect(sub.rounds).to.equal(2n);
    round = { aggId: sub.verdiktaAggId, slots: {}, drv: drvFor() };
    await mine(1);
    await lens(scn, "round 2, B+1", b, s, "DRAW");
    await draw(round, b, s, "drawJury (small K=6)");
    await runRound(scn, b, s, round, { pw: 4 });
    await lens(scn, "round 2 result", b, s, "FINALIZE");
    await sendExact("finalizeSubmission (pass, K=6)", escrow.connect(other), "finalizeSubmission", [b, s]);
    sub = await escrow.getSubmission(b, s);
    results[scn] = { status: sub.status, passCount: sub.passCount, rounds: sub.rounds };
    expect(sub.status).to.equal(3n);
    expect(sub.passCount).to.equal(4n);
  });

  // ------------------------------------------------------------------ 3. hard fail
  it("3. hard fail (1 of 4): Failed, bond to the creator", async () => {
    const scn = "3 hard fail";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    const round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await draw(round, b, s, "drawJury (small K=6)");
    await runRound(scn, b, s, round, { pw: 1 });
    await lens(scn, "result (hard)", b, s, "FINALIZE");
    const cb = await ethers.provider.getBalance(creator.address);
    await sendExact("finalizeSubmission (hard fail)", escrow.connect(other), "finalizeSubmission", [b, s]);
    const sub = await escrow.getSubmission(b, s);
    const cd = (await ethers.provider.getBalance(creator.address)) - cb;
    results[scn] = { status: sub.status, passCount: sub.passCount, creatorDelta: cd };
    expect(sub.status).to.equal(2n);
    expect(cd).to.equal(BOND);
    await lens(scn, "finalized", b, s, "DONE");
  });

  // ------------------------------------------------------------------ 4. failed round
  it("4a. too few commits past the deadline: closeFailedRound -> AwaitingRerun (prepay refunded); expireRerun after 2 h", async () => {
    const scn = "4a few commits";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    const round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await draw(round, b, s, "drawJury (small K=6)");
    for (const x of [0, 1]) await round.drv.commit(round, x, [100_000n, PASS]);
    await lens(scn, "2 commits", b, s, "AWAIT_ORACLE");
    await time.increase(301);
    await lens(scn, "past deadline", b, s, "CLOSE_FAILED");
    const hb = await ethers.provider.getBalance(hunter.address);
    const i0 = await agg.getRoundInfo(aggId);
    await sendExact("closeFailedRound (settle path, K=6)", escrow.connect(other), "closeFailedRound", [b, s]);
    const i = await agg.getRoundInfo(aggId);
    const sub = await escrow.getSubmission(b, s);
    const delta = (await ethers.provider.getBalance(hunter.address)) - hb;
    results[scn] = { phase: i[0], status: sub.status, bondHeld: sub.bondHeld, hunterRefund: delta, expected: i0[4] - i0[5] };
    expect(i[0]).to.equal(8n);
    expect(sub.status).to.equal(6n);
    expect(sub.bondHeld).to.equal(BOND);
    expect(delta).to.equal(i0[4] - i0[5]);    // everything but the base fees (incl. the draw reward)
    await lens(scn, "awaiting rerun", b, s, "RERUN");
    await time.increase(2 * HOUR + 1);
    await lens(scn, "rerun window closed", b, s, "EXPIRE_RERUN");
    const hb2 = await ethers.provider.getBalance(hunter.address);
    await sendExact("expireRerun", escrow.connect(other), "expireRerun", [b, s]);
    expect((await ethers.provider.getBalance(hunter.address)) - hb2).to.equal(BOND);
    expect((await escrow.getSubmission(b, s)).status).to.equal(2n);
    await lens(scn, "expired", b, s, "DONE");
  });

  it("4b. M commits but never closed/promoted: closeFailedRound -> prepay shared by the committers, bond kept", async () => {
    const scn = "4b M commits unpromoted";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    const round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await draw(round, b, s, "drawJury (small K=6)");
    for (const x of [0, 1, 2, 3, 4]) await round.drv.commit(round, x, [100_000n, PASS]);
    await time.increase(301);
    await lens(scn, "past deadline", b, s, "CLOSE_FAILED");
    const p0 = await agg.ethOwed(ethers.ZeroAddress);                                  // the arbiter pool
    const hb = await ethers.provider.getBalance(hunter.address);
    const left = (r) => r[4] - r[5] - r[6] - r[7];
    const before = left(await agg.getRoundInfo(aggId));
    await sendExact("closeFailedRound (settle path, K=6)", escrow.connect(other), "closeFailedRound", [b, s]);
    const i = await agg.getRoundInfo(aggId);
    const sub = await escrow.getSubmission(b, s);
    // the 5 committed slots share the unspent prepay (CommitPayment, counted in rewards); the rest to the pool
    const shares = await agg.queryFilter(agg.filters.CommitPayment(aggId));
    expect(shares.length).to.equal(5);
    const share = before / 5n;
    for (const e of shares) expect(e.args.amount).to.equal(share);
    const poolGot = (await agg.ethOwed(ethers.ZeroAddress)) - p0;
    expect(poolGot).to.equal(before - share * 5n);
    expect(left(i)).to.equal(poolGot);
    results[scn] = { phase: i[0], status: sub.status, committersGot: share * 5n, poolGot, hunterGot: (await ethers.provider.getBalance(hunter.address)) - hb };
    expect(sub.status).to.equal(6n);
    expect(sub.bondHeld).to.equal(BOND);
  });

  // ------------------------------------------------------------------ 5. undrawn round
  it("5a. undrawn, unsealed: after 1 day still AWAIT_ORACLE; after 8,192 blocks closeFailedRound cancels (prepay to the arbiter pool)", async () => {
    const scn = "5a undrawn unsealed";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    await time.increase(24 * HOUR + 1);
    await lens(scn, "1 day, unsealed", b, s, "AWAIT_ORACLE");
    await mine(8200);
    await lens(scn, "past 8,191 blocks", b, s, "CLOSE_FAILED");
    const p0 = await agg.ethOwed(ethers.ZeroAddress);                                  // the arbiter pool
    const hb = await ethers.provider.getBalance(hunter.address);
    await sendExact("closeFailedRound (cancelUnsealed path)", escrow.connect(other), "closeFailedRound", [b, s]);
    const i = await agg.getRoundInfo(aggId);
    const sub = await escrow.getSubmission(b, s);
    results[scn] = { phase: i[0], status: sub.status, bondHeld: sub.bondHeld, poolGot: (await agg.ethOwed(ethers.ZeroAddress)) - p0, received: i[4], hunterGot: (await ethers.provider.getBalance(hunter.address)) - hb };
    expect(i[0]).to.equal(9n);
    expect(results[scn].poolGot).to.equal(i[4]);                                         // the whole prepay
    expect(sub.status).to.equal(6n);
    expect(sub.bondHeld).to.equal(BOND);
    await lens(scn, "after cancel", b, s, "RERUN");
  });

  it("5b. undrawn, sealed: closeFailedRound after 1 day (cancelUnsealed)", async () => {
    const scn = "5b undrawn sealed";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    await mine(1);
    await agg.connect(other).sealSeed(aggId);
    await time.increase(24 * HOUR - 60);
    await lens(scn, "sealed, < 1 day", b, s, "DRAW");
    await time.increase(61);
    await lens(scn, "sealed, > 1 day", b, s, "CLOSE_FAILED");
    await sendExact("closeFailedRound (cancelUnsealed path)", escrow.connect(other), "closeFailedRound", [b, s]);
    const sub = await escrow.getSubmission(b, s);
    results[scn] = { phase: (await agg.getRoundInfo(aggId))[0], status: sub.status, bondHeld: sub.bondHeld };
    expect(sub.status).to.equal(6n);
  });

  it("5c. drawn after 256 blocks (seed from EIP-2935 history)", async () => {
    const scn = "5c late draw";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    await mine(300);
    await lens(scn, "300 blocks, no history entry", b, s);
    const [, B] = await agg.getRoundInfo(aggId);
    await H.recordHash(history, B + 1n);
    await lens(scn, "300 blocks, history has B+1", b, s, "DRAW");
    const round = { aggId, slots: {}, drv: drvFor() };
    await draw(round, b, s, "drawJury (small K=6)");
    // leave it to fail: no commits
    await time.increase(301);
    await escrow.connect(other).closeFailedRound(b, s);
  });

  // ------------------------------------------------------------------ 6. one number
  it("6a. one-number result [FUND]: pass at 3 of 4", async () => {
    const scn = "6a one-number";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    const round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await draw(round, b, s, "drawJury (small K=6)");
    await runRound(scn, b, s, round, { pw: 3, oneNumber: true });
    const [scoresOut] = await agg.getEvaluation(aggId);
    await lens(scn, "result", b, s, "FINALIZE");
    await escrow.connect(other).finalizeSubmission(b, s);
    const sub = await escrow.getSubmission(b, s);
    results[scn] = { aggregatedLen: scoresOut.length, aggregated: scoresOut.map(String).join("/"), status: sub.status, passCount: sub.passCount, acceptance: sub.acceptance, rejection: sub.rejection };
    expect(scoresOut.length).to.equal(1);
    expect(sub.status).to.equal(3n);
  });

  it("6b. mixed lengths (one juror reveals one number among two-outcome reveals)", async () => {
    const scn = "6b mixed lengths";
    const { b, evalCid } = await createBounty();
    const { s, aggId } = await prepareStart(b, evalCid);
    const round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await draw(round, b, s, "drawJury (small K=6)");
    await runRound(scn, b, s, round, { pw: 4, mixLen: true });
    const [scoresOut] = await agg.getEvaluation(aggId);
    const [scores] = await agg.getOutcomeScores(aggId, 1);
    await escrow.connect(other).finalizeSubmission(b, s);
    const sub = await escrow.getSubmission(b, s);
    results[scn] = { aggregatedLen: scoresOut.length, fundScores: scores.map(String).join("/"), status: sub.status, passCount: sub.passCount };
  });

  // ------------------------------------------------------------------ 7. beacons (jumbo)
  it("7. jumbo (12/10/8/4) with beacons: drawJury twice, pass 7 of 8 (Q=6, R=4)", async () => {
    const scn = "7 jumbo beacons";
    const { b, evalCid } = await createBounty({ jury: J12, withBeacons: true, quota: 6, forfeitLine: 4 });
    const { s, wallet, aggId } = await prepareStart(b, evalCid, "jumbo+beacons");
    const drv = drvFor();
    const round = { aggId, slots: {}, drv };
    await mine(1);
    await lens(scn, "B+1", b, s, "DRAW");
    const rc1 = await sendExact("drawJury (beacon start)", escrow.connect(other), "drawJury", [b, s]);
    expect((await agg.getRoundInfo(aggId))[0]).to.equal(2n);
    const topic = beacons.interface.getEvent("BeaconCalled").topicHash;
    round.beacons = rc1.logs.filter((l) => l.topics[0] === topic).map((l) => beacons.interface.parseLog(l).args)
      .map((a) => ({ index: Number(a.index), key: a.key, arb: drv.byKey.get(a.key) }));
    await lens(scn, "beacon stage, 0 values", b, s, "AWAIT_ORACLE");
    await drv.answerBeacon(round, 0);
    await lens(scn, "beacon stage, 1 value", b, s, "AWAIT_ORACLE");
    await drv.answerBeacon(round, 1);
    await lens(scn, "beacon stage, quorum", b, s, "DRAW");
    for (const bc of round.beacons.slice(2)) await drv.answerBeacon(round, bc.index);   // keep them unfrozen
    const rc2 = await draw(round, b, s, "drawJury (jumbo K=12 after beacons)");
    const jd = rc2.logs.filter((l) => l.address === agg.target).map((l) => { try { return agg.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "JuryDrawn");
    expect(Object.keys(round.slots).length).to.equal(12);
    await lens(scn, "drawn", b, s, "AWAIT_ORACLE");
    await runRound(scn, b, s, round, { pw: 7 });
    await lens(scn, "result", b, s, "FINALIZE");
    const hb = await ethers.provider.getBalance(hunter.address);
    await sendExact("finalizeSubmission (pass, jumbo N=8)", escrow.connect(other), "finalizeSubmission", [b, s]);
    const i = await agg.getRoundInfo(aggId);
    const sub = await escrow.getSubmission(b, s);
    const delta = (await ethers.provider.getBalance(hunter.address)) - hb;
    results[scn] = { status: sub.status, passCount: sub.passCount, drawReward: jd.args.reward, drawer: jd.args.drawer === wallet ? "wallet" : jd.args.drawer, delta, expected: BOUNTY + BOND + (i[4] - i[5] - i[6] - i[7]) + jd.args.reward };
    expect(sub.status).to.equal(3n);
    expect(delta).to.equal(BOUNTY + BOND + (i[4] - i[5] - i[6] - i[7]) + jd.args.reward);
    await time.increase(301);
    await sendExact("settle (jumbo, direct)", agg.connect(other), "settle", [aggId]);
  });

  it("7b. jumbo: failed round settle path gas (too few commits)", async () => {
    const { b, evalCid } = await createBounty({ jury: J12, quota: 6, forfeitLine: 4 });
    const { s, aggId } = await prepareStart(b, evalCid, "jumbo");
    const round = { aggId, slots: {}, drv: drvFor() };
    await mine(1);
    await draw(round, b, s, "drawJury (jumbo K=12, no beacons)");
    for (const x of [0, 1, 2]) await round.drv.commit(round, x, [100_000n, PASS]);
    await time.increase(301);
    await lens("7b jumbo failed", "past deadline", b, s, "CLOSE_FAILED");
    await sendExact("closeFailedRound (settle path, K=12)", escrow.connect(other), "closeFailedRound", [b, s]);
    expect((await escrow.getSubmission(b, s)).status).to.equal(6n);
  });

  // ------------------------------------------------------------------ 8. the real Jumbo config K=50
  it("8a. jumbo K=50/38/27/17 with beacons: pass 20 of 27 (Q=18, R=12)", async () => {
    const scn = "8a jumbo50 beacons";
    const { b, evalCid } = await createBounty({ jury: JUMBO, cls: CLS + 1, withBeacons: true, quota: 18, forfeitLine: 12 });
    const { s, aggId } = await prepareStart(b, evalCid, "jumbo50+beacons");
    expect(await agg.getJury(aggId)).to.deep.equal([50n, 38n, 27n, 17n, 600n]);   // Jumbo, on the same aggregator
    const drv = drvFor();
    const round = { aggId, slots: {}, drv };
    await mine(2);
    await lens(scn, "B+2", b, s, "DRAW");
    const rc1 = await sendExact("drawJury (beacon start, K=50 class)", escrow.connect(other), "drawJury", [b, s]);
    const topic = beacons.interface.getEvent("BeaconCalled").topicHash;
    round.beacons = rc1.logs.filter((l) => l.topics[0] === topic).map((l) => beacons.interface.parseLog(l).args)
      .map((a) => ({ index: Number(a.index), key: a.key, arb: drv.byKey.get(a.key) }));
    for (const bc of round.beacons) await drv.answerBeacon(round, bc.index);
    await mine(1);
    await lens(scn, "beacon quorum (+1 block)", b, s, "DRAW");
    await draw(round, b, s, "drawJury (K=50 after beacons)");
    expect(Object.keys(round.slots).length).to.equal(50);
    await lens(scn, "drawn", b, s, "AWAIT_ORACLE");
    await runRound(scn, b, s, round, { pw: 20 });
    await lens(scn, "result", b, s, "FINALIZE");
    await sendExact("finalizeSubmission (pass, K=50 N=27)", escrow.connect(other), "finalizeSubmission", [b, s]);
    const sub = await escrow.getSubmission(b, s);
    results[scn] = { status: sub.status, passCount: sub.passCount, acceptance: sub.acceptance };
    expect(sub.status).to.equal(3n);
    expect(sub.passCount).to.equal(20n);
  });

  it("8b. jumbo K=50: a start that settles 2 due K=50 rounds; closeFailedRound settle path at K=50", async () => {
    const scn = "8b jumbo50 settle";
    const signers = await ethers.getSigners();
    const { b, evalCid } = await createBounty({ jury: JUMBO, cls: CLS + 1, quota: 18, forfeitLine: 12 });
    const subs = [];
    for (const who of [signers[2], signers[3]]) {
      const x = await prepareStart(b, evalCid, "jumbo50", who);
      const round = { aggId: x.aggId, slots: {}, drv: drvFor() };
      await mine(2);   // eth_call runs at the latest block: B+2 must be mined for the gas search
      await draw(round, b, x.s, "drawJury (K=50, no beacons)");
      for (const sl of [0, 1, 2]) await round.drv.commit(round, sl, [100_000n, PASS]);
      subs.push(x);
    }
    await time.increase(601);
    await lens(scn, "X past deadline", b, subs[0].s, "CLOSE_FAILED");
    // the queue now holds 8a's final round + X + Y, all due: the next request settles two of them
    const { b: b2, evalCid: e2 } = await createBounty({ jury: JUMBO, cls: CLS + 1, quota: 18, forfeitLine: 12 });
    const z = await prepareStart(b2, e2, "jumbo50, settles 2 due K=50 rounds", signers[5]);
    const rc = await ethers.provider.getTransactionReceipt((await escrow.queryFilter(escrow.filters.WorkSubmitted(b2))).pop().transactionHash);
    const settled = rc.logs.filter((l) => l.address === agg.target && l.topics[0] === agg.interface.getEvent("RoundSettled").topicHash).length;
    results[scn] = { settledInsideStart: settled, startGas: Number(rc.gasUsed) };
    for (const x of subs) {
      const ph = (await agg.getRoundInfo(x.aggId))[0];
      await lens(scn, `sub ${x.s} phase ${ph}`, b, x.s, "CLOSE_FAILED");
      await sendExact(`closeFailedRound (K=50, round phase ${ph} before)`, escrow.connect(other), "closeFailedRound", [b, x.s]);
      expect((await escrow.getSubmission(b, x.s)).status).to.equal(6n);
    }
  });

  after(() => {
    console.log("\n=== lens nextAction log ===");
    console.table(lensLog.map(([a, b2, c, d, e]) => ({ scenario: a, step: b2, nextAction: c, check: d, note: e })));
    console.log("=== results ===");
    for (const [k, v] of Object.entries(results)) console.log(k, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
    console.log("=== gas (used / eth_estimateGas, sent with gasLimit = estimate) ===");
    for (const [k, v] of Object.entries(gas)) console.log(k.padEnd(48), v.map((x) => `${x.used}${x.est ? "/" + x.est : ""}`).join("  "));
    console.log("=== minimal gasLimit where estimate refused ===", JSON.stringify(minGas));
    console.log("=== lens mismatches ===", mismatches.length ? "\n" + mismatches.join("\n") : "none");
  });
});
