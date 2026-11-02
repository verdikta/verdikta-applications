// The site's chain side (node P4b1): the indexer, the keeper, the listing feed, the record mirror
// and the badge, over one StakeAttestation deployment (config.chain). Everything the API shows is
// of one block, the indexer's cursor: the feed and the record are read on-chain at it (through
// the lens at the contract's address, with the merged ABI), and the history is the events
// indexed up to it. Reads are cached per block.
import { Contract, JsonRpcProvider, Network } from 'ethers';

import { STAKE_ATTESTATION_ABI } from '../chain/abi.js';
import { badgeFor, renderBadge } from '../record/badge.js';
import { listingLabels } from '../record/labels.js';
import { PriceError, readEthUsd } from '../record/price.js';
import { readRecord } from '../record/record.js';
import { refreshArchives } from './archives.js';
import { buildFeed } from './feed.js';
import { createIndexer } from './indexer.js';
import { createKeeper, keeperWallet } from './keeper.js';
import { feedEvents, listingOf, project, publicEvent } from './projection.js';
import { StateStore } from './store.js';

const DAY = 86400;
const CACHE_ENTRIES = 256;
const EVENTS_MAX = 1000;
const POSITION = /^([0-9]{1,15}):([0-9]{1,9})$/;

export class SiteError extends Error {
  constructor(code, detail, status = 503) {
    super(`${code}: ${detail}`);
    this.name = 'SiteError';
    this.code = code;
    this.status = status;
  }
}

/** The JSON-RPC provider for config.chain, its URL read from the environment now. */
export function createChainProvider(config, env = process.env) {
  const url = env[config.chain.rpcUrlEnv];
  if (typeof url !== 'string' || !url.trim()) throw new SiteError('RPC_URL_MISSING', `${config.chain.rpcUrlEnv} holds no RPC URL`);
  const network = Network.from(config.chain.chainId);
  return new JsonRpcProvider(url.trim(), network, { staticNetwork: network });
}

