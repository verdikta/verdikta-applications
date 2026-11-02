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
//
// The control facts (src/control/; node P8) are the site's own, not the chain's: each answer reads
// them from its state snapshot, so a record cached per block still states the latest check, and the
// checks themselves run beside the indexer, like the archive reads.
//
// What counts (node P9, owner decision Q34): the record, the feed, the badge and the labels read only
// a listing with a valid builder signature and the project's proof (src/control/counting.js), since
// recordByHash combines every listing of a hash. Any other listing of the hash shows apart, as not
// counted, with no amount, and never adds to the stake shown; the site offers no commit on it.
import { JsonRpcProvider, Network } from 'ethers';

import { stakeAttestation } from '../chain/abi.js';
import { outputJson } from '../chain/codec.js';
import { readerAt } from '../chain/read.js';
import { notCountedReason } from '../control/counting.js';
import { CONTROL_REASONS } from '../control/facts.js';
import { FORK_TIMEOUT_MS, createForkChecker } from '../control/forkCheck.js';
import { createRepositoryChecker } from '../control/gitCheck.js';
import { ControlError, createControl } from '../control/index.js';
import { RefusalCounter, refusalsFileIn } from '../listing/refusals.js';
import { badgeFor, renderBadge } from '../record/badge.js';
import { listingLabels } from '../record/labels.js';
import { PriceError, readEthUsd } from '../record/price.js';
import { partitionRecord, readRecord } from '../record/record.js';
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

