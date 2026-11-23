// Writes test/fixtures/scoring-lib.vectors.json: the v2 aggregator's own answers (verdikta-dispatcher,
// `beacon` branch, reputationBasedAggregator/contracts/ScoringLib.sol and AggregatorLib.sol) for the cases
// test/aggregatorRound.test.js holds src/aggregatorRound.js to. It deploys both libraries from the
// dispatcher's compiled artifacts on Hardhat's in-process network and calls their public functions.
//
//   cd stake-attestation/onchain
//   DISPATCHER=/path/to/verdikta-dispatcher npx hardhat run --no-compile ../e2e/test/fixtures/gen-scoring-vectors.cjs
//
// DISPATCHER_COMMIT names the commit the artifacts were built at (recorded in the file).
const fs = require('fs');
const path = require('path');
// hardhat is onchain's (the cwd's), not this package's
const hre = require(require.resolve('hardhat', { paths: [process.cwd()] }));

const { ethers } = hre;
const DISPATCHER = process.env.DISPATCHER;
if (!DISPATCHER) throw new Error('Set DISPATCHER to a verdikta-dispatcher checkout with compiled artifacts');
const art = (name) => JSON.parse(fs.readFileSync(path.join(DISPATCHER, 'reputationBasedAggregator', 'artifacts', 'contracts', `${name}.sol`, `${name}.json`), 'utf8'));

// A small deterministic generator (xorshift32), so the cases are the same on every run.
let state = 0x9e3779b9;
const rand = (n) => {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state % n;
};
const s = (v) => v.map((x) => x.map((y) => y.toString()));

