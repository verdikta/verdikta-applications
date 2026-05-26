/**
 * Contracts routes for example-arbiters.
 *
 * Read-only descriptive view of the core Verdikta contracts — the
 * ReputationAggregator, the ReputationKeeper, and the wVDKA staking token —
 * including their addresses and live on-chain configuration. Reuses the same
 * VerdiktaService + per-network cache as the analytics routes.
 *
 * Every endpoint accepts a ?network= query param (default base-sepolia).
 */

const express = require('express');
const router = express.Router();

const logger = require('../utils/logger');
const { analyticsCache } = require('../utils/analyticsCacheService');
const { getVerdiktaService } = require('../utils/verdiktaService');
const { networks, normalizeNetwork } = require('../config');

/**
 * Assemble addresses + live config for the three contracts. Aggregator data is
 * required (via healthCheck); the keeper extras and token metadata are each
 * guarded so a single failing call degrades gracefully rather than sinking the
 * whole page.
 */
async function getContractsOverview(network) {
  const key = normalizeNetwork(network);
  const net = networks[key];
  const verdiktaService = getVerdiktaService(key);

  const health = await verdiktaService.healthCheck();
  if (!health.healthy) {
    return {
      network: key,
      networkName: net.name,
      explorer: net.explorer,
      healthy: false,
      error: health.error || `Could not reach the aggregator on ${key}`,
      contracts: null,
      generatedAt: Date.now()
    };
  }

  let thresholds = null;
  let oracleCount = null;
  let payment = null;
  let wvdka = null;
  let keeperConfig = null;

  try {
    thresholds = await verdiktaService.getKeeperThresholds();
  } catch (e) {
    logger.warn('[contracts] keeper thresholds failed', { network: key, msg: e.message });
  }
  try {
    keeperConfig = await verdiktaService.getKeeperConfig();
  } catch (e) {
    logger.warn('[contracts] keeper config failed', { network: key, msg: e.message });
  }
  try {
    oracleCount = await verdiktaService.getOracleCount();
  } catch (e) {
    logger.warn('[contracts] oracle count failed', { network: key, msg: e.message });
  }
  try {
    payment = await verdiktaService.getPaymentConfig();
  } catch (e) {
    logger.warn('[contracts] payment config failed', { network: key, msg: e.message });
  }
  if (health.wvdkaAddress) {
    try {
      wvdka = await verdiktaService.getTokenInfo(health.wvdkaAddress);
    } catch (e) {
      logger.warn('[contracts] wVDKA token info failed', { network: key, msg: e.message });
    }
  }

  return {
    network: key,
    networkName: net.name,
    explorer: net.explorer,
    healthy: true,
    contracts: {
      aggregator: {
        address: health.aggregatorAddress,
        config: health.config,
        payment // { linkTokenAddress, jobId, fee } or null
      },
      keeper: {
        address: health.keeperAddress,
        registeredOracles: oracleCount,
        mildThreshold: thresholds?.mildThreshold ?? null,
        severeThreshold: thresholds?.severeThreshold ?? null,
        verdiktaTokenAddress: health.wvdkaAddress || null,
        config: keeperConfig // stake/penalty/selection config + selectionCounter, or null
      },
      wvdka: wvdka || (health.wvdkaAddress ? { address: health.wvdkaAddress } : null)
    },
    generatedAt: Date.now()
  };
}

/**
 * GET /api/contracts/overview
 * Contract addresses + live configuration (cached per network).
 */
router.get('/overview', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  try {
    const cacheKey = `contracts_overview_${network}`;
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

    const data = await getContractsOverview(network);
    analyticsCache.set(cacheKey, data);

    return res.json({ success: true, data, cached: false });
  } catch (error) {
    logger.error('[contracts/overview] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to get contracts overview',
      details: error.message
    });
  }
});

/**
 * POST /api/contracts/refresh
 * Invalidate the cache for a network so the next read pulls fresh contract data.
 */
router.post('/refresh', (req, res) => {
  const network = normalizeNetwork(req.query.network || req.body?.network);
  try {
    analyticsCache.invalidate(`contracts_overview_${network}`);
    logger.info('[contracts/refresh] cache cleared', { network });
    return res.json({ success: true, network });
  } catch (error) {
    logger.error('[contracts/refresh] error', { network, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to refresh contracts',
      details: error.message
    });
  }
});

module.exports = router;
