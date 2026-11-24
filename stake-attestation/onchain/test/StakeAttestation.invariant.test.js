// Funds conservation under random call sequences (build nodes P2c, P2d). After every step of a random
// sequence over several makers, hunters, listings and claims, the contract's balance is exactly
//
//     escrow (every listing) + held bonds + held prepays + withdrawable credits + the fee balance
//
// where a bond is held until its claim settles or expires, a prepay is held while its claim is
// Committed or RoundFailed without a started round (a refused submission), the credits are the
// pull ledger of every account but the fee recipient, and the fee balance is the fee recipient's.
// Nothing else may hold ETH here, so a payment made twice, or one never made, breaks the equation.
// The sequence also checks the bookkeeping the payouts rely on: owedWei is the sum of its claims'
// owed amounts, an owing listing has no escrow, and pendingClaims counts the unresolved claims.
//
// Actors include contracts that refuse ETH on and off, so the pull-ledger fallback is exercised,
// and the aggregator refunds part of a round's budget at random, so leftover refunds flow too.
//
// P2d adds disputes, re-triggers and recoverLeftoverEth to the sequence, with the aggregator
// refusing submissions and breaking its withdrawals at random. A dispute's prepay goes straight
// to its request, so the equation is unchanged. At the end every round is finalized and every
// wallet recovered, and refund attribution is checked: what each (funder, claim) received as
// LeftoverRefunded is exactly what the aggregator credited to the wallets funded by it
// (RequesterRefunded), and no wallet keeps a credit or a balance.
//
// P2e adds late claims (decision D6) on Rolled and Closed listings and bad-disclosure flags. A
// late claim's bond and prepay are held as any claim's, it is never paid or owed an award, and
// it is not one of pendingClaims (it never holds close). At the end the record of every listing
// (recordByHash) is checked against the claims themselves: every count, the findings in
// settlement order with what each was paid and owed, and the flags in the order raised.
//
// P17 adds the settlement safeguards (errata E8, E9) on seeds of their own, so the five seeds
// above keep their sequences (their listings are made at the fixture's size, the top award, and
// the default floor, so none of their claims is confirmed or narrow). On the new seeds the owner
// sets the narrow-INVALID floor and the confirmation size at random, between listings, and a
// fourth stream calls confirm: its prepay leaves the escrow for the round and its leftover comes
// back as a top-up would (owed awards first), so the equation is unchanged and an owing listing
// still has no escrow. The record is checked for the narrow INVALIDs and the confirmations too.
// Under solidity-coverage those three seeds are skipped (the coverage job's time limit: the
// suite already takes most of it); StakeAttestation.safeguards.test.js covers every line they
// reach, and `npx hardhat test` runs them.
//
// P16 adds the hunter's appeal (erratum E7). A claim round's INVALID now waits out the appeal
// window unless its hunter settles it, so the sequences above take other paths than before
// (their equation and their checks are unchanged), and the P17 drive settles an INVALID as its
// hunter, the waiver. Three more seeds run the appeal on a fifth stream with the safeguards:
// appeals (now and then by someone else, or out of their window, to be refused), appeal rounds
// judged at random (held, narrow, overturned, timed out, malformed), their one re-trigger, and
// INVALIDs settled by their hunter or by anyone from settleableAt. An appeal's prepay goes
// straight to its request from the hunter, so the equation is unchanged; refund attribution
// covers its wallets; the record is checked for the appeals by result; and no claim gets a
// second dispute-panel verdict. Skipped under solidity-coverage, as P17's are:
// StakeAttestation.appeal.test.js covers every line they reach.
//
// The v2 aggregator (MIGRATION.md): a request only escrows the prepay, and the jury is drawn later
// (drawJury, from block B+2), so every result follows a draw through StakeAttestation.drawJury,
// whose reward is credited to the round's wallet. A sixth stream drives the rounds the way the
// network and its keepers would, or would not: draws (through the contract, or directly at the
// aggregator by someone else, who then takes the reward), commits that close the window or do
// not, promotion, deadlines that pass (finalize then settles the round at the aggregator: failed,
// the unspent prepay back to the wallet, or to the aggregator's TREASURY when M commits were in
// but nobody promoted), and rounds never drawn (sealed, then a day later finalize cancels them,
// the whole prepay to the treasury). The treasury's ETH is outside the contract, so the equation
// is unchanged. The aggregator's other stand-in, the jurors' posted fee, varies at random so the
// rounds leave different leftovers. Refund attribution counts, per (funder, claim), everything
// credited to the claim's wallets: the refunds (RequesterRefunded to a wallet), the draw rewards
// (JuryDrawn with the wallet as drawer) and any value sent above the escrow (RequestFunded). At
// the end every open round is ended (blocks and a day pass) and finalized.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time, mine, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");
const { rng, split } = require("./helpers/random");

const { ClaimState, ListingState, SCALE, T, FEE, LISTING_CID, DISPUTE_CID, JUSTIFICATION } = H;
const { parseEther } = ethers;

const REACHED = [
  "Judged", "EvaluationFailed", "Settled", "Depleted", "OwedPaid", "Reopened", "LeftoverRefunded",
  "PaymentDeferred", "Expired", "Closed", "Withdrawn",
  "SubmissionFailed", "Disputed", "DisputeJudged", "DisputeFailed", "Retriggered", "RefundDeferred",
  "LateClaim", "Flagged",
];
const REACHED_P17 = ["ConfirmationRequested", "NarrowInvalid", "ConfirmationRefunded", "ConfirmationNoVerdict"];
const REACHED_P16 = ["Appealed"];
// The v2 aggregator's events, over every seed: draws, a promotion, failed rounds settled there, and
// rounds never drawn, cancelled (their prepay to the treasury).
const REACHED_V2 = ["JuryDrawn", "CommitPhaseComplete", "RoundSettled", "RoundCancelled", "EvaluationFailed"];
const UNRESOLVED = new Set([ClaimState.Committed, ClaimState.Revealed, ClaimState.Judged, ClaimState.Disputed, ClaimState.RoundFailed]);

async function setup() {
  const f = await H.deploy();
  const signers = await ethers.getSigners();
  const Rejecting = await ethers.getContractFactory("MockRejectingHunter");
  const makerC = await Rejecting.deploy();
  const hunterC = await Rejecting.deploy();
  const makers = [signers[1], signers[2], makerC];
  const hunters = [signers[5], signers[6], signers[7], hunterC];
  return { ...f, makers, hunters, contracts: [makerC, hunterC] };
}

// A random vector a round could deliver: mostly well formed, around the edges; sometimes not.
function randomVector(r) {
  const s = SCALE - r.int(0, 5);
  switch (r.int(0, 9)) {
    case 0:
    case 1: return H.oneHot(r.pick([3, 4, 5, 5])); // a large award, to drain escrows
    case 9: return H.oneHot(r.int(0, 5));
    case 7: { // valid mass near the threshold
      const valid = r.pick([T - 1, T, T + 1]);
      const [a, b, c, d] = split(r, valid, 4);
      const inv = r.int(0, s - valid);
      return [inv, s - valid - inv, a, b, c, d];
    }
    case 8: return r.pick([[0, 0, 0], [SCALE + 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, SCALE - 6], split(r, SCALE, 7), [SCALE]]); // [SCALE]: a one-number answer
    default: return split(r, s, 6);
  }
}

