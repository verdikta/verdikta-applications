/**
 * Hunter connection analysis: which hunter addresses are linked on chain.
 *
 * RPC-only (no indexer is available for Base mainnet from this host), so it
 * looks for links that plain JSON-RPC can find cheaply:
 *
 *   1. Parent account: who first funded each hunter EOA (the first block where
 *      balance > 0 or nonce > 0 is found by archive binary search; that
 *      block's transfer to the address names the funder; for ETH moved by a
 *      contract call, the candidate whose balance fell by the amount received,
 *      so relayed smart-account transfers credit the account, not the relayer).
 *      For smart-wallet hunters: the wallet's address owners, else whoever sent
 *      the transaction that created it.
 *   2. "funded"         - a hunter's parent is another hunter.
 *   3. "shared-funder"  - two or more hunters have the same parent. Funders
 *      with HUB_NONCE+ transactions (exchanges, faucets, bridge relayers) link
 *      unrelated people, so they are reported as hubs and never join groups.
 *      A common smart-wallet owner always links (relation: 'owner').
 *   4. "token-transfer" - any ERC-20/721 Transfer log between two hunters.
 *
 * Not detected: plain ETH sends between hunters after their first funding
 * (no RPC call lists an address's transactions), and ETH moved by a contract
 * whose call data does not contain the recipient.
 *
 * Results are cached in data/<network>/hunterLinks.json and refreshed by a
 * background run; readers never wait on RPC.
 */

const fs = require('fs').promises;
const path = require('path');
const { ethers } = require('ethers');
const { config } = require('../config');
const logger = require('./logger');

const NETWORK = config.network || 'base-sepolia';
const STATE_FILE = path.join(__dirname, `../data/${NETWORK}/hunterLinks.json`);
const STATE_VERSION = 1;

// Keyless archive gateways (historical balance/nonce/code). getLogs is capped
// at 1000 blocks there, so log scans default to the main RPC (Infura: 10k).
const DEFAULT_ARCHIVE_RPC = {
  base: 'https://base.gateway.tenderly.co',
  'base-sepolia': 'https://base-sepolia.gateway.tenderly.co'
};

const HUB_NONCE = parseInt(process.env.HUNTER_LINKS_HUB_NONCE, 10) || 1000;
const FUNDER_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIRMATIONS = 5;
const MAX_LOG_CHUNK = 10000;
const MIN_LOG_CHUNK = 250;
const LOG_PARALLEL = 4;
const ADDRESS_PARALLEL = 4;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const lc = (a) => (a || '').toLowerCase();
const hex = (n) => '0x' + n.toString(16);
const padTopic = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
const topicToAddress = (t) => lc('0x' + t.slice(-40));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// RPC
// ------------------------------------------------------------

function makeRpc(url) {
  const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
  return {
    async send(method, params, attempts = 4) {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        try {
          return await provider.send(method, params);
        } catch (err) {
          lastErr = err;
          if (isRangeError(err)) throw err; // caller shrinks the range instead
          await sleep(500 * 2 ** i);
        }
      }
      throw lastErr;
    }
  };
}

function isRangeError(err) {
  const msg = `${err?.shortMessage || ''} ${err?.message || ''} ${err?.error?.message || ''}`.toLowerCase();
  return /range|too many|limit|exceed|10000|1000 block|coalesce|response size|query returned more/.test(msg);
}

// ------------------------------------------------------------
// Parent account per hunter
// ------------------------------------------------------------

