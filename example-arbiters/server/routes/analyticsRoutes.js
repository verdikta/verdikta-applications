/**
 * Analytics routes for example-arbiters.
 *
 * Arbiter/oracle diagnostics read directly from the Verdikta aggregator and
 * ReputationKeeper contracts. No bounty, submission, or IPFS data is involved.
 *
 * Every endpoint accepts a ?network= query param (default base-sepolia) so the
 * client can toggle between Base Sepolia and Base mainnet. Results are cached
 * per network.
 */

const express = require('express');
const router = express.Router();

const logger = require('../utils/logger');
const { analyticsCache } = require('../utils/analyticsCacheService');
const { getVerdiktaService, toAggId } = require('../utils/verdiktaService');
const oracleHealthLoader = require('../utils/oracleHealthLoader');
const { normalizeNetwork } = require('../config');
const { classMap } = require('@verdikta/common');

/**
 * Arbiter availability per class (ClassID): the selectable count (the jury
 * size is per request; a draw short of K repeats arbiters and fails only with
 * none selectable), the aggregator's maxJury and the keeper's scansAll(cls),
 * enriched with class names from classMap.
 */
async function getArbiterAnalytics(network) {
  const verdiktaService = getVerdiktaService(network);

  try {
    const arbiterData = await verdiktaService.getArbiterAvailabilityByClass();

    const enrichedByClass = {};
    for (const [classId, data] of Object.entries(arbiterData.byClass)) {
      let classInfo = null;
      try {
        classInfo = classMap.getClass(Number(classId));
      } catch {
        classInfo = null;
      }
      enrichedByClass[classId] = {
        ...data,
        className: classInfo?.name || `Class ${classId}`,
        classDescription: classInfo?.description || '',
        shortName: classInfo?.shortName || null
      };
    }

    return {
      byClass: enrichedByClass,
      totalOracles: arbiterData.totalOracles,
      maxJury: arbiterData.maxJury, // the largest K a request may ask for (each request sets its own)
      verdiktaConnected: true,
      timestamp: arbiterData.timestamp
    };
  } catch (error) {
    logger.error('[analytics] Failed to get arbiter analytics', { network, msg: error.message });
    return {
      byClass: {},
      totalOracles: null,
      verdiktaConnected: false,
      message: error.code === 'NOT_CONFIGURED'
        ? error.message
        : `Could not reach the aggregator on ${normalizeNetwork(network)}`,
      timestamp: Date.now()
    };
  }
}

/**
 * Aggregator config + contract addresses for the System Health section.
 */
async function getSystemHealth(network) {
  const verdiktaService = getVerdiktaService(network);

  let aggregatorConfig = null;
  let verdiktaHealth = null;

  try {
    verdiktaHealth = await verdiktaService.healthCheck();
    if (verdiktaHealth.healthy) {
      aggregatorConfig = verdiktaHealth.config;
    }
  } catch (error) {
    logger.warn('[analytics] Failed to get Verdikta health', { network, msg: error.message });
    verdiktaHealth = { healthy: false, error: error.message };
  }

  return {
    network: normalizeNetwork(network),
    verdikta: {
      configured: verdiktaHealth?.configured !== false,
      healthy: verdiktaHealth?.healthy || false,
      aggregatorAddress: verdiktaHealth?.aggregatorAddress || null,
      keeperAddress: verdiktaHealth?.keeperAddress || null,
      linkTokenAddress: verdiktaHealth?.linkTokenAddress || null,
      wvdkaAddress: verdiktaHealth?.wvdkaAddress || null,
      error: verdiktaHealth?.error || null
    },
    aggregatorConfig,
    // No blockchain sync service in this app — data is read live on cache miss.
    sync: null,
    timestamp: Date.now()
  };
}

/**
 * GET /api/analytics/overview
 * Combined arbiter availability + system health (cached per network).
 */
