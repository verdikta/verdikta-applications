// Funds conservation under random call sequences (build node P2c). After every step of a random
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
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");
const { rng, split } = require("./helpers/random");

const { ClaimState, ListingState, SCALE, T, FEE, LISTING_CID, DISPUTE_CID, JUSTIFICATION } = H;
const { parseEther } = ethers;

const REACHED = [
  "Judged", "EvaluationFailed", "Settled", "Depleted", "OwedPaid", "Reopened", "LeftoverRefunded",
  "PaymentDeferred", "Expired", "Closed", "Withdrawn",
];
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
    case 8: return r.pick([[0, 0, 0], [SCALE + 1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, SCALE - 6], split(r, SCALE, 7)]);
    default: return split(r, s, 6);
  }
}

describe("StakeAttestation: funds conservation under random call sequences (P2c)", function () {
  this.timeout(1_800_000);
  const reached = {}; // events emitted, over every seed

  for (const seed of [11, 2026, 0xbeef, 7, 424242]) {
    it(`seed ${seed}: balance == escrow + held bonds + held prepays + withdrawable credits + fee balance after every step`, async function () {
      const { sa, aggregator, feeRecipient, makers, hunters, contracts } = await loadFixture(setup);
      const r = rng(seed);
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
          if (UNRESOLVED.has(k.state)) {
            bonds += k.bondWei;
            pendingBy.set(c.listingId, (pendingBy.get(c.listingId) || 0n) + 1n);
          }
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
          const open = await claimsIn([ClaimState.Revealed]);
          if (!open.length) return;
          const c = r.pick(open);
          const { requestId } = await sa.getClaim(c.id);
          await attempt("result", () => aggregator.scriptResult(requestId, randomVector(r), JUSTIFICATION));
          await attempt("finalize", () => send(r.pick([...makers, ...hunters]), "finalize", [c.id]));
        },
        async finalize() {
          const open = await claimsIn([ClaimState.Revealed]);
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
          const pending = await claimsIn([ClaimState.Committed]);
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
          await aggregator.setRefundAmount(r.pick([0n, FEE / 2n, FEE, 3n * FEE]));
        },
        async rejecting() {
          const c = r.pick(contracts);
          await c.setRejecting(!(await c.rejecting()));
        },
        async plainEth() {
          await attempt("plainEth", () => r.pick(hunters.filter((h) => !h.act)).sendTransaction({ to: sa.target, value: 1n }));
        },
      };
      const weights = {
        list: 3, commit: 14, disclose: 3, release: 1, reveal: 14, judge: 14, finalize: 3, settle: 14,
        expire: 4, topUp: 6, withdraw: 5, close: 2, rollForward: 2, wait: 6, refunds: 3, rejecting: 3, plainEth: 1,
      };
      const bag = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));

      await actions.list();
      await checkInvariant(0, "list");
      for (let step = 1; step <= 250; step++) {
        const name = r.pick(bag);
        await actions[name]();
        await checkInvariant(step, name);
      }
      // The sequence must have reached the paths that move money.
      for (const name of ["commit", "reveal", "finalize", "settle"]) {
        expect(stats.ok[name] || 0, `seed ${seed}: ${name} succeeded ${JSON.stringify(stats)}`).to.be.greaterThan(0);
      }
      expect(stats.ok.plainEth || 0).to.equal(0);
      for (const ev of REACHED) reached[ev] = (reached[ev] || 0) + (await sa.queryFilter(sa.filters[ev]())).length;
      const states = await Promise.all(listings.map(async ({ id }) => (await sa.getListing(id)).state));
      expect(states.length).to.be.greaterThan(1);
      expect(Object.values(ListingState)).to.include.members([...new Set(states)]);
    });
  }

  it("the sequences reached every path that moves money", function () {
    for (const ev of REACHED) expect(reached[ev] || 0, `${ev} ${JSON.stringify(reached)}`).to.be.greaterThan(0);
  });
});