describe("StakeAttestation: funds conservation under random call sequences (P2c, P2d)", function () {
  this.timeout(1_800_000);
  const reached = {}; // events emitted, over every seed
  const reachedP17 = {}; // the safeguards' events, over the P17 seeds
  const reachedP16 = {}; // the appeal's events and results, over the P16 seeds
  const reachedV2 = {}; // the aggregator's events and the claims' expiry reasons, over every seed

  const SEEDS = [
    [11, false], [2026, false], [0xbeef, false], [7, false], [424242, false], [1710, true], [17, true], [0x10ad, true],
    [1616, true, true], [0xa99e, true, true], [70707, true, true],
  ];
  for (const [seed, safeguards, appeals = false] of SEEDS) {
    const label = appeals ? " with the safeguards and the appeal (P16)" : safeguards ? " with the safeguards (P17)" : "";
    it(`seed ${seed}${label}: balance == escrow + held bonds + held prepays + withdrawable credits + fee balance after every step`, async function () {
      if (safeguards && hre.__SOLIDITY_COVERAGE_RUNNING) this.skip();
      const { sa, aggregator, owner, feeRecipient, makers, hunters, contracts } = await loadFixture(setup);
      const r = rng(seed);
      // P2d's actions draw from their own stream and run as extra steps, so the P2c sequence
      // keeps its pace (they still change the state it acts on).
      const r2 = rng(seed ^ 0x5eed);
      // P2e's actions (late claims, flags) draw from a third stream, for the same reason.
      const r3 = rng(seed ^ 0x2e2e);
      // P17's (the owner's program values, confirm) a fourth, used on the safeguards' seeds only.
      const r4 = rng(seed ^ 0x1717);
      // P16's (the appeal) a fifth, used on the appeal's seeds only.
      const r5 = rng(seed ^ 0x1616);
      // The v2 aggregator's rounds (the draw, commits, promotion, deadlines, cancellation) a sixth.
      const r6 = rng(seed ^ 0x2222);
      const listings = []; // { id, maker }
      const claims = []; // { id, listingId, hunter }
      const accounts = [...new Set([...makers, ...hunters].map((a) => a.target ?? a.address))];
      const stats = { ok: {}, reverted: {} };

      const send = async (actor, fn, args, value = 0n) => {
        if (actor.act) return actor.act(sa.target, sa.interface.encodeFunctionData(fn, args), { value });
        return sa.connect(actor)[fn](...args, { value });
      };
      const attempt = async (name, thunk) => {
        try {
          await (await thunk()).wait();
          stats.ok[name] = (stats.ok[name] || 0) + 1;
        } catch (e) {
          if (!/reverted|revert/i.test(String(e.message))) throw e;
          stats.reverted[name] = (stats.reverted[name] || 0) + 1;
        }
      };
      const claimsIn = async (states) => {
        const out = [];
        for (const c of claims) if (states.includes((await sa.getClaim(c.id)).state)) out.push(c);
        return out;
      };

      async function checkInvariant(step, action) {
        let escrow = 0n;
        let bonds = 0n;
        let prepays = 0n;
        const owedBy = new Map();
        const pendingBy = new Map();
        for (const c of claims) {
          const k = await sa.getClaim(c.id);
          expect(k.late, `step ${step} claim ${c.id}: late`).to.equal(Boolean(c.late));
          if (UNRESOLVED.has(k.state)) {
            bonds += k.bondWei;
            // A late claim never holds close(): it is not one of pendingClaims.
            if (!k.late) pendingBy.set(c.listingId, (pendingBy.get(c.listingId) || 0n) + 1n);
          }
          if (k.late) expect([k.paidWei, k.owedWei], `step ${step} late claim ${c.id}: no award`).to.deep.equal([0n, 0n]);
          if (k.state === ClaimState.Committed || (k.state === ClaimState.RoundFailed && k.requestId === ethers.ZeroHash)) {
            prepays += k.prepayWei;
          }
          owedBy.set(c.listingId, (owedBy.get(c.listingId) || 0n) + k.owedWei);
        }
        for (const { id } of listings) {
          const l = await sa.getListing(id);
          escrow += l.escrowWei;
          const at = `step ${step} (${action}) listing ${id}`;
          expect(l.owedWei, `${at}: owedWei`).to.equal(owedBy.get(id) || 0n);
          if (l.owedWei > 0n) expect(l.escrowWei, `${at}: owing with escrow`).to.equal(0n);
          expect(l.pendingClaims, `${at}: pendingClaims`).to.equal(pendingBy.get(id) || 0n);
        }
        let credits = 0n;
        for (const a of accounts) credits += await sa.withdrawable(a);
        const fees = await sa.withdrawable(feeRecipient.address);
        const balance = await ethers.provider.getBalance(sa.target);
        expect(balance, `step ${step} (${action})`).to.equal(escrow + bonds + prepays + credits + fees);
      }

      const disclosable = async () => {
        const out = [];
        const now = BigInt(await time.latest());
        for (const c of claims) {
          const k = await sa.getClaim(c.id);
          if (k.state === ClaimState.Committed && k.disclosedAt === 0n && now + 1n < k.committedAt + 3600n) out.push(c);
        }
        return out;
      };
      const shuffled = (xs) => xs.map((x) => [r.next(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
      const plainSigners = [...makers, ...hunters].filter((a) => !a.act);
      // Every EvaluationWallet clone the contract created: claim rounds (accepted or refused) and disputes.
      const walletsSeen = async () => {
        const out = new Set();
        for (const name of ["EvaluationRequested", "SubmissionFailed", "Disputed", "ConfirmationRequested", "Appealed"]) {
          for (const ev of await sa.queryFilter(sa.filters[name]())) out.add(ev.args.wallet);
        }
        return [...out];
      };
      const openRequestOf = (k) => (k.state === ClaimState.Disputed ? k.disputeRequestId : k.requestId);
      const phaseOf = async (requestId) => (await aggregator.getRoundInfo(requestId)).phase;
      // Draw a claim's open round if it is still to be drawn (through StakeAttestation.drawJury, by
      // anyone: the wallet earns the reward), mining to block B+2 first. Returns its request id.
      const drawOpen = async (claimId) => {
        const requestId = openRequestOf(await sa.getClaim(claimId));
        const info = await aggregator.getRoundInfo(requestId);
        if (info.phase !== 1n && info.phase !== 2n) return requestId;
        const block = BigInt(await ethers.provider.getBlockNumber());
        if (block < info.requestBlock + 2n) await mine(Number(info.requestBlock + 2n - block));
        await attempt("draw", () => send(r6.pick([...makers, ...hunters]), "drawJury", [claimId]));
        return requestId;
      };
      // The open rounds whose aggregator phase is one of `phases`.
      const roundsIn = async (phases) => {
        const out = [];
        for (const c of await claimsIn([ClaimState.Revealed, ClaimState.Disputed])) {
          const requestId = openRequestOf(await sa.getClaim(c.id));
          if (phases.includes(await phaseOf(requestId))) out.push({ c, requestId });
        }
        return out;
      };

      const actions = {
        async list() {
          if (listings.length >= 6) return;
          const maker = r.pick(makers);
          const a = parseEther(r.pick(["0.001", "0.01", "0.1"]));
          const awards = [a, 2n * a, 4n * a, 8n * a];
          const p = H.params({
            artifact: H.atCommit(H.freshCommit()),
            awards,
            lowestClassCounted: BigInt(r.int(2, 5)),
            bondWei: parseEther(r.pick(["0", "0.001", "0.02"])),
            fixWindow: BigInt(r.pick([0, 0, 600])),
            disputeWindow: 24n * 3600n,
            revealWindow: 72n * 3600n,
          });
          p.disclosureGrace = p.fixWindow; // so the maker may flag (P2e); no draw, the sequence is unchanged
          await send(maker, "list", [p, LISTING_CID, DISPUTE_CID, []]);
          const id = await sa.listingCount();
          listings.push({ id, maker });
          const fee = await sa.feeDue(id);
          const extra = BigInt(r.pick([0, 0, 1, 4])) * a;
          await attempt("open", () => send(maker, "fund", [id, fee], fee + awards[3] + extra));
        },
        async commit() {
          if (!listings.length || claims.length >= 48) return;
          const { id } = r.pick(listings);
          if (!(await sa.acceptsCommits(id))) return;
          const hunter = r.pick(hunters);
          const price = await sa.commitPrice(id);
          const extra = BigInt(r.pick([0, 0, 1000]));
          const before = await sa.claimCount();
          await attempt("commit", () =>
            send(hunter, "commit", [id, ethers.sha256(ethers.toBeHex(before + 1n, 32)), H.CT], price + extra));
          if ((await sa.claimCount()) === before) return;
          const claim = { id: before + 1n, listingId: id, hunter };
          claims.push(claim);
          if (r.next() < 0.8) await attempt("disclose", () => send(hunter, "disclose", [claim.id, H.CT_CID]));
        },
        async disclose() {
          const ready = await disclosable();
          if (!ready.length) return;
          const c = r.pick(ready);
          await attempt("disclose", () => send(c.hunter, "disclose", [c.id, H.CT_CID]));
        },
        async release() {
          const ready = await claimsIn([ClaimState.Committed]);
          if (!ready.length) return;
          const c = r.pick(ready);
          const { maker } = listings.find((l) => l.id === c.listingId);
          await attempt("release", () => send(maker, "release", [c.id]));
        },
        async reveal() {
          for (const { id } of shuffled(listings)) {
            const head = (await sa.getListing(id)).headClaim;
            if (head === 0n) continue;
            const k = await sa.getClaim(head);
            if (k.state !== ClaimState.Committed || k.disclosedAt === 0n) continue;
            const c = claims.find((x) => x.id === head);
            const topUp = (await sa.revealTopUp(head)) + BigInt(r.pick([0, 0, 777]));
            await attempt("reveal", () => send(c.hunter, "reveal", [head, H.BCID, H.CK, H.EK], topUp));
            return;
          }
        },
        async judge() {
          const open = await claimsIn([ClaimState.Revealed, ClaimState.Disputed]);
          if (!open.length) return;
          const c = r.pick(open);
          const requestId = await drawOpen(c.id);
          await attempt("result", () => aggregator.scriptResult(requestId, randomVector(r), JUSTIFICATION));
          await attempt("finalize", () => send(r.pick([...makers, ...hunters]), "finalize", [c.id]));
        },
        async finalize() {
          const open = await claimsIn([ClaimState.Revealed, ClaimState.Disputed]);
          if (!open.length) return;
          await attempt("finalize", () => send(r.pick([...makers, ...hunters]), "finalize", [r.pick(open).id]));
        },
        async settle() {
          const judged = await claimsIn([ClaimState.Judged]);
          if (!judged.length) return;
          const c = r.pick(judged);
          if (r.next() < 0.6) await time.increase(24 * 3600); // past a dispute window
          await attempt("settle", () => send(r.pick(hunters), "settle", [c.id]));
        },
        async expire() {
          const pending = await claimsIn([ClaimState.Committed, ClaimState.RoundFailed]);
          if (!pending.length) return;
          await attempt("expire", () => send(r.pick(hunters), "expire", [r.pick(pending).id]));
        },
        async topUp() {
          if (!listings.length) return;
          // mostly a listing that is short (Depleted, or owing), as a maker would top up
          const short = [];
          for (const x of listings) {
            const k = await sa.getListing(x.id);
            if (k.state === ListingState.Depleted || k.owedWei > 0n) short.push(x);
          }
          const { id, maker } = short.length && r.next() < 0.7 ? r.pick(short) : r.pick(listings);
          const l = await sa.getListing(id);
          const amount = r.pick([1n, l.awards[1], l.awards[3], l.owedWei, l.owedWei + l.awards[3], l.owedWei / 2n]);
          await attempt("topUp", () => send(maker, "fund", [id, 0n], amount));
        },
        async withdraw() {
          const all = [...makers, ...hunters, feeRecipient];
          const owed = [];
          for (const a of all) if ((await sa.withdrawable(a.target ?? a.address)) > 0n) owed.push(a);
          const a = owed.length && r.next() < 0.8 ? r.pick(owed) : r.pick(all);
          await attempt("withdraw", () => (a.claim ? a.claim(sa.target) : sa.connect(a).withdraw()));
        },
        async close() {
          if (!listings.length) return;
          const { id, maker } = r.pick(listings);
          await attempt("close", () => send(maker, "close", [id]));
        },
        async rollForward() {
          if (listings.length < 2) return;
          const a = r.pick(listings);
          const b = r.pick(listings.filter((l) => l.maker === a.maker && l.id !== a.id).concat([a]));
          await attempt("rollForward", () => send(a.maker, "rollForward", [a.id, b.id]));
        },
        async wait() {
          await time.increase(r.next() < 0.8 ? r.pick([30, 400, 900]) : r.pick([4000, 86400, 3 * 86400]));
        },
        async refunds() {
          // The jurors' posted fee (0: the round's clamped fee, all of it spent): a round leaves the
          // base fees and bonuses they do not take unspent, which the wallet gets back.
          await aggregator.setArbiterFee(r.pick([0n, FEE / 36n, FEE / 90n, 1n]));
        },
        async rejecting() {
          const c = r.pick(contracts);
          await c.setRejecting(!(await c.rejecting()));
        },
        async plainEth() {
          await attempt("plainEth", () => r.pick(hunters.filter((h) => !h.act)).sendTransaction({ to: sa.target, value: 1n }));
        },
      };
      const later = {
        async lateClaim() {
          if (claims.length >= 56) return;
          const ended = [];
          for (const x of listings) {
            const st = (await sa.getListing(x.id)).state;
            if (st === ListingState.Rolled || st === ListingState.Closed) ended.push(x);
          }
          if (!ended.length) return;
          const { id } = r3.pick(ended);
          const hunter = r3.pick(hunters);
          const price = await sa.commitPrice(id);
          const before = await sa.claimCount();
          await attempt("lateClaim", () =>
            send(hunter, "lateClaim", [id, ethers.sha256(ethers.toBeHex(before + 1n, 32)), H.CT], price + BigInt(r3.pick([0, 0, 1000]))));
          if ((await sa.claimCount()) === before) return;
          const claim = { id: before + 1n, listingId: id, hunter, late: true };
          claims.push(claim);
          if (r3.next() < 0.8) await attempt("disclose", () => send(hunter, "disclose", [claim.id, H.CT_CID]));
        },
        async flag() {
          const ready = await claimsIn([ClaimState.Committed]);
          if (!ready.length) return;
          const c = r3.pick(ready);
          const { maker } = listings.find((l) => l.id === c.listingId);
          await attempt("flag", () => send(maker, "flagBadDisclosure", [c.id]));
        },
      };
      const extras = {
        async dispute() {
          for (const c of shuffled(await claimsIn([ClaimState.Judged]))) {
            const k = await sa.getClaim(c.id);
            if (k.outcome < 2n || k.dispute !== 0n) continue; // valid and undisputed only
            const { maker } = listings.find((l) => l.id === c.listingId);
            const fee = (await sa.disputeFee(c.listingId)) + BigInt(r2.pick([0, 0, 555]));
            await attempt("dispute", () => send(maker, "dispute", [c.id, H.STATEMENT_CID], fee));
            return;
          }
        },
        async retrigger() {
          const failed = await claimsIn([ClaimState.RoundFailed]);
          if (!failed.length) return;
          const c = r2.pick(failed);
          const topUp = (await sa.retriggerTopUp(c.id)) + BigInt(r2.pick([0, 0, 333]));
          await attempt("retrigger", () => send(c.hunter, "retrigger", [c.id], topUp));
        },
        async recover() {
          const wallets = await walletsSeen();
          if (!wallets.length) return;
          await attempt("recover", () => sa.connect(r2.pick(plainSigners)).recoverLeftoverEth(r2.pick(wallets)));
        },
        async faults() {
          await aggregator.setWithdrawBroken(r2.next() < 0.3);
          const pause = r2.next() < 0.2; // refuse every submission while paused
          if (pause !== (await aggregator.paused())) await aggregator.setPaused(pause);
        },
      };
      const weights = {
        list: 3, commit: 14, disclose: 3, release: 1, reveal: 14, judge: 14, finalize: 3, settle: 14,
        expire: 4, topUp: 6, withdraw: 5, close: 2, rollForward: 2, wait: 6, refunds: 3, rejecting: 3, plainEth: 1,
      };
      const bag = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));
      const bag2 = Object.entries({ dispute: 1, retrigger: 3, recover: 2, faults: 2 }).flatMap(([k, w]) => Array(w).fill(k));
      const bag3 = Object.entries({ lateClaim: 3, flag: 1 }).flatMap(([k, w]) => Array(w).fill(k));
      const safeguardActions = {
        // The owner's program values: the first set confirms most awards and has a band; later
        // ones anything in bounds, and only the listings made after them take them.
        async program(first = false) {
          const floor = first ? r4.pick([250_000n, 350_000n, 420_000n]) : r4.pick([250_000n, 350_000n, 420_000n, 500_000n, BigInt(T)]);
          const size = first ? r4.pick([0n, parseEther("0.002")]) : r4.pick([0n, 0n, parseEther("0.002"), parseEther("0.03"), parseEther("100")]);
          await attempt("program", () => sa.connect(owner).setNarrowInvalidFloor(floor));
          await attempt("program", () => sa.connect(owner).setConfirmAboveWei(size));
        },
        // Take a listing's head claim through its round to a verdict near the safeguards' edges:
        // a counted class (a confirmation's candidate), LOW, an INVALID inside or below the band.
        async drive() {
          for (const { id } of shuffled(listings)) {
            const head = (await sa.getListing(id)).headClaim;
            if (head === 0n) continue;
            const k = await sa.getClaim(head);
            if (k.state !== ClaimState.Committed || k.disclosedAt === 0n) continue;
            const c = claims.find((x) => x.id === head);
            const [, revealableAt, revealDeadline] = await sa.claimTimes(head);
            const now = BigInt(await time.latest());
            if (revealDeadline !== 0n && now + 1n >= revealDeadline) {
              // Its reveal window passed while the clock jumped: expire it, so the queue moves on.
              await attempt("expire", () => send(r4.pick(hunters), "expire", [head]));
              continue;
            }
            if (revealableAt > now + 1n) await time.increaseTo(revealableAt);
            await attempt("reveal", async () => send(c.hunter, "reveal", [head, H.BCID, H.CK, H.EK], await sa.revealTopUp(head)));
            if ((await sa.getClaim(head)).state !== ClaimState.Revealed) return;
            const m = r4.int(200_000, 500_000);
            const band = [SCALE - m, 0, 0, m, 0, 0];
            const vector = r4.pick([H.oneHot(3), H.oneHot(4), H.oneHot(5), H.oneHot(3), H.oneHot(4), H.oneHot(2), H.oneHot(0), band, band]);
            const requestId = await drawOpen(head);
            await attempt("result", () => aggregator.scriptResult(requestId, vector, JUSTIFICATION));
            await attempt("finalize", () => send(r4.pick(plainSigners), "finalize", [head]));
            // An INVALID settles at once, by its hunter, who waives the appeal (erratum E7, P16). The
            // draw is kept, so the stream keeps its pace.
            const j = await sa.getClaim(head);
            if (j.state === ClaimState.Judged && j.outcome === 0n) {
              r4.pick(hunters);
              await attempt("settle", () => send(c.hunter, "settle", [head]));
            }
            return;
          }
        },
        // confirm a claim that awaits its confirmation, moving the clock to its window if none is open.
        async confirm() {
          const judged = await claimsIn([ClaimState.Judged]);
          if (!judged.length) return;
          const now = BigInt(await time.latest());
          const ready = [];
          let earliest = 0n;
          for (const c of judged) {
            const [opensAt, deadline] = await sa.confirmWindow(c.id);
            if (opensAt === 0n || now + 1n >= deadline) continue;
            if (now + 1n >= opensAt) ready.push(c);
            else if (earliest === 0n || opensAt < earliest) earliest = opensAt;
          }
          if (!ready.length && earliest !== 0n && r4.next() < 0.7) {
            await time.increaseTo(earliest);
            for (const c of judged) {
              const [opensAt, deadline] = await sa.confirmWindow(c.id);
              if (opensAt !== 0n && opensAt <= earliest + 1n && earliest + 1n < deadline) ready.push(c);
            }
          }
          // Mostly one whose window is open; now and then any judged claim, to be refused.
          const c = ready.length && r4.next() < 0.9 ? r4.pick(ready) : r4.next() < 0.3 ? r4.pick(judged) : null;
          if (c) await attempt("confirm", () => send(r4.pick([...makers, ...hunters]), "confirm", [c.id]));
        },
        // settle a claim that awaits its confirmation from its deadline: the first verdict stands.
        async settleLate() {
          const waiting = [];
          for (const c of await claimsIn([ClaimState.Judged])) {
            const [, deadline] = await sa.confirmWindow(c.id);
            if (deadline !== 0n) waiting.push({ c, deadline });
          }
          if (!waiting.length) return;
          const { c, deadline } = r4.pick(waiting);
          if (deadline > BigInt(await time.latest()) + 1n) await time.increaseTo(deadline);
          await attempt("settle", () => send(r4.pick(hunters), "settle", [c.id]));
        },
      };
      const bag4 = Object.entries({ program: 1, drive: 6, confirm: 5, settleLate: 1 }).flatMap(([k, w]) => Array(w).fill(k));
      const appealActions = {
        // Take a listing's head claim through its round to a verdict, mostly an INVALID (often
        // narrow), and most often appeal it at once, before another stream settles it.
        async drive() {
          for (const { id } of shuffled(listings)) {
            const head = (await sa.getListing(id)).headClaim;
            if (head === 0n) continue;
            const k = await sa.getClaim(head);
            if (k.state !== ClaimState.Committed || k.disclosedAt === 0n) continue;
            const c = claims.find((x) => x.id === head);
            const [, revealableAt, revealDeadline] = await sa.claimTimes(head);
            const now = BigInt(await time.latest());
            if (revealDeadline !== 0n && now + 1n >= revealDeadline) {
              await attempt("expire", () => send(r5.pick(hunters), "expire", [head]));
              continue;
            }
            if (revealableAt > now + 1n) await time.increaseTo(revealableAt);
            await attempt("reveal", async () => send(c.hunter, "reveal", [head, H.BCID, H.CK, H.EK], await sa.revealTopUp(head)));
            if ((await sa.getClaim(head)).state !== ClaimState.Revealed) return;
            const m = r5.int(200_000, 500_000);
            const vector = r5.pick([H.oneHot(0), H.oneHot(0), [SCALE - m, 0, 0, m, 0, 0], [SCALE - m, 0, 0, m, 0, 0], H.oneHot(1), H.oneHot(4)]);
            const requestId = await drawOpen(head);
            await attempt("result", () => aggregator.scriptResult(requestId, vector, JUSTIFICATION));
            await attempt("finalize", () => send(r5.pick(plainSigners), "finalize", [head]));
            const j = await sa.getClaim(head);
            if (j.state === ClaimState.Judged && j.outcome === 0n && r5.next() < 0.75) {
              const fee = (await sa.disputeFee(id)) + BigInt(r5.pick([0, 0, 0, 777]));
              await attempt("appeal", () => send(c.hunter, "appeal", [head], fee));
            }
            return;
          }
        },
        // The hunter appeals a Judged INVALID inside its window; now and then someone else, or a
        // claim outside its window, to be refused.
        async appeal() {
          const judged = await claimsIn([ClaimState.Judged]);
          if (!judged.length) return;
          const now = BigInt(await time.latest());
          const ready = [];
          for (const c of judged) {
            const d = await sa.appealDeadline(c.id);
            if (d !== 0n && now + 1n < d) ready.push(c);
          }
          const c = ready.length && r5.next() < 0.9 ? r5.pick(ready) : r5.pick(judged);
          const who = r5.next() < 0.85 ? c.hunter : r5.pick([...makers, ...hunters]);
          const fee = (await sa.disputeFee(c.listingId)) + BigInt(r5.pick([0, 0, 0, 777]));
          await attempt("appeal", () => send(who, "appeal", [c.id], fee));
        },
        // An open appeal round ends: held, narrow, overturned, a DUPLICATE, timed out or malformed.
        async judgeAppeal() {
          const open = [];
          for (const c of await claimsIn([ClaimState.Disputed])) if ((await sa.getClaim(c.id)).disputeKind === 3n) open.push(c);
          if (!open.length) return;
          const c = r5.pick(open);
          const m = r5.int(200_000, 500_000);
          const outcome = r5.int(0, 9);
          const requestId = await drawOpen(c.id);
          if (outcome < 2) {
            // no verdict: the round's deadline passes with no jury answer
            const { deadline } = await aggregator.getRoundInfo(requestId);
            if (deadline !== 0n && BigInt(await time.latest()) <= deadline) await time.increaseTo(deadline + 1n);
          } else {
            const vector = [null, null, H.oneHot(0), [SCALE - m, 0, 0, m, 0, 0], H.oneHot(1), H.oneHot(2), H.oneHot(3), H.oneHot(4), H.oneHot(5), [1, 2, 3]][outcome];
            await attempt("result", () => aggregator.scriptResult(requestId, vector, JUSTIFICATION));
          }
          await attempt("finalize", () => send(r5.pick(plainSigners), "finalize", [c.id]));
          // No verdict: most often the hunter re-triggers at once.
          if ((await sa.retriggerDeadline(c.id)) !== 0n && r5.next() < 0.6) {
            await attempt("appealRetrigger", async () => send(c.hunter, "retrigger", [c.id], await sa.retriggerTopUp(c.id)));
          }
        },
        // The appeal's one re-trigger, mostly by the hunter inside its window.
        async retriggerAppeal() {
          const now = BigInt(await time.latest());
          const ready = [];
          for (const c of await claimsIn([ClaimState.Judged])) {
            if ((await sa.getClaim(c.id)).disputeKind !== 3n) continue;
            const d = await sa.retriggerDeadline(c.id);
            if (d !== 0n && (now + 1n < d || r5.next() < 0.1)) ready.push(c);
          }
          if (!ready.length) return;
          const c = r5.pick(ready);
          const who = r5.next() < 0.9 ? c.hunter : r5.pick([...makers, ...hunters]);
          const topUp = (await sa.retriggerTopUp(c.id)) + BigInt(r5.pick([0, 0, 333]));
          await attempt("appealRetrigger", () => send(who, "retrigger", [c.id], topUp));
        },
        // A Judged INVALID settles: by its hunter (the waiver), or by anyone, mostly from settleableAt.
        async settleInvalid() {
          const invalid = [];
          for (const c of await claimsIn([ClaimState.Judged])) if ((await sa.getClaim(c.id)).outcome === 0n) invalid.push(c);
          if (!invalid.length) return;
          const c = r5.pick(invalid);
          if (r5.next() < 0.4) {
            await attempt("settle", () => send(c.hunter, "settle", [c.id]));
            return;
          }
          const at = await sa.settleableAt(c.id);
          if (at > BigInt(await time.latest()) + 1n && r5.next() < 0.7) await time.increaseTo(at);
          await attempt("settle", () => send(r5.pick([...makers, ...hunters]), "settle", [c.id]));
        },
      };
      const bag5 = Object.entries({ drive: 5, appeal: 3, judgeAppeal: 6, retriggerAppeal: 2, settleInvalid: 3 }).flatMap(([k, w]) => Array(w).fill(k));
      const roundActions = {
        // A round still to be drawn is drawn: mostly through the contract (its wallet earns the
        // reward), now and then directly at the aggregator by someone else, who takes it after
        // the requester's 30 s (and earns nothing inside them).
        async draw() {
          const undrawn = await roundsIn([1n, 2n]);
          if (!undrawn.length) return;
          const { c, requestId } = r6.pick(undrawn);
          if (r6.next() < 0.75) {
            await drawOpen(c.id);
            return;
          }
          const { requestBlock } = await aggregator.getRoundInfo(requestId);
          const block = BigInt(await ethers.provider.getBlockNumber());
          if (block < requestBlock + 2n) await mine(Number(requestBlock + 2n - block));
          if (r6.next() < 0.5) await time.increase(31);
          await attempt("draw", () => aggregator.connect(r6.pick(plainSigners)).drawJury(requestId));
        },
        // Commits arrive: the M+-th closes the window; fewer may leave it open past T+.
        async commits() {
          const open = await roundsIn([3n]);
          if (!open.length) return;
          const { requestId } = r6.pick(open);
          await attempt("commits", () => aggregator.scriptCommits(requestId, r6.int(1, 6)));
          // A keeper most often promotes a window that closed, from C+2 (the caller's reward).
          if ((await phaseOf(requestId)) === 4n && r6.next() < 0.6) {
            await mine(2);
            await attempt("promote", () => aggregator.connect(r6.pick(plainSigners)).promote(requestId));
          }
        },
        // Someone promotes a closed window (from C+2), or closes one past T+ with M commits.
        async promote() {
          const closing = await roundsIn([3n, 4n]);
          if (!closing.length) return;
          const { requestId } = r6.pick(closing);
          const who = r6.pick(plainSigners);
          if ((await phaseOf(requestId)) === 3n) {
            const { windowEnd } = await aggregator.getRoundInfo(requestId);
            if (BigInt(await time.latest()) <= windowEnd) await time.increaseTo(windowEnd + 1n);
            await attempt("closeCommits", () => aggregator.connect(who).closeCommits(requestId));
            return;
          }
          await mine(2);
          await attempt("promote", () => aggregator.connect(who).promote(requestId));
        },
        // A drawn round's deadline passes with no result; finalize settles it at the aggregator.
        async deadline() {
          const drawn = await roundsIn([3n, 4n, 5n]);
          if (!drawn.length) return;
          const { c, requestId } = r6.pick(drawn);
          const { deadline } = await aggregator.getRoundInfo(requestId);
          if (BigInt(await time.latest()) <= deadline) await time.increaseTo(deadline + 1n);
          await attempt("finalize", () => send(r6.pick([...makers, ...hunters]), "finalize", [c.id]));
        },
        // A round nobody draws: its seed sealed, and a day later finalize cancels it at the
        // aggregator, the whole prepay to the treasury.
        async cancel() {
          const undrawn = await roundsIn([1n]);
          if (!undrawn.length) return;
          const { c, requestId } = r6.pick(undrawn);
          const { requestBlock, sealedHash } = await aggregator.getRoundInfo(requestId);
          if (sealedHash === ethers.ZeroHash) {
            const block = BigInt(await ethers.provider.getBlockNumber());
            if (block < requestBlock + 2n) await mine(Number(requestBlock + 2n - block));
            await attempt("seal", () => aggregator.sealSeed(requestId));
          }
          await time.increase(24 * 3600 + 1);
          await attempt("finalize", () => send(r6.pick([...makers, ...hunters]), "finalize", [c.id]));
        },
      };
      const bag6 = Object.entries({ draw: 5, commits: 3, promote: 2, deadline: 2, cancel: 1 }).flatMap(([k, w]) => Array(w).fill(k));

      if (safeguards) await safeguardActions.program(true); // the first listing takes these values
      await actions.list();
      await checkInvariant(0, "list");
      for (let step = 1; step <= 300; step++) {
        const name = r.pick(bag);
        await actions[name]();
        await checkInvariant(step, name);
        if (r2.next() < 0.25) {
          const extra = r2.pick(bag2);
          await extras[extra]();
          await checkInvariant(step, extra);
        }
        if (r3.next() < 0.2) {
          const extra = r3.pick(bag3);
          await later[extra]();
          await checkInvariant(step, extra);
        }
        if (safeguards && r4.next() < 0.5) {
          const extra = r4.pick(bag4);
          await safeguardActions[extra]();
          await checkInvariant(step, extra);
        }
        if (appeals && r5.next() < 0.6) {
          const extra = r5.pick(bag5);
          await appealActions[extra]();
          await checkInvariant(step, `appeal ${extra}`);
        }
        if (r6.next() < 0.3) {
          const extra = r6.pick(bag6);
          await roundActions[extra]();
          await checkInvariant(step, `round ${extra}`);
        }
      }
      // A fixed owed top-up, on the first seed, after the random steps so their sequences are unchanged:
      // a listing whose escrow is its top award, a HIGH that settles and depletes it, a CRITICAL that
      // settles short with the rest owed, then the maker's top-up, which pays the owed award first
      // (OwedPaid) and reopens the listing (StakeAttestation.settlement.test.js, payout-depletes-escrow).
      // The random streams reach an owed top-up only by chance, and solidity-coverage skips the seeds
      // that did. Its listing and claims are the test's own, so every check covers them.
      let fixedListing = null;
      let reachedFixedPromotion = false;
      if (seed === SEEDS[0][0]) {
        const maker = makers[0];
        const plainHunters = hunters.filter((x) => !x.act);
        const p = H.params({ artifact: H.atCommit(H.freshCommit()) });
        await (await send(maker, "list", [p, LISTING_CID, DISPUTE_CID, []])).wait();
        const id = await sa.listingCount();
        listings.push({ id, maker });
        fixedListing = id;
        const fee = await sa.feeDue(id);
        await (await send(maker, "fund", [id, fee], fee + p.awards[3])).wait();
        const fixed = [];
        for (const [i, hunter] of plainHunters.slice(0, 2).entries()) {
          const before = await sa.claimCount();
          await (await send(hunter, "commit", [id, ethers.sha256(ethers.toBeHex(before + 1n, 32)), H.CT], await sa.commitPrice(id))).wait();
          const claim = { id: before + 1n, listingId: id, hunter, bcid: `Qm${"O".repeat(42)}${String(i).padStart(2, "0")}` };
          claims.push(claim);
          fixed.push(claim);
          await (await send(hunter, "disclose", [claim.id, H.CT_CID])).wait();
        }
        for (const [claim, vector] of [[fixed[0], H.V.HIGH], [fixed[1], H.V.CRITICAL]]) {
          await H.revealAs(sa, claim.hunter, claim.id, { bcid: claim.bcid });
          await H.judgeAs(sa, aggregator, claim.hunter, claim.id, vector);
          await H.afterDisputeWindow(sa, claim.id);
          await (await sa.connect(claim.hunter).settle(claim.id)).wait();
          await checkInvariant(300, "fixed owed top-up");
        }
        const owing = await sa.getListing(id);
        expect(owing.owedWei, "the CRITICAL settled short: part of its award is owed").to.be.greaterThan(0n);
        await (await send(maker, "fund", [id, 0n], owing.owedWei + p.awards[3])).wait();
        expect((await sa.getListing(id)).owedWei).to.equal(0n);
        await checkInvariant(300, "fixed owed top-up");
      }
      // A fixed promotion, after the random steps so their sequences are unchanged: one open round
      // still before its deadline (drawn here if need be) gets its M+ commits and is promoted from
      // C+2, as a keeper would. The random streams reach promotion only by chance: since the mock
      // refuses results after a round's deadline (as the real aggregator does), rounds left past it
      // crowd the round stream's picks, and over these seeds it promoted none.
      // On the first seed, when no open round can be promoted (none is left before its deadline), one more
      // claim on the fixed listing (reopened by its top-up) gives it one: solidity-coverage skips the seeds
      // whose rounds did.
      const promotable = async () => {
        const out = [];
        for (const c of await claimsIn([ClaimState.Revealed, ClaimState.Disputed])) {
          const info = await aggregator.getRoundInfo(openRequestOf(await sa.getClaim(c.id)));
          if (info.phase <= 2n || ((info.phase === 3n || info.phase === 4n) && info.deadline >= BigInt(await time.latest()) + 60n)) out.push(c);
        }
        return out;
      };
      let toPromote = await promotable();
      if (!toPromote.length && fixedListing !== null) {
        const hunter = hunters.filter((x) => !x.act)[2];
        const before = await sa.claimCount();
        await (await send(hunter, "commit", [fixedListing, ethers.sha256(ethers.toBeHex(before + 1n, 32)), H.CT], await sa.commitPrice(fixedListing))).wait();
        const claim = { id: before + 1n, listingId: fixedListing, hunter };
        claims.push(claim);
        await (await send(hunter, "disclose", [claim.id, H.CT_CID])).wait();
        await H.revealAs(sa, hunter, claim.id, { bcid: `Qm${"O".repeat(42)}02` });
        await checkInvariant(300, "fixed promotion: its claim");
        toPromote = await promotable();
      }
      for (const c of toPromote) {
        const requestId = openRequestOf(await sa.getClaim(c.id));
        let info = await aggregator.getRoundInfo(requestId);
        if (info.phase === 1n) {
          const block = BigInt(await ethers.provider.getBlockNumber());
          if (block < info.requestBlock + 2n) await mine(Number(info.requestBlock + 2n - block));
          await attempt("draw", () => send(makers[0], "drawJury", [c.id]));
          info = await aggregator.getRoundInfo(requestId);
        }
        if ((info.phase !== 3n && info.phase !== 4n) || info.deadline < BigInt(await time.latest()) + 60n) continue;
        if (info.phase === 3n) {
          const [K, M] = (await aggregator.getJury(requestId)).map(Number);
          const mPlus = M + Math.ceil((K - M) / 2);
          await attempt("commits", () => aggregator.scriptCommits(requestId, Math.max(1, mPlus - Number(info.commits))));
        }
        if ((await phaseOf(requestId)) !== 4n) continue;
        await mine(2);
        await attempt("promote", () => aggregator.connect(plainSigners[0]).promote(requestId));
        if ((await phaseOf(requestId)) === 5n) {
          await checkInvariant(300, "fixed promotion");
          reachedFixedPromotion = true;
          break;
        }
      }
      if (seed === SEEDS[0][0]) expect(reachedFixedPromotion, 'the fixed promotion promoted a round').to.equal(true);
      // Drain: every round finalized, every wallet recovered, then refund attribution.
      await aggregator.setWithdrawBroken(false);
      if (await aggregator.paused()) await aggregator.setPaused(false);
      // Every open round ends: a drawn one is past its deadline (settle fails it, if it has no
      // result), and one never drawn can be cancelled (unsealed: past the block-hash history;
      // sealed: a day after its request).
      await mine(8200);
      await time.increase(2 * 24 * 3600);
      for (let pass = 0; pass < 2; pass++) {
        for (const c of await claimsIn([ClaimState.Revealed, ClaimState.Disputed])) {
          await attempt("finalize", () => sa.finalize(c.id));
        }
      }
      expect(await claimsIn([ClaimState.Revealed, ClaimState.Disputed]), "a round left open").to.deep.equal([]);
      const wallets = await walletsSeen();
      for (const w of wallets) await attempt("recover", () => sa.recoverLeftoverEth(w));
      await checkInvariant(301, "drain");
      const credited = new Map();
      const refunded = new Map();
      const add = (m, k, v) => { if (v !== 0n) m.set(k, (m.get(k) || 0n) + v); };
      const isWallet = new Set(wallets);
      const toTreasury = [];
      for (const ev of await aggregator.queryFilter(aggregator.filters.RequesterRefunded())) {
        if (!isWallet.has(ev.args.requester)) {
          // a refund the aggregator routes to its treasury (M commits never promoted)
          expect(ev.args.requester, `refund to ${ev.args.requester}`).to.equal(await aggregator.treasury());
          toTreasury.push(ev.args.amount);
          continue;
        }
        const [funder, claimId] = await sa.walletInfo(ev.args.requester);
        expect(funder, `wallet ${ev.args.requester}`).to.not.equal(ethers.ZeroAddress);
        add(credited, `${funder}/${claimId}`, ev.args.amount);
      }
      // The draw rewards the wallets earned, and value sent above a round's escrow (to credit).
      for (const ev of await aggregator.queryFilter(aggregator.filters.JuryDrawn())) {
        if (!isWallet.has(ev.args.drawer)) continue;
        const [funder, claimId] = await sa.walletInfo(ev.args.drawer);
        add(credited, `${funder}/${claimId}`, ev.args.reward);
      }
      for (const ev of await aggregator.queryFilter(aggregator.filters.RequestFunded())) {
        const [funder, claimId] = await sa.walletInfo(ev.args.requester);
        expect(funder, `requester ${ev.args.requester}`).to.not.equal(ethers.ZeroAddress);
        const { received } = await aggregator.getRoundInfo(ev.args.aggRequestId);
        add(credited, `${funder}/${claimId}`, ev.args.fromCredit + ev.args.fromValue - received);
      }
      for (const ev of await sa.queryFilter(sa.filters.LeftoverRefunded())) {
        add(refunded, `${ev.args.funder}/${ev.args.claimId}`, ev.args.amountWei);
      }
      expect(credited.size, `seed ${seed}: no leftover was credited`).to.be.greaterThan(0);
      const sorted = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      expect(sorted(refunded), `seed ${seed}: refunds by (funder, claim)`).to.deep.equal(sorted(credited));
      for (const w of wallets) {
        expect(await aggregator.ethOwed(w), `wallet ${w} credit`).to.equal(0n);
        expect(await ethers.provider.getBalance(w), `wallet ${w} balance`).to.equal(0n);
      }

      // The record (P2e) of every listing, against the claims themselves.
      const flaggedInOrder = (await sa.queryFilter(sa.filters.Flagged())).map((e) => e.args.claimId);
      const makerDisputed = (await sa.queryFilter(sa.filters.Disputed())).map((e) => e.args.claimId);
      const confirmationsOf = (await sa.queryFilter(sa.filters.ConfirmationRequested())).map((e) => e.args.claimId);
      const count = (xs, id) => BigInt(xs.filter((x) => x === id).length);
      for (const { id } of listings) {
        const mine = [];
        for (const c of claims.filter((x) => x.listingId === id)) mine.push({ id: c.id, k: await sa.getClaim(c.id) });
        const stake = mine.filter((c) => !c.k.late);
        const late = mine.filter((c) => c.k.late);
        const n = (xs, f) => BigInt(xs.filter(f).length);
        const byOutcome = (xs) => [0, 1, 2, 3, 4, 5].map((o) => n(xs, (c) => c.k.state === ClaimState.Settled && c.k.outcome === BigInt(o)));
        const expired = (xs, ...why) => n(xs, (c) => c.k.state === ClaimState.Expired && why.includes(c.k.expiry));
        const l0 = await sa.getListing(id);
        const rec = await sa.recordByHash(l0.artifactHash);
        const at = `seed ${seed} listing ${id}`;
        if ((await sa.getListing(id)).openedAt === 0n) {
          // Never funded: no stake, no claims, not on the record.
          expect([rec.listingCount, BigInt(mine.length)], at).to.deep.equal([0n, 0n]);
          continue;
        }
        expect(rec.listingCount, at).to.equal(1n);
        for (const h of [rec.history, rec.listings[0].history]) {
          expect(h.claims, `${at} claims`).to.equal(BigInt(stake.length));
          expect(h.pending, `${at} pending`).to.equal(n(stake, (c) => UNRESOLVED.has(c.k.state)));
          expect([...h.outcomes], `${at} outcomes`).to.deep.equal(byOutcome(stake));
          expect(h.released, `${at} released`).to.equal(n(stake, (c) => c.k.released));
          expect(h.undisclosed, `${at} undisclosed`).to.equal(expired(stake, 1n));
          expect(h.unrevealed, `${at} unrevealed`).to.equal(expired(stake, 2n));
          expect(h.noVerdict, `${at} noVerdict`).to.equal(expired(stake, 3n, 4n, 5n));
          // The maker's disputes (one per claim at most) apart from the confirmations (P17): a
          // maker's dispute with no verdict may be followed by a confirmation, which then names
          // the claim's round, so the maker's no-verdict count is what is left of its disputes.
          const disputes = stake.reduce((a, c) => a + count(makerDisputed, c.id), 0n);
          const maker = (d) => n(stake, (c) => c.k.disputeKind === 1n && c.k.dispute === d);
          expect(h.disputes, `${at} disputes`).to.equal(disputes);
          expect([h.disputesHeld, h.disputesOverturned, h.disputesNoVerdict], `${at} dispute results`)
            .to.deep.equal([maker(2n), maker(3n), disputes - maker(2n) - maker(3n) - maker(1n)]);
          const conf = (d) => n(stake, (c) => c.k.disputeKind === 2n && c.k.dispute === d);
          expect(h.confirmationRounds, `${at} confirmation rounds`).to.equal(stake.reduce((a, c) => a + count(confirmationsOf, c.id), 0n));
          expect([h.confirmationsHeld, h.confirmationsOverturned], `${at} confirmation results`).to.deep.equal([conf(2n), conf(3n)]);
          const awardOf = (c) => (c.k.outcome >= l0.lowestClassCounted ? l0.awards[Number(c.k.outcome) - 2] : 0n);
          expect(h.confirmationsNoVerdict, `${at} confirmations with no verdict`).to.equal(n(stake, (c) => c.k.state === ClaimState.Settled
            && c.k.outcome >= 2n && (c.k.dispute === 0n || c.k.dispute === 4n) && awardOf(c) > l0.confirmAboveWei));
          // The hunter's appeals (P16), one per claim at most, apart from the maker's disputes
          // and the confirmations: held and overturned at their verdict, no verdict at settle.
          for (const [xs, filed, held, overturned, none, who] of [
            [stake, h.appeals, h.appealsHeld, h.appealsOverturned, h.appealsNoVerdict, "appeals"],
            [late, h.lateAppeals, h.lateAppealsHeld, h.lateAppealsOverturned, h.lateAppealsNoVerdict, "late appeals"],
          ]) {
            const appealed = (f) => n(xs, (c) => c.k.disputeKind === 3n && f(c));
            expect([filed, held, overturned, none], `${at} ${who}`).to.deep.equal([
              appealed(() => true), appealed((c) => c.k.dispute === 2n), appealed((c) => c.k.dispute === 3n),
              appealed((c) => c.k.dispute === 4n && c.k.state === ClaimState.Settled),
            ]);
          }
          const mass = (c) => [2, 3, 4, 5].reduce((a, i) => a + BigInt(c.k.vector[i]), 0n);
          const narrow = (xs) => n(xs, (c) => c.k.state === ClaimState.Settled && c.k.outcome === 0n && mass(c) >= l0.narrowInvalidFloor);
          expect([h.narrowInvalid, h.lateNarrowInvalid], `${at} narrow INVALIDs`).to.deep.equal([narrow(stake), narrow(late)]);
          expect(h.lateClaims, `${at} lateClaims`).to.equal(BigInt(late.length));
          expect([...h.lateOutcomes], `${at} lateOutcomes`).to.deep.equal(byOutcome(late));
          expect(h.lateExpired, `${at} lateExpired`).to.equal(expired(late, 1n, 2n, 3n, 4n, 5n));
        }
        // Findings: every settled valid claim, in settlement order (= commit order on a listing).
        const valid = mine.filter((c) => c.k.state === ClaimState.Settled && c.k.outcome >= 2n);
        expect([...rec.findings].map((f) => f.claimId), `${at} findings`).to.deep.equal(valid.map((c) => c.id));
        expect(rec.findingCount).to.equal(BigInt(valid.length));
        for (const [i, f] of [...rec.findings].entries()) {
          const k = valid[i].k;
          expect([f.outcome, f.late, f.paidWei, f.owedWei, f.dispute, f.disputeKind, f.revealedAt, f.settledAt, f.bcid, f.hunter], `${at} finding ${f.claimId}`)
            .to.deep.equal([k.outcome, k.late, k.paidWei, k.owedWei, k.dispute, k.disputeKind, k.revealedAt, k.settledAt, k.bcid, k.hunter]);
        }
        // Flags: every flagged claim, in the order raised.
        const ids = new Set(mine.map((c) => c.id));
        expect([...rec.flags].map((f) => f.claimId), `${at} flags`).to.deep.equal(flaggedInOrder.filter((x) => ids.has(x)));
        expect(n(mine, (c) => c.k.flaggedBadDisclosure)).to.equal(rec.flagCount);
        const l = await sa.getListing(id);
        expect([rec.listings[0].escrowWei, rec.listings[0].owedWei, rec.listings[0].state], `${at} money`).to.deep.equal([l.escrowWei, l.owedWei, l.state]);
        expect([rec.listings[0].narrowInvalidFloor, rec.listings[0].confirmAboveWei], `${at} program values`).to.deep.equal([l.narrowInvalidFloor, l.confirmAboveWei]);
      }

      // One dispute-panel verdict per claim (erratum E7): never two DisputeJudged for a claim.
      const verdicts = (await sa.queryFilter(sa.filters.DisputeJudged())).map((e) => e.args.claimId);
      for (const c of claims) expect(count(verdicts, c.id) <= 1n, `seed ${seed} claim ${c.id}: dispute-panel verdicts`).to.equal(true);

      // The sequence must have reached the paths that move money.
      for (const name of ["commit", "reveal", "finalize", "settle"]) {
        expect(stats.ok[name] || 0, `seed ${seed}: ${name} succeeded ${JSON.stringify(stats)}`).to.be.greaterThan(0);
      }
      expect(stats.ok.plainEth || 0).to.equal(0);
      for (const ev of REACHED) reached[ev] = (reached[ev] || 0) + (await sa.queryFilter(sa.filters[ev]())).length;
      for (const ev of REACHED_V2) reachedV2[ev] = (reachedV2[ev] || 0) + (await aggregator.queryFilter(aggregator.filters[ev]())).length;
      for (const c of claims) {
        const k = await sa.getClaim(c.id);
        if (k.state === ClaimState.Expired) reachedV2[`expiry${k.expiry}`] = (reachedV2[`expiry${k.expiry}`] || 0) + 1;
      }
      reachedV2.treasury = (reachedV2.treasury || 0) + toTreasury.length;
      if (appeals) {
        for (const ev of REACHED_P16) reachedP16[ev] = (reachedP16[ev] || 0) + (await sa.queryFilter(sa.filters[ev]())).length;
        for (const name of ["appeal", "appealRetrigger"]) reachedP16[name] = (reachedP16[name] || 0) + (stats.ok[name] || 0);
        for (const c of claims) {
          const k = await sa.getClaim(c.id);
          if (k.disputeKind === 3n) reachedP16[`result${k.dispute}`] = (reachedP16[`result${k.dispute}`] || 0) + 1;
        }
      } else {
        // The other seeds make no appeal.
        for (const ev of REACHED_P16) expect((await sa.queryFilter(sa.filters[ev]())).length, `seed ${seed}: ${ev}`).to.equal(0);
      }
      if (safeguards) {
        for (const ev of REACHED_P17) reachedP17[ev] = (reachedP17[ev] || 0) + (await sa.queryFilter(sa.filters[ev]())).length;
      } else {
        // The original seeds never confirm and never return an INVALID's bond.
        for (const ev of REACHED_P17) expect((await sa.queryFilter(sa.filters[ev]())).length, `seed ${seed}: ${ev}`).to.equal(0);
      }
      const states = await Promise.all(listings.map(async ({ id }) => (await sa.getListing(id)).state));
      expect(states.length).to.be.greaterThan(1);
      expect(Object.values(ListingState)).to.include.members([...new Set(states)]);
    });
  }

  it("the sequences reached every path that moves money", function () {
    for (const ev of REACHED) expect(reached[ev] || 0, `${ev} ${JSON.stringify(reached)}`).to.be.greaterThan(0);
    // The v2 rounds: drawn, promoted, failed and settled at the aggregator, cancelled, a refund to
    // its treasury; and a failed claim expired with its bond back because no jury answered
    // (RoundsUnanswered). RoundsFailed (a jury answered with no verdict) is rare here: the v2
    // tests (StakeAttestation.v2.test.js) and settlement's cover it.
    for (const k of [...REACHED_V2, "treasury", "expiry5"]) {
      expect(reachedV2[k] || 0, `${k} ${JSON.stringify(reachedV2)}`).to.be.greaterThan(0);
    }
    if (hre.__SOLIDITY_COVERAGE_RUNNING) return; // the safeguards' seeds did not run
    for (const ev of REACHED_P17) expect(reachedP17[ev] || 0, `${ev} ${JSON.stringify(reachedP17)}`).to.be.greaterThan(0);
    // The appeal's seeds made appeals and re-triggers, and their results: held, overturned, no verdict.
    for (const k of [...REACHED_P16, "appeal", "appealRetrigger", "result2", "result3", "result4"]) {
      expect(reachedP16[k] || 0, `${k} ${JSON.stringify(reachedP16)}`).to.be.greaterThan(0);
    }
  });
});
