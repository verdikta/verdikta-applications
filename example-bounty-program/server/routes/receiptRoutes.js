const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { config } = require('../config');
const jobStorage = require('../utils/jobStorage');
const logger = require('../utils/logger');

const router = express.Router();

// Minimal read ABI
const ESCROW_ABI = [
  'function getBounty(uint256 bountyId) view returns (tuple(address creator, string evaluationCid, uint64 requestedClass, uint8 threshold, uint256 payoutWei, uint256 createdAt, uint64 submissionDeadline, uint8 status, address winner, uint256 submissions))',
  'function getSubmission(uint256 bountyId, uint256 submissionId) view returns (tuple(address hunter, string evaluationCid, string hunterCid, address evalWallet, bytes32 verdiktaAggId, uint8 status, uint256 acceptance, uint256 rejection, string justificationCids, uint256 submittedAt, uint256 finalizedAt, uint256 linkMaxBudget, uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, string addendum))'
];

function providerRO() {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}

function escrowRO() {
  return new ethers.Contract(config.bountyEscrowAddress, ESCROW_ABI, providerRO());
}

function getReceiptSalt() {
  // Keep this server-side; MUST be set for stable pseudonyms.
  return config.receiptSalt || process.env.RECEIPT_SALT || '';
}

function pseudonymousAgentId(address) {
  const salt = getReceiptSalt();
  if (!salt) return 'UNKNOWN';
  const msg = String(address || '').toLowerCase();
  const h = crypto.createHmac('sha256', salt).update(msg).digest();
  // Base32-ish without padding (simple alphabet)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of h) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 10) break;
  }
  return out || 'UNKNOWN';
}

