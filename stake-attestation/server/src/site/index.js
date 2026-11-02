// The site's chain side (node P4b1): the indexer, the keeper, the listing feed, the record mirror
// and the badge, over one StakeAttestation deployment (config.chain). Everything one answer shows
// is of one block, the indexer's cursor: each request takes the store's state once (a transaction
// replaces the state object and never changes the old one, so that is a consistent snapshot), its
// feed and record are read on-chain at that block, pinned by its hash (chain/read.js), through
// the lens at the contract's address with the merged ABI, and its history is the snapshot's
// events. Reads are cached per block hash.
//
// Freshness: an answer is fresh while the last sync that reached the confirmed head is at most
// SA_MAX_STALENESS_SECONDS old and the cursor's block is no older than that. The badge states a
// live stake only when fresh; otherwise it says the record is unavailable. The feed and the record
// say whether they are fresh, and of which block.
import { JsonRpcProvider, Network } from 'ethers';

import { stakeAttestation } from '../chain/abi.js';
import { readerAt } from '../chain/read.js';
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

/**
 * The JSON-RPC provider for config.chain, its URL read from the environment now. ethers'
 * request cache is off (cacheTimeout -1): the indexer reads a block twice to see whether it
 * changed, and a cached answer would hide the change. The network is given so ethers does not
 * probe for it; the indexer asks the endpoint for its chain id itself (eth_chainId) every sync.
 */
