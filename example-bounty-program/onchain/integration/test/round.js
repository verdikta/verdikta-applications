// Drives full commit-reveal rounds through TestOperator, the way arbiter nodes would:
// request (escrow) -> drawJury at B+2 -> health answers -> commits (the M+-th, or one after T+, closes
// the commit phase at block C) -> promote at C+2 -> reveals -> settle.
const { ethers, network } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers");

class RoundDriver {
  /** `beacons`: send every request with item 9's beacon flag; `jury`: the requests' [K, M, N, P, timeout]
   *  (default the Small class preset) */
  constructor(core, arbs, requester, { beacons = false, jury = [6, 5, 4, 3, 300] } = {}) {
    this.core = core;
    this.beacons = beacons;
    this.jury = jury;
    this.agg = core.agg;
    this.keeper = core.keeper;
    this.arbs = arbs;
    this.requester = requester;
    this.byOpJob = new Map(arbs.map((a) => [`${a.opAddr.toLowerCase()}|${a.jobId}`, a]));
    this.byKey = new Map(arbs.map((a) => [a.key, a]));
    this.gas = {};
  }

  log(kind, rcpt) {
    (this.gas[kind] = this.gas[kind] || []).push(Number(rcpt.gasUsed));
    return rcpt;
  }

  async _mapRequests(rcpt) {
    const out = [];
    for (const r of H.oracleRequests(rcpt)) {
      const ref = await this.agg.requestRef(r.requestId);
      const arb = this.byOpJob.get(`${r.operator.toLowerCase()}|${r.specId}`);
      out.push({ slot: Number(ref & 0xffn), arb, req: r });
    }
    return out;
  }

  hasEvent(rcpt, name) {
    const topic = this.agg.interface.getEvent(name).topicHash;
    return rcpt.logs.some((l) => l.topics[0] === topic);
  }

  /** Phase 1: escrow only. `beacons` sets item 9's per-request beacon flag. */
  async requestOnly({ kind = "request (escrow)", value, beacons = this.beacons, minFee = 0n, jury = this.jury } = {}) {
    value = value ?? (await this.agg.maxTotalFee(H.MAX_FEE, minFee, beacons, jury[0], jury[3]));
    const tx = await this.agg.connect(this.requester).requestAIEvaluationWithApproval(
      ["QmRequestCid"], "", 500, H.MAX_FEE, minFee, H.BASE_COST, 5, 1, beacons, jury, { value, gasLimit: 16_000_000 }
    );
    const reqRcpt = this.log(kind, await tx.wait());
    const aggId = ethers.zeroPadValue(ethers.toBeHex(await this.agg.roundCount()), 32);
    return { aggId, reqRcpt, slots: {} };
  }

  /**
   * Beacon stage (flagged requests): the first drawJury picks the beacons and sends each a health
   * call; each of the first `answering` (default all) answers it, in pick order.
   */
  async beaconStage(round, { by = this.requester, waitBlocks = 1, answering } = {}) {
    if (waitBlocks) await mine(waitBlocks);
    const rcpt = this.log("drawJury (start beacons)", await (await this.agg.connect(by).drawJury(round.aggId, { gasLimit: 16_000_000 })).wait());
    round.beaconRcpt = rcpt;
    const bc = this.core.beacons;
    const topic = bc.interface.getEvent("BeaconCalled").topicHash;
    round.beacons = rcpt.logs.filter((l) => l.topics[0] === topic).map((l) => bc.interface.parseLog(l).args)
      .map((a) => ({ index: Number(a.index), key: a.key, arb: this.byKey.get(a.key) }));
    const n = answering ?? round.beacons.length;
    for (const b of round.beacons.slice(0, n)) await this.answerBeacon(round, b.index);
    return rcpt;
  }

  /** The beacon at `index` answers its health call with its next chain value, as any arbiter does. */
  async answerBeacon(round, index, { from } = {}) {
    const b = round.beacons[index];
    const tx = await this.keeper.connect(from || b.arb.node).answerHealthCall(b.key, b.arb.ch.next());
    return this.log("beacon answer", await tx.wait());
  }

  /** Phase 2: draw the jury (from block B+2) and collect the commit requests. */
  async draw(round, { by = this.requester, waitBlocks = 1 } = {}) {
    if (round.beacons === undefined && (await this.agg.getRoundInfo(round.aggId))[0] === 1n && this.beacons) {
      await this.beaconStage(round, { by, waitBlocks });
      waitBlocks = 0;
    }
    if (waitBlocks) await mine(waitBlocks);
    const rcpt = this.log("drawJury (select + dispatch K)", await (await this.agg.connect(by).drawJury(round.aggId, { gasLimit: 16_000_000 })).wait());
    round.rcpt = rcpt;
    for (const s of await this._mapRequests(rcpt)) round.slots[s.slot] = { ...s, commitReq: s.req };
    round.K = Object.keys(round.slots).length;
    return rcpt;
  }

