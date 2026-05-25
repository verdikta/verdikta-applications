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
const { getVerdiktaService } = require('../utils/verdiktaService');
const { normalizeNetwork } = require('../config');
const { classMap } = require('@verdikta/common');

/**
 * Arbiter availability per class, enriched with class names from classMap.
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
      verdiktaConnected: true,
      timestamp: arbiterData.timestamp
    };
  } catch (error) {
    logger.error('[analytics] Failed to get arbiter analytics', { network, msg: error.message });
    return {
      byClass: {},
      totalOracles: null,
      verdiktaConnected: false,
      message: `Could not reach the aggregator on ${normalizeNetwork(network)}`,
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
      configured: true,
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
 * POST /api/analytics/refresh
 * Invalidate the cache for a network so the next read pulls fresh contract data.
 */
router.post('/refresh', (req, res) => {
  const network = normalizeNetwork(req.query.network || req.body?.network);
  try {
    analyticsCache.invalidate(`analytics_overview_${network}`);
    analyticsCache.invalidate(`analytics_arbiters_${network}`);
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
