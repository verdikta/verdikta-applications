const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const logger = require('../utils/logger');

const router = express.Router();

// -------------------- CONFIG --------------------
function readBool(v) { return /^(1|true|yes|on)$/i.test(String(v || '').trim()); }
const TMP_BASE = process.env.VERDIKTA_TMP_DIR || path.join(os.tmpdir(), 'verdikta');

const PIN_TIMEOUT_MS = Number(process.env.PIN_TIMEOUT_MS || 20000);
const PINATA_BASE = (process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud').replace(/\/+$/,'');
const PINATA_RAW = process.env.IPFS_PINNING_KEY || '';
// Accept JWT with or without "Bearer "
const PINATA_AUTH = PINATA_RAW.startsWith('Bearer ') ? PINATA_RAW : (PINATA_RAW ? `Bearer ${PINATA_RAW}` : '');

const DEV_ENV_FAKE = readBool(process.env.DEV_FAKE_RUBRIC_CID);

// -------------------- UTILS --------------------
async function ensureTmp() {
  await fs.mkdir(TMP_BASE, { recursive: true });
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

function normalizeProviderError(err) {
  const out = { message: err?.message || String(err) };
  if (err?.response) {
    out.providerStatus = err.response.status;
    try {
      out.providerBody = typeof err.response.data === 'string'
        ? err.response.data
        : JSON.stringify(err.response.data);
    } catch {
      out.providerBody = String(err.response.data);
    }
  } else if (err?.status) {
    out.providerStatus = err.status;
  }
  if (err?.stack) out.stack = err.stack.split('\n')[0];
  return out;
}

/** Pin JSON content at Pinata (no multipart). Returns IpfsHash string. */
async function pinJsonToPinata(contentObj, name = 'verdikta-json') {
  if (!PINATA_AUTH) throw new Error('IPFS_PINNING_KEY not set');
  const url = `${PINATA_BASE}/pinning/pinJSONToIPFS`;
  const body = {
    pinataContent: contentObj,
    pinataMetadata: { name }
  };

  const r = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': PINATA_AUTH,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }),
    PIN_TIMEOUT_MS,
    'Pinata pinJSONToIPFS'
  );

  const text = await r.text();
  if (!r.ok) {
    let parsed;
    try { parsed = JSON.parse(text); } catch {}
    const err = new Error(`Pinata returned ${r.status}`);
    err.status = r.status;
    err.response = { status: r.status, data: parsed ?? text };
    throw err;
  }
  const parsed = JSON.parse(text);
  if (!parsed?.IpfsHash) throw new Error('Pinata response missing IpfsHash');
  return parsed.IpfsHash;
}

// -------------------- RUBRICS: pin JSON --------------------
router.post('/rubrics', async (req, res) => {
  const t0 = Date.now();
  try {
    await ensureTmp();

    const { rubric, classId } = req.body || {};
    if (!rubric || typeof rubric !== 'object') {
      return res.status(400).json({ success: false, error: 'rubric body is required' });
    }
    if (!Array.isArray(rubric.criteria) || rubric.criteria.length < 1) {
      return res.status(400).json({ success: false, error: 'Invalid rubric: criteria required' });
    }

    // Enrich with metadata
    const rubricWithMeta = {
      ...rubric,
      version: rubric.version || '1.0',
      classId: classId ?? 128,
      createdAt: new Date().toISOString(),
    };

    // Dev bypass (query OR env)
    const devBypass = readBool(req.query?.dev) || DEV_ENV_FAKE;
    if (devBypass) {
      // Write once to OS temp to make debugging easy; return a fake CID
      const tmpPath = path.join(
        TMP_BASE,
        `rubric-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );
      try {
        await fs.writeFile(tmpPath, JSON.stringify(rubricWithMeta, null, 2), 'utf8');
      } catch (e) {
        logger.warn('[rubrics] dev write failed (continuing)', { msg: e.message });
      }
      const cid = `dev-${path.basename(tmpPath)}`;
      logger.warn('[rubrics] DEV bypass active — returning fake CID', { cid, durMs: Date.now() - t0 });
      return res.json({ success: true, rubricCid: cid });
    }

    // Pin for real
    const cid = await pinJsonToPinata(rubricWithMeta, `rubric-${rubric.title || 'untitled'}`);
    logger.info('[rubrics] pinned JSON rubric', { cid, durMs: Date.now() - t0 });
    return res.json({ success: true, rubricCid: cid });

  } catch (e) {
    const details = normalizeProviderError(e);
    logger.error('[rubrics] failed', { ...details });
    // 502 to indicate upstream/pinning failure
    return res.status(502).json({ success: false, error: 'IPFS JSON pin failed', details });
  }
});

// -------------------- FETCH VIA IPFS CLIENT --------------------
router.get('/fetch/:cid', async (req, res) => {
  try {
    const ipfs = req.app.locals.ipfsClient;
    if (!ipfs) return res.status(500).send('IPFS client not initialized');

    const data = await withTimeout(ipfs.fetchFromIPFS(req.params.cid), PIN_TIMEOUT_MS, 'IPFS fetch');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    return res.send(data);
  } catch (err) {
    const details = normalizeProviderError(err);
    logger.error('[fetch] failed', { cid: req.params.cid, ...details });
    return res.status(502).json({ error: 'Fetch failed', details });
  }
});

// -------------------- DIAGNOSTICS --------------------
router.get('/diagnostics/ipfs', async (req, res) => {
  const ipfs = req.app.locals.ipfsClient;
  try { await ensureTmp(); } catch {}
  res.json({
    ipfsClient: !!ipfs,
    hasUploadFn: !!(ipfs && typeof ipfs.uploadToIPFS === 'function'),
    tmpDirOk: true,
    gateway: process.env.IPFS_GATEWAY || null,
    pinService: process.env.IPFS_PINNING_SERVICE || null,
    keyPresent: !!PINATA_AUTH,
    devEnv: DEV_ENV_FAKE || false
  });
});

// Auth probe
router.get('/diagnostics/ipfs/auth', async (req, res) => {
  try {
    if (!PINATA_AUTH) {
      return res.status(400).json({ success: false, error: 'IPFS_PINNING_KEY not set' });
    }
    const url = `${PINATA_BASE}/data/testAuthentication`;
    const r = await withTimeout(
      fetch(url, { headers: { Authorization: PINATA_AUTH } }),
      PIN_TIMEOUT_MS,
      'Pinata auth'
    );
    const body = await r.text();
    return res.status(r.status).json({ success: r.ok, status: r.status, body });
  } catch (e) {
    const details = normalizeProviderError(e);
    logger.error('[ipfs auth probe] failed', { ...details });
    return res.status(502).json({ success: false, error: 'Auth probe failed', details });
  }
});

// JSON pin probe (mirrors /rubrics path)
router.post('/diagnostics/ipfs/pin', async (req, res) => {
  try {
    // Respect dev bypass here too if set via query/env, to test both paths
    const devBypass = readBool(req.query?.dev) || DEV_ENV_FAKE;
    if (devBypass) {
      const tmpPath = path.join(
        TMP_BASE,
        `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
      );
      try {
        await fs.writeFile(tmpPath, JSON.stringify({ probe: true, t: Date.now() }, null, 2), 'utf8');
      } catch (e) {
        logger.warn('[ipfs pin probe] dev write failed', { msg: e.message });
      }
      return res.json({ success: true, cid: `dev-${path.basename(tmpPath)}` });
    }

    const cid = await pinJsonToPinata({ probe: true, t: Date.now() }, 'verdikta-probe');
    return res.json({ success: true, cid });
  } catch (e) {
    const details = normalizeProviderError(e);
    logger.error('[ipfs pin probe] failed', { ...details });
    return res.status(502).json({ success: false, error: 'Pin probe failed', details });
  }
});

module.exports = router;