  async request(opts = {}) {
    const round = await this.requestOnly(opts);
    await this.draw(round);
    return round;
  }

  /** Every called arbiter (jurors and random probes) answers its health call, except `exceptSlots`. */
  async answerAll(round, exceptSlots = []) {
    const skip = new Set(exceptSlots.map((sl) => round.slots[sl].arb.key));
    const topic = this.keeper.interface.getEvent("HealthCall").topicHash;
    const keeperAddr = this.keeper.target.toLowerCase();
    const called = [...new Set(round.rcpt.logs
      .filter((l) => l.address.toLowerCase() === keeperAddr && l.topics[0] === topic)
      .map((l) => l.topics[1]))];
    for (const k of called) {
      if (skip.has(k)) continue;
      const arb = this.byKey.get(k);
      if (((await this.keeper.getArbiter(k)).flags & 16n) === 0n) continue;   // no call pending (a beacon answered it)
      this.log("health answer", await (await this.keeper.connect(arb.node).answerHealthCall(k, arb.ch.next())).wait());
    }
  }

  /** Commit `reveal` for a slot. Records whether this commit closed the commit phase. */
  async commit(round, slot, reveal, kind = "commit") {
    const s = round.slots[slot];
    s.reveal = reveal;
    s.salt = (1n << 127n) | (BigInt(slot) + 1n);   // a full 128-bit salt: the top bit set
    const word = H.commitWord(round.aggId, s.arb.opAddr, reveal, s.salt);
    const rcpt = await (await H.fulfil(s.commitReq, s.arb.node, [word], "")).wait();
    const received = this.hasEvent(rcpt, "CommitReceived");
    if (received) s.committed = true;
    if (this.hasEvent(rcpt, "CommitWindowClosed")) { round.closing = true; this.log("closing commit (records C)", rcpt); }
    else if (received) this.log(kind, rcpt);
    else this.log("ignored commit (after close)", rcpt);
    return rcpt;
  }

  async closeCommits(round) {
    const rcpt = this.log("closeCommits (records C)", await (await this.agg.closeCommits(round.aggId)).wait());
    round.closing = true;
    return rcpt;
  }

  /** Draw the promoted commits from block C+2. */
  async promote(round, { by, waitBlocks = 1 } = {}) {
    if (waitBlocks) await mine(waitBlocks);
    const agg = by ? this.agg.connect(by) : this.agg;
    const rcpt = this.log("promote (dispatches M reveals)", await (await agg.promote(round.aggId, { gasLimit: 16_000_000 })).wait());
    for (const r of await this._mapRequests(rcpt)) round.slots[r.slot].revealReq = r.req;
    round.closing = false;
    return rcpt;
  }

  promotedSlots(round) {
    return Object.values(round.slots).filter((s) => s.revealReq).map((s) => s.slot);
  }

  async reveal(round, slot, kind = "reveal") {
    const s = round.slots[slot];
    const cid = `QmJustification${slot}:${H.saltHex(s.salt)}`;
    const rcpt = await (await H.fulfil(s.revealReq, s.arb.node, s.reveal, cid)).wait();
    return this.log(kind, rcpt);
  }

  async settle(round) {
    return this.log("settle (applyOutcomes x K)", await (await this.agg.settle(round.aggId, { gasLimit: 16_000_000 })).wait());
  }

  /** A complete honest round: all answer, all commit, every promoted arbiter reveals. `request` holds
   *  requestOnly's options (e.g. item 8's `minFee`). */
  async fullRound({ vectors, lateReveals = true, settle = true, request = {} } = {}) {
    const round = await this.request(request);
    await this.answerAll(round);
    const slots = Object.keys(round.slots).map(Number).sort((a, b) => a - b);
    for (const sl of slots) await this.commit(round, sl, vectors ? vectors(sl) : H.vec(600_000 + (sl % 3) * 10_000));
    if (!round.closing) {
      await time.increase(Number(await this.agg.tPlus()) + 1);
      await this.closeCommits(round);
    }
    await this.promote(round);
    const prom = this.promotedSlots(round);
    const N = Number((await this.agg.getJury(round.aggId))[2]);
    for (let i = 0; i < prom.length; i++) {
      if (i < N) await this.reveal(round, prom[i], i === N - 1 ? "finalizing reveal (Nth)" : "reveal");
      else if (lateReveals) await this.reveal(round, prom[i], "late reveal");
    }
    if (settle) {
      await time.increaseTo((await this.agg.getRoundInfo(round.aggId))[8] + 1n);   // past the deadline
      await this.settle(round);
    }
    return round;
  }
}

module.exports = { RoundDriver };
