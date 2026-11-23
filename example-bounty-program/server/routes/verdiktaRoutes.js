/**
 * Verdikta Routes
 * Provides endpoints for querying Verdikta aggregator data
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { getVerdiktaService, isVerdiktaServiceAvailable } = require('../utils/verdiktaService');

/**
 * GET /api/verdikta/agg-history/:aggId[?aggregator=0x…|?jury=N|?bountyId=N]
 * Returns the full lifecycle of one round. v2 round ids are sequential per aggregator (one per
 * jury size), so name the aggregator, its jury index, or the bounty whose round it is; the first
 * approved aggregator (jury 0) is assumed otherwise.
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
    } else if (req.query.bountyId != null && req.query.bountyId !== '') {
      const { getContractService } = require('../utils/contractService');
      where.aggregator = await (await getContractService().getAggregatorFor(Number(req.query.bountyId))).getAddress();
    } else if (req.query.jury != null && req.query.jury !== '') {
      where.jury = Number(req.query.jury);
    }
    let data;
    try {
      data = await verdiktaService.getAggHistory(aggId, where);
    } catch (whereErr) {
      if (/approved aggregator|no aggregator for jury/.test(whereErr.message)) {
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
