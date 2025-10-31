// server/routes/ipfsRoutes.js
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

// POST /api/rubrics
// body: { rubric: object, classId?: number }
router.post('/rubrics', async (req, res) => {
  try {
    const { rubric, classId } = req.body || {};
    if (!rubric || typeof rubric !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing rubric object' });
    }
    if (!Array.isArray(rubric.criteria) || rubric.criteria.length < 1) {
      return res.status(400).json({
        success: false,
        error: 'Rubric validation failed',
        details: 'Criteria array must have at least one criterion'
      });
    }

    // write rubric JSON to a temp file
    const tmpDir = path.join(__dirname, '../tmp');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `rubric-${Date.now()}.json`);
    await fs.writeFile(tmpFile, JSON.stringify(rubric, null, 2));

    const ipfsClient = req.app.locals.ipfsClient;
    let rubricCid;
    try {
      rubricCid = await ipfsClient.uploadToIPFS(tmpFile);
      logger.info('Rubric uploaded to IPFS', { rubricCid, classId });
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }

    return res.json({ success: true, rubricCid });
  } catch (err) {
    logger.error('Rubric upload failed', { error: err.message });
    return res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// GET /api/fetch/:cid  — convenience passthrough (text)
router.get('/fetch/:cid', async (req, res) => {
  try {
    const ipfsClient = req.app.locals.ipfsClient;
    const content = await ipfsClient.fetchFromIPFS(req.params.cid);
    res.type('text/plain').send(content);
  } catch (err) {
    logger.error('Fetch from IPFS failed', { cid: req.params.cid, error: err.message });
    res.status(500).json({ error: 'Failed to fetch IPFS content', details: err.message });
  }
});

module.exports = router;