export function createChainProvider(config, env = process.env) {
  const url = env[config.chain.rpcUrlEnv];
  if (typeof url !== 'string' || !url.trim()) throw new SiteError('RPC_URL_MISSING', `${config.chain.rpcUrlEnv} holds no RPC URL`);
  const network = Network.from(config.chain.chainId);
  return new JsonRpcProvider(url.trim(), network, { staticNetwork: network, cacheTimeout: -1 });
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

const blockOf = (c) => ({ number: c.number, hash: c.hash, timestamp: c.timestamp });

/**
 * @param {object} o
 * @param {object} o.config - loadConfig(); config.chain must be set
 * @param {import('ethers').JsonRpcApiProvider} o.provider - with send (eth_call by block hash)
 * @param {Record<string, string|undefined>} [o.env] - where the keeper's key is read
 * @param {(cid: string) => Promise<Buffer>} o.fetchArchive - reads a listing archive by CID
 * @param {object} o.logger
 * @param {object} [o.keeperHooks]
 * @param {() => number} [o.now] - wall-clock ms (tests move it)
 */
export function createSite({ config, provider, env = process.env, fetchArchive, logger, keeperHooks, now = Date.now }) {
  const chain = config.chain;
  if (!chain) throw new TypeError('createSite needs config.chain (SA_CONTRACT_ADDRESS)');
  const store = new StateStore(chain.dataDir, { chainId: chain.chainId, address: chain.address, fromBlock: chain.fromBlock });
  const indexer = createIndexer({ provider, store, chain, logger });
  const at = (block) => readerAt(provider, stakeAttestation, chain.address, block.hash);

  // the projection of a state snapshot's events, kept for the latest one asked for
  let projected = { events: null, value: null };
  const projectionOf = (state) => {
    if (projected.events !== state.events) projected = { events: state.events, value: project(state.events) };
    return projected.value;
  };
  const projection = () => projectionOf(store.state);

  let keeper = null;
  let keeperError = null;
  if (config.keeper.enabled) {
    const { wallet, error } = keeperWallet(config.keeper, env);
    keeperError = error;
    if (wallet) keeper = createKeeper({ provider, store, chain, cfg: config.keeper, wallet, projection, logger, hooks: keeperHooks });
    else logger.warn(`keeper: off (${error}: ${config.keeper.keyEnv})`);
  }

  const status = { lastSync: null, lastFreshSync: null, syncError: null, lastKeep: null, keepError: null };
  const records = lru();
  const feeds = lru();
  const prices = lru();
  let discloseWindow = null;

  /** The state to answer from, and its block. */
  const snapshot = () => {
    const state = store.state;
    if (!state.cursor) throw new SiteError('NOT_INDEXED', 'the indexer has not read a block yet');
    return { state, block: blockOf(state.cursor) };
  };

  function freshness(block) {
    const maxMs = config.chain.maxStalenessSeconds * 1000;
    const t = now();
    if (!status.lastFreshSync || t - status.lastFreshSync.at > maxMs) return { fresh: false, staleReason: 'INDEXER_STALE' };
    if (t - block.timestamp * 1000 > maxMs) return { fresh: false, staleReason: 'CHAIN_BEHIND' };
    return { fresh: true, staleReason: null };
  }

  async function chainRead(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SiteError) throw err;
      logger.warn(`site: a chain read failed (${err?.code ?? err?.message ?? err})`);
      throw new SiteError('CHAIN_UNAVAILABLE', 'the chain could not be read at the indexed block');
    }
  }

  /** ETH/USD at a block, or why there is none. */
  async function priceAt(block) {
    const cached = prices.get(block.hash);
    if (cached) return cached;
    try {
      const price = await readEthUsd({ provider, feed: config.labels.ethUsdFeed, blockHash: block.hash, at: block.timestamp, maxAgeSeconds: config.labels.ethUsdMaxAgeSeconds });
      return prices.set(block.hash, { price, priceError: null });
    } catch (err) {
      if (!(err instanceof PriceError)) throw err;
      // a failed read is not cached: the next request asks again
      if (err.code === 'ETH_USD_UNREADABLE') return { price: null, priceError: err.code };
      return prices.set(block.hash, { price: null, priceError: err.code });
    }
  }

  const labelContext = (price) => ({ price, badgeFloorWei: config.labels.badgeFloorWei, underStakedRatioBps: config.labels.underStakedRatioBps });

  /**
   * The archives of the listings the feed may show, read beside the indexer: one run at a time,
   * started by each sync but never awaited by it, so a slow gateway cannot hold up chain reads
   * (and with them the keeper's candidates and the answers' freshness).
   */
  let archiveRun = null;
  function refreshArchivesBeside() {
    if (archiveRun) return archiveRun;
    const listings = [...projection().listings.values()].filter((l) => l.opened && !l.rolled && !l.closed);
    archiveRun = refreshArchives({ fetchArchive, store, listings, now, maxBytes: config.archives.maxBytes, retryMs: config.archives.retryMs, logger })
      .catch((err) => {
        if (store.locked) logger.warn(`feed: reading listing archives failed (${err?.code ?? String(err?.message ?? err).slice(0, 200)})`);
      })
      .finally(() => {
        archiveRun = null;
      });
    return archiveRun;
  }

  /** One indexer pass; the archives of the listings it found are read beside it. */
  async function sync() {
    try {
      const r = await indexer.sync();
      const caughtUp = Boolean(r.cursor) && r.cursor.number >= r.safeHead;
      status.lastSync = { at: now(), head: r.head, safeHead: r.safeHead, added: r.added, rolledBack: r.rolledBack, caughtUp };
      if (caughtUp) status.lastFreshSync = status.lastSync;
      status.syncError = null;
      refreshArchivesBeside();
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
      status.lastKeep = { at: now(), sent: r.sent.length };
      status.keepError = null;
      return r;
    } catch (err) {
      status.keepError = err?.code ?? 'KEEPER_FAILED';
      throw err;
    }
  }

  async function feed() {
    const { state, block } = snapshot();
    let value = feeds.get(block.hash);
    if (!value || value.archives !== state.archives) {
      value = await chainRead(async () => {
        const read = at(block);
        discloseWindow ??= Number((await read('DISCLOSE_WINDOW'))[0]);
        const { price } = await priceAt(block);
        const listings = await buildFeed({ read, projection: projectionOf(state), block, archives: state.archives, labels: labelContext(price), discloseWindow });
        return feeds.set(block.hash, { archives: state.archives, block, listings });
      });
    }
    return { block: value.block, ...freshness(value.block), listings: value.listings };
  }

  /** The history of a record's listings: the snapshot's events, placed and published. */
  function historyOf(record, events, block) {
    const proj = project(events);
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
   * The record of a hash at the indexed block (or, for tests, at an earlier `blockTag`), its
   * labels and its history; null when the hash has no opened listing.
   */
  async function record(artifactHash, { blockTag } = {}) {
    const hash = artifactHash.toLowerCase();
    const { state, block: cursor } = snapshot();
    const view = await chainRead(async () => {
      let block = cursor;
      let events = state.events;
      if (blockTag !== undefined) {
        block = blockOf(await provider.getBlock(blockTag));
        events = state.events.filter((e) => e.blockNumber <= block.number);
      }
      const key = `${hash}:${block.hash}`;
      const cached = records.get(key);
      if (cached !== undefined) return cached;
      const rec = await readRecord(at(block), hash, { listingPage: chain.recordListingPage, itemPage: chain.recordItemPage });
      if (rec.listingCount === '0') return records.set(key, null);
      const { price, priceError } = await priceAt(block);
      const ctx = labelContext(price);
      const labels = {
        listings: Object.fromEntries(rec.listings.map((l) => [l.listingId, listingLabels(l, ctx)])),
        price,
        priceError,
        placeholders: config.labels.placeholders,
      };
      const v = { artifactHash: hash, block, record: rec, labels, history: historyOf(rec, events, block) };
      v.badge = badgeFor(v);
      return records.set(key, v);
    });
    return view && { ...view, ...freshness(view.block) };
  }

  /**
   * The badge for a hash: its SVG and what it says. A live stake is stated only from a fresh
   * record; a stale or unreadable one is "record unavailable".
   */
  async function badge(artifactHash) {
    let b;
    try {
      const view = await record(artifactHash);
      b = view && !view.fresh
        ? { state: 'unavailable', message: 'record unavailable', listingId: null, class: null }
        : badgeFor(view);
    } catch (err) {
      if (!(err instanceof SiteError)) throw err;
      b = { state: 'unavailable', message: 'record unavailable', listingId: null, class: null };
    }
    return { ...b, svg: renderBadge(b) };
  }

  /** The feed's events after `after` ("<block>:<logIndex>"), at most `limit`. */
  function events({ after = null, limit = 100 } = {}) {
    const { state, block } = snapshot();
    let from = null;
    if (after !== null) {
      const m = POSITION.exec(after);
      if (!m) throw new SiteError('BAD_CURSOR', 'after is "<block>:<logIndex>", as `next` gives it', 400);
      from = [Number(m[1]), Number(m[2])];
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENTS_MAX) throw new SiteError('BAD_LIMIT', `limit is 1 to ${EVENTS_MAX}`, 400);
    const all = feedEvents(projectionOf(state), state.events);
    const start = from ? all.findIndex((e) => e.blockNumber > from[0] || (e.blockNumber === from[0] && e.logIndex > from[1])) : 0;
    const page = start === -1 ? [] : all.slice(start, start + limit);
    const last = page.at(-1);
    return { block, ...freshness(block), events: page, next: last ? `${last.blockNumber}:${last.logIndex}` : after };
  }

  function statusView() {
    const state = store.state;
    const inflight = state.keeper.inflight;
    return {
      chainId: chain.chainId,
      contract: chain.address,
      indexer: {
        cursor: state.cursor,
        ...(state.cursor ? freshness(state.cursor) : { fresh: false, staleReason: 'NOT_INDEXED' }),
        events: state.events.length,
        confirmations: chain.confirmations,
        lastSync: status.lastSync,
        error: status.syncError,
      },
      keeper: {
        enabled: Boolean(keeper),
        address: keeper?.address ?? null,
        error: keeper ? status.keepError : keeperError ?? (config.keeper.enabled ? null : 'KEEPER_OFF'),
        expire: config.keeper.expire,
        inflight: inflight ? { action: inflight.action, claimId: inflight.claimId, from: inflight.from, nonce: inflight.nonce, attempts: inflight.attempts.map((a) => ({ kind: a.kind, hash: a.hash, sentAt: a.sentAt })) } : null,
        foreign: (state.keeper.foreign ?? []).map((f) => ({ action: f.action, claimId: f.claimId, from: f.from, nonce: f.nonce })),
        last: state.keeper.last,
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
    /** Resolves once the archive reads started so far have finished (for tests and shutdown). */
    archivesIdle: () => archiveRun ?? Promise.resolve(),
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