export { ControlError };

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
 * @param {(o: { repo: string, commit: string }) => Promise<object>} [o.checkRepository] - the git
 *   check (default: builder/bin/verdikta-control-check.js in a process of its own)
 * @param {(chainId: number) => object|null} [o.chainProviderFor] - a provider on a listing's chain
 *   (default: this site's for its own chain, SA_CONTROL_RPC_URL_<id> for another)
 * @param {(o: { repo: string }) => Promise<object>} [o.checkFork] - what the host says of a repository
 *   (default: its API, src/control/forkCheck.js)
 */
export function createSite({ config, provider, env = process.env, fetchArchive, logger, keeperHooks, now = Date.now, checkRepository, chainProviderFor, checkFork }) {
  const chain = config.chain;
  if (!chain) throw new TypeError('createSite needs config.chain (SA_CONTRACT_ADDRESS)');
  const store = new StateStore(chain.dataDir, { chainId: chain.chainId, address: chain.address, fromBlock: chain.fromBlock });
  const indexer = createIndexer({ provider, store, chain, logger });
  const at = (block) => readerAt(provider, stakeAttestation, chain.address, block.hash);
  const refusals = new RefusalCounter({ file: refusalsFileIn(chain.dataDir) });

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

  const control = createControl({
    config,
    store,
    provider,
    env,
    now,
    logger,
    checkRepository: checkRepository ?? createRepositoryChecker(config.control, { env }),
    chainProviderFor,
    checkFork: checkFork ?? createForkChecker({ timeoutMs: config.control.forkTimeoutMs ?? FORK_TIMEOUT_MS, env }),
    readListing: async (listingId) => {
      const { block } = snapshot();
      return outputJson('getListing', (await at(block)('getListing', [listingId]))[0]);
    },
  });

  /** Why a listing of the projection does not count, from a state snapshot; null: it counts. */
  const reasonOf = (state, l, fact) => notCountedReason({ known: state.archives[l.listingCid], artifact: l.artifact, fact, terms: control.termsOf(state, l) });

  const status = { lastSync: null, lastFreshSync: null, syncError: null, lastKeep: null, keepError: null };
  const records = lru();
  const histories = lru();
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
    // every listing that opened: what is on a record also needs its builder's signature read
    const listings = [...projection().listings.values()].filter((l) => l.opened);
    archiveRun = refreshArchives({ fetchArchive, store, listings, now, maxBytes: config.archives.maxBytes, retryMs: config.archives.retryMs, logger, devKeys: () => (config.trust.mode === 'dev' ? control.devKeys(store.state) : null) })
      .catch((err) => {
        if (store.locked) logger.warn(`feed: reading listing archives failed (${err?.code ?? String(err?.message ?? err).slice(0, 200)})`);
      })
      .finally(() => {
        archiveRun = null;
      });
    return archiveRun;
  }

  /**
   * The control facts' checks, beside the indexer in the same way: one run at a time, started by
   * each sync and never awaited by it, so a git host or another chain that hangs holds up nothing.
   */
  let controlRun = null;
  function refreshControlBeside() {
    if (controlRun) return controlRun;
    const listings = [...projection().listings.values()];
    controlRun = control.refresh(listings)
      .catch((err) => {
        if (store.locked) logger.warn(`control: a run failed (${err?.code ?? err?.name ?? 'error'})`);
      })
      .finally(() => {
        controlRun = null;
      });
    return controlRun;
  }

  /** One indexer pass; the archives of the listings it found are read beside it, and their control facts checked. */
  async function sync() {
    try {
      const r = await indexer.sync();
      const caughtUp = Boolean(r.cursor) && r.cursor.number >= r.safeHead;
      status.lastSync = { at: now(), head: r.head, safeHead: r.safeHead, added: r.added, rolledBack: r.rolledBack, caughtUp };
      if (caughtUp) status.lastFreshSync = status.lastSync;
      status.syncError = null;
      refreshArchivesBeside();
      refreshControlBeside();
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
    const known = projectionOf(state).listings;
    const listings = [];
    const notCounted = [];
    for (const e of value.listings) {
      const l = known.get(e.listingId);
      const fact = control.factOf(state, { artifactHash: e.artifactHash, maker: e.maker, artifact: l?.artifact });
      const reason = l ? reasonOf(state, l, fact) : 'NOT_CHECKED_YET';
      if (reason) notCounted.push({ listingId: e.listingId, artifactHash: e.artifactHash, artifact: e.artifact, maker: e.maker, reason, detail: CONTROL_REASONS[reason] ?? null });
      else listings.push({ ...e, control: { subject: fact.subject, proof: fact.proof, statement: fact.statement, reason: fact.reason } });
    }
    return { block: value.block, ...freshness(value.block), listings, notCounted };
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
      return records.set(key, { artifactHash: hash, block, record: rec, labels });
    });
    if (!view) return view;
    return countedAnswer(view, state, hash, { events: blockTag === undefined ? state.events : state.events.filter((e) => e.blockNumber <= view.block.number) });
  }

  /** The record's answer: what counts on the record, the rest apart (src/control/counting.js). */
  function countedAnswer(view, state, hash, { events }) {
    const known = projectionOf(state).listings;
    const facts = {};
    const reasons = new Map();
    for (const l of view.record.listings) {
      const id = String(l.listingId);
      const p = known.get(id);
      facts[id] = control.factOf(state, { artifactHash: hash, maker: l.maker, artifact: p?.artifact });
      const reason = p ? reasonOf(state, p, facts[id]) : 'NOT_CHECKED_YET';
      if (reason) reasons.set(id, reason);
    }
    const counted = new Set(view.record.listings.map((l) => String(l.listingId)).filter((id) => !reasons.has(id)));
    const { record: rec, findings, flags } = partitionRecord(view.record, counted);
    const apart = view.record.listings.filter((l) => !counted.has(String(l.listingId)));
    const first = known.get(String(view.record.listings[0]?.listingId));
    // what is shown of a block's events changes only when another listing starts or stops counting
    const historyKey = `${hash}:${view.block.hash}:${[...counted].join(',')}`;
    const told = histories.get(historyKey) ?? histories.set(historyKey, {
      history: historyOf(rec, events, view.block),
      apartEvents: apart.length ? historyOf({ ...rec, listings: apart, findings: [] }, events, view.block).events : [],
    });
    const out = {
      ...view,
      record: rec,
      labels: { ...view.labels, listings: Object.fromEntries(Object.entries(view.labels.listings).filter(([id]) => counted.has(id))) },
      history: told.history,
      ...freshness(view.block),
      artifact: first ? { kind: first.artifact.kind, repo: first.artifact.repo, baseCommit: first.artifact.baseCommit, chainId: first.artifact.chainId, address: first.artifact.address } : null,
      fork: first ? control.forkOf(state, first.artifact.repo) : null,
      control: facts,
      notCounted: {
        listings: apart.map((l) => {
          const id = String(l.listingId);
          return { listingId: id, maker: l.maker, state: l.state, lapsed: l.lapsed, reason: reasons.get(id), detail: CONTROL_REASONS[reasons.get(id)] ?? null };
        }),
        findings,
        flags,
        events: told.apartEvents,
      },
    };
    out.badge = badgeFor(out);
    return out;
  }

  /**
   * A signature for a contract listing's control fact (src/control/index.js). The listing is read
   * from the indexed events, its maker and artifact from there too, never from the request.
   * @returns {Promise<object>} the listing's fact, after the proof
   */
  async function submitControlProof(artifactHash, listingId, body) {
    const hash = artifactHash.toLowerCase();
    const l = control.listingIdValid(listingId) ? projection().listings.get(listingId) : null;
    if (!l || l.artifactHash.toLowerCase() !== hash) throw new SiteError('LISTING_NOT_FOUND', 'no indexed listing of this artifact hash has this id', 404);
    const listing = { artifactHash: hash, maker: l.maker, artifact: l.artifact };
    await control.submit(listing, body);
    return control.factOf(store.state, listing);
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
    const proj = projectionOf(state);
    const all = feedEvents(proj, state.events);
    const start = from ? all.findIndex((e) => e.blockNumber > from[0] || (e.blockNumber === from[0] && e.logIndex > from[1])) : 0;
    // the chain's events, all of them; each says whether its listing counts at this answer
    const counts = (id) => {
      const l = proj.listings.get(id);
      return Boolean(l) && reasonOf(state, l, control.factOf(state, { artifactHash: l.artifactHash, maker: l.maker, artifact: l.artifact })) === null;
    };
    const page = start === -1 ? [] : all.slice(start, start + limit).map((e) => ({ ...e, counted: counts(e.listingId) }));
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
      control: { gitHosts: config.control.gitHosts },
      listings: { refused: refusals.view() },
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
    /** The provider and the deployment, for reads at the latest block (src/dispute/statement.js). */
    provider,
    contract: chain.address,
    sync,
    keep,
    /** Resolves once the archive reads started so far have finished (for tests and shutdown). */
    archivesIdle: () => archiveRun ?? Promise.resolve(),
    /** Resolves once the control checks started so far have finished (for tests and shutdown). */
    controlIdle: () => controlRun ?? Promise.resolve(),
    submitControlProof,
    /** Refused listing attempts by reason; they live beside this site's state. */
    refusals,
    /** A deployment proof sent with a listing request: checked now, stored only if it counts. */
    checkDeployment: (listing, proof) => control.submit(listing, proof),
    /** A signing step's dev key: only those count under dev trust. */
    noteDevTrust: (devTrust) => control.noteDevTrust(devTrust),
    /** The message a contract listing's deployer or owner signs, for a request's maker and artifact. */
    stake: { chainId: chain.chainId, address: chain.address },
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
