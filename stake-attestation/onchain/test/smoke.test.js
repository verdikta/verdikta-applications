// The launch smoke check (node P23; scripts/smoke.js, README "Running the site", step 7): a deployment JSON, an RPC URL
// from the environment, the site's origin and an artifact hash. It reads recordByHash through the lens at the block the
// site's answer is of, and the site's record route, and exits 0 only when both answer for the hash and agree on every
// fact both carry. Here: StakeAttestation on the in-process network behind Hardhat's JSON-RPC server, a record with two
// listings of one hash (a valid finding on one, a bad-disclosure flag on the other), and a stub site whose answers each
// test sets. The stub's record is written from the chain's answer by this file's own reading of it (enums by name,
// uints as decimal strings, as the server's record route writes it), not by the script's.
//
// @skip-on-coverage: it reads the contract and changes nothing, and the coverage job has no time to spare (.solcover.js).
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { TASK_NODE_CREATE_SERVER } = require("hardhat/builtin-tasks/task-names");

const H = require("./helpers/claims");
const { saveDeployment, writeMergedAbi } = require("../deploy/helpers");
const smoke = require("../scripts/smoke");

const ONCHAIN = path.resolve(__dirname, "..");
const ArtifactKind = ["Repo", "Contract"];
const names = (o) => Object.entries(o).sort((a, b) => (a[1] < b[1] ? -1 : 1)).map(([k]) => k);
// The enum at each path of the record: this file's own table, apart from the script's reading of the ABI.
const ENUM_AT = {
  kind: ArtifactKind,
  "listings.state": names(H.ListingState),
  "listings.lowestClassCounted": H.OUTCOME_NAMES,
  "findings.outcome": H.OUTCOME_NAMES,
  "findings.dispute": names(H.DisputeResult),
  "findings.disputeKind": names(H.DisputeKind),
  "flags.state": names(H.ClaimState),
  "flags.outcome": H.OUTCOME_NAMES,
};

