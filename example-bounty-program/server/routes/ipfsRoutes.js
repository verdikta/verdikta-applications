const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const { validateRubric } = require('../utils/validation');

const router = express.Router();
const TMP_DIR = path.join(__dirname, '..', 'tmp');

// robust boolean reader: true if "1|true|yes|on" (case/space-insensitive)
function readBool(v) {
  if (v == null) return false;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

// evaluate once at module load; we’ll also allow a per-request override (?dev=1)
const DEV_ENV = readBool(process.env.DEV_FAKE_RUBRIC_CID);

async function ensureTmp() {
  try { await fs.mkdir(TMP_DIR, { recursive: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: `Failed to create tmp dir: ${e.message}` }; }
}

function stringifyErr(e) {
  if (!e) return 'Unknown error';
  if (e.response?.data) { try { return JSON.stringify(e.response.data); } catch {} return String(e.response.data); }
  if (e.data)           { try { return JSON.stringify(e.data); } catch {} return String(e.data); }
  return e.message || String(e);
}

// POST /api/rubrics -> save rubric JSON to IPFS (or return dev CID)
router.post('/rubrics', async (req, res) => {
  const devQuery = readBool(req.query.dev); // ?dev=1 forces bypass
  const devBypass = devQuery || DEV_ENV;

  logger.info('[rubrics] POST', {
    devQuery, DEV_ENV, devBypass,
    envRaw: process.env.DEV_FAKE_RUBRIC_CID || null
  });

  try {
    const { rubric, classId } = req.body || {};
    if (!rubric || typeof rubric !== 'object') {
      return res.status(400).json({ success: false, error: 'rubric body is required' });
    }
    const v = validateRubric(rubric);
    if (!v.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid rubric',
        details: 'Rubric validation failed',
        errors: v.errors || []
      });
    }

    const tmpOk = await ensureTmp();
    if (!tmpOk.ok) {
      return res.status(500).json({ success: false, error: tmpOk.error });
    }

    const rubricWithMeta = {
      ...rubric,
      version: rubric.version || '1.0',
      classId: classId ?? 128,
      createdAt: new Date().toISOString(),
    };

    const tmpFile = path.join(TMP_DIR, `rubric-${Date.now()}.json`);
    try {
      await fs.writeFile(tmpFile, JSON.stringify(rubricWithMeta, null, 2), 'utf8');
    } catch (e) {
      return res.status(500).json({ success: false, error: `Failed to write temporary rubric file: ${e.message}` });
    }

    // dev bypass
    if (devBypass) {
      const fake = `dev-${path.basename(tmpFile)}`;
      logger.warn('[rubrics] DEV bypass active; returning fake CID', { fake });
      return res.json({ success: true, rubricCid: fake });
    }

    // real IPFS upload
    const ipfs = req.app.locals.ipfsClient;
    if (!ipfs || typeof ipfs.uploadToIPFS !== 'function') {
      return res.status(500).json({ success: false, error: 'IPFS client not initialized on server' });
    }

    let rubricCid;
    try {
      logger.info('[rubrics] uploading to IPFS', { bytes: JSON.stringify(rubricWithMeta).length });
      rubricCid = await ipfs.uploadToIPFS(tmpFile);
    } catch (e) {
      const msg = stringifyErr(e);
      logger.error('[rubrics] IPFS upload failed', { msg });
      return res.status(500).json({ success: false, error: `IPFS upload failed: ${msg}` });
    } finally {
      fs.unlink(tmpFile).catch(() => {});
    }

    logger.info('[rubrics] success', { rubricCid });
    return res.json({ success: true, rubricCid });
  } catch (err) {
    logger.error('[rubrics] unhandled error', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

// GET /api/fetch/:cid -> fetch as text (convenience)
router.get('/fetch/:cid', async (req, res) => {
  try {
    const ipfs = req.app.locals.ipfsClient;
    if (!ipfs) return res.status(500).send('IPFS client not initialized');

    const data = await ipfs.fetchFromIPFS(req.params.cid);
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.send(data);
  } catch (err) {
    const msg = stringifyErr(err);
    logger.error('[fetch] failed', { cid: req.params.cid, msg });
    return res.status(500).json({ error: `Fetch failed: ${msg}` });
  }
});

// Diagnostics
router.get('/diagnostics/ipfs', async (req, res) => {
  const ipfs = req.app.locals.ipfsClient;
  const tmpOk = await ensureTmp();
  return res.json({
    ipfsClient: !!ipfs,
    hasUploadFn: !!(ipfs && typeof ipfs.uploadToIPFS === 'function'),
    tmpDirOk: tmpOk.ok,
    tmpError: tmpOk.error || null,
    devEnv: DEV_ENV
  });
});

module.exports = router;