/** Lowest block in [lo, hi] where pred is true; pred must be monotonic. */
async function firstBlockWhere(pred, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Contract wallet, as opposed to an EOA (EIP-7702 delegated EOAs carry 0xef0100 code). */
function isContractCode(code) {
  return !!code && code !== '0x' && !lc(code).startsWith('0xef0100');
}

/**
 * Who first funded (EOA) or created (contract) `address`.
 * Returns { kind, parent, via, parentTx, parentBlock }; parent is null when unknown.
 *   via: 'direct' | 'deposit' (L1 bridge deposit tx) | 'contract-call' (address in a
 *        contract call's data) | 'creation' | 'unknown' | 'none' (never funded)
 */
async function findParent(rpc, address, latest) {
  const addr = lc(address);
  const code = await rpc.send('eth_getCode', [addr, hex(latest)]);

  if (isContractCode(code)) {
    const b = await firstBlockWhere(
      async (n) => isContractCode(await rpc.send('eth_getCode', [addr, hex(n)])), 0, latest);
    const receipts = await rpc.send('eth_getBlockReceipts', [hex(b)]) || [];
    const padded = padTopic(addr);
    const r = receipts.find((x) => lc(x.contractAddress) === addr)
      || receipts.find((x) => (x.logs || []).some((l) => lc(l.address) === addr || (l.topics || []).some((t) => lc(t) === padded)));
    // Smart wallets are usually deployed by a bundler or relayer; their owners
    // are the meaningful parent accounts.
    const owners = await walletOwners(rpc, addr);
    if (owners.length) {
      return { kind: 'contract', parent: owners[0], owners, via: 'owner', parentTx: r?.transactionHash || null, parentBlock: b };
    }
    return { kind: 'contract', parent: r ? lc(r.from) : null, via: r ? 'creation' : 'unknown', parentTx: r?.transactionHash || null, parentBlock: b };
  }

  // Monotonic for EOAs: balance can only fall to zero via an own tx, which bumps the nonce.
  const touched = async (n) => {
    const [bal, nonce] = await Promise.all([
      rpc.send('eth_getBalance', [addr, hex(n)]),
      rpc.send('eth_getTransactionCount', [addr, hex(n)])
    ]);
    return BigInt(bal) > 0n || BigInt(nonce) > 0n;
  };
  if (!(await touched(latest))) {
    return { kind: 'eoa', parent: null, via: 'none', parentTx: null, parentBlock: null };
  }
  const b = await firstBlockWhere(touched, 0, latest);
  const block = await rpc.send('eth_getBlockByNumber', [hex(b), true]);
  const txs = block?.transactions || [];
  const direct = txs.find((t) => lc(t.to) === addr && BigInt(t.value || 0) > 0n);
  if (direct) {
    return { kind: 'eoa', parent: lc(direct.from), via: direct.type === '0x7e' ? 'deposit' : 'direct', parentTx: direct.hash, parentBlock: b };
  }
  // ETH sent by a contract (disperse tools, bridge fills): the recipient is usually in the call data.
  const bare = addr.slice(2);
  const viaCall = txs.find((t) => lc(t.input).includes(bare));
  if (viaCall) {
    const sender = await resolveEthSender(rpc, addr, viaCall, b);
    const rec = { kind: 'eoa', parent: sender, via: 'contract-call', parentTx: viaCall.hash, parentBlock: b };
    if (sender !== lc(viaCall.from)) rec.relayer = lc(viaCall.from);
    return rec;
  }
  return { kind: 'eoa', parent: null, via: 'unknown', parentTx: null, parentBlock: b };
}

const ABI = ethers.AbiCoder.defaultAbiCoder();
const selector = (sig) => ethers.id(sig).slice(0, 10);
const MAX_OWNER_SLOTS = 10;

async function tryCall(rpc, to, data) {
  try {
    const out = await rpc.send('eth_call', [{ to, data }, 'latest'], 2);
    return out && out !== '0x' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Address owners of a smart wallet: Coinbase Smart Wallet (ownerAtIndex; passkey
 * owners have no address and are skipped), Safe (getOwners), or Ownable (owner).
 */
async function walletOwners(rpc, wallet) {
  const owners = [];
  const next = await tryCall(rpc, wallet, selector('nextOwnerIndex()'));
  if (next) {
    const n = Math.min(Number(BigInt(next)), MAX_OWNER_SLOTS);
    for (let i = 0; i < n; i++) {
      const out = await tryCall(rpc, wallet, selector('ownerAtIndex(uint256)') + ABI.encode(['uint256'], [i]).slice(2));
      if (!out) continue;
      try {
        const [bytes] = ABI.decode(['bytes'], out);
        if (ethers.dataLength(bytes) === 32) owners.push(lc(ABI.decode(['address'], bytes)[0]));
      } catch { /* removed or passkey owner */ }
    }
    return [...new Set(owners)];
  }
  const safe = await tryCall(rpc, wallet, selector('getOwners()'));
  if (safe) {
    try { return [...new Set(ABI.decode(['address[]'], safe)[0].map(lc))]; } catch { /* not a Safe */ }
  }
  const own = await tryCall(rpc, wallet, selector('owner()'));
  if (own && ethers.dataLength(own) === 32) {
    const o = lc(ABI.decode(['address'], own)[0]);
    if (o !== ethers.ZeroAddress) return [o];
  }
  return [];
}

/** Address-shaped 32-byte words in call data (high bytes zero, value large enough to not be a length or offset). */
function addressesInCalldata(input) {
  const data = lc(input).slice(10);
  const out = new Set();
  for (let i = 0; i + 64 <= data.length; i += 64) {
    const word = data.slice(i, i + 64);
    if (word.startsWith('000000000000000000000000') && BigInt('0x' + word) >= 2n ** 120n) out.add('0x' + word.slice(24));
  }
  return [...out];
}

/**
 * ETH moved by a contract call: the real sender is whichever candidate (call
 * target, addresses in the call data, tx sender) lost at least the amount the
 * recipient gained in that block. Relayed smart-account (EIP-7702 / 4337)
 * transfers credit the account, not the relayer. Falls back to tx.from.
 */
async function resolveEthSender(rpc, recipient, tx, block) {
  const bal = async (a, n) => BigInt(await rpc.send('eth_getBalance', [a, hex(n)]));
  const received = (await bal(recipient, block)) - (await bal(recipient, block - 1));
  if (received <= 0n) return lc(tx.from);
  const from = lc(tx.from);
  const candidates = [...new Set([lc(tx.to), ...addressesInCalldata(tx.input)])]
    .filter((c) => c && c !== recipient && c !== from && c !== ethers.ZeroAddress)
    .slice(0, 30);
  let best = null;
  for (const c of candidates) {
    const drop = (await bal(c, block - 1)) - (await bal(c, block));
    if (drop >= received && (!best || drop < best.drop)) best = { c, drop };
  }
  return best ? best.c : from;
}

async function describeFunder(rpc, address) {
  const [nonce, code] = await Promise.all([
    rpc.send('eth_getTransactionCount', [address, 'latest']),
    rpc.send('eth_getCode', [address, 'latest'])
  ]);
  const n = Number(BigInt(nonce));
  const contract = isContractCode(code);
  return { nonce: n, isContract: contract, hub: contract || n >= HUB_NONCE, checkedAt: Date.now() };
}

// ------------------------------------------------------------
// Token transfers between hunters
// ------------------------------------------------------------

/**
 * Transfer logs in [from, to] whose topics match; shrinks the chunk on range
 * errors. onProgress(lastBlockDone) is called after each batch of chunks.
 */
async function scanTransfers(rpc, fromTopics, toTopics, from, to, onProgress) {
  const found = [];
  let chunk = MAX_LOG_CHUNK;
  let start = from;
  while (start <= to) {
    const ranges = [];
    for (let i = 0, s = start; i < LOG_PARALLEL && s <= to; i++, s += chunk) {
      ranges.push([s, Math.min(s + chunk - 1, to)]);
    }
    try {
      const results = await Promise.all(ranges.map(([a, b]) => rpc.send('eth_getLogs', [{
        fromBlock: hex(a), toBlock: hex(b), topics: [TRANSFER_TOPIC, fromTopics, toTopics]
      }])));
      for (const logs of results) found.push(...logs);
      start = ranges[ranges.length - 1][1] + 1;
      if (onProgress) await onProgress(start - 1, found);
    } catch (err) {
      if (!isRangeError(err) || chunk <= MIN_LOG_CHUNK) throw err;
      chunk = Math.max(MIN_LOG_CHUNK, Math.floor(chunk / 2));
    }
  }
  return found;
}

function toTransfer(log) {
  return {
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    token: lc(log.address),
    txHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)),
    block: Number(BigInt(log.blockNumber))
  };
}

async function tokenSymbol(rpc, token) {
  try {
    const data = await rpc.send('eth_call', [{ to: token, data: '0x95d89b41' }, 'latest'], 2);
    const [sym] = ethers.AbiCoder.defaultAbiCoder().decode(['string'], data);
    return String(sym).slice(0, 16);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// State
// ------------------------------------------------------------

function emptyState() {
  return { version: STATE_VERSION, network: NETWORK, addresses: {}, funders: {}, tokens: {},
    transfers: [], tokenScan: { covered: [], cursor: null }, lastRunAt: null, lastError: null };
}

async function readState(file = STATE_FILE) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return s.version === STATE_VERSION ? s : emptyState();
  } catch {
    return emptyState();
  }
}

async function writeState(state, file = STATE_FILE) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------

const status = { running: false, phase: null, done: 0, total: 0, startedAt: null };

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

/**
 * One incremental pass over `hunterAddresses`. `rpcs` = { state, logs }.
 * Parents are permanent once found; funders are rechecked weekly; the token
 * scan moves forward from its cursor and backfills newly seen hunters.
 */
async function runAnalysis(hunterAddresses, rpcs, { file = STATE_FILE } = {}) {
  if (status.running) return { skipped: true };
  Object.assign(status, { running: true, phase: 'parents', done: 0, total: 0, startedAt: Date.now() });
  const state = await readState(file);
  try {
    const hunters = [...new Set(hunterAddresses.map(lc).filter(Boolean))];
    const latest = Number(BigInt(await rpcs.state.send('eth_blockNumber', []))) - CONFIRMATIONS;

    // 1. Parents for hunters not analyzed yet (or whose earlier lookup failed)
    const todo = hunters.filter((a) => !state.addresses[a] || state.addresses[a].error);
    status.total = todo.length;
    let sinceSave = 0;
    await mapLimit(todo, ADDRESS_PARALLEL, async (a) => {
      try {
        state.addresses[a] = { ...(await findParent(rpcs.state, a, latest)), analyzedAt: Date.now() };
      } catch (err) {
        state.addresses[a] = { error: err.shortMessage || err.message, analyzedAt: Date.now() };
      }
      status.done++;
      if (++sinceSave >= 10) { sinceSave = 0; await writeState(state, file); }
    });

    // 2. Funder size, to tell personal wallets from exchanges/faucets/bridges
    status.phase = 'funders';
    const funders = [...new Set(hunters.flatMap((a) => [state.addresses[a]?.parent, ...(state.addresses[a]?.owners || [])]).filter(Boolean))]
      .filter((f) => !state.funders[f] || Date.now() - state.funders[f].checkedAt > FUNDER_RECHECK_MS);
    Object.assign(status, { done: 0, total: funders.length });
    await mapLimit(funders, ADDRESS_PARALLEL, async (f) => {
      try { state.funders[f] = await describeFunder(rpcs.state, f); } catch (err) {
        logger.warn('[hunterLinks] funder lookup failed', { funder: f, msg: err.message });
      }
      status.done++;
    });
    await writeState(state, file);

    // 3. Token transfers between hunters
    status.phase = 'transfers';
    const seen = new Set(state.transfers.map((t) => `${t.txHash}:${t.logIndex}`));
    const addLogs = (logs) => {
      for (const log of logs) {
        const t = toTransfer(log);
        const key = `${t.txHash}:${t.logIndex}`;
        if (!seen.has(key)) { seen.add(key); state.transfers.push(t); }
      }
    };
    const firstBlockOf = (list) => {
      const blocks = list.map((a) => state.addresses[a]?.parentBlock).filter((b) => Number.isFinite(b));
      return blocks.length ? Math.min(...blocks) : null;
    };
    // A hunter is "covered" once its whole history since first funding has been
    // scanned. Failed parent lookups stay uncovered so a later run backfills them.
    const all = hunters.map(padTopic);
    const analyzedOk = (a) => state.addresses[a] && !state.addresses[a].error;
    const covered = new Set(state.tokenScan.covered);
    const fresh = hunters.filter((a) => !covered.has(a) && analyzedOk(a));

    if (state.tokenScan.cursor == null) {
      // First scan: from the earliest hunter activity
      const start = firstBlockOf(hunters);
      state.tokenScan = { covered: hunters.filter(analyzedOk), cursor: start == null ? latest : start - 1 };
    } else if (fresh.length) {
      // Backfill hunters seen for the first time, up to the existing cursor
      const start = firstBlockOf(fresh);
      if (start != null && start <= state.tokenScan.cursor) {
        const freshTopics = fresh.map(padTopic);
        addLogs(await scanTransfers(rpcs.logs, freshTopics, all, start, state.tokenScan.cursor));
        addLogs(await scanTransfers(rpcs.logs, all, freshTopics, start, state.tokenScan.cursor));
      }
      state.tokenScan.covered = [...covered, ...fresh];
    }

    const from = state.tokenScan.cursor + 1;
    Object.assign(status, { done: 0, total: Math.max(0, latest - from + 1) });
    let batches = 0;
    if (from <= latest) {
      await scanTransfers(rpcs.logs, all, all, from, latest, async (doneTo, logs) => {
        addLogs(logs.splice(0));
        state.tokenScan.cursor = doneTo;
        status.done = doneTo - from + 1;
        if (++batches % 25 === 0) await writeState(state, file);
      });
    }

    for (const t of state.transfers) {
      if (!(t.token in state.tokens)) state.tokens[t.token] = await tokenSymbol(rpcs.state, t.token);
    }

    state.lastRunAt = Date.now();
    state.lastError = null;
    await writeState(state, file);
    return { skipped: false };
  } catch (err) {
    state.lastError = err.shortMessage || err.message;
    await writeState(state, file).catch(() => {});
    throw err;
  } finally {
    Object.assign(status, { running: false, phase: null });
  }
}

// ------------------------------------------------------------
// Connections (read time)
// ------------------------------------------------------------

/**
 * Groups of linked hunters from the cached state.
 * Returns { groups, hubs, groupOf, coverage }.
 */
function buildConnections(state, hunterAddresses) {
  const hunters = [...new Set(hunterAddresses.map(lc).filter(Boolean))];
  const H = new Set(hunters);
  const parentOf = (a) => state.addresses[a] || {};

  const root = new Map(hunters.map((a) => [a, a]));
  const find = (a) => { while (root.get(a) !== a) { root.set(a, root.get(root.get(a))); a = root.get(a); } return a; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) root.set(ra, rb); };

  const links = [];

  // Parent accounts: every address owner of a smart wallet, else the funder/creator
  const parentsOf = (a) => {
    const p = parentOf(a);
    if (p.via === 'owner' && Array.isArray(p.owners)) return p.owners.map((o) => ({ parent: o, via: 'owner', txHash: p.parentTx }));
    return p.parent ? [{ parent: p.parent, via: p.via, txHash: p.parentTx }] : [];
  };

  // Funded (or owned) directly by another hunter
  for (const a of hunters) {
    for (const p of parentsOf(a)) {
      if (H.has(p.parent) && p.parent !== a) {
        links.push({ type: 'funded', from: p.parent, to: a, via: p.via, txHash: p.txHash });
        union(p.parent, a);
      }
    }
  }

  // Same parent (not itself a hunter). Funders with HUB_NONCE+ txs are hubs and
  // link nobody; an owner is a direct control relationship, so owners never are.
  const byParent = new Map();
  for (const a of hunters) {
    for (const p of parentsOf(a)) {
      if (H.has(p.parent)) continue;
      if (!byParent.has(p.parent)) byParent.set(p.parent, []);
      byParent.get(p.parent).push({ address: a, via: p.via, txHash: p.txHash });
    }
  }
  const hubs = [];
  for (const [funder, members] of byParent) {
    if (members.length < 2) continue;
    const info = state.funders[funder];
    const ownerOnly = members.every((m) => m.via === 'owner');
    if (!ownerOnly && (!info || info.hub)) {
      hubs.push({ funder, hunters: members.length, nonce: info?.nonce ?? null, isContract: info?.isContract ?? null, unchecked: !info });
      continue;
    }
    links.push({ type: 'shared-funder', relation: ownerOnly ? 'owner' : 'funder', funder, funderNonce: info?.nonce ?? null, members });
    for (const m of members.slice(1)) union(members[0].address, m.address);
  }

  // Token transfers between hunters (one link per pair and token)
  const pairs = new Map();
  for (const t of state.transfers || []) {
    if (!H.has(t.from) || !H.has(t.to) || t.from === t.to) continue;
    const key = `${t.from}>${t.to}>${t.token}`;
    const e = pairs.get(key) || { type: 'token-transfer', from: t.from, to: t.to, token: t.token,
      symbol: state.tokens?.[t.token] || null, count: 0, txHash: t.txHash, lastBlock: 0 };
    e.count++;
    if (t.block >= e.lastBlock) { e.lastBlock = t.block; e.txHash = t.txHash; }
    pairs.set(key, e);
    union(t.from, t.to);
  }
  links.push(...pairs.values());

  // Assemble groups
  const members = new Map();
  for (const a of hunters) {
    const r = find(a);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(a);
  }
  const groupsRaw = [...members.values()].filter((m) => m.length > 1);
  const linkAddrs = (l) => (l.type === 'shared-funder' ? l.members.map((m) => m.address) : [l.from, l.to]);
  const groups = groupsRaw
    .map((addrs) => {
      const set = new Set(addrs);
      return { addresses: addrs, links: links.filter((l) => set.has(linkAddrs(l)[0])) };
    })
    .sort((a, b) => b.addresses.length - a.addresses.length || a.addresses[0].localeCompare(b.addresses[0]))
    .map((g, i) => ({ id: i + 1, ...g }));

  const groupOf = {};
  for (const g of groups) for (const a of g.addresses) groupOf[a] = g.id;

  const analyzed = hunters.filter((a) => state.addresses[a] && !state.addresses[a].error);
  return {
    groups,
    hubs: hubs.sort((a, b) => b.hunters - a.hunters),
    groupOf,
    coverage: {
      hunters: hunters.length,
      analyzed: analyzed.length,
      parentKnown: analyzed.filter((a) => state.addresses[a].parent).length,
      neverFunded: analyzed.filter((a) => state.addresses[a].via === 'none').length,
      linkedHunters: Object.keys(groupOf).length,
      tokenScanThroughBlock: state.tokenScan?.cursor ?? null,
      hubNonceThreshold: HUB_NONCE,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError
    }
  };
}

