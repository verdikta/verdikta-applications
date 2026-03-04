/**
 * Verdikta Routes
 * Provides endpoints for querying Verdikta aggregator data
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { getVerdiktaService, isVerdiktaServiceAvailable } = require('../utils/verdiktaService');

/**
 * GET /api/verdikta/agg-history/:aggId
 * Returns full oracle evaluation lifecycle for a given aggregation ID
 */
router.get('/agg-history/:aggId', async (req, res) => {
  const { aggId } = req.params;

  // Validate aggId format: 0x + 64 hex chars
  if (!/^0x[0-9a-fA-F]{64}$/.test(aggId)) {
    return res.status(400).json({
      error: 'Invalid aggId format',
      details: 'Expected 0x followed by 64 hex characters'
    });
  }

  if (!isVerdiktaServiceAvailable()) {
    return res.status(503).json({
      error: 'Verdikta service not available',
      details: 'Aggregator address not configured'
    });
  }

  try {
    const verdiktaService = getVerdiktaService();
    const data = await verdiktaService.getAggHistory(aggId);
    return res.json({ success: true, data });
  } catch (error) {
    logger.error('[verdikta/agg-history] error', { aggId, msg: error.message });
    return res.status(500).json({
      error: 'Failed to fetch aggregation history',
      details: error.message
    });
  }
});

module.exports = router;
