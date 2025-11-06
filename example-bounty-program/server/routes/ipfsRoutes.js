const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const logger = require('../utils/logger');

const router = express.Router();
const TMP_DIR = path.join(__dirname, '..', 'tmp');

async function ensureTmp() {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

const PIN_TIMEOUT_MS = Number(process.env.PIN_TIMEOUT_MS || 20000);
const PINATA_BASE = (process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud').replace(/\/+$/,'');
// Expect RAW JWT in env (no "Bearer ")
const PINATA_JWT = process.env.IPFS_PINNING_KEY || '';
const PINATA_AUTH_HEADER = PINATA_JWT
  ? (PINATA_JWT.toLowerCase().startsWith('bearer ') ? PINATA_JWT : `Bearer ${PINATA_JWT}`)
  : '';

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
  if (!PINATA_AUTH_HEADER) throw new Error('IPFS_PINNING_KEY not set');
  const url = `${PINATA_BASE}/pinning/pinJSONToIPFS`;
  const body = {
    pinataContent: contentObj,
    pinataMetadata: { name }
  };
  const r = await withTimeout(
    fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': PINATA_AUTH_HEADER,   // <- we add "Bearer " here
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

// -------------------- RUBRICS: pin JSON (no file streaming) --------------------
router.post('/rubrics', async (req, res) => {
  const t0 = Date.now();
  try {
    const { rubric, classId } = req.body || {};
    if (!rubric || typeof rubric !== 'object') {
      return res.status(400).json({ success: false, error: 'rubric body is required' });
    }
    if (!Array.isArray(rubric.criteria) || rubric.criteria.length < 1) {
      return res.status(400).json({ success: false, error: 'Invalid rubric: criteria required' });
    }

    // Enrich and pin as JSON (faster, safer)
    const rubricWithMeta = {
      ...rubric,
      version: rubric.version || '1.0',
      classId: classId ?? 128,
      createdAt: new Date().toISOString(),
    };

    const cid = await pinJsonToPinata(rubricWithMeta, `rubric-${rubric.title || 'untitled'}`);
    logger.info('[rubrics] pinned JSON rubric', { cid, durMs: Date.now() - t0 });

    return res.json({ success: true, rubricCid: cid });
  } catch (e) {
    const details = normalizeProviderError(e);
    logger.error('[rubrics] failed', { ...details });
    return res.status(502).json({ success: false, error: 'IPFS JSON pin failed', details });
  }
});

// -------------------- FETCH VIA IPFS CLIENT (unchanged) --------------------
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
    keyPresent: !!PINATA_JWT
  });
});

// Auth probe
router.get('/diagnostics/ipfs/auth', async (req, res) => {
  try {
    if (!PINATA_AUTH_HEADER) {
      return res.status(400).json({ success: false, error: 'IPFS_PINNING_KEY not set' });
    }
    const url = `${PINATA_BASE}/data/testAuthentication`;
    const r = await withTimeout(
      fetch(url, { headers: { Authorization: PINATA_AUTH_HEADER } }),
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

// JSON pin probe
router.post('/diagnostics/ipfs/pin', async (req, res) => {
  try {
    const cid = await pinJsonToPinata({ probe: true, t: Date.now() }, 'verdikta-probe');
    return res.json({ success: true, cid });
  } catch (e) {
    const details = normalizeProviderError(e);
    logger.error('[ipfs pin probe] failed', { ...details });
    return res.status(502).json({ success: false, error: 'Pin probe failed', details });
  }
});

module.exports = router;

