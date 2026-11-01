// Shared set-up for the settlement tests (build node P2c): the default listing of design §7.1,
// the merged ABI (contract + lens), and one helper per step of a claim's life up to settle.
// The values match StakeAttestation.claims.test.js (P2b) and @verdikta/common's
// test/fixtures/code-review/code_review.bug.json stake block.
const hre = require("hardhat");
const { ethers } = hre;
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { linkedFactory } = require("./linked");

const { parseEther, ZeroAddress, ZeroHash, sha256, toUtf8Bytes } = ethers;

// ---- enums, in declaration order ----
const ListingState = { Listed: 0n, Open: 1n, Depleted: 2n, Rolled: 3n, Closed: 4n };
const Outcome = { INVALID: 0n, DUPLICATE: 1n, LOW: 2n, MEDIUM: 3n, HIGH: 4n, CRITICAL: 5n };
const OUTCOME_NAMES = ["INVALID", "DUPLICATE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const ClaimState = {
  Committed: 0n, Revealable: 1n, Revealed: 2n, Judged: 3n, Disputed: 4n, Settled: 5n, Expired: 6n, RoundFailed: 7n,
};

const HOUR = 3600n;
const DAY = 24n * HOUR;
const FIX = 14n * DAY;
const DISPUTE = 72n * HOUR;
const GRACE = 48n * HOUR;
const REVEAL = 7n * DAY;

const SCALE = 1_000_000;
const T = 500_001;

const LISTING_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const DISPUTE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CT_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const BCID = "bafkreidivzimqfqtoqxkrpge6bjyhlvxqs3rhe73owtmdulaxr5do5in7u";
const JUSTIFICATION = "bafkreihjustificationcidxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const REPO = "https://github.com/acme/vault";
const COMMIT = "9c1e4f0a3b7d2e5c8f1a4b6d9e0c3f5a7b2d4e6f";

const ARCHIVE = sha256(toUtf8Bytes("claim archive"));
const CT = sha256(toUtf8Bytes("claim archive, encrypted to the disclosure key"));
const CK = "0x" + "11".repeat(16);
const EK = "0x" + "22".repeat(32);

const LISTING_FEE = parseEther("0.01");
// common's bugSpec.stake: LOW 0, MEDIUM 0.1 ETH, HIGH 0.4 ETH, CRITICAL 2 ETH; MEDIUM counted.
const AWARDS = [0n, parseEther("0.1"), parseEther("0.4"), parseEther("2")];
const TOP = AWARDS[3];
const BOND = parseEther("0.02");
const ORACLE = {
  requestedClass: 133n,
  maxOracleFee: parseEther("0.00012"),
  disputeMaxOracleFee: parseEther("0.0002"),
  estimatedBaseCost: parseEther("0.000001"),
  alpha: 500n,
  maxFeeBasedScaling: 1n,
};
const FEE = ORACLE.maxOracleFee * 3n; // the mock's maxTotalFee: min(fee, ceiling) * 3

// The six one-hot verdicts and a few named vectors (order INVALID, DUPLICATE, LOW..CRITICAL).
const oneHot = (i) => OUTCOME_NAMES.map((_, k) => (k === i ? SCALE : 0));
const V = {
  INVALID: oneHot(0),
  DUPLICATE: oneHot(1),
  LOW: oneHot(2),
  MEDIUM: oneHot(3),
  HIGH: oneHot(4),
  CRITICAL: oneHot(5),
};

const atCommit = (commit) => ({ kind: 0n, repo: REPO, baseCommit: commit, chainId: 0n, addr: ZeroAddress });
let commitCounter = 0;
// A fresh, valid 40-hex commit per call, so one maker can hold many listings.
const freshCommit = () => (++commitCounter).toString(16).padStart(40, "0");

function params(overrides = {}) {
  return {
    artifact: atCommit(COMMIT),
    disclosureKey: "0x" + "a1".repeat(32),
    awards: [...AWARDS],
    lowestClassCounted: Outcome.MEDIUM,
    bondWei: BOND,
    fixWindow: 0n,
    disputeWindow: DISPUTE,
    disclosureGrace: 0n,
    revealWindow: REVEAL,
    allowlist: [],
    valueAtRiskUsd: 0n,
    oracle: { ...ORACLE },
    ...overrides,
  };
}

// The views served at the StakeAttestation address by its lens, merged into the contract's ABI.
function mergedAbi(name) {
  const main = hre.artifacts.readArtifactSync(name).abi;
  const lens = hre.artifacts.readArtifactSync("StakeAttestationLens").abi;
  const key = (e) => `${e.type}:${e.name}`;
  const seen = new Set(main.map(key));
  return [
    ...main,
    ...lens.filter((e) => ["function", "event", "error"].includes(e.type) && !seen.has(key(e)) && e.name !== "host"),
  ];
}

