const express = require('express');
const router = express.Router();

const PROJECT = 'example-agents';
const VERSION = require('../package.json').version;

router.get('/status', (_req, res) => {
  res.json({
    project: PROJECT,
    version: VERSION,
    status: 'coming-soon',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
