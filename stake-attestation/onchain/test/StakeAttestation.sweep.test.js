// StakeAttestation, final sweep (build node P2e): every state change emits an event (design
// §13.4's listing feed at least); every contract fits EIP-170 and EIP-3860 and the contract sizer
// enforces it (strict); `npm run coverage:check` fails below 95% line coverage on a contract; and
// the deploy scripts, which read every value from the environment, deploy and link the libraries
// first. The scripts are exercised here on the in-process network only, never a live one.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const H = require("./helpers/claims");

const {
  V, FIX, GRACE, TOP, BOND, FEE, DISPUTE_FEE, LISTING_FEE, LISTING_CID, DISPUTE_CID, CT_CID, BCID,
  JUSTIFICATION, STATEMENT_CID, ARCHIVE, CT, CK, EK, params, freshCommit, atCommit, deploy, eventsOf,
} = H;

const ROOT = path.join(__dirname, "..");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "sa-p2e-"));

// Design §13.4: "the listing feed is those events".
const FEED = [
  "Listed", "Opened", "Committed", "Flagged", "Released", "Revealed", "Judged", "Disputed", "Settled",
  "Expired", "RolledForward", "Renewed", "Closed", "LateClaim",
];

describe("StakeAttestation: final sweep (P2e)", function () {
  // ------------------------------------------------------------------ events
  describe("events (design §13.4)", function () {
    it("declares every event of the listing feed", async function () {
      const { sa } = await loadFixture(deploy);
      const events = sa.interface.fragments.filter((f) => f.type === "event").map((f) => f.name);
      for (const name of FEED) expect(events, name).to.include(name);
    });

    it("every state-changing function emits an event from the contract when it succeeds", async function () {
      const { sa, aggregator, owner, maker, other, feeRecipient, hunters } = await loadFixture(deploy);
      const ran = {};
      const run = async (fn, txp, event) => {
        const rc = await (await txp).wait();
        const names = eventsOf(sa, rc, event).map((e) => e.name);
        expect(names, `${fn} emits ${event}`).to.include(event);
        ran[fn] = true;
        return rc;
      };
      const claimIdOf = (rc, ev) => eventsOf(sa, rc, ev)[0].args.claimId;

      // The listing.
      const p = params({ fixWindow: FIX, disclosureGrace: GRACE });
      let rc = await run("list", sa.connect(maker).list(p, LISTING_CID, DISPUTE_CID, []), "Listed");
      const id = eventsOf(sa, rc, "Listed")[0].args.listingId;
      await run("fund", sa.connect(maker).fund(id, LISTING_FEE, { value: LISTING_FEE + 3n * TOP }), "Opened");
      await run("renew", sa.connect(maker).renew(id, { value: LISTING_FEE }), "Renewed");
      await run("withdraw", sa.connect(feeRecipient).withdraw(), "Withdrawn");

      // A claim through flag, release, reveal, judgement, dispute and settlement.
      rc = await run("commit", sa.connect(hunters[0]).commit(id, ARCHIVE, CT, { value: BOND + FEE }), "Committed");
      const a = claimIdOf(rc, "Committed");
      await run("disclose", sa.connect(hunters[0]).disclose(a, CT_CID), "Disclosed");
      await run("flagBadDisclosure", sa.connect(maker).flagBadDisclosure(a), "Flagged");
      await run("release", sa.connect(maker).release(a), "Released");
      await run("reveal", sa.connect(hunters[0]).reveal(a, BCID, CK, EK), "Revealed");
      await aggregator.scriptResult((await sa.getClaim(a)).requestId, V.HIGH, JUSTIFICATION);
      await run("finalize", sa.connect(other).finalize(a), "Judged");
      await run("dispute", sa.connect(maker).dispute(a, STATEMENT_CID, { value: DISPUTE_FEE }), "Disputed");
      await aggregator.scriptResult((await sa.getClaim(a)).disputeRequestId, V.HIGH, JUSTIFICATION);
      await run("finalize", sa.connect(other).finalize(a), "DisputeJudged");
      await run("settle", sa.connect(other).settle(a), "Settled");

      // A failed round, re-triggered, whose leftover recovery is deferred and then retried.
      rc = await (await sa.connect(hunters[1]).commit(id, ARCHIVE, CT, { value: BOND + FEE })).wait();
      const b = claimIdOf(rc, "Committed");
      await sa.connect(hunters[1]).disclose(b, CT_CID);
      await sa.connect(maker).release(b);
      await sa.connect(hunters[1]).reveal(b, BCID, CK, EK);
      await time.increase(300); // the mock's response timeout
      await run("finalize", sa.connect(other).finalize(b), "EvaluationFailed");
      await run("retrigger", sa.connect(hunters[1]).retrigger(b, { value: FEE }), "Retriggered");
      await aggregator.setRefundAmount(FEE / 2n);
      await aggregator.scriptResult((await sa.getClaim(b)).requestId, V.DUPLICATE, JUSTIFICATION);
      await aggregator.setWithdrawBroken(true);
      await run("finalize", sa.connect(other).finalize(b), "RefundDeferred");
      await aggregator.setWithdrawBroken(false);
      await run("recoverLeftoverEth", sa.connect(other).recoverLeftoverEth((await sa.getClaim(b)).evalWallet), "LeftoverRefunded");
      await sa.settle(b);

      // An undisclosed claim, expired.
      rc = await (await sa.connect(hunters[2]).commit(id, ARCHIVE, CT, { value: BOND + FEE })).wait();
      const c = claimIdOf(rc, "Committed");
      await time.increase(3600);
      await run("expire", sa.connect(other).expire(c), "Expired");

      // Roll forward, a late claim, close.
      const successor = await H.openListing(sa, maker, params({ artifact: atCommit(freshCommit()) }));
      await run("rollForward", sa.connect(maker).rollForward(id, successor), "RolledForward");
      await run("lateClaim", sa.connect(hunters[3]).lateClaim(id, ARCHIVE, CT, { value: BOND + FEE }), "LateClaim");
      await run("close", sa.connect(maker).close(id), "Closed");

      // The owner's two powers, and Ownable2Step.
      await run("setListingFee", sa.connect(owner).setListingFee(1n), "ListingFeeSet");
      await run("setFeeRecipient", sa.connect(owner).setFeeRecipient(other.address), "FeeRecipientSet");
      await run("transferOwnership", sa.connect(owner).transferOwnership(other.address), "OwnershipTransferStarted");
      await run("acceptOwnership", sa.connect(other).acceptOwnership(), "OwnershipTransferred");
      await run("renounceOwnership", sa.connect(other).renounceOwnership(), "OwnershipTransferred");

      // Every state-changing function of the merged ABI ran above. lensDelegate is plumbing that
      // only the contract itself may call, inside a static frame (it cannot change state).
      const mutating = sa.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .filter((n) => n !== "lensDelegate");
      expect(Object.keys(ran).sort()).to.deep.equal([...new Set(mutating)].sort());
      await expect(sa.connect(other).lensDelegate("0x")).to.be.revertedWith("self only");
    });
  });

  // ------------------------------------------------------------------ catalogue
  describe("catalogue coverage (verdikta-common data/code-review-fixtures.v1.json)", function () {
    // Decision D2: the paid pre-flight is out of the MVP, and with it these four cases.
    const DEFERRED = [
      "preflight-credited-same-archive-hash", "preflight-not-credited-different-archive-hash",
      "preflight-forfeited-without-commit", "zero-preflight-fee",
    ];
    it("every in-scope contract-layer case has a test named after it; the deferred ones are the four pre-flight cases", function () {
      const catalogue = require("@verdikta/common/data/code-review-fixtures.v1.json");
      const ids = catalogue.cases.filter((c) => c.layer === "contract").map((c) => c.id);
      const titles = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js"))
        .flatMap((f) => [...fs.readFileSync(path.join(__dirname, f), "utf8").matchAll(/\bit\(\s*[`"']([^`"']+)/g)].map((m) => m[1]));
      const named = (id) => titles.filter((t) => t.startsWith(`${id}:`) || t.startsWith(`${id} `));
      expect(DEFERRED.every((id) => ids.includes(id)), "the deferred cases are in the catalogue").to.equal(true);
      for (const id of ids) {
        if (DEFERRED.includes(id)) expect(named(id), `${id} is deferred (D2)`).to.deep.equal([]);
        else expect(named(id), `${id} has a test`).to.have.length(1);
      }
      expect(ids.length - DEFERRED.length).to.equal(23);
    });
  });

  // ------------------------------------------------------------------ size
  describe("size (EIP-170, EIP-3860)", function () {
    it("every contract that is deployed fits: runtime at most 24,576 bytes, initcode at most 49,152", async function () {
      if (hre.__SOLIDITY_COVERAGE_RUNNING) this.skip(); // coverage instruments the bytecode
      const sizes = {};
      for (const name of ["StakeAttestation", "StakeAttestationLens", "ClaimLogic", "RecordLogic", "EvaluationWallet",
        "StakeAttestationHarness", "MockVerdiktaAggregator"]) {
        const a = await hre.artifacts.readArtifact(name);
        const runtime = (a.deployedBytecode.length - 2) / 2;
        const init = (a.bytecode.length - 2) / 2;
        sizes[name] = { runtime, init };
        expect(runtime, `${name} runtime`).to.be.at.most(24_576);
        expect(init, `${name} initcode`).to.be.at.most(49_152);
      }
      // StakeAttestation's initcode carries the lens's and the wallet's creation code.
      expect(sizes.StakeAttestation.init).to.be.greaterThan(sizes.StakeAttestation.runtime + sizes.StakeAttestationLens.runtime);
    });

    it("the contract sizer is installed and strict, so `npx hardhat size-contracts` fails above the limit", function () {
      expect(hre.config.contractSizer, "contractSizer config").to.be.an("object");
      expect(hre.config.contractSizer.strict).to.equal(true);
      expect(hre.tasks).to.have.property("size-contracts");
    });
  });

  // ------------------------------------------------------------------ coverage gate
  describe("coverage:check", function () {
    const script = path.join(ROOT, "scripts", "check-coverage.js");
    const contracts = () =>
      require(script).productionContracts(path.join(ROOT, "contracts")).map((f) => path.join(ROOT, "contracts", f));
    const summary = (pct, { drop } = {}) => {
      const out = { total: { lines: { total: 100, covered: 100, pct: 100 } } };
      for (const f of contracts()) if (f !== drop) out[f] = { lines: { total: 1000, covered: Math.round(pct * 10), pct } };
      return out;
    };
    const check = (s) => {
      const dir = scratch();
      const file = path.join(dir, "coverage-summary.json");
      fs.writeFileSync(file, JSON.stringify(s));
      return spawnSync(process.execPath, [script, file], { cwd: ROOT, encoding: "utf8" });
    };

    it("is the package's coverage:check script: solidity-coverage, then the check", function () {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
      expect(pkg.scripts["coverage:check"]).to.match(/^hardhat coverage && node scripts\/check-coverage\.js$/);
      const solcover = require(path.join(ROOT, ".solcover.js"));
      expect(solcover.istanbulReporter).to.include("json-summary");
      expect(solcover.skipFiles).to.include.members(["mocks/", "test/", "interfaces/"]);
    });

    it("covers every production contract: the contracts and libraries, never the mocks, harness or interface", function () {
      const files = require(script).productionContracts(path.join(ROOT, "contracts"));
      expect(files).to.include.members([
        "StakeAttestation.sol", "StakeAttestationLens.sol", "EvaluationWallet.sol",
        "libraries/ClaimLogic.sol", "libraries/ClaimRules.sol", "libraries/RecordLogic.sol",
      ]);
      expect(files.filter((f) => /^(mocks|test|interfaces)\//.test(f))).to.deep.equal([]);
    });

    it("passes at 95% line coverage on every contract, and fails below it or when a contract has no figure", function () {
      expect(check(summary(95)).status, "95%").to.equal(0);
      expect(check(summary(100)).status, "100%").to.equal(0);
      const low = check(summary(94.99));
      expect(low.status, "94.99%").to.equal(1);
      expect(low.stderr).to.match(/below 95%/);
      const one = summary(100);
      one[contracts()[0]].lines = { total: 1000, covered: 949, pct: 94.9 };
      expect(check(one).status, "one contract low").to.equal(1);
      const missing = check(summary(100, { drop: contracts()[1] }));
      expect(missing.status, "a contract missing").to.equal(1);
      expect(missing.stderr).to.match(/no coverage figure/);
      const none = spawnSync(process.execPath, [script, path.join(scratch(), "absent.json")], { cwd: ROOT, encoding: "utf8" });
      expect(none.status, "no summary").to.equal(1);
    });
  });

  // ------------------------------------------------------------------ deploy scripts
  describe("deploy scripts (never run against a live network here)", function () {
    let D; // loaded here, not at file load, so a broken script fails these tests only
    before(function () {
      D = require("../deploy/01_deploy_stake_attestation.js");
    });
    const A = (n) => ethers.getAddress("0x" + String(n).repeat(40));
    const liveEnv = (extra = {}) => ({
      VERDIKTA_AGGREGATOR_BASE_SEPOLIA: A(1),
      VERDIKTA_AGGREGATOR_BASE: A(2),
      SA_INITIAL_OWNER: A(3),
      SA_FEE_RECIPIENT: A(4),
      SA_LISTING_FEE_WEI: "10000000000000000",
      ...extra,
    });

    it("reads the aggregator and the constructor arguments from the environment only, per network, and refuses a missing or malformed one", function () {
      expect(D.configFromEnv("base_sepolia", liveEnv())).to.deep.equal({
        aggregator: A(1), initialOwner: A(3), feeRecipient: A(4), listingFeeWei: 10n ** 16n,
      });
      expect(D.configFromEnv("base", liveEnv()).aggregator).to.equal(A(2));
      for (const name of ["VERDIKTA_AGGREGATOR_BASE_SEPOLIA", "SA_INITIAL_OWNER", "SA_FEE_RECIPIENT", "SA_LISTING_FEE_WEI"]) {
        expect(() => D.configFromEnv("base_sepolia", liveEnv({ [name]: undefined })), name).to.throw(name);
        expect(() => D.configFromEnv("base_sepolia", liveEnv({ [name]: "" })), name).to.throw(name);
      }
      expect(() => D.configFromEnv("base", liveEnv({ VERDIKTA_AGGREGATOR_BASE: undefined }))).to.throw("VERDIKTA_AGGREGATOR_BASE");
      expect(() => D.configFromEnv("base_sepolia", liveEnv({ SA_FEE_RECIPIENT: "0x1234" }))).to.throw("SA_FEE_RECIPIENT");
      expect(() => D.configFromEnv("base_sepolia", liveEnv({ SA_INITIAL_OWNER: ethers.ZeroAddress }))).to.throw("SA_INITIAL_OWNER");
      expect(() => D.configFromEnv("base_sepolia", liveEnv({ SA_LISTING_FEE_WEI: "0.01" }))).to.throw("SA_LISTING_FEE_WEI");
      expect(() => D.configFromEnv("base_sepolia", liveEnv({ SA_LISTING_FEE_WEI: "1e16" }))).to.throw("SA_LISTING_FEE_WEI");
      expect(() => D.configFromEnv("sepolia", liveEnv())).to.throw(/Unsupported network/);
      // The in-process network needs nothing: the mock aggregator and the deployer stand in.
      expect(D.configFromEnv("hardhat", {})).to.deep.equal({
        aggregator: null, initialOwner: null, feeRecipient: null, listingFeeWei: 10n ** 16n,
      });
    });

    it("deploys ClaimLogic first, then RecordLogic, links both into StakeAttestation and passes the constructor arguments", async function () {
      const [deployer, owner, recipient] = await ethers.getSigners();
      const aggregator = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
      const out = await D.deployStakeAttestation(hre, {
        aggregator: aggregator.target, initialOwner: owner.address, feeRecipient: recipient.address, listingFeeWei: 123n,
      }, { log: () => {} });
      const { contracts } = out;
      expect(Object.keys(contracts)).to.deep.equal([
        "ClaimLogic", "RecordLogic", "StakeAttestation", "StakeAttestationLens", "EvaluationWalletImplementation", "VerdiktaAggregator",
      ]);
      expect(out.deployer).to.equal(deployer.address);
      expect(out.constructorArgs).to.deep.equal([aggregator.target, owner.address, recipient.address, "123"]);
      expect(out.libraries).to.deep.equal({ ClaimLogic: contracts.ClaimLogic, RecordLogic: contracts.RecordLogic });
      // The libraries were deployed before the contract that links them.
      const blockOf = async (a) => (await ethers.provider.getTransactionReceipt(out.transactions[a])).blockNumber;
      expect(await blockOf("ClaimLogic")).to.be.lessThan(await blockOf("RecordLogic"));
      expect(await blockOf("RecordLogic")).to.be.lessThan(await blockOf("StakeAttestation"));
      expect(out.deploymentBlock).to.equal(await blockOf("StakeAttestation"));
      const code = (await ethers.provider.getCode(contracts.StakeAttestation)).toLowerCase();
      for (const lib of ["ClaimLogic", "RecordLogic"]) expect(code, lib).to.include(contracts[lib].slice(2).toLowerCase());

      const sa = new ethers.Contract(contracts.StakeAttestation, H.mergedAbi("StakeAttestation"), owner);
      expect(await sa.verdikta()).to.equal(aggregator.target);
      expect(await sa.owner()).to.equal(owner.address);
      expect(await sa.feeRecipient()).to.equal(recipient.address);
      expect(await sa.listingFeeWei()).to.equal(123n);
      expect(await sa.lens()).to.equal(contracts.StakeAttestationLens);
      expect(await sa.walletImplementation()).to.equal(contracts.EvaluationWalletImplementation);
      // It works: a listing opens and the record (RecordLogic, through the lens) answers.
      const id = await H.openListing(sa, owner, params({ artifact: atCommit(freshCommit()) }));
      expect((await sa.recordByHash((await sa.getListing(id)).artifactHash)).listingCount).to.equal(1n);
    });

    it("main(): on the in-process network deploys the mock aggregator, saves the deployment and the merged ABI", async function () {
      const dir = scratch();
      const out = await D.main({ env: {}, saveDir: dir, log: () => {} });
      expect(out.network).to.equal("hardhat");
      expect(await ethers.provider.getCode(out.contracts.VerdiktaAggregator)).to.not.equal("0x");
      const [deployer] = await ethers.getSigners();
      expect(out.constructorArgs.slice(1, 3)).to.deep.equal([deployer.address, deployer.address]);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, `${out.chainId}-hardhat.json`), "utf8"));
      expect(saved.contracts).to.deep.equal(out.contracts);
      const abi = JSON.parse(fs.readFileSync(path.join(dir, "StakeAttestation.abi.json"), "utf8")).abi;
      const names = abi.filter((f) => f.type === "function").map((f) => f.name);
      expect(names).to.include.members(["lateClaim", "recordByHash", "recordPage", "commitPrice", "claimState"]);
    });

    it("refuses a live network whose aggregator address has no code, before deploying anything", async function () {
      await expect(D.checkAggregator(hre, ethers.Wallet.createRandom().address)).to.be.rejectedWith(/no contract/);
      const aggregator = await (await ethers.getContractFactory("MockVerdiktaAggregator")).deploy();
      await expect(D.checkAggregator(hre, aggregator.target)).to.not.be.rejected;
    });

    it("the Base Sepolia and mainnet shell scripts parse, load an optional .env and deploy to their own network", function () {
      for (const [file, network] of [["deploy_testnet.sh", "base_sepolia"], ["deploy_mainnet.sh", "base"]]) {
        const p = path.join(ROOT, file);
        expect(spawnSync("bash", ["-n", p]).status, `${file} parses`).to.equal(0);
        expect(fs.statSync(p).mode & 0o111, `${file} is executable`).to.not.equal(0);
        const text = fs.readFileSync(p, "utf8");
        expect(text).to.match(/set -euo pipefail/);
        expect(text).to.include(`NETWORK="${network}"`);
        expect(text).to.include("deploy/01_deploy_stake_attestation.js");
        expect(text).to.match(/if \[ -f \.env \]/);
      }
      const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
      expect(example).to.not.match(/[0-9a-fA-F]{64}/); // no key
      for (const v of ["PRIVATE_KEY", "SA_INITIAL_OWNER", "SA_FEE_RECIPIENT", "SA_LISTING_FEE_WEI",
        "VERDIKTA_AGGREGATOR_BASE_SEPOLIA", "VERDIKTA_AGGREGATOR_BASE"]) {
        expect(example, v).to.include(v);
      }
    });

    it("the live networks take their key and RPC URL from the environment; the config holds no key", function () {
      const text = fs.readFileSync(path.join(ROOT, "hardhat.config.js"), "utf8");
      expect(text).to.not.match(/0x[0-9a-fA-F]{64}/);
      const accounts = [process.env.PRIVATE_KEY].filter(Boolean);
      for (const [name, chainId] of [["base_sepolia", 84532], ["base", 8453]]) {
        const n = hre.config.networks[name];
        expect(n, name).to.be.an("object");
        expect(n.chainId).to.equal(chainId);
        expect(n.accounts).to.deep.equal(accounts.map((k) => (k.startsWith("0x") ? k : `0x${k}`)));
      }
      expect(hre.network.name).to.equal("hardhat"); // the tests run in-process
    });
  });
});
