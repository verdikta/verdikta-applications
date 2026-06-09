/**
 * Arbiter management routes for example-arbiters.
 *
 * Read-only lookup that backs the wallet-gated "My Arbiters" page: given a
 * connected owner address, return the arbiters that wallet controls on a
 * network, grouped by operator contract, with claimable ETH (per owner) and per-job
 * stake / lock state. The actual claim + deregister transactions are sent client-side
 * via the user's wallet; this endpoint only supplies what to show and the
 * keeper address needed to build the deregister tx.
 */

const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');

const logger = require('../utils/logger');
const { getVerdiktaService } = require('../utils/verdiktaService');
const { normalizeNetwork } = require('../config');

/**
 * GET /api/arbiters/owned?owner=0x..&network=..
 * Arbiters owned by `owner` on `network`, grouped by operator contract.
 */
router.get('/owned', async (req, res) => {
  const network = normalizeNetwork(req.query.network);
  const owner = req.query.owner;

  if (!owner || !ethers.isAddress(owner)) {
    return res.status(400).json({
      success: false,
      error: 'A valid ?owner= address is required'
    });
  }

  try {
    const verdiktaService = getVerdiktaService(network);
    const data = await verdiktaService.getOwnedArbiters(owner);
    return res.json({ success: true, data: { network, ...data } });
  } catch (error) {
    logger.error('[arbiters/owned] error', { network, owner, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to load owned arbiters',
      details: error.message
    });
  }
});

module.exports = router;