// ------------------------------------------------------------
// Background service
// ------------------------------------------------------------

let timer = null;

function startHunterLinksService(getHunterAddresses) {
  if (process.env.HUNTER_LINKS_ENABLED === 'false') {
    logger.info('[hunterLinks] disabled via HUNTER_LINKS_ENABLED=false');
    return;
  }
  const archiveUrl = process.env.HUNTER_LINKS_ARCHIVE_RPC_URL || DEFAULT_ARCHIVE_RPC[NETWORK];
  const logsUrl = process.env.HUNTER_LINKS_LOGS_RPC_URL || config.rpcUrl;
  if (!archiveUrl || !logsUrl) {
    logger.warn('[hunterLinks] no archive/log RPC for network; not starting', { network: NETWORK });
    return;
  }
  const rpcs = { state: makeRpc(archiveUrl), logs: makeRpc(logsUrl) };
  const hours = parseFloat(process.env.HUNTER_LINKS_INTERVAL_HOURS) || 6;

  const tick = async () => {
    try {
      const t0 = Date.now();
      const res = await runAnalysis(await getHunterAddresses(), rpcs);
      if (!res.skipped) logger.info('[hunterLinks] analysis complete', { ms: Date.now() - t0 });
    } catch (err) {
      logger.error('[hunterLinks] analysis failed', { msg: err.shortMessage || err.message });
    }
  };
  setTimeout(tick, 2 * 60 * 1000).unref();
  timer = setInterval(tick, hours * 60 * 60 * 1000);
  timer.unref();
  logger.info('[hunterLinks] service started', { intervalHours: hours, hubNonce: HUB_NONCE });
}

function getStatus() {
  return { ...status };
}

module.exports = {
  startHunterLinksService,
  runAnalysis,
  buildConnections,
  readState,
  getStatus,
  // exported for tests
  findParent,
  firstBlockWhere,
  addressesInCalldata,
  isContractCode,
  STATE_FILE
};
