const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
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
  try {
    let job;
    try {
      job = await jobStorage.getJob(jobId);
    } catch (e) {
      // Fallback: try jobId - 1 for legacy URLs (old 1-based IDs)
      if (jobId > 0) {
        job = await jobStorage.getJob(jobId - 1);
        if (job) {
          job._legacyRedirect = jobId - 1; // Signal to caller to redirect
        }
      }
      if (!job) throw e;
    }
    const onChainId = job.jobId;
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

    // Get local submission data for clientType
    const localSubmission = job.submissions?.find(s => s.submissionId === submissionId);

    // IMPORTANT: After payout, contract sets payoutWei to 0 to prevent double-payment
    // So we need to get the original amount from the job record for receipts
    // Convert job.bountyAmount (ETH) back to wei for consistency
    const payoutWei = bounty.payoutWei && bounty.payoutWei.toString() !== '0' 
      ? bounty.payoutWei 
      : ethers.parseEther(String(job.bountyAmount || 0));

    // Create a new bounty object with the corrected payoutWei
    // (ethers Result objects are immutable, so we need to create a new plain object)
    const bountyWithCorrectPayout = {
      creator: bounty.creator,
      evaluationCid: bounty.evaluationCid,
      requestedClass: bounty.requestedClass,
      threshold: bounty.threshold,
      payoutWei: payoutWei, // Use the corrected amount
      createdAt: bounty.createdAt,
      submissionDeadline: bounty.submissionDeadline,
      status: bounty.status,
      winner: bounty.winner,
      submissions: bounty.submissions
    };

    return { 
      job, 
      onChainId: Number(onChainId), 
      bounty: bountyWithCorrectPayout,
      submission, 
      localSubmission 
    };
  } catch (error) {
    logger.error('[loadReceiptData] Error', {
      jobId,
      submissionId,
      error: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });
    throw error;
  }
}

async function fetchEthPrice() {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { timeout: 5000 }
    );
    const data = await response.json();
    return data?.ethereum?.usd || null;
  } catch (err) {
    logger.warn('Failed to fetch ETH price', { error: err.message });
    return null;
  }
}

function formatEthAmount(weiAmount) {
  // Format with up to 18 decimal places (full precision), removing only trailing zeros
  const ethValue = ethers.formatEther(weiAmount);
  // Don't convert to number - keep as string to preserve precision
  // Just remove trailing zeros after decimal point
  return ethValue.replace(/\.?0+$/, '');
}

function getWinnerLabel(submission, localSubmission) {
  const isBot = localSubmission?.clientType === 'bot';
  
  if (isBot) {
    // For bots, use Agent + pseudonym
    const agentId = pseudonymousAgentId(submission.hunter);
    return { label: `Agent ${agentId}`, type: 'agent' };
  } else {
    // For humans/frontend users, use pseudonymous wallet address
    const addr = submission.hunter || '';
    const short = addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'Unknown';
    return { label: short, type: 'human' };
  }
}