function isPaidWinner({ bounty, submission }) {
  // Contract enum (documented elsewhere): 3 = PassedPaid
  const statusIndex = Number(submission?.status);
  const passedPaid = statusIndex === 3;
  const hunter = (submission?.hunter || '').toLowerCase();
  const winner = (bounty?.winner || '').toLowerCase();
  return Boolean(passedPaid && hunter && winner && hunter === winner);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortHash(h) {
  if (!h) return '';
  const s = String(h);
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

async function loadReceiptData(jobId, submissionId) {
  const job = await jobStorage.getJob(jobId);
  const onChainId = job.onChainId ?? job.onChainBountyId ?? job.bountyId;
  if (onChainId == null) {
    const err = new Error('Job has no on-chain bounty ID');
    err.code = 'NO_ONCHAIN_ID';
    throw err;
  }

  const c = escrowRO();
  const [bounty, submission] = await Promise.all([
    c.getBounty(onChainId),
    c.getSubmission(onChainId, submissionId)
  ]);

  return { job, onChainId: Number(onChainId), bounty, submission };
}

// Public receipt URL (server-rendered for OG tags)
router.get('/r/:jobId/:submissionId', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const submissionId = parseInt(req.params.submissionId, 10);

  if (Number.isNaN(jobId) || Number.isNaN(submissionId)) {
    return res.status(400).send('Bad Request');
  }

  try {
    const { job, onChainId, bounty, submission } = await loadReceiptData(jobId, submissionId);

    // Gate: receipts only for paid winners
    if (!isPaidWinner({ bounty, submission })) {
      return res.status(404).send('Receipt not found');
    }

    const amountEth = ethers.formatEther(bounty.payoutWei);
    const title = job.title || `Bounty #${onChainId}`;

    const agentId = pseudonymousAgentId(submission.hunter);
    const agentLabel = `Agent ${agentId}`;

    const receiptUrl = `${req.protocol}://${req.get('host')}/r/${jobId}/${submissionId}`;
    const ogImageUrl = `${req.protocol}://${req.get('host')}/og/receipt/${jobId}/${submissionId}.svg`;

    const ogTitle = `Receipt: PASS — ${amountEth} ETH — ${title}`;
    const ogDesc = `${agentLabel} earned ${amountEth} ETH. Final verdict: PASS (paid).`;

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(ogTitle)}</title>
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escapeHtml(receiptUrl)}" />
  <meta property="og:title" content="${escapeHtml(ogTitle)}" />
  <meta property="og:description" content="${escapeHtml(ogDesc)}" />
  <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}" />
  <meta name="twitter:description" content="${escapeHtml(ogDesc)}" />
  <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
  <style>
    body{font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background:#0b0b0c; color:#fff; margin:0; padding:24px;}
    .card{max-width:820px;margin:0 auto;background:#141416;border:1px solid #2b2b2f;border-radius:16px;padding:20px;}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
    .badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:#1f1f24;border:1px solid #2b2b2f;font-weight:600;font-size:12px;}
    .pass{background:rgba(0,212,170,0.12);border-color:rgba(0,212,170,0.35);color:#00d4aa;}
    .amt{font-size:34px;font-weight:800;letter-spacing:-0.02em;margin:14px 0 6px;}
    .title{font-size:18px;color:#d7d7db;margin:0 0 10px;}
    .muted{color:#9a9aa3;font-size:13px;}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
    a{color:#8ab4ff}
    .copy{margin-top:14px;padding:12px;border-radius:12px;background:#101013;border:1px solid #2b2b2f;}
  </style>
</head>
<body>
  <div class="card">
    <div class="row">
      <span class="badge pass">✅ PAID · PASS</span>
      <span class="badge">Base</span>
      <span class="badge mono">Bounty ${onChainId}</span>
      <span class="badge mono">Submission ${submissionId}</span>
    </div>

    <div class="amt">${escapeHtml(amountEth)} ETH</div>
    <p class="title">${escapeHtml(title)}</p>
    <p class="muted">Winner: <span class="mono">${escapeHtml(agentLabel)}</span> · Finalized: <span class="mono">${escapeHtml(String(Number(submission.finalizedAt || 0)))}</span></p>

    <div class="copy">
      <div class="muted">Share text</div>
      <div class="mono">Receipt: ${escapeHtml(agentLabel)} earned ${escapeHtml(amountEth)} ETH ✅ “${escapeHtml(title)}” ${escapeHtml(receiptUrl)}</div>
    </div>

    <p class="muted" style="margin-top:14px">(This receipt is generated from on-chain state. Hunter address is intentionally pseudonymous.)</p>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    logger.warn('[receipt] error', { jobId, submissionId, msg: err?.message });
    return res.status(404).send('Receipt not found');
  }
});

// OG image endpoint (SVG). If we later need PNG for X, we can swap/augment.
router.get('/og/receipt/:jobId/:submissionId.svg', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const submissionId = parseInt(req.params.submissionId, 10);
  if (Number.isNaN(jobId) || Number.isNaN(submissionId)) {
    return res.status(400).send('Bad Request');
  }

  try {
    const { job, onChainId, bounty, submission } = await loadReceiptData(jobId, submissionId);

    if (!isPaidWinner({ bounty, submission })) {
      return res.status(404).send('Not found');
    }

    const amountEth = ethers.formatEther(bounty.payoutWei);
    const title = job.title || `Bounty #${onChainId}`;
    const agentId = pseudonymousAgentId(submission.hunter);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b0b0c"/>
      <stop offset="100%" stop-color="#141416"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00d4aa"/>
      <stop offset="100%" stop-color="#4aa3ff"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="1200" height="630" fill="url(#bg)"/>
  <rect x="60" y="60" width="1080" height="510" rx="28" fill="#101013" stroke="#2b2b2f" stroke-width="2"/>

  <rect x="100" y="105" width="190" height="44" rx="22" fill="rgba(0,212,170,0.12)" stroke="rgba(0,212,170,0.35)"/>
  <text x="195" y="135" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-weight="800" font-size="18" fill="#00d4aa">✅ PAID · PASS</text>

  <rect x="310" y="105" width="120" height="44" rx="22" fill="#151518" stroke="#2b2b2f"/>
  <text x="370" y="135" text-anchor="middle" font-family="ui-sans-serif, system-ui" font-weight="700" font-size="16" fill="#d7d7db">Base</text>

  <text x="100" y="240" font-family="ui-sans-serif, system-ui" font-weight="900" font-size="74" fill="#ffffff">${escapeHtml(amountEth)} ETH</text>

  <text x="100" y="300" font-family="ui-sans-serif, system-ui" font-weight="600" font-size="28" fill="#d7d7db">${escapeHtml(title).slice(0, 70)}</text>

  <text x="100" y="370" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas" font-size="22" fill="#9a9aa3">Winner: Agent ${escapeHtml(agentId)} · Bounty ${onChainId} · Submission ${submissionId}</text>

  <rect x="100" y="420" width="1000" height="6" fill="url(#accent)" opacity="0.7"/>

  <text x="100" y="485" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas" font-size="18" fill="#8ab4ff">bounties.verdikta.org/r/${jobId}/${submissionId}</text>
  <text x="100" y="525" font-family="ui-sans-serif, system-ui" font-size="16" fill="#9a9aa3">On-chain proof · Hunter address pseudonymous</text>
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    // Allow caching; receipt content should be immutable once paid.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(svg);
  } catch (err) {
    logger.warn('[receipt-og] error', { jobId, submissionId, msg: err?.message });
    return res.status(404).send('Not found');
  }
});

module.exports = router;
