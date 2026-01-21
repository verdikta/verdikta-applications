// server/routes/resolveBounty.js
const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const { config } = require('../config');

const ESCROW_ADDRESS = config.bountyEscrowAddress;
const RPC_PROVIDER_URL = config.rpcUrl;

if (!ESCROW_ADDRESS) {
  console.warn('[resolve-bounty] BOUNTY_ESCROW_ADDRESS not set in config');
}
if (!RPC_PROVIDER_URL) {
  console.warn('[resolve-bounty] RPC_URL not set in config');
}

const BOUNTY_ABI = [
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string rubricCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)",
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (address,string,uint64,uint8,uint256,uint256,uint64,uint8,address,uint256)"
];

function getProvider() {
  if (!RPC_PROVIDER_URL) throw new Error('RPC provider not configured');
  return new ethers.JsonRpcProvider(RPC_PROVIDER_URL);
}

// POST /api/resolve-bounty
// body: { creator, rubricCid?, submissionDeadline, txHash?, lookback?, deadlineToleranceSec? }
router.post('/api/resolve-bounty', async (req, res) => {
  try {
    const {
      creator,
      rubricCid,
      submissionDeadline,
      txHash,
      lookback = 300,
      deadlineToleranceSec = 300
    } = req.body || {};

    if (!ESCROW_ADDRESS) return res.status(500).json({ success: false, error: 'ESCROW_ADDRESS missing' });
    if (!creator || !submissionDeadline) {
      return res.status(400).json({ success: false, error: 'creator and submissionDeadline are required' });
    }

    const provider = getProvider();
    const escrow = new ethers.Contract(ESCROW_ADDRESS, BOUNTY_ABI, provider);

    // 1) Fast path: parse tx logs if txHash provided
    if (txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt?.logs?.length) {
        const iface = new ethers.Interface([BOUNTY_ABI[0]]);
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== ESCROW_ADDRESS.toLowerCase()) continue;
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === 'BountyCreated') {
              const bountyId = Number(parsed.args.bountyId);
              return res.json({ success: true, method: 'tx', bountyId });
            }
          } catch { /* not our event */ }
        }
      }
      // if not found, fall through to state scan
    }

    // 2) State scan (batched, bounded)
    const total = Number(await escrow.bountyCount());
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(404).json({ success: false, error: 'No bounties on chain yet' });
    }

    const start = Math.max(0, total - 1);
    const stop  = Math.max(0, total - 1 - Math.max(1, Number(lookback)));
    const wantCreator  = String(creator).toLowerCase();
    const wantCid      = rubricCid ? String(rubricCid) : '';
    const wantDeadline = Number(submissionDeadline);
    const tol          = Math.max(0, Number(deadlineToleranceSec));

    let best = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    const batchSize = 40;
    let cursor = start;
    while (cursor >= stop) {
      const ids = [];
      for (let i = 0; i < batchSize && cursor >= stop; i++, cursor--) ids.push(cursor);

      const results = await Promise.allSettled(
        ids.map(async (i) => {
          const b = await escrow.getBounty(i);
          const bCreator  = (b[0] || '').toLowerCase();
          if (bCreator !== wantCreator) return null;
          const bCid      = b[1] || '';
          const bDeadline = Number(b[6] || 0);
          const delta     = Math.abs(bDeadline - wantDeadline);
          const cidOk      = !wantCid || wantCid === bCid;
          const deadlineOk = delta <= tol;
          if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) return { id: i, delta };
          return null;
        })
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          if (r.value.delta < bestDelta) {
            best = r.value.id;
            bestDelta = r.value.delta;
            if (bestDelta === 0) {
              return res.json({ success: true, method: 'state', bountyId: best, delta: bestDelta });
            }
          }
        }
      }
    }

    if (best != null) {
      return res.json({ success: true, method: 'state', bountyId: best, delta: bestDelta });
    }

    return res.status(404).json({ success: false, error: 'No matching bounty found' });
  } catch (err) {
    console.error('[resolve-bounty] error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Internal error' });
  }
});

module.exports = router;