// Public receipt URL (server-rendered for OG tags)
router.get('/r/:jobId/:submissionId', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const submissionId = parseInt(req.params.submissionId, 10);

  if (Number.isNaN(jobId) || Number.isNaN(submissionId)) {
    return res.status(400).send('Bad Request');
  }

  try {
    const { job, onChainId, bounty, submission, localSubmission } = await loadReceiptData(jobId, submissionId);

    // Redirect legacy URLs (old 1-based jobId) to new 0-based
    if (job._legacyRedirect != null) {
      return res.redirect(301, `/r/${job._legacyRedirect}/${submissionId}`);
    }

    // Gate: receipts only for paid winners
    if (!isPaidWinner({ bounty, submission })) {
      return res.status(404).send('Receipt not found');
    }

    const amountEth = formatEthAmount(bounty.payoutWei);
    const title = job.title || `Bounty #${onChainId}`;
    const winnerInfo = getWinnerLabel(submission, localSubmission);
    const winnerLabel = winnerInfo.label;
    const networkName = config.networkName || 'Base';
    const submissionDisplay = submissionId + 1; // Display as 1-indexed for users

    // Fetch ETH price for USD conversion
    const ethPriceUSD = await fetchEthPrice();
    const amountUSD = ethPriceUSD ? (parseFloat(amountEth) * ethPriceUSD).toFixed(2) : null;

    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const receiptUrl = `${proto}://${req.get('host')}/r/${jobId}/${submissionId}`;
    // Use PNG for better X/Twitter compatibility
    const ogImageUrl = `${proto}://${req.get('host')}/og/receipt/${jobId}/${submissionId}.png`;

    const ogTitle = `Receipt: PASS — ${amountEth} ETH${amountUSD ? ` ($${amountUSD})` : ''} — ${title}`;
    const ogDesc = `${winnerLabel} earned ${amountEth} ETH${amountUSD ? ` ($${amountUSD} USD)` : ''}. Final verdict: PASS (paid).`;

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
    .header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
    .verdikta-logo{display:flex;align-items:center;gap:8px;color:#8ab4ff;font-weight:600;font-size:14px;text-decoration:none;}
    .verdikta-logo svg{width:32px;height:32px;}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
    .badge{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;background:#1f1f24;border:1px solid #2b2b2f;font-weight:600;font-size:12px;}
    .pass{background:rgba(0,212,170,0.12);border-color:rgba(0,212,170,0.35);color:#00d4aa;}
    .amt{font-size:34px;font-weight:800;letter-spacing:-0.02em;margin:14px 0 6px;}
    .title{font-size:18px;color:#d7d7db;margin:0 0 10px;}
    .muted{color:#9a9aa3;font-size:13px;}
    .mono{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
    a{color:#8ab4ff;text-decoration:none;}
    a:hover{text-decoration:underline;}
    .copy{margin-top:14px;padding:12px;border-radius:12px;background:#101013;border:1px solid #2b2b2f;}
    .copy-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
    .copy-btn{padding:4px 12px;background:#2b2b2f;border:1px solid #3b3b3f;border-radius:6px;color:#8ab4ff;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.2s;}
    .copy-btn:hover{background:#3b3b3f;border-color:#4b4b5f;color:#fff;}
    .copy-btn:active{transform:scale(0.95);}
    .footer{margin-top:24px;padding-top:16px;border-top:1px solid #2b2b2f;text-align:center;}
    .powered-by{display:inline-flex;flex-direction:column;align-items:center;gap:4px;color:#9a9aa3;font-size:12px;text-decoration:none;}
    .powered-by-line{display:flex;align-items:center;gap:8px;}
    .powered-by img{height:24px;width:auto;opacity:0.8;}
    .powered-by:hover{color:#8ab4ff;}
    .powered-by:hover img{opacity:1;}
    .tagline{font-size:11px;color:#7a7a83;font-style:italic;}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="row">
        <span class="badge pass">✅ PAID · PASS</span>
        <span class="badge">${escapeHtml(networkName)}</span>
        <span class="badge mono">Bounty #${onChainId}</span>
        <span class="badge mono">Submission #${submissionDisplay}</span>
      </div>
      <a href="https://bounties.verdikta.org" class="verdikta-logo">
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="32" cy="32" r="28" stroke="#667eea" stroke-width="4" fill="none"/>
          <circle cx="32" cy="32" r="18" stroke="#667eea" stroke-width="4" fill="none"/>
          <circle cx="32" cy="32" r="8" stroke="#667eea" stroke-width="4" fill="none"/>
        </svg>
        <span>Verdikta Bounties</span>
      </a>
    </div>

    <div class="amt">${escapeHtml(amountEth)} ETH${amountUSD ? ` <span style="font-size:0.6em;color:#9a9aa3">($${escapeHtml(amountUSD)} USD)</span>` : ''}</div>
    <p class="title">${escapeHtml(title)}</p>
    <p class="muted">Winner: <span class="mono">${escapeHtml(winnerLabel)}</span>${winnerInfo.type === 'agent' ? ' <span class="badge" style="font-size:11px;padding:3px 6px">🤖 AI Agent</span>' : ''} · Finalized: <span class="mono">${escapeHtml(String(Number(submission.finalizedAt || 0)))}</span></p>

    <div class="copy">
      <div class="copy-header">
        <div class="muted">Share text</div>
        <button class="copy-btn" onclick="copyShareText()">📋 Copy</button>
      </div>
      <div class="mono" id="share-text">Receipt: ${escapeHtml(winnerLabel)} earned ${escapeHtml(amountEth)} ETH${amountUSD ? ` ($${escapeHtml(amountUSD)} USD)` : ""} ✅ "${escapeHtml(title)}" ${escapeHtml(receiptUrl)}</div>
    </div>

    <script>
      function copyShareText() {
        const text = document.getElementById('share-text').textContent;
        navigator.clipboard.writeText(text).then(() => {
          const btn = document.querySelector('.copy-btn');
          const originalText = btn.textContent;
          btn.textContent = '✅ Copied!';
          btn.style.background = 'rgba(0,212,170,0.2)';
          btn.style.borderColor = 'rgba(0,212,170,0.35)';
          btn.style.color = '#00d4aa';
          setTimeout(() => {
            btn.textContent = originalText;
            btn.style.background = '';
            btn.style.borderColor = '';
            btn.style.color = '';
          }, 2000);
        }).catch(err => {
          alert('Failed to copy text');
        });
      }
    </script>

    <p class="muted" style="margin-top:14px">(This receipt is generated from on-chain state. ${winnerInfo.type === 'human' ? 'Winner address is pseudonymous.' : ''})</p>

    <div class="footer">
      <a href="https://verdikta.org" class="powered-by" target="_blank" rel="noopener noreferrer">
        <div class="powered-by-line">
          <img src="/verdikta-logo.png" alt="Verdikta" />
          <span style="font-weight:600">Powered by Verdikta</span>
        </div>
        <span class="tagline">Trust at Machine Speed</span>
      </a>
    </div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    logger.error('[receipt] error', { 
      jobId, 
      submissionId, 
      msg: err?.message,
      stack: err?.stack?.split('\n').slice(0, 3).join('\n')
    });
    return res.status(404).send('Receipt not found');
  }
});

/**
 * Generate OG image SVG content
 * @param {Object} params - Receipt data
 * @returns {string} SVG content
 */
function generateReceiptSvg({ jobId, submissionId, onChainId, amountEth, amountUSD, title, winnerLabel, winnerType, networkName }) {
  const usdText = amountUSD ? ` ($${amountUSD} USD)` : '';
  const winnerTypeText = winnerType === 'agent' ? '🤖 AI Agent' : 'Human';
  const submissionDisplay = submissionId + 1; // Display as 1-indexed
  
  return `<?xml version="1.0" encoding="UTF-8"?>
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

  <!-- Verdikta Bounties Logo (top right) -->
  <g transform="translate(900, 90)">
    <circle cx="20" cy="20" r="16" stroke="#667eea" stroke-width="2.5" fill="none"/>
    <circle cx="20" cy="20" r="10" stroke="#667eea" stroke-width="2.5" fill="none"/>
    <circle cx="20" cy="20" r="4" stroke="#667eea" stroke-width="2.5" fill="none"/>
  </g>
  <text x="930" y="115" font-family="Arial, sans-serif" font-weight="700" font-size="16" fill="#8ab4ff">Verdikta Bounties</text>

  <rect x="100" y="105" width="190" height="44" rx="22" fill="rgba(0,212,170,0.12)" stroke="rgba(0,212,170,0.35)"/>
  <text x="195" y="135" text-anchor="middle" font-family="Arial, sans-serif" font-weight="800" font-size="18" fill="#00d4aa">✅ PAID · PASS</text>

  <rect x="310" y="105" width="160" height="44" rx="22" fill="#151518" stroke="#2b2b2f"/>
  <text x="390" y="135" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="16" fill="#d7d7db">${escapeHtml(networkName)}</text>

  <text x="100" y="240" font-family="Arial, sans-serif" font-weight="900" font-size="74" fill="#ffffff">${escapeHtml(amountEth)} ETH</text>
  ${amountUSD ? `<text x="100" y="280" font-family="Arial, sans-serif" font-weight="600" font-size="32" fill="#9a9aa3">$${escapeHtml(amountUSD)} USD</text>` : ''}

  <text x="100" y="${amountUSD ? '330' : '300'}" font-family="Arial, sans-serif" font-weight="600" font-size="28" fill="#d7d7db">${escapeHtml(title).slice(0, 70)}</text>

  <text x="100" y="${amountUSD ? '390' : '370'}" font-family="monospace" font-size="22" fill="#9a9aa3">Winner: ${escapeHtml(winnerLabel)} (${winnerTypeText}) · Bounty #${onChainId} · Submission #${submissionDisplay}</text>

  <rect x="100" y="420" width="1000" height="6" fill="url(#accent)" opacity="0.7"/>

  <text x="100" y="485" font-family="monospace" font-size="18" fill="#8ab4ff">bounties.verdikta.org/r/${jobId}/${submissionId}</text>
  <text x="100" y="525" font-family="Arial, sans-serif" font-size="16" fill="#9a9aa3">Powered by Verdikta · Trust at Machine Speed · On-chain proof</text>
</svg>`;
}

// OG image endpoint (SVG)
router.get('/og/receipt/:jobId/:submissionId.svg', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const submissionId = parseInt(req.params.submissionId, 10);
  if (Number.isNaN(jobId) || Number.isNaN(submissionId)) {
    return res.status(400).send('Bad Request');
  }

  try {
    const { job, onChainId, bounty, submission, localSubmission } = await loadReceiptData(jobId, submissionId);

    if (!isPaidWinner({ bounty, submission })) {
      return res.status(404).send('Not found');
    }

    const amountEth = formatEthAmount(bounty.payoutWei);
    const title = job.title || `Bounty #${onChainId}`;
    const winnerInfo = getWinnerLabel(submission, localSubmission);
    const ethPriceUSD = await fetchEthPrice();
    const amountUSD = ethPriceUSD ? (parseFloat(amountEth) * ethPriceUSD).toFixed(2) : null;

    const svg = generateReceiptSvg({ jobId, submissionId, onChainId, amountEth, amountUSD, title, winnerLabel: winnerInfo.label, winnerType: winnerInfo.type, networkName: config.networkName });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    // Allow caching; receipt content should be immutable once paid.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(svg);
  } catch (err) {
    logger.warn('[receipt-og] error', { jobId, submissionId, msg: err?.message });
    return res.status(404).send('Not found');
  }
});

// OG image endpoint (PNG) - better compatibility with X/Twitter
router.get('/og/receipt/:jobId/:submissionId.png', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const submissionId = parseInt(req.params.submissionId, 10);
  if (Number.isNaN(jobId) || Number.isNaN(submissionId)) {
    return res.status(400).send('Bad Request');
  }

  try {
    const { job, onChainId, bounty, submission, localSubmission } = await loadReceiptData(jobId, submissionId);

    if (!isPaidWinner({ bounty, submission })) {
      return res.status(404).send('Not found');
    }

    const amountEth = formatEthAmount(bounty.payoutWei);
    const title = job.title || `Bounty #${onChainId}`;
    const winnerInfo = getWinnerLabel(submission, localSubmission);
    const ethPriceUSD = await fetchEthPrice();
    const amountUSD = ethPriceUSD ? (parseFloat(amountEth) * ethPriceUSD).toFixed(2) : null;

    const svg = generateReceiptSvg({ jobId, submissionId, onChainId, amountEth, amountUSD, title, winnerLabel: winnerInfo.label, winnerType: winnerInfo.type, networkName: config.networkName });

    // Convert SVG to PNG using sharp
    const pngBuffer = await sharp(Buffer.from(svg))
      .png()
      .toBuffer();

    res.setHeader('Content-Type', 'image/png');
    // Allow caching; receipt content should be immutable once paid.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(pngBuffer);
  } catch (err) {
    logger.warn('[receipt-og-png] error', { jobId, submissionId, msg: err?.message });
    return res.status(404).send('Not found');
  }
});

// Share data endpoint - returns amount and agent ID for client share text
router.get('/r/:jobId/:submissionId/share', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const submissionId = parseInt(req.params.submissionId, 10);
  if (Number.isNaN(jobId) || Number.isNaN(submissionId)) {
    return res.status(400).json({ success: false, error: 'Bad Request' });
  }

  try {
    const { job, onChainId, bounty, submission, localSubmission } = await loadReceiptData(jobId, submissionId);

    if (!isPaidWinner({ bounty, submission })) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const amountEth = formatEthAmount(bounty.payoutWei);
    const title = job.title || `Bounty #${onChainId}`;
    const winnerInfo = getWinnerLabel(submission, localSubmission);
    const ethPriceUSD = await fetchEthPrice();
    const amountUSD = ethPriceUSD ? (parseFloat(amountEth) * ethPriceUSD).toFixed(2) : null;

    return res.json({
      success: true,
      jobId,
      submissionId,
      onChainId,
      amountEth,
      amountUSD,
      title,
      winnerLabel: winnerInfo.label,
      winnerType: winnerInfo.type,
      // Legacy field for backward compatibility
      agentId: winnerInfo.type === 'agent' ? winnerInfo.label.replace('Agent ', '') : null
    });
  } catch (err) {
    logger.warn('[receipt-share] error', { jobId, submissionId, msg: err?.message });
    return res.status(404).json({ success: false, error: 'Not found' });
  }
});

// Serve Verdikta logo for receipt footer
router.get('/verdikta-logo.png', (req, res) => {
  const logoPath = path.join(__dirname, '../../client/public/verdikta-logo.png');
  
  // Check if file exists
  if (!fs.existsSync(logoPath)) {
    return res.status(404).send('Logo not found');
  }
  
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
  res.sendFile(logoPath);
});

module.exports = router;