/** The record as the site's route writes it, from the chain's decoded answer. */
function asSite(value, type, at = "") {
  if (type.baseType === "array") return [...value].map((v) => asSite(v, type.arrayChildren, at));
  if (type.baseType === "tuple") return Object.fromEntries(type.components.map((c, i) => [c.name, asSite(value[i], c, at ? `${at}.${c.name}` : c.name)]));
  if (ENUM_AT[at]) return ENUM_AT[at][Number(value)];
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** The record as if only `counted` listings were on it (the server's src/record/record.js partitionRecord). */
function counted(rec, ids) {
  const keep = (x) => ids.has(String(x.listingId));
  const listings = rec.listings.filter(keep);
  const sum = (key, i) => listings.reduce((s, l) => s + BigInt(i === undefined ? l.history[key] : l.history[key][i]), 0n).toString();
  const history = Object.fromEntries(Object.entries(rec.history).map(([k, v]) => [k, Array.isArray(v) ? v.map((_, i) => sum(k, i)) : sum(k)]));
  const findings = rec.findings.filter(keep);
  const flags = rec.flags.filter(keep);
  return {
    record: { ...rec, listingCount: String(listings.length), active: rec.active.filter((id) => ids.has(String(id))), listings, history, findingCount: String(findings.length), findings, flagCount: String(flags.length), flags },
    apart: { findings: rec.findings.filter((x) => !keep(x)), flags: rec.flags.filter((x) => !keep(x)) },
  };
}

async function world() {
  const fromBlock = await ethers.provider.getBlockNumber();
  const f = await H.deploy();
  const commit = H.freshCommit();
  // a valid finding (HIGH, at most the confirmation size, so it settles after its dispute window)
  const first = await H.openListing(f.sa, f.maker, H.params({ artifact: H.atCommit(commit) }));
  const { claimId } = await H.revealedClaim(f.sa, f.hunter, first);
  await H.judgeAs(f.sa, f.aggregator, f.hunter, claimId, H.V.HIGH);
  await H.afterDisputeWindow(f.sa, claimId);
  await f.sa.settle(claimId);
  // another maker's listing of the same version, with a disclosure the maker flags
  const second = await H.openListing(f.sa, f.other, H.params({ artifact: H.atCommit(commit), fixWindow: H.DAY, disclosureGrace: H.DAY }));
  const flagged = await H.claimAs(f.sa, f.hunters[1], second);
  await f.sa.connect(f.other).flagBadDisclosure(flagged.claimId);
  const { artifactHash } = await f.sa.getListing(first);
  return { ...f, fromBlock, commit, first, second, artifactHash };
}

describe("The launch smoke check (scripts/smoke.js) @skip-on-coverage", function () {
  let rpc;
  let rpcUrl;
  let site;
  let siteOrigin;
  let answers; // path -> { status, body } the stub site gives
  let dir;

  before(async function () {
    rpc = await hre.run(TASK_NODE_CREATE_SERVER, { hostname: "127.0.0.1", port: 0, provider: hre.network.provider });
    rpcUrl = `http://127.0.0.1:${(await rpc.listen()).port}`;
    site = http.createServer((req, res) => {
      const a = answers[new URL(req.url, "http://x").pathname];
      if (!a) {
        res.statusCode = 404;
        return res.end('{"error":"NOT_FOUND"}');
      }
      res.statusCode = a.status ?? 200;
      res.setHeader("content-type", "application/json");
      return res.end(typeof a.body === "string" ? a.body : JSON.stringify(a.body));
    });
    await new Promise((r) => site.listen(0, "127.0.0.1", r));
    siteOrigin = `http://127.0.0.1:${site.address().port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-smoke-"));
  });

  after(async function () {
    await rpc?.close();
    await new Promise((r) => site?.close(r));
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The world, its deployment JSON and merged ABI in a folder of their own, and the stub's honest answers. */
  async function setUp({ count = null } = {}) {
    const w = await loadFixture(world);
    const countedIds = count ? count(w) : null;
    const out = path.join(dir, `d${Math.random().toString(16).slice(2)}`);
    const file = saveDeployment({
      network: "hardhat", chainId: 31337, deploymentBlock: w.fromBlock + 1,
      contracts: { StakeAttestation: w.sa.target, VerdiktaAggregator: w.aggregator.target },
    }, out, () => {});
    writeMergedAbi(hre.artifacts, out, () => {});
    const block = await ethers.provider.getBlock("latest");
    const fragment = w.sa.interface.getFunction("recordByHash");
    const rec = asSite(await w.sa.recordByHash(w.artifactHash, { blockTag: block.number }), fragment.outputs[0]);
    const ids = new Set(countedIds ?? rec.listings.map((l) => String(l.listingId)));
    const { record, apart } = counted(rec, ids);
    const listed = rec.listings.find((l) => !ids.has(String(l.listingId)));
    const view = {
      artifactHash: w.artifactHash,
      block: { number: block.number, hash: block.hash, timestamp: block.timestamp },
      record,
      labels: {},
      history: { events: [] },
      fresh: true,
      staleReason: null,
      artifact: { kind: "Repo", repo: H.REPO, baseCommit: w.commit, chainId: "0", address: ethers.ZeroAddress },
      notCounted: {
        listings: listed ? [{ listingId: String(listed.listingId), maker: listed.maker, state: listed.state, lapsed: listed.lapsed, reason: "NO_PROOF", detail: "…" }] : [],
        findings: apart.findings,
        flags: apart.flags,
        events: [],
      },
    };
    answers = {
      [`/api/records/${w.artifactHash}`]: { body: view },
      "/api/status": { body: { chainId: 31337, contract: w.sa.target, indexer: { fresh: true } } },
    };
    return { w, file, view, rec };
  }

  async function runSmoke({ file, hash, origin = siteOrigin, env = { SA_RPC_URL: rpcUrl }, extra = [] } = {}) {
    const lines = [];
    const code = await smoke.run({ argv: ["--deployment", file, "--site", origin, "--hash", hash, ...extra], env, log: (l) => lines.push(l) });
    return { code, out: lines.join("\n") };
  }

  it("reads a record with findings, flags and two listings, and the site agrees: exit 0", async function () {
    const { w, file, rec } = await setUp();
    expect(rec.listings.length).to.equal(2);
    expect(rec.findings.length).to.equal(1);
    expect(rec.flags.length).to.equal(1);
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code, r.out).to.equal(0);
    expect(r.out).to.match(/^OK/m);
  });

  it("agrees with a site that counts one listing and shows the other apart, as the site's rule has it: exit 0", async function () {
    const { w, file, view } = await setUp({ count: (x) => [String(x.first)] });
    expect(view.record.listings.length).to.equal(1);
    expect(view.notCounted.listings.length).to.equal(1);
    expect(view.notCounted.flags.length).to.equal(1, "the flag is the other listing's");
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code, r.out).to.equal(0);
  });

  it("a fact the site states otherwise: exit 1, naming it", async function () {
    const { w, file, view } = await setUp();
    view.record.listings[0].escrowWei = (BigInt(view.record.listings[0].escrowWei) + 1n).toString();
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/listings\[0\]\.escrowWei/);
  });

  it("an enum, a finding and a flag the site states otherwise: exit 1 each", async function () {
    for (const tamper of [
      (v) => { v.record.listings[1].state = "Closed"; },
      (v) => { v.record.findings[0].outcome = "CRITICAL"; },
      (v) => { v.record.flags[0].state = "Settled"; },
      (v) => { v.record.history.outcomes[4] = "0"; },
      (v) => { v.record.active = []; },
    ]) {
      const { w, file, view } = await setUp();
      tamper(view);
      const r = await runSmoke({ file, hash: w.artifactHash });
      expect(r.code, r.out).to.equal(1);
    }
  });

  it("a fact the site leaves out: exit 1", async function () {
    const { w, file, view } = await setUp();
    delete view.record.history.claims;
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/history\.claims/);
  });

  it("a listing the site neither counts nor shows apart, or shows apart with other facts: exit 1", async function () {
    const firstOnly = { count: (x) => [String(x.first)] };
    for (const tamper of [
      (v) => { v.notCounted.listings = []; },
      (v) => { v.notCounted.listings[0].state = "Closed"; },
      (v) => { v.notCounted.listings[0].maker = ethers.ZeroAddress; },
      (v) => { v.notCounted.flags = []; },
      (v) => { v.notCounted.listings.push({ ...v.notCounted.listings[0] }); },
    ]) {
      const { w, file, view } = await setUp(firstOnly);
      tamper(view);
      const r = await runSmoke({ file, hash: w.artifactHash });
      expect(r.code, r.out).to.equal(1);
    }
  });

  it("the site does not answer for the hash, answers an error, or is not there: exit 1", async function () {
    const { w, file } = await setUp();
    answers[`/api/records/${w.artifactHash}`] = { status: 404, body: { error: "RECORD_NOT_FOUND" } };
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
    answers[`/api/records/${w.artifactHash}`] = { status: 503, body: { error: "CHAIN_UNAVAILABLE" } };
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
    answers[`/api/records/${w.artifactHash}`] = { body: "<html>not json</html>" };
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
    expect((await runSmoke({ file, hash: w.artifactHash, origin: "http://127.0.0.1:1" })).code).to.equal(1);
  });

  it("the chain has no listing of the hash: exit 1, whatever the site says", async function () {
    const { file, view } = await setUp();
    const nothing = ethers.keccak256(ethers.toUtf8Bytes("never listed"));
    expect((await runSmoke({ file, hash: nothing })).code).to.equal(1);
    answers[`/api/records/${nothing}`] = { body: { ...view, artifactHash: nothing } };
    expect((await runSmoke({ file, hash: nothing })).code).to.equal(1);
  });

  it("the site's block is not on this chain, or the site answers for another hash: exit 1", async function () {
    const { w, file, view } = await setUp();
    view.block.hash = ethers.keccak256(ethers.toUtf8Bytes("another branch"));
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
    const again = await setUp();
    again.view.artifactHash = ethers.ZeroHash;
    expect((await runSmoke({ file: again.file, hash: w.artifactHash })).code).to.equal(1);
  });

  it("the site serves another deployment, or another chain: exit 1", async function () {
    const { w, file } = await setUp();
    answers["/api/status"] = { body: { chainId: 31337, contract: w.aggregator.target } };
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
    answers["/api/status"] = { body: { chainId: 84532, contract: w.sa.target } };
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
    answers["/api/status"] = { status: 503, body: { error: "CHAIN_NOT_CONFIGURED" } };
    expect((await runSmoke({ file, hash: w.artifactHash })).code).to.equal(1);
  });

  it("the RPC endpoint is on another chain than the deployment JSON's: exit 1", async function () {
    const { w, file } = await setUp();
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...d, chainId: 84532 }));
    answers["/api/status"] = { body: { chainId: 84532, contract: w.sa.target } };
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/chain/i);
  });

  it("a site whose record is not fresh: exit 1", async function () {
    const { w, file, view } = await setUp();
    view.fresh = false;
    view.staleReason = "INDEXER_STALE";
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/INDEXER_STALE/);
  });

  it("the site's artifact does not hash to the record's key: exit 1", async function () {
    const { w, file, view } = await setUp();
    view.artifact.baseCommit = H.freshCommit();
    const r = await runSmoke({ file, hash: w.artifactHash });
    expect(r.code).to.equal(1);
    expect(r.out).to.match(/artifact/);
  });

  it("a usage error: exit 2, with nothing read", async function () {
    const { w, file } = await setUp();
    expect((await runSmoke({ file, hash: w.artifactHash, env: {} })).code).to.equal(2);
    expect((await runSmoke({ file, hash: "0x1234" })).code).to.equal(2);
    expect((await runSmoke({ file: path.join(dir, "missing.json"), hash: w.artifactHash })).code).to.equal(2);
    expect((await runSmoke({ file, hash: w.artifactHash, origin: "http://verifiers.verdikta.org" })).code).to.equal(2, "a site's origin is https, but for loopback");
    expect((await runSmoke({ file, hash: w.artifactHash, origin: "https://verifiers.verdikta.org/api" })).code).to.equal(2, "an origin, no path");
  });

  it("npm run smoke runs it: the exit code is the check's", async function () {
    const { w, file } = await setUp();
    const exit = (args) => new Promise((resolve, reject) => {
      const child = spawn("npm", ["run", "--silent", "smoke", "--", ...args], { cwd: ONCHAIN, env: { ...process.env, SA_RPC_URL: rpcUrl }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, out }));
    });
    const ok = await exit(["--deployment", file, "--site", siteOrigin, "--hash", w.artifactHash]);
    expect(ok.code, ok.out).to.equal(0);
    answers[`/api/records/${w.artifactHash}`].body.record.listings[0].bondWei = "1";
    const bad = await exit(["--deployment", file, "--site", siteOrigin, "--hash", w.artifactHash]);
    expect(bad.code, bad.out).to.equal(1);
  });

  it("the script's enum names are the contract's declarations, in order", function () {
    const src = fs.readdirSync(path.join(ONCHAIN, "contracts"), { recursive: true }).filter((f) => f.endsWith(".sol") && !f.startsWith("mocks") && !f.startsWith("test"))
      .map((f) => fs.readFileSync(path.join(ONCHAIN, "contracts", f), "utf8")).join("\n");
    for (const [name, members] of Object.entries(smoke.ENUMS)) {
      const m = new RegExp(`enum ${name}\\s*\\{([^}]*)\\}`).exec(src);
      expect(m, name).to.not.equal(null);
      expect(m[1].split(",").map((s) => s.replace(/\/\/.*$/gm, "").trim()).filter(Boolean), name).to.deep.equal(members);
    }
  });
});
