// Shared fixtures for the reputation v2 tests.
const { ethers } = require("hardhat");

const abi = ethers.AbiCoder.defaultAbiCoder();
const T = { NONE: 0, DELIVERED: 1, MISS_FINISHED: 2, MISS_FAILED: 3, NOCOMMIT_FAILED: 4 };
const Q = { NONE: 0, CLOSE: 1, OFF: 2, FAR: 3 };
const COMMITTED = 0x80;
const code = (t, q = 0, committed = false) => t | (q << 4) | (committed ? COMMITTED : 0);
const STAKE = 100n * 10n ** 18n;
const FEE = 10n ** 13n;
const MAX_FEE = 8n * 10n ** 13n;
const BASE_COST = 8n * 10n ** 9n;
const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";   // EIP-2935
/** a likelihood pair on the arbiters' 0..1,000,000 scale */
const vec = (accept) => [BigInt(accept), 1_000_000n - BigInt(accept)];

/** Hash chain: chain[0] = seed, chain[i] = keccak(chain[i-1]); head = chain[L]. */
function makeChain(L = 64) {
  const c = [ethers.hexlify(ethers.randomBytes(32))];
  for (let i = 1; i <= L; i++) c.push(ethers.keccak256(c[i - 1]));
  return {
    chain: c, used: 0, head: c[L],
    /** the next value, which answers the keeper's current head */
    next() { this.used++; return this.chain[L - this.used]; },
    /** the value that hashes to `head` */
    preimageOf(head) { const i = this.chain.indexOf(head); if (i < 1) throw new Error("not on chain"); return this.chain[i - 1]; },
  };
}

async function deployCore({ withAggregator = true } = {}) {
  const [deployer] = await ethers.getSigners();
  const link = await (await ethers.getContractFactory("MockLinkToken")).deploy(10n ** 27n);
  const token = await (await ethers.getContractFactory("TestToken")).deploy();
  const keeper = await (await ethers.getContractFactory("ReputationKeeper")).deploy(await token.getAddress());
  let agg = null, aggLib = null, scoring = null, beacons = null;
  if (withAggregator) {
    aggLib = await (await ethers.getContractFactory("AggregatorLib")).deploy();
    scoring = await (await ethers.getContractFactory("ScoringLib")).deploy();
    const F = await ethers.getContractFactory("ReputationAggregator", {
      libraries: { AggregatorLib: await aggLib.getAddress(), ScoringLib: await scoring.getAddress() },
    });
    agg = await F.deploy(await link.getAddress(), await keeper.getAddress());
    await keeper.setApproved(await agg.getAddress(), true);
    // item 9's beacon stage lives in its own contract: the keeper approves it, it approves the aggregator
    beacons = await (await ethers.getContractFactory("JuryBeacons")).deploy(await keeper.getAddress());
    await keeper.setApproved(await beacons.getAddress(), true);
    await beacons.setApproved(await agg.getAddress(), true);
    await agg.setContracts(await keeper.getAddress(), await beacons.getAddress(), deployer.address);
  }
  await token.approve(await keeper.getAddress(), ethers.MaxUint256);
  return { deployer, link, token, keeper, agg, aggLib, scoring, beacons };
}

/**
 * Register `n` arbiters in `cls`. Each gets its own TestOperator (distinct payee owner), a node
 * signer from `nodes`, and a hash chain. `jobsPerOperator` > 1 reuses operators (for big pools).
 * `gate` (default on) makes each operator require keeper.isContractApproved(requester), as
 * ArbiterOperator does on mainnet.
 */
async function registerArbiters(core, n, { cls = 1, nodes, jobsPerOperator = 1, fee = FEE, gate = true } = {}) {
  const signers = await ethers.getSigners();
  nodes = nodes || signers.slice(10, 40);
  const OpF = await ethers.getContractFactory("TestOperator");
  const arbs = [];
  let op = null;
  for (let i = 0; i < n; i++) {
    const node = nodes[i % nodes.length];
    if (i % jobsPerOperator === 0) {
      const ownerAddr = ethers.Wallet.createRandom().address;   // distinct payee per operator
      op = await OpF.deploy(await core.link.getAddress(), ownerAddr, node.address);
      if (gate) await op.setGate(await core.keeper.getAddress());   // as ArbiterOperator's keeper list
    }
    const jobId = ethers.zeroPadValue(ethers.toBeHex(i + 1), 32);
    const ch = makeChain();
    await core.keeper.registerArbiter(await op.getAddress(), jobId, fee, [cls], ch.head);
    const key = await core.keeper.keyOf(await op.getAddress(), jobId);
    arbs.push({ op, opAddr: await op.getAddress(), jobId, key, node, ch });
  }
  return arbs;
}

/** The reveal's salt field: 32 hex chars, a 128-bit salt (items 4 and 5). */
function saltHex(salt) {
  return BigInt(salt).toString(16).padStart(32, "0");
}
/** The commit (items 4 and 5): keccak256(abi.encode(aggId, operator, response, salt)), all 32 bytes. */
function commitWord(aggId, operatorAddr, reveal, salt) {
  const enc = abi.encode(["bytes32", "address", "uint256[]", "uint256"], [aggId, operatorAddr, reveal, salt]);
  return BigInt(ethers.keccak256(enc));
}

/** Install MockHistory at the EIP-2935 address (Hardhat's stub reverts). */
async function installHistory() {
  const { network } = require("hardhat");
  const m = await (await ethers.getContractFactory("MockHistory")).deploy();
  const code = await ethers.provider.getCode(await m.getAddress());
  await network.provider.send("hardhat_setCode", [HISTORY, code]);
  return ethers.getContractAt("MockHistory", HISTORY);
}

/** Copy block n's real hash into the history mock. */
async function recordHash(history, n) {
  const b = await ethers.provider.getBlock(Number(n));
  await history.set(n, b.hash);
}

/** OracleRequest events emitted by any TestOperator in a receipt. */
function oracleRequests(receipt) {
  const iface = new ethers.Interface([
    "event OracleRequest(bytes32 indexed specId, address requester, bytes32 requestId, uint256 payment, address callbackAddr, bytes4 callbackFunctionId, uint256 cancelExpiration, uint256 dataVersion, bytes data)",
  ]);
  const out = [];
  for (const l of receipt.logs) {
    try {
      const p = iface.parseLog({ topics: [...l.topics], data: l.data });
      if (p && p.name === "OracleRequest") out.push({ operator: l.address, ...p.args.toObject() });
    } catch (_) {}
  }
  return out;
}

/** Fulfil a request through its operator, as the arbiter's node would. */
async function fulfil(req, node, response, cid) {
  const op = await ethers.getContractAt("TestOperator", req.operator);
  const data = abi.encode(["bytes32", "uint256[]", "string"], [req.requestId, response, cid]);
  return op.connect(node).fulfillOracleRequest2(
    req.requestId, req.payment, req.callbackAddr, req.callbackFunctionId, req.cancelExpiration, data,
    { gasLimit: 16_000_000 }
  );
}

module.exports = {
  abi, T, Q, COMMITTED, code, STAKE, FEE, MAX_FEE, BASE_COST, HISTORY, vec,
  makeChain, deployCore, registerArbiters, saltHex, commitWord, oracleRequests, fulfil, installHistory, recordHash,
};
