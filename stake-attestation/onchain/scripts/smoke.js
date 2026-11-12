#!/usr/bin/env node
// The launch smoke check (node P23; README "Running the site", step 7): does a listing's record read back the same
// from the chain and from the site?
//
//   SA_RPC_URL=<a Base Sepolia endpoint> npm run smoke -- --deployment deployments/84532-base_sepolia.json \
//     --site https://verifiers.verdikta.org --hash 0x<the artifact hash>
//
// It reads the deployment JSON deploy/01_deploy_stake_attestation.js wrote, and the merged ABI beside it
// (StakeAttestation.abi.json, or --abi), asks the site's /api/status which deployment it serves, then the site's record
// route, GET /api/records/<hash>, and calls the lens's recordByHash at the block the site's answer is of, pinned by its
// hash (EIP-1898), so the two are of one block. It exits 0 only when:
//   - the RPC endpoint is the deployment's chain, and the site serves that chain and that contract;
//   - both answer for the hash: the chain holds a listing of it, and the site answers 200 with a fresh record;
//   - every listing on the chain is either on the site's record or apart from it (notCounted), never both, never
//     neither; the site's record is the chain's restricted to the listings it counts, field for field (uints as decimal
//     strings, enums by name, as the server writes them); the listings apart state the chain's maker, state and
//     lapsed, and the findings and flags apart are the chain's for them;
//   - the artifact the site names hashes to the record's key (artifactHashOf) and is of the chain's kind.
// Anything else is exit 1, with every difference named; a usage error is exit 2, with nothing read. The RPC URL is
// read from the environment only and never printed: a provider's URL can carry its key.
// It is plain ethers, no Hardhat: it runs wherever onchain's dependencies are installed.
const fs = require("node:fs");
const path = require("node:path");
const { Interface, JsonRpcProvider, Network, getAddress } = require("ethers");

// The contract's enums the record holds, by name, in declaration order (test/smoke.test.js holds them to the sources).
const ENUMS = Object.freeze({
  ArtifactKind: Object.freeze(["Repo", "Contract"]),
  ListingState: Object.freeze(["Listed", "Open", "Depleted", "Rolled", "Closed"]),
  Outcome: Object.freeze(["INVALID", "DUPLICATE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  ClaimState: Object.freeze(["Committed", "Revealable", "Revealed", "Judged", "Disputed", "Settled", "Expired", "RoundFailed"]),
  DisputeResult: Object.freeze(["None", "Pending", "Held", "Overturned", "NoVerdict"]),
  DisputeKind: Object.freeze(["None", "Maker", "Confirmation", "Appeal"]),
});

const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;
const TIMEOUT_MS = 30000;
const MAX_DIFFS = 40;

class Usage extends Error {}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!["--deployment", "--site", "--hash", "--abi"].includes(k) || argv[i + 1] === undefined) throw new Usage(`unknown or incomplete argument ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  for (const k of ["deployment", "site", "hash"]) if (!out[k]) throw new Usage(`--${k} is required`);
  return out;
}

/** The site's origin: https, or plain http on loopback (tests); no path, query or credentials. */
function siteOrigin(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Usage(`--site ${raw} is not a URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) throw new Usage(`--site must be https (plain http on loopback only): ${raw}`);
  if (u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname)) throw new Usage(`--site is the site's origin alone, e.g. https://verifiers.verdikta.org: ${raw}`);
  return u.origin;
}

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Usage(`${what} ${file} cannot be read: ${err.code ?? err.message}`);
  }
}

function deploymentOf(file, abiFile) {
  const d = readJson(file, "the deployment JSON");
  const address = d?.contracts?.StakeAttestation;
  if (!Number.isSafeInteger(d?.chainId) || typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Usage(`${file} is not a deployment JSON: it needs chainId and contracts.StakeAttestation`);
  }
  const abiPath = abiFile ?? path.join(path.dirname(file), "StakeAttestation.abi.json");
  const abi = readJson(abiPath, "the merged ABI");
  const fragments = Array.isArray(abi) ? abi : abi?.abi;
  let iface;
  try {
    iface = new Interface(fragments);
  } catch (err) {
    throw new Usage(`${abiPath} is not an ABI: ${err.message}`);
  }
  // the raw fragment keeps each parameter's internalType, which names the enums (ethers' ParamType does not)
  const recordOutput = fragments.find((f) => f.type === "function" && f.name === "recordByHash")?.outputs?.[0];
  if (!recordOutput || !fragments.some((f) => f.type === "function" && f.name === "artifactHashOf")) {
    throw new Usage(`${abiPath} has no recordByHash or artifactHashOf: use the merged ABI (contract and lens) the deploy script wrote`);
  }
  return { chainId: d.chainId, address: getAddress(address), iface, recordOutput };
}

