/**
 * Verdikta Routes
 * Provides endpoints for querying Verdikta aggregator data
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { getVerdiktaService, isVerdiktaServiceAvailable } = require('../utils/verdiktaService');

/**
 * GET /api/verdikta/agg-history/:aggId[?aggregator=0x…]
 * Returns the full lifecycle of one round on the escrow's aggregator (one serves every jury size;
 * the round's jury comes from getJury). `aggregator`, when given, must be that aggregator.
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
    const where = {};
    if (req.query.aggregator) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(req.query.aggregator))) {
        return res.status(400).json({ error: 'Invalid aggregator address' });
      }
      where.aggregator = String(req.query.aggregator);
    }
    let data;
    try {
      data = await verdiktaService.getAggHistory(aggId, where);
    } catch (whereErr) {
      if (/escrow's aggregator/.test(whereErr.message)) {
        return res.status(400).json({ error: 'Unknown aggregator', details: whereErr.message });
      }
      throw whereErr;
    }
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