router.get('/overview', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  try {
    const cacheKey = `analytics_overview_${network}`;
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: cached.timestamp,
        ageMs: cached.ageMs
      });
    }

    const [arbiterData, systemData] = await Promise.all([
      getArbiterAnalytics(network),
      getSystemHealth(network)
    ]);

    const result = {
      network,
      arbiters: arbiterData,
      system: systemData,
      generatedAt: Date.now()
    };

    analyticsCache.set(cacheKey, result);

    return res.json({ success: true, data: result, cached: false });
  } catch (error) {
    logger.error('[analytics/overview] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get analytics overview',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/arbiters
 * Arbiter availability per class (cached per network).
 */
router.get('/arbiters', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  try {
    const cacheKey = `analytics_arbiters_${network}`;
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({ success: true, data: cached.data, cached: true, cachedAt: cached.timestamp });
    }

    const data = await getArbiterAnalytics(network);
    analyticsCache.set(cacheKey, data);

    return res.json({ success: true, data, cached: false });
  } catch (error) {
    logger.error('[analytics/arbiters] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get arbiter analytics',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/system
 * System health and aggregator configuration (not cached — cheap).
 */
router.get('/system', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  try {
    const data = await getSystemHealth(network);
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('[analytics/system] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get system health',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/owners
 * Arbiters grouped by owner address (sorted numerically ascending), with totals
 * for # arbiters, average reputation, claimable ETH and node funding.
 * Cached per network.
 */
router.get('/owners', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  const cacheKey = `analytics_owners_${network}`;
  try {
    const cached = analyticsCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached.data, cached: true, cachedAt: cached.timestamp });
    }

    const verdiktaService = getVerdiktaService(network);
    const data = await verdiktaService.getOwnersAnalytics();
    const payload = { network, ...data };

    analyticsCache.set(cacheKey, payload);

    return res.json({ success: true, data: payload, cached: false });
  } catch (error) {
    logger.error('[analytics/owners] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get owners analytics',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/oracle-health
 * Per-operator commit/reveal reliability + network eval success rate, derived
 * from aggregator lifecycle events over a recent window.
 * Optional ?days= (1..60, default 14) sizes the look-back window.
 *
 * Served through oracleHealthLoader: a warm cache answers instantly, an
 * expired one is served as-is (`stale: true`) while one background rescan
 * replaces it, and only a cold key makes the caller wait on the scan.
 */
router.get('/oracle-health', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 14));
  try {
    const { data, cached, stale, refreshing, cachedAt } = await oracleHealthLoader.load(network, days);
    return res.json({ success: true, data, cached, stale, refreshing, ...(cachedAt ? { cachedAt } : {}) });
  } catch (error) {
    logger.error('[analytics/oracle-health] error', { network, days, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get oracle health',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/agg-history/:aggId
 * Full blow-by-blow of a single oracle aggregation (the drill-down behind a
 * blameworthy round). :aggId is the bytes32 round id or the decimal round
 * number (v2 ids are sequential: aggId = bytes32(round)).
 * ?network=base|base-sepolia selects the chain.
 */
router.get('/agg-history/:aggId', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  const aggId = toAggId(req.params.aggId);
  if (!aggId) {
    return res.status(400).json({ success: false, error: 'Invalid round id: give a bytes32 aggId or a round number' });
  }
  const cacheKey = `analytics_agg_history_${network}_${aggId}`;
  try {
    const cached = analyticsCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached.data, cached: true, cachedAt: cached.timestamp });
    }
    const verdiktaService = getVerdiktaService(network);
    const data = await verdiktaService.getAggHistory(aggId);
    analyticsCache.set(cacheKey, data);
    return res.json({ success: true, data, cached: false });
  } catch (error) {
    logger.error('[analytics/agg-history] error', { network, aggId, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to get agg history', details: error.message });
  }
});

/**
 * POST /api/analytics/refresh
 * Invalidate the cache for a network so the next read pulls fresh contract data.
 */
router.post('/refresh', (req, res) => {
  const network = normalizeNetwork(req.query.network || req.body?.network);
  try {
    analyticsCache.invalidate(`analytics_overview_${network}`);
    analyticsCache.invalidate(`analytics_arbiters_${network}`);
    analyticsCache.invalidate(`analytics_owners_${network}`);
    // oracle-health keys are suffixed by window size; clear the common ones.
    // (Deleting, not just expiring: an explicit Refresh should pay for a cold
    // scan rather than be handed the stale copy by stale-while-revalidate.)
    for (const d of [1, 7, 14, 30, 60]) analyticsCache.invalidate(oracleHealthLoader.cacheKey(network, d));
    logger.info('[analytics/refresh] cache cleared', { network });
    return res.json({ success: true, network });
  } catch (error) {
    logger.error('[analytics/refresh] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to refresh analytics',
      details: error.message
    });
  }
});

module.exports = router;