async function deploy() {
  const [owner, maker, other, feeRecipient, ...hunters] = await ethers.getSigners();
  const aggregator = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
  const args = [aggregator.target, owner.address, feeRecipient.address, LISTING_FEE];
  const saDeployed = await (await linkedFactory("StakeAttestation")).deploy(...args);
  const sa = new ethers.Contract(saDeployed.target, mergedAbi("StakeAttestation"), owner);
  return { owner, maker, other, feeRecipient, hunters, hunter: hunters[0], aggregator, sa };
}

function eventsOf(contract, receipt, name) {
  const address = contract.target.toLowerCase();
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === address)
    .map((l) => {
      try {
        return contract.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.name === name);
}

async function blockTime(receipt) {
  return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
}

async function listAs(sa, maker, p = params(), { listingCid = LISTING_CID, disputeCid = DISPUTE_CID, knownIssueIds = [] } = {}) {
  const rc = await (await sa.connect(maker).list(p, listingCid, disputeCid, knownIssueIds)).wait();
  return eventsOf(sa, rc, "Listed")[0].args.listingId;
}

// list + the opening fund with `escrow` (default: exactly the top award)
async function openListing(sa, maker, p = params(), opts = {}) {
  const id = await listAs(sa, maker, p, opts);
  const fee = await sa.feeDue(id);
  await sa.connect(maker).fund(id, fee, { value: fee + (opts.escrow ?? p.awards[3]) });
  return id;
}

async function commitAs(sa, hunter, listingId, { archive = ARCHIVE, ct = CT, value } = {}) {
  const v = value === undefined ? await sa.commitPrice(listingId) : value;
  const rc = await (await sa.connect(hunter).commit(listingId, archive, ct, { value: v })).wait();
  return { claimId: eventsOf(sa, rc, "Committed")[0].args.claimId, at: await blockTime(rc) };
}

async function claimAs(sa, hunter, listingId, opts = {}) {
  const { claimId, at } = await commitAs(sa, hunter, listingId, opts);
  const rc = await (await sa.connect(hunter).disclose(claimId, opts.cid ?? CT_CID)).wait();
  return { claimId, committedAt: at, disclosedAt: await blockTime(rc) };
}

async function revealAs(sa, hunter, claimId, { bcid = BCID, ck = CK, ek = EK, value } = {}) {
  const v = value === undefined ? await sa.revealTopUp(claimId) : value;
  const rc = await (await sa.connect(hunter).reveal(claimId, bcid, ck, ek, { value: v })).wait();
  const ev = eventsOf(sa, rc, "EvaluationRequested")[0];
  return { rc, requestId: ev ? ev.args.requestId : ZeroHash, at: await blockTime(rc) };
}

// commit, disclose and reveal one claim on a listing whose fix window is 0 (or has ended)
async function revealedClaim(sa, hunter, listingId, opts = {}) {
  const { claimId } = await claimAs(sa, hunter, listingId, opts);
  const { requestId, rc } = await revealAs(sa, hunter, claimId, opts);
  return { claimId, requestId, rc };
}

// the jury's vector arrives at the aggregator (the round finalizes there); then finalize
async function judgeAs(sa, aggregator, caller, claimId, vector, justification = JUSTIFICATION) {
  const { requestId } = await sa.getClaim(claimId);
  await aggregator.scriptResult(requestId, vector.map(BigInt), justification);
  const rc = await (await sa.connect(caller).finalize(claimId)).wait();
  return { rc, at: await blockTime(rc) };
}

// past the dispute window of a claim judged at `judgedAt`
async function afterDisputeWindow(sa, claimId) {
  const c = await sa.getClaim(claimId);
  const l = await sa.getListing(c.listingId);
  const at = c.judgedAt + l.disputeWindow;
  const now = BigInt(await time.latest());
  if (now < at) await time.setNextBlockTimestamp(at);
}

module.exports = {
  ListingState, Outcome, OUTCOME_NAMES, ClaimState,
  HOUR, DAY, FIX, DISPUTE, GRACE, REVEAL, SCALE, T,
  LISTING_CID, DISPUTE_CID, CT_CID, BCID, JUSTIFICATION, REPO, COMMIT,
  ARCHIVE, CT, CK, EK, LISTING_FEE, AWARDS, TOP, BOND, ORACLE, FEE, V, oneHot,
  atCommit, freshCommit, params, mergedAbi, deploy, eventsOf, blockTime,
  listAs, openListing, commitAs, claimAs, revealAs, revealedClaim, judgeAs, afterDisputeWindow,
};
