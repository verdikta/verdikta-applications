const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { isValidCid } = require('../utils/validation');

/**
 * GET /api/fetch/:cid
 * Fetch content from IPFS
 */
router.get('/fetch/:cid', async (req, res) => {
  try {
    const { cid } = req.params;

    // Validate CID format
    if (!isValidCid(cid)) {
      return res.status(400).json({
        error: 'Invalid CID format',
        details: 'The provided CID does not match the expected format'
      });
    }

    logger.info(`GET /api/fetch/${cid} called`);

    // Fetch from IPFS using ipfsClient
    const ipfsClient = req.app.locals.ipfsClient;
    const data = await ipfsClient.fetchFromIPFS(cid);

    logger.info('Successfully fetched from IPFS', { 
      cid, 
      size: data.length 
    });

    // Try to detect content type
    let contentType = 'application/octet-stream';
    let content = data;

    try {
      // Attempt to parse as JSON
      const jsonContent = JSON.parse(data.toString('utf-8'));
      contentType = 'application/json';
      content = JSON.stringify(jsonContent, null, 2);
    } catch (e) {
      // Not JSON, check for other types based on content
      const dataStr = data.toString('utf-8', 0, Math.min(100, data.length));
      if (dataStr.startsWith('<!DOCTYPE html') || dataStr.startsWith('<html')) {
        contentType = 'text/html';
      } else if (data[0] === 0xFF && data[1] === 0xD8) {
        contentType = 'image/jpeg';
      } else if (data[0] === 0x89 && data[1] === 0x50) {
        contentType = 'image/png';
      } else if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
        contentType = 'application/pdf';
      }
    }

    // Set response headers
    res.set({
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000', // 1 year cache (IPFS content is immutable)
      'X-Content-CID': cid
    });

    res.send(content);

  } catch (error) {
    logger.error('Error fetching from IPFS:', error);
    
    if (error.message.includes('not found') || error.message.includes('404')) {
      return res.status(404).json({
        error: 'CID not found',
        details: error.message
      });
    }
    
    if (error.message.includes('timeout') || error.message.includes('timed out')) {
      return res.status(504).json({
        error: 'Request timeout',
        details: error.message
      });
    }
    
    return res.status(500).json({
      error: 'Failed to fetch from IPFS',
      details: error.message
    });
  }
});

/**
 * POST /api/rubrics/validate
 * Validate rubric JSON structure
 */
router.post('/rubrics/validate', async (req, res) => {
  try {
    const { rubric } = req.body;

    if (!rubric) {
      return res.status(400).json({
        error: 'Missing rubric',
        details: 'Request body must include rubric object'
      });
    }

    const { validateRubric } = require('../utils/validation');
    const result = validateRubric(rubric);

    res.json({
      valid: result.valid,
      errors: result.errors,
      warnings: [] // Can add warnings for non-critical issues
    });

  } catch (error) {
    logger.error('Error validating rubric:', error);
    res.status(500).json({
      error: 'Failed to validate rubric',
      details: error.message
    });
  }
});

module.exports = router;