function lru() {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set(k, v) {
      m.set(k, v);
      if (m.size > CACHE_ENTRIES) m.delete(m.keys().next().value);
      return v;
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.config - loadConfig(); config.chain must be set
 * @param {import('ethers').Provider} o.provider
 * @param {Record<string, string|undefined>} [o.env] - where the keeper's key is read
 * @param {(cid: string) => Promise<Buffer>} o.fetchArchive - reads a listing archive by CID
 * @param {object} o.logger
 * @param {object} [o.keeperHooks]
 */
export function createSite({ config, provider, env = process.env, fetchArchive, logger, keeperHooks }) {
  const chain = config.chain;
  if (!chain) throw new TypeError('createSite needs config.chain (SA_CONTRACT_ADDRESS)');
  const store = new StateStore(chain.dataDir, { chainId: chain.chainId, address: chain.address, fromBlock: chain.fromBlock });
  const contract = new Contract(chain.address, STAKE_ATTESTATION_ABI, provider);
  const indexer = createIndexer({ provider, store, chain, logger });

  let projected = { key: null, value: null };
  const projection = () => {
    const key = `${store.state.cursor?.hash ?? 'none'}:${store.state.events.length}`;
    if (projected.key !== key) projected = { key, value: project(store.state.events) };
    return projected.value;
  };

  let keeper = null;
  let keeperError = null;
  if (config.keeper.enabled) {
    const { wallet, error } = keeperWallet(config.keeper, env);
    keeperError = error;
    if (wallet) keeper = createKeeper({ provider, store, chain, cfg: config.keeper, wallet, projection, logger, hooks: keeperHooks });
    else logger.warn(`keeper: off (${error}: ${config.keeper.keyEnv})`);
  }

  const status = { lastSync: null, syncError: null, lastKeep: null, keepError: null };
  const records = lru();
  const feeds = lru();
  const prices = lru();
  let discloseWindow = null;

  const cursorBlock = () => {
    const c = store.state.cursor;
    if (!c) throw new SiteError('NOT_INDEXED', 'the indexer has not read a block yet');
    return { number: c.number, hash: c.hash, timestamp: c.timestamp };
  };

  async function chainRead(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SiteError) throw err;
      logger.warn(`site: a chain read failed (${err?.code ?? err?.message ?? err})`);
      throw new SiteError('CHAIN_UNAVAILABLE', 'the chain could not be read');
    }
  }

  /** ETH/USD at a block, or why there is none. */
  async function priceAt(block) {
    const cached = prices.get(block.hash);
    if (cached) return cached;
    try {
      const price = await readEthUsd({ provider, feed: config.labels.ethUsdFeed, blockTag: block.number, at: block.timestamp, maxAgeSeconds: config.labels.ethUsdMaxAgeSeconds });
      return prices.set(block.hash, { price, priceError: null });
    } catch (err) {
      if (!(err instanceof PriceError)) throw err;
      // a failed read is not cached: the next request asks again
      if (err.code === 'ETH_USD_UNREADABLE') return { price: null, priceError: err.code };
      return prices.set(block.hash, { price: null, priceError: err.code });
    }
  }

  const labelContext = (price) => ({ price, badgeFloorWei: config.labels.badgeFloorWei, underStakedRatioBps: config.labels.underStakedRatioBps });

  /** One indexer pass, then the archives of the listings the feed may show. */
  async function sync() {
    try {
      const r = await indexer.sync();
      const listings = [...projection().listings.values()].filter((l) => l.opened && !l.rolled && !l.closed);
      await refreshArchives({ fetchArchive, store, listings, now: Date.now(), maxBytes: config.archives.maxBytes, retryMs: config.archives.retryMs, logger });
      status.lastSync = { at: Date.now(), head: r.head, safeHead: r.safeHead, added: r.added, rolledBack: r.rolledBack };
      status.syncError = null;
      return r;
    } catch (err) {
      status.syncError = err?.code ?? 'SYNC_FAILED';
      throw err;
    }
  }

  async function keep() {
    if (!keeper) return { sent: [], pending: null };
    try {
      const r = await keeper.run();
      status.lastKeep = { at: Date.now(), sent: r.sent.length };
      status.keepError = null;
      return r;
    } catch (err) {
      status.keepError = err?.code ?? 'KEEPER_FAILED';
      throw err;
    }
  }

  async function feed() {
    const block = cursorBlock();
    const cached = feeds.get(block.hash);
    if (cached && cached.archives === store.state.archives) return cached.value;
    return chainRead(async () => {
      discloseWindow ??= Number(await contract.DISCLOSE_WINDOW());
      const { price } = await priceAt(block);
      const listings = await buildFeed({ contract, projection: projection(), block, archives: store.state.archives, labels: labelContext(price), discloseWindow });
      const value = { block, listings };
      feeds.set(block.hash, { archives: store.state.archives, value });
      return value;
    });
  }

  /** The history of a record's listings: the events up to `block`, placed and published. */
  function historyOf(record, block) {
    const events = store.state.events.filter((e) => e.blockNumber <= block.number);
    const proj = events.length === store.state.events.length ? projection() : project(events);
    const ids = new Set(record.listings.map((l) => l.listingId));
    const shown = events.filter((e) => ids.has(listingOf(proj, e))).map((e) => publicEvent(proj, e));
    const publishedClaims = [...proj.claims.values()]
      .filter((c) => c.published && ids.has(c.listingId))
      .map((c) => c.claimId)
      .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    const settled = record.findings.map((f) => Number(f.settledAt));
    const lastValidFindingAt = settled.length ? Math.max(...settled) : null;
    return {
      events: shown,
      publishedClaims,
      lastValidFindingAt,
      daysSinceLastValidFinding: lastValidFindingAt === null ? null : Math.floor((block.timestamp - lastValidFindingAt) / DAY),
    };
  }

  /**
   * The record of a hash at the indexed block (or at `blockTag`), its labels and its history;
   * null when the hash has no opened listing.
   */
  async function record(artifactHash, { blockTag } = {}) {
    const hash = artifactHash.toLowerCase();
    return chainRead(async () => {
      let block = cursorBlock();
      if (blockTag !== undefined) {
        const b = await provider.getBlock(blockTag);
        block = { number: b.number, hash: b.hash, timestamp: b.timestamp };
      }
      const key = `${hash}:${block.hash}`;
      const cached = records.get(key);
      if (cached !== undefined) return cached;
      const rec = await readRecord(contract, hash, { blockTag: block.number, listingPage: chain.recordListingPage, itemPage: chain.recordItemPage });
      if (rec.listingCount === '0') return records.set(key, null);
      const { price, priceError } = await priceAt(block);
      const ctx = labelContext(price);
      const labels = {
        listings: Object.fromEntries(rec.listings.map((l) => [l.listingId, listingLabels(l, ctx)])),
        price,
        priceError,
        placeholders: config.labels.placeholders,
      };
      const view = { artifactHash: hash, block, record: rec, labels, history: historyOf(rec, block) };
      view.badge = badgeFor(view);
      return records.set(key, view);
    });
  }

  /** The badge for a hash: its SVG and what it says. A record that cannot be read: "record unavailable". */
  async function badge(artifactHash) {
    let b;
    try {
      b = badgeFor(await record(artifactHash));
    } catch (err) {
      if (!(err instanceof SiteError)) throw err;
      b = { state: 'unavailable', message: 'record unavailable', listingId: null, class: null };
    }
    return { ...b, svg: renderBadge(b) };
  }

  /** The feed's events after `after` ("<block>:<logIndex>"), at most `limit`. */
  function events({ after = null, limit = 100 } = {}) {
    const block = cursorBlock();
    let from = null;
    if (after !== null) {
      const m = POSITION.exec(after);
      if (!m) throw new SiteError('BAD_CURSOR', 'after is "<block>:<logIndex>", as `next` gives it', 400);
      from = [Number(m[1]), Number(m[2])];
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENTS_MAX) throw new SiteError('BAD_LIMIT', `limit is 1 to ${EVENTS_MAX}`, 400);
    const all = feedEvents(projection(), store.state.events);
    const start = from ? all.findIndex((e) => e.blockNumber > from[0] || (e.blockNumber === from[0] && e.logIndex > from[1])) : 0;
    const page = start === -1 ? [] : all.slice(start, start + limit);
    const last = page.at(-1);
    return { block, events: page, next: last ? `${last.blockNumber}:${last.logIndex}` : after };
  }

  function statusView() {
    const inflight = store.state.keeper.inflight;
    return {
      chainId: chain.chainId,
      contract: chain.address,
      indexer: {
        cursor: store.state.cursor,
        events: store.state.events.length,
        confirmations: chain.confirmations,
        lastSync: status.lastSync,
        error: status.syncError,
      },
      keeper: {
        enabled: Boolean(keeper),
        address: keeper?.address ?? null,
        error: keeper ? status.keepError : keeperError ?? (config.keeper.enabled ? null : 'KEEPER_OFF'),
        expire: config.keeper.expire,
        inflight: inflight ? { action: inflight.action, claimId: inflight.claimId, nonce: inflight.nonce, attempts: inflight.attempts.map((a) => ({ kind: a.kind, hash: a.hash, sentAt: a.sentAt })) } : null,
        last: store.state.keeper.last,
        lastRun: status.lastKeep,
      },
      labels: { placeholders: config.labels.placeholders, ethUsdFeed: config.labels.ethUsdFeed },
    };
  }

  const timers = new Set();
  let stopped = false;
  function loop(name, fn, everyMs) {
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        logger.warn(`${name}: ${err?.code ?? 'ERROR'}: ${String(err?.message ?? err).slice(0, 300)}`);
      }
      if (!stopped) {
        const t = setTimeout(() => { timers.delete(t); tick(); }, everyMs);
        timers.add(t);
      }
    };
    tick();
  }

  return {
    store,
    indexer,
    keeper,
    sync,
    keep,
    feed,
    record,
    badge,
    events,
    status: statusView,
    start() {
      loop('indexer', sync, chain.pollMs);
      if (keeper) loop('keeper', keep, config.keeper.pollMs);
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    close() {
      this.stop();
      store.close();
    },
  };
}