// ---------------------------------------------------------------------------------------------- the server's form

/**
 * A decoded ABI value as the site writes it (server/src/chain/codec.js), from the raw JSON ABI's parameter: uints as
 * decimal strings, an enum by its member's name, a struct as an object by component name, arrays as arrays.
 */
function toJson(value, param) {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array) {
    const child = { ...param, type: array[1], internalType: (param.internalType ?? "").replace(/\[\d*\]$/, "") };
    return Array.from(value, (v) => toJson(v, child));
  }
  if (param.type === "tuple") return Object.fromEntries(param.components.map((c, i) => [c.name, toJson(value[i], c)]));
  const enumName = /^enum (?:\w+\.)?(\w+)$/.exec(param.internalType ?? "")?.[1];
  if (enumName) {
    const names = ENUMS[enumName];
    if (!names) throw new Error(`the ABI names an enum this check does not know: ${enumName}`);
    const name = names[Number(value)];
    if (name === undefined) throw new Error(`${value} is not a member of ${enumName}`);
    return name;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

/** The record as if only `counted` listings were on it: the site's rule (server/src/record/record.js partitionRecord). */
function partition(record, counted) {
  const keep = (x) => counted.has(String(x.listingId));
  const listings = record.listings.filter(keep);
  const history = {};
  for (const [k, v] of Object.entries(record.history)) {
    history[k] = Array.isArray(v)
      ? v.map((_, i) => listings.reduce((s, l) => s + BigInt(l.history[k][i]), 0n).toString())
      : listings.reduce((s, l) => s + BigInt(l.history[k]), 0n).toString();
  }
  const findings = record.findings.filter(keep);
  const flags = record.flags.filter(keep);
  return {
    record: {
      ...record,
      listingCount: String(listings.length),
      active: record.active.filter((id) => counted.has(String(id))),
      listings,
      history,
      findingCount: String(findings.length),
      findings,
      flagCount: String(flags.length),
      flags,
    },
    findings: record.findings.filter((x) => !keep(x)),
    flags: record.flags.filter((x) => !keep(x)),
  };
}

const same = (a, b) => (typeof a === "string" && typeof b === "string" && HEX.test(a) && HEX.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Every fact of `chain` the site's `site` misses or states otherwise, by path. */
function differences(chain, site, at, out) {
  if (out.length >= MAX_DIFFS) return out;
  if (Array.isArray(chain)) {
    if (!Array.isArray(site)) out.push(`${at}: the chain has a list of ${chain.length}, the site ${site === undefined ? "nothing" : JSON.stringify(site)}`);
    else if (site.length !== chain.length) out.push(`${at}: the chain has ${chain.length}, the site ${site.length}`);
    else chain.forEach((v, i) => differences(v, site[i], `${at}[${i}]`, out));
  } else if (chain !== null && typeof chain === "object") {
    if (site === null || typeof site !== "object" || Array.isArray(site)) out.push(`${at}: the site has ${JSON.stringify(site)}`);
    else for (const [k, v] of Object.entries(chain)) {
      if (!Object.hasOwn(site, k)) out.push(`${at}.${k}: the site does not state it (the chain: ${JSON.stringify(v)})`);
      else differences(v, site[k], `${at}.${k}`, out);
    }
  } else if (!same(chain, site)) {
    out.push(`${at}: the chain ${JSON.stringify(chain)}, the site ${JSON.stringify(site)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- reads

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { miss: `${url}: no answer (${err.cause?.code ?? err.name})` };
  }
  const text = await res.text();
  if (res.status !== 200) return { miss: `${url}: HTTP ${res.status} ${text.slice(0, 200)}` };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { miss: `${url}: not JSON` };
  }
}

/**
 * @param {{ argv: string[], env?: Record<string, string|undefined>, log?: (line: string) => void }} o
 * @returns {Promise<number>} the exit code: 0 agree, 1 a miss or a disagreement, 2 a usage error
 */
async function run({ argv, env = process.env, log = (l) => console.log(l) }) {
  let a;
  let d;
  let origin;
  const rpcUrl = env.SA_RPC_URL;
  try {
    a = args(argv);
    origin = siteOrigin(a.site);
    if (!HASH.test(a.hash)) throw new Usage(`--hash is an artifact hash, 0x and 64 hex digits: ${a.hash}`);
    if (!rpcUrl) throw new Usage("SA_RPC_URL is not set: the chain's JSON-RPC endpoint, from the environment only");
    d = deploymentOf(a.deployment, a.abi);
  } catch (err) {
    if (!(err instanceof Usage)) throw err;
    log(`usage: ${err.message}`);
    log("SA_RPC_URL=… npm run smoke -- --deployment <deployments/…json> --site <https://origin> --hash <0x…> [--abi <merged ABI>]");
    return 2;
  }
  const hash = a.hash.toLowerCase();
  const misses = [];
  const miss = (m) => { misses.push(m); };
  const redact = (s) => String(s).split(rpcUrl).join("<SA_RPC_URL>");
  const provider = new JsonRpcProvider(rpcUrl, Network.from(d.chainId), { staticNetwork: Network.from(d.chainId), batchMaxCount: 1 });
  const rpc = async (method, params) => {
    try {
      return await provider.send(method, params);
    } catch (err) {
      throw new Error(redact(err.shortMessage ?? err.message ?? err));
    }
  };
  const finish = () => {
    provider.destroy();
    if (misses.length) {
      for (const m of misses) log(`MISS ${m}`);
      log(`FAIL: ${misses.length} miss(es) or difference(s) for ${hash}`);
      return 1;
    }
    return 0;
  };

  // 1. the chain and the deployment the site serves
  try {
    const chainId = Number(await rpc("eth_chainId", []));
    if (chainId !== d.chainId) miss(`the RPC endpoint is on chain ${chainId}, the deployment JSON on chain ${d.chainId}`);
  } catch (err) {
    miss(`the chain could not be read: ${err.message}`);
  }
  const status = await getJson(`${origin}/api/status`);
  if (status.miss) miss(status.miss);
  else {
    if (status.body.chainId !== d.chainId) miss(`the site serves chain ${status.body.chainId}, the deployment is on chain ${d.chainId}`);
    if (typeof status.body.contract !== "string" || !same(status.body.contract, d.address)) miss(`the site serves contract ${status.body.contract}, the deployment is ${d.address}`);
  }
  if (misses.length) return finish();

  // 2. the site's record
  const answer = await getJson(`${origin}/api/records/${hash}`);
  if (answer.miss) {
    miss(answer.miss);
    // say whether the chain holds the hash either way
    try {
      const raw = await rpc("eth_call", [{ to: d.address, data: d.iface.encodeFunctionData("recordByHash", [hash]) }, "latest"]);
      const listings = d.iface.decodeFunctionResult("recordByHash", raw)[0].listingCount;
      miss(`(the chain at its head holds ${listings} listing(s) of ${hash})`);
    } catch (err) {
      miss(`(the chain could not be read either: ${err.message})`);
    }
    return finish();
  }
  const view = answer.body;
  if (typeof view?.artifactHash !== "string" || view.artifactHash.toLowerCase() !== hash) miss(`the site answered for ${view?.artifactHash}, not ${hash}`);
  if (view?.fresh !== true) miss(`the site's record is not fresh (${view?.staleReason ?? "no freshness stated"}): its indexer is behind`);
  const block = view?.block;
  if (!block || !Number.isSafeInteger(block.number) || typeof block.hash !== "string" || !HASH.test(block.hash)) {
    miss(`the site's answer names no block: ${JSON.stringify(block)}`);
    return finish();
  }
  if (!view.record || !view.notCounted) {
    miss("the site's answer has no record or no notCounted");
    return finish();
  }

  // 3. recordByHash at that block, by its hash
  let chain;
  try {
    const b = await rpc("eth_getBlockByHash", [block.hash, false]);
    if (!b) throw new Error(`block ${block.hash} is not on this chain`);
    if (Number(b.number) !== block.number) miss(`the site's block ${block.hash} is number ${Number(b.number)} on the chain, ${block.number} on the site`);
    const raw = await rpc("eth_call", [{ to: d.address, data: d.iface.encodeFunctionData("recordByHash", [hash]) }, { blockHash: block.hash, requireCanonical: true }]);
    chain = toJson(d.iface.decodeFunctionResult("recordByHash", raw)[0], d.recordOutput);
  } catch (err) {
    miss(`recordByHash at the site's block ${block.number} (${block.hash}) could not be read: ${err.message}`);
    return finish();
  }
  if (chain.listingCount === "0") {
    miss(`the chain holds no listing of ${hash} at the site's block`);
    return finish();
  }

  // 4. every listing on the record or apart, once
  const ids = (list) => (Array.isArray(list) ? list.map((l) => String(l?.listingId)) : null);
  const counted = ids(view.record.listings);
  const apart = ids(view.notCounted.listings);
  if (!counted || !apart) {
    miss("the site's record or notCounted has no listings list");
    return finish();
  }
  const onChain = chain.listings.map((l) => String(l.listingId));
  for (const [name, list] of [["the record", counted], ["notCounted", apart]]) {
    if (new Set(list).size !== list.length) miss(`${name} names a listing twice`);
    for (const id of list) if (!onChain.includes(id)) miss(`${name} names listing ${id}, which is not a listing of ${hash} on the chain`);
  }
  for (const id of onChain) {
    const n = (counted.includes(id) ? 1 : 0) + (apart.includes(id) ? 1 : 0);
    if (n === 0) miss(`listing ${id} is on the chain and neither on the site's record nor apart from it`);
    if (n === 2) miss(`listing ${id} is both on the site's record and apart from it`);
  }

  // 5. the record, field for field, and the listings apart
  const expected = partition(chain, new Set(counted));
  for (const dif of differences(expected.record, view.record, "record", [])) miss(dif);
  for (const l of view.notCounted.listings) {
    const c = chain.listings.find((x) => String(x.listingId) === String(l.listingId));
    if (!c) continue;
    for (const k of ["maker", "state", "lapsed"]) if (!same(c[k], l[k])) miss(`notCounted listing ${l.listingId}.${k}: the chain ${JSON.stringify(c[k])}, the site ${JSON.stringify(l[k])}`);
  }
  for (const dif of differences(expected.findings, view.notCounted.findings, "notCounted.findings", [])) miss(dif);
  for (const dif of differences(expected.flags, view.notCounted.flags, "notCounted.flags", [])) miss(dif);

  // 6. the artifact the site names is the one the hash is of
  const art = view.artifact;
  if (!art || typeof art !== "object") miss("the site names no artifact for the record");
  else {
    if (art.kind !== chain.kind) miss(`artifact.kind: the chain ${chain.kind}, the site ${art.kind}`);
    try {
      const kind = ENUMS.ArtifactKind.indexOf(art.kind);
      if (kind < 0) throw new Error(`kind ${art.kind}`);
      const raw = await rpc("eth_call", [{ to: d.address, data: d.iface.encodeFunctionData("artifactHashOf", [[kind, art.repo, art.baseCommit, BigInt(art.chainId), art.address]]) }, { blockHash: block.hash, requireCanonical: true }]);
      const of = d.iface.decodeFunctionResult("artifactHashOf", raw)[0];
      if (of.toLowerCase() !== hash) miss(`the site's artifact (${art.repo} at ${art.baseCommit}) hashes to ${of}, not ${hash}`);
    } catch (err) {
      miss(`the site's artifact could not be hashed: ${redact(err.message)}`);
    }
  }

  if (misses.length) return finish();
  log(`OK ${hash}: the site's record at block ${block.number} (${block.hash}) agrees with recordByHash on every fact both carry: `
    + `${onChain.length} listing(s), ${counted.length} counted and ${apart.length} apart; ${chain.findings.length} finding(s); ${chain.flags.length} flag(s)`);
  return finish();
}

if (require.main === module) {
  run({ argv: process.argv.slice(2) }).then((code) => { process.exitCode = code; }, (err) => {
    console.error(`FAIL: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}

module.exports = { ENUMS, run, partition, differences, toJson };
