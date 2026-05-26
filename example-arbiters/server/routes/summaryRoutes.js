/**
 * Summary route for example-arbiters.
 *
 * Lightweight cross-network headline stats for the home page: the total number
 * of registered arbiters on each network plus whether its aggregator is
 * reachable. Deliberately cheap — one `getOracleCount` (getRegisteredOraclesCount)
 * per network, no full enumeration — so the landing page loads fast.
 */

const express = require('express');
const router = express.Router();

const logger = require('../utils/logger');
const { analyticsCache } = require('../utils/analyticsCacheService');
const { getVerdiktaService } = require('../utils/verdiktaService');
const { networks } = require('../config');

async function getSummary() {
  const results = await Promise.all(
    Object.values(networks).map(async (net) => {
      const verdiktaService = getVerdiktaService(net.key);
      let totalArbiters = null;
      let healthy = false;
      try {
        totalArbiters = await verdiktaService.getOracleCount();
        healthy = true;
      } catch (e) {
        logger.warn('[summary] oracle count failed', { network: net.key, msg: e.message });
      }
      return {
        network: net.key,
        name: net.name,
        chainId: net.chainId,
        explorer: net.explorer,
        totalArbiters,
        healthy
      };
    })
  );
  return { networks: results, generatedAt: Date.now() };
}

/**
 * GET /api/summary
 * Per-network arbiter totals + health for the home page (cached).
 */
router.get('/', async (_req, res) => {
  try {
    const cacheKey = 'summary';
    const cached = analyticsCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached.data, cached: true, cachedAt: cached.timestamp });
    }

    const data = await getSummary();
    analyticsCache.set(cacheKey, data);
    return res.json({ success: true, data, cached: false });
  } catch (error) {
    logger.error('[summary] error', { msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to get summary', details: error.message });
  }
});

module.exports = router;