async function main() {
  const [signer] = await ethers.getSigners();
  const deploy = async (name) => {
    const a = art(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy();
    await c.waitForDeployment();
    return c;
  };
  const scoring = await deploy('ScoringLib');
  const agg = await deploy('AggregatorLib');

  const bestCluster = [];
  const hand = [
    { v: [[0, 0, 0, 0, 700000, 300000], [0, 0, 0, 0, 700000, 300000], [0, 0, 0, 0, 700000, 300000]], p: 2 },
    { v: [[0, 0, 0, 0, 1000000, 0], [0, 0, 0, 0, 700000, 300000], [0, 0, 0, 0, 700001, 299999]], p: 2 },
    { v: [[1000000, 0], [0, 1000000], [1000000, 0]], p: 2 },
    { v: [[1, 0], [3, 0], [5, 0]], p: 2 },
    { v: [[1, 0], [2, 0], [50, 0], [60, 0]], p: 3 },
    { v: [[0, 10], [0, 11], [0, 12], [100, 0]], p: 3 },
    { v: [[5], [1], [9], [2]], p: 3 },
    { v: [[7], [7], [7], [7]], p: 3 },
    { v: [[100], [0], [50], [51], [49]], p: 3 },
    { v: [[0, 0], [10, 10], [0, 0], [10, 10]], p: 2 },
  ];
  for (const h of hand) bestCluster.push({ v: s(h.v), p: h.p });
  for (let t = 0; t < 30; t += 1) {
    const n = 2 + rand(7);
    const len = rand(3) === 0 ? 1 : 2 + rand(5);
    const spreadOf = [3, 1000, 1000000][rand(3)];
    const v = Array.from({ length: n }, () => Array.from({ length: len }, () => rand(spreadOf)));
    bestCluster.push({ v: s(v), p: 2 + rand(n) });
  }
  for (const c of bestCluster) c.inCluster = [...await scoring.bestCluster(c.v, c.p)];

  const tieOrder = [];
  for (let t = 0; t < 8; t += 1) {
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`tie ${t}`));
    const ids = Array.from({ length: 1 + rand(7) }, () => rand(6));
    tieOrder.push({ seed, ids, perm: (await scoring.tieOrder(seed, ids)).map(Number) });
  }

  const aggregate = [];
  const aggHand = [
    { v: [[0, 0, 0, 0, 700000, 300000], [0, 0, 0, 0, 700001, 299999], [0, 0, 0, 0, 1000000, 0], [0, 0, 0, 0, 700000, 300000]], p: 3 },
    { v: [[0, 1000000], [500000], [0, 1000000], [500000]], p: 3 }, // a length tie: the longer wins
    { v: [[42], [41], [40], [1000000]], p: 3 },
    { v: [[1, 2, 3], [1, 2], [1, 2], [9, 9, 9]], p: 3 },
    { v: [[5, 5]], p: 3 },
    { v: [[0, 1000000], [0, 1000000], [1000000, 0], [1000000, 0]], p: 2 }, // a cluster tie: the seed decides
  ];
  for (const h of aggHand) aggregate.push({ v: s(h.v), p: h.p });
  for (let t = 0; t < 16; t += 1) {
    const n = 1 + rand(6);
    const len = rand(3) === 0 ? 1 : 2 + rand(4);
    const v = Array.from({ length: n }, () => Array.from({ length: rand(5) === 0 ? 1 + rand(5) : len }, () => rand([10, 1000000][rand(2)])));
    aggregate.push({ v: s(v), p: 2 + rand(4) });
  }
  for (let i = 0; i < aggregate.length; i += 1) {
    const c = aggregate[i];
    c.floor = '30000';
    c.seed = ethers.keccak256(ethers.toUtf8Bytes(`seed ${i}`));
    c.ids = c.v.map((_, k) => (k * 2 + i) % 7);
    const [inCl, out, codes, med, spread] = await scoring.aggregate(c.v, c.p, c.floor, c.seed, c.ids);
    Object.assign(c, { inCl: [...inCl], agg: out.map(String), codes: codes.map(Number), med: med.map(String), spread: spread.toString() });
  }

  const pickPromoted = [];
  for (let t = 0; t < 10; t += 1) {
    const k = 3 + rand(5);
    const committed = Array.from({ length: k }, () => rand(4) !== 0);
    const n = committed.filter(Boolean).length;
    if (n === 0) continue;
    const m = 1 + rand(n);
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`promote ${t}`));
    pickPromoted.push({ committed, m, seed, chosen: (await scoring.pickPromoted(committed, m, seed)).map(Number) });
  }

  const classifyOne = [];
  for (const [x, med, spread] of [[[10], [0], 10], [[16], [0], 10], [[30], [0], 10], [[31], [0], 10], [[1, 2, 3], [1, 2], 1], [[0, 0], [5, 9], 4]]) {
    classifyOne.push({ x: x.map(String), med: med.map(String), spread: String(spread), q: Number(await scoring.classifyOne(x, med, spread)) });
  }

  const parseCidSalt = [];
  const salt32 = 'be4cdf395cfcfd8b385f0123456789ab';
  for (const packed of [
    `QmUpload:${salt32}`, `Qm:with:colons:${salt32}`, `x:${salt32.toUpperCase()}`, `:${salt32}`, `QmUpload:${salt32.slice(1)}`,
    `QmUpload:${salt32}0`, `QmUpload-${salt32}`, `QmUpload:${salt32.slice(0, 31)}g`, '', 'QmUpload:be4cdf395cfcfd8b385f',
  ]) {
    const [ok, cid, salt] = await agg.parseCidSalt(packed);
    parseCidSalt.push({ packed, ok, cid, salt: salt.toString() });
  }

  const out = {
    source: {
      repository: 'verdikta-dispatcher',
      branch: 'beacon',
      commit: process.env.DISPATCHER_COMMIT || null,
      files: ['reputationBasedAggregator/contracts/ScoringLib.sol', 'reputationBasedAggregator/contracts/AggregatorLib.sol'],
      generator: 'e2e/test/fixtures/gen-scoring-vectors.cjs',
    },
    bestCluster, tieOrder, aggregate, pickPromoted, classifyOne, parseCidSalt,
  };
  const file = path.join(__dirname, 'scoring-lib.vectors.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${file}: ${bestCluster.length} clusters, ${aggregate.length} aggregates, ${pickPromoted.length} promotions`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
