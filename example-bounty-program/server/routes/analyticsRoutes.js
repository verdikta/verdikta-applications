/**
 * Analytics Routes
 * Provides analytics data for the bounty program dashboard
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const jobStorage = require('../utils/jobStorage');
const { config } = require('../config');
const { analyticsCache } = require('../utils/analyticsCacheService');
const { getVerdiktaService, isVerdiktaServiceAvailable } = require('../utils/verdiktaService');
const { getContractService } = require('../utils/contractService');
const { classMap } = require('@verdikta/common');
const { summarizeTemplateUsage } = require('../utils/templateUsage');
const hunterLinks = require('../utils/hunterLinks');
const scoreSpread = require('../utils/scoreSpread');
const { ethers } = require('ethers');

/**
 * GET /api/analytics/overview
 * Returns combined analytics overview (cached)
 */
router.get('/overview', async (req, res) => {
  try {
    const cacheKey = 'analytics_overview';
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: cached.timestamp,
        ageMs: cached.ageMs
      });
    }

    // Gather all analytics data
    const [arbiterData, bountyData, submissionData, systemData, fulfilledData, templateData, hunterData, roundData] = await Promise.all([
      getArbiterAnalytics(),
      getBountyAnalytics(),
      getSubmissionAnalytics(),
      getSystemHealth(),
      getFulfilledBounties(),
      getTemplateUsageAnalytics(),
      getHunterAnalytics(),
      getRoundAnalytics()
    ]);

    const result = {
      arbiters: arbiterData,
      bounties: bountyData,
      submissions: submissionData,
      system: systemData,
      fulfilledBounties: fulfilledData,
      templates: templateData,
      rounds: roundData,
      // Counts only; the per-address list is served by GET /hunters.
      hunters: {
        totalSubmitters: hunterData.totalSubmitters,
        totalWinners: hunterData.totalWinners,
        ...(await getConnectionCounts(hunterData))
      },
      generatedAt: Date.now()
    };

    analyticsCache.set(cacheKey, result);

    return res.json({
      success: true,
      data: result,
      cached: false
    });
  } catch (error) {
    logger.error('[analytics/overview] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get analytics overview',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/arbiters
 * Returns arbiter availability per class
 */
router.get('/arbiters', async (req, res) => {
  try {
    const cacheKey = 'analytics_arbiters';
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: cached.timestamp
      });
    }

    const data = await getArbiterAnalytics();
    analyticsCache.set(cacheKey, data);

    return res.json({
      success: true,
      data,
      cached: false
    });
  } catch (error) {
    logger.error('[analytics/arbiters] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get arbiter analytics',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/bounties
 * Returns bounty statistics
 */
router.get('/bounties', async (req, res) => {
  try {
    const cacheKey = 'analytics_bounties';
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: cached.timestamp
      });
    }

    const data = await getBountyAnalytics();
    analyticsCache.set(cacheKey, data);

    return res.json({
      success: true,
      data,
      cached: false
    });
  } catch (error) {
    logger.error('[analytics/bounties] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get bounty analytics',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/submissions
 * Returns submission statistics
 */
router.get('/submissions', async (req, res) => {
  try {
    const cacheKey = 'analytics_submissions';
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: cached.timestamp
      });
    }

    const data = await getSubmissionAnalytics();
    analyticsCache.set(cacheKey, data);

    return res.json({
      success: true,
      data,
      cached: false
    });
  } catch (error) {
    logger.error('[analytics/submissions] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get submission analytics',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/templates
 * Returns rubric template usage
 */
router.get('/templates', async (req, res) => {
  try {
    const cacheKey = 'analytics_templates';
    const cached = analyticsCache.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        cached: true,
        cachedAt: cached.timestamp
      });
    }

    const data = await getTemplateUsageAnalytics();
    analyticsCache.set(cacheKey, data);

    return res.json({
      success: true,
      data,
      cached: false
    });
  } catch (error) {
    logger.error('[analytics/templates] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get template usage',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/hunters?view=submitters|winners
 * Distinct hunter addresses with per-address submission and win counts.
 * view=winners keeps only addresses with at least one paid win.
 */
router.get('/hunters', async (req, res) => {
  try {
    const view = req.query.view === 'winners' ? 'winners' : 'submitters';
    const cacheKey = 'analytics_hunters';
    const cached = analyticsCache.get(cacheKey);
    const data = cached ? cached.data : await getHunterAnalytics();
    if (!cached) analyticsCache.set(cacheKey, data);

    const { groupOf } = await getConnections(data);
    const hunters = (view === 'winners' ? data.hunters.filter(h => h.wins > 0) : data.hunters)
      .map(h => ({ ...h, group: groupOf[h.address.toLowerCase()] ?? null }));

    return res.json({
      success: true,
      data: { ...data, view, hunters },
      cached: !!cached,
      cachedAt: cached?.timestamp
    });
  } catch (error) {
    logger.error('[analytics/hunters] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get hunter analytics',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/hunters/connections
 * Groups of hunter addresses linked on chain (one funded another, same parent
 * account, or a token transfer between them), from the cached background
 * analysis in utils/hunterLinks.js. Heuristic: links are evidence, not proof
 * of common ownership.
 */
router.get('/hunters/connections', async (req, res) => {
  try {
    const cacheKey = 'analytics_hunters';
    const cached = analyticsCache.get(cacheKey);
    const data = cached ? cached.data : await getHunterAnalytics();
    if (!cached) analyticsCache.set(cacheKey, data);

    const { groups, hubs, coverage } = await getConnections(data);
    const stats = new Map(data.hunters.map(h => [h.address.toLowerCase(), h]));
    const enriched = groups.map(g => {
      const members = g.addresses.map(a => {
        const h = stats.get(a) || {};
        return { address: h.address || a, submissions: h.submissions || 0, wins: h.wins || 0, ethWon: h.ethWon || 0 };
      }).sort((x, y) => y.wins - x.wins || y.submissions - x.submissions);
      return {
        id: g.id,
        members,
        wins: members.reduce((n, m) => n + m.wins, 0),
        ethWon: Math.round(members.reduce((n, m) => n + m.ethWon, 0) * 1e6) / 1e6,
        links: g.links
      };
    });

    return res.json({
      success: true,
      data: { groups: enriched, hubs, coverage, status: hunterLinks.getStatus() }
    });
  } catch (error) {
    logger.error('[analytics/hunters/connections] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get hunter connections',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/score-spread?days=14
 * How far apart the arbiters' scores are for the same submission in the same
 * round: per-round standard deviation of the FUND score over the round's N counted
 * reveals (getOutcomeScores), pooled and per day, the bonus-paid cluster where known,
 * each round's pass count against Q, plus every round (worst first) and a per-bounty roll-up.
 * Served from the background collection in utils/scoreSpread.js; never waits on RPC.
 */
router.get('/score-spread', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(scoreSpread.MAX_REPORT_DAYS, parseInt(req.query.days, 10) || 14));
    const cacheKey = `analytics_score_spread_${days}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached.data, cached: true, cachedAt: cached.timestamp });
    }
    const [state, listed] = await Promise.all([scoreSpread.readState(), jobStorage.listJobs({})]);
    const data = {
      ...scoreSpread.buildReport(state, listed.jobs || listed, { days }),
      status: scoreSpread.getStatus(),
      generatedAt: Date.now()
    };
    analyticsCache.set(cacheKey, data);
    return res.json({ success: true, data, cached: false });
  } catch (error) {
    logger.error('[analytics/score-spread] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get arbiter score spread',
      details: error.message
    });
  }
});

/**
 * GET /api/analytics/system
 * Returns system health and configuration
 */
router.get('/system', async (req, res) => {
  try {
    const data = await getSystemHealth();
    return res.json({
      success: true,
      data
    });
  } catch (error) {
    logger.error('[analytics/system] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to get system health',
      details: error.message
    });
  }
});

/**
 * POST /api/analytics/refresh
 * Invalidates cache and triggers blockchain sync for fresh data
 */
router.post('/refresh', async (req, res) => {
  try {
    // Clear analytics cache
    analyticsCache.clear();
    logger.info('Analytics cache manually cleared');

    // Trigger blockchain sync to get latest submission statuses
    let syncTriggered = false;
    try {
      const { getSyncService } = require('../utils/syncService');
      const syncService = getSyncService();
      if (syncService) {
        await syncService.syncNow();
        syncTriggered = true;
        logger.info('Blockchain sync triggered via analytics refresh');
      }
    } catch (syncErr) {
      logger.warn('Could not trigger blockchain sync', { msg: syncErr.message });
    }

    return res.json({
      success: true,
      message: syncTriggered ? 'Cache cleared and blockchain sync triggered' : 'Cache cleared (sync not available)'
    });
  } catch (error) {
    logger.error('[analytics/refresh] error', { msg: error.message });
    return res.status(500).json({
      error: 'Failed to refresh analytics',
      details: error.message
    });
  }
});

// ============================================================
// Analytics Data Fetching Functions
// ============================================================

/**
 * Get arbiter/oracle analytics from ReputationKeeper contract
 */
// Last successful arbiter read. A transient RPC failure (e.g. Infura 429
// "Too Many Requests") serves this, marked stale, instead of dropping the page to
// class-only data — and caching that degraded result for the full cache TTL.
let lastGoodArbiterAnalytics = null;

async function getArbiterAnalytics() {
  const verdiktaService = getVerdiktaService();

  // If Verdikta service is not configured, return class data from classMap only
  if (!verdiktaService) {
    logger.info('Verdikta service not available, returning class-only data');
    return getClassOnlyAnalytics('Verdikta aggregator not configured - showing class information only');
  }

  try {
    const arbiterData = await verdiktaService.getArbiterAvailabilityByClass();

    // Enrich with class names from classMap
    const enrichedByClass = {};
    for (const [classId, data] of Object.entries(arbiterData.byClass)) {
      const classInfo = classMap.getClass(Number(classId));
      enrichedByClass[classId] = {
        ...data,
        className: classInfo?.name || `Class ${classId}`,
        classDescription: classInfo?.description || '',
        shortName: classInfo?.shortName || null
      };
    }

    const result = {
      byClass: enrichedByClass,
      totalOracles: arbiterData.totalOracles,
      verdiktaConnected: true,
      timestamp: arbiterData.timestamp
    };
    lastGoodArbiterAnalytics = result;
    return result;
  } catch (error) {
    logger.error('Failed to get arbiter analytics from contract', { msg: error.message });
    if (lastGoodArbiterAnalytics) {
      return {
        ...lastGoodArbiterAnalytics,
        stale: true,
        message: 'Live arbiter data temporarily unavailable (blockchain RPC error) - showing the last successful read'
      };
    }
    // Nothing read yet since startup: fall back to class-only data
    return getClassOnlyAnalytics('Arbiter data temporarily unavailable (blockchain RPC error) - showing class information only. Try Refresh in a minute.');
  }
}

/**
 * Get class information without oracle data (fallback when Verdikta not available)
 */
function getClassOnlyAnalytics(message) {
  const classes = classMap.listClasses({});
  const byClass = {};

  for (const cls of classes) {
    const fullClass = classMap.getClass(Number(cls.id));
    byClass[cls.id] = {
      classId: Number(cls.id),
      className: cls.name || `Class ${cls.id}`,
      classDescription: fullClass?.description || '',
      status: cls.status,
      // No oracle data available
      active: null,
      new: null,
      blocked: null,
      total: null,
      avgQualityScore: null,
      avgTimelinessScore: null
    };
  }

  return {
    byClass,
    totalOracles: null,
    verdiktaConnected: false,
    message,
    timestamp: Date.now()
  };
}

/**
 * Effective historical bounty amount for analytics display.
 *
 * `job.bountyAmount` mirrors the contract's `payoutWei`, which is the *remaining*
 * escrow — not the original bounty value. Once a bounty is awarded, the contract
 * zeroes `payoutWei`, so the analytics row and totals lose the historical amount.
 *
 * For AWARDED (post-payout) or CLOSED (post-refund) bounties, fall back to the
 * determination-payment fields on the Bounty struct, which are preserved and
 * represent the paid-out amount (or the intended payout for non-windowed
 * bounties). Returns 0 only when we genuinely have no signal.
 */
function effectiveBountyAmount(job) {
  const cur = parseFloat(job?.bountyAmount);
  if (Number.isFinite(cur) && cur > 0) return cur;

  const arb = parseFloat(job?.arbiterDeterminationPayment);
  const cre = parseFloat(job?.creatorDeterminationPayment);
  const candidate = Math.max(
    Number.isFinite(arb) ? arb : 0,
    Number.isFinite(cre) ? cre : 0,
  );
  if (candidate > 0) return candidate;

  return Number.isFinite(cur) ? cur : 0;
}

/**
 * ETH actually paid to a bounty's winner: the escrow's PayoutSent.amountWei or
 * CreatorApproved.amountPaid (synced onto the winning submission and the job as
 * payoutWei / payoutAmountWei). The two configured payments differ (creator
 * approval vs arbiter pass), so their max is not what was paid. Records synced
 * before the amount was stored fall back to the payment that applies: the
 * creator's for a creator-approved winner, else the arbiters'.
 */
function paidAmountEth(job, winningSub) {
  const wei = winningSub?.payoutWei ?? job?.payoutAmountWei;
  if (wei != null && wei !== '') {
    try { return Number(ethers.formatEther(BigInt(String(wei)))); } catch { /* fall through */ }
  }
  const pay = parseFloat(winningSub?.creatorApproved ? job?.creatorDeterminationPayment : job?.arbiterDeterminationPayment);
  if (Number.isFinite(pay) && pay > 0) return pay;
  return effectiveBountyAmount(job);
}

/**
 * Get bounty statistics from job storage
 * Only counts jobs from the current contract
 */
async function getBountyAnalytics() {
  try {
    // listJobs({}) filters by current contract by default
    const jobs = await jobStorage.listJobs({});
    const jobList = jobs.jobs || jobs;

    // Calculate totals from filtered jobs only
    let totalETH = 0;
    let totalWithAmount = 0;
    const byStatus = {};

    for (const job of jobList) {
      // Count by status
      const status = job.status || 'UNKNOWN';
      byStatus[status] = (byStatus[status] || 0) + 1;

      // Sum ETH — use the effective historical amount so awarded bounties
      // (whose on-chain payoutWei has been zeroed) still contribute to the
      // lifetime total.
      const amount = effectiveBountyAmount(job);
      totalETH += amount;
      if (amount > 0) totalWithAmount++;
    }

    const avgBountyAmount = totalWithAmount > 0 ? totalETH / totalWithAmount : 0;

    return {
      byStatus,
      totalBounties: jobList.length,
      totalETH: Math.round(totalETH * 10000) / 10000,
      avgBountyAmount: Math.round(avgBountyAmount * 10000) / 10000,
      currentContract: config.bountyEscrowAddress,
      orphanedCount: 0, // Not relevant when filtering by current contract
      legacyCount: 0,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error('Failed to get bounty analytics', { msg: error.message });
    throw error;
  }
}

/**
 * Which outcome bucket a submission is in (v2, the escrow's Q-of-N rule). `round` is the live
 * round's state from checkEvaluationReady, for a submission whose local status still says the
 * round is in flight; otherwise the synced status decides. Buckets:
 *   approvedPaid      PassedPaid (oracle pass or creator approval, paid)
 *   approvedUnpaid    PassedUnpaid (passed after another submission won)
 *   passPending       the round passed (>= Q scores at the threshold): finalize pays
 *   awaitingCreator   PendingCreatorApproval
 *   awaitingRerun     soft fail (R..Q-1), or AwaitingRerun on-chain: may re-run
 *   noResult          a round with no result (dead round, bad result shape) or a re-run never taken
 *                     (RERUN_EXPIRED); the bond is returned
 *   hardFail          fewer than R scores at the threshold: Failed, bond forfeited to the creator
 *   evaluating        the round has no result yet
 *   prepared          prepared, not started
 *   unknown           none of the above
 */
function submissionBucket(sub, round = null) {
  const status = (sub.status || '').toLowerCase();
  const onChain = (sub.onChainStatus || '').toLowerCase();
  if (status === 'passedpaid' || onChain === 'passedpaid') return 'approvedPaid';
  if (status === 'passedunpaid' || onChain === 'passedunpaid' || sub.passedUnpaid) return 'approvedUnpaid';
  if (status === 'approved' || status === 'passed' || status === 'accepted') return sub.paidWinner ? 'approvedPaid' : 'approvedUnpaid';
  if (status === 'pendingcreatorapproval' || onChain === 'pendingcreatorapproval') return 'awaitingCreator';
  if (status === 'awaiting_rerun' || onChain === 'awaitingrerun' || status === 'soft_fail_pending_finalization') return 'awaitingRerun';
  if (status === 'no_result_pending_close' || status === 'timeout') return 'noResult';
  if (status === 'failed' || status === 'rejected' || onChain === 'failed') {
    return sub.failureReason === 'NO_RESULT' || sub.failureReason === 'RERUN_EXPIRED' ? 'noResult' : 'hardFail';
  }
  if (status === 'rejected_pending_finalization') return 'hardFail';
  if (status === 'accepted_pending_claim') return 'passPending';
  if (status === 'pending' || status === 'pendingverdikta' || status === 'pending_evaluation' || onChain === 'pendingverdikta') {
    if (round?.ready) {
      if (round.outcome === 'pass') return 'passPending';
      if (round.outcome === 'hard_fail') return 'hardFail';
      return 'awaitingRerun';   // soft fail, or a result of the wrong shape: finalize lets it re-run
    }
    if (round?.outcome === 'no_result') return 'noResult';
    return 'evaluating';
  }
  if (status === 'prepared' || onChain === 'prepared') return 'prepared';
  return 'unknown';
}

/**
 * Get submission statistics from job storage (v2: outcomes from the escrow's Q-of-N rule)
 */
async function getSubmissionAnalytics() {
  try {
    const jobs = await jobStorage.listJobs({});
    const jobList = jobs.jobs || jobs;

    const byOutcome = {
      approvedPaid: 0, approvedUnpaid: 0, passPending: 0, awaitingCreator: 0, awaitingRerun: 0,
      noResult: 0, hardFail: 0, evaluating: 0, prepared: 0, unknown: 0
    };
    let totalSubmissions = 0;
    let creatorApproved = 0;     // passed by the creator, not the arbiters: not in passRate
    const scores = [];
    const passCounts = [];
    const statusCounts = {}; // Track all status values for debugging
    const evaluatingSamples = []; // Sample of submissions counted as evaluating for debugging
    // v2 round and bond facts from the synced escrow events
    const v2 = { rerunSubmissions: 0, totalRounds: 0, bondsReturned: 0, bondReturnedWei: 0n, bondsForfeited: 0, bondForfeitedWei: 0n };

    for (const job of jobList) {
      if (!job.submissions) continue;

      for (const sub of job.submissions) {
        totalSubmissions++;
        const status = (sub.status || '').toLowerCase();
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        // A submission whose local status says the round is in flight: ask the escrow's lens.
        let round = null;
        if (['pending', 'pendingverdikta', 'pending_evaluation'].includes(status)) {
          const onChainSubmissionId = sub.onChainSubmissionId ?? sub.submissionId;
          if (job.jobId != null && onChainSubmissionId != null) {
            try {
              round = await getContractService().checkEvaluationReady(job.jobId, onChainSubmissionId);
            } catch (err) {
              logger.warn('Could not check evaluation ready', { bountyId: job.jobId, submissionId: onChainSubmissionId, msg: err.message });
            }
          }
        }
        const bucket = submissionBucket(sub, round);
        byOutcome[bucket]++;
        if (sub.creatorApproved) creatorApproved++;

        const acceptance = round?.ready ? round.scores?.acceptance : (sub.result?.acceptance ?? sub.acceptance ?? sub.score);
        if (['approvedPaid', 'approvedUnpaid', 'passPending'].includes(bucket) && !sub.creatorApproved && Number(acceptance) > 0) {
          scores.push(Number(acceptance));
        }
        const pc = round?.ready ? round.passCount : sub.passCount;
        if (pc != null && (round?.ready || sub.roundOutcome || ['approvedPaid', 'approvedUnpaid', 'hardFail'].includes(bucket)) && !sub.creatorApproved) {
          passCounts.push(Number(pc));
        }

        if (bucket === 'evaluating' && evaluatingSamples.length < 5) {
          evaluatingSamples.push({
            jobId: job.jobId, jobTitle: job.title, submissionId: sub.submissionId,
            status: sub.status, onChainStatus: sub.onChainStatus, bountyStatus: job.status,
            phase: round?.phaseName ?? null, nextAction: round?.nextAction ?? null,
            verdiktaAggId: sub.verdiktaAggId
          });
        }

        const rounds = Math.max(Number(sub.rounds) || 0, Array.isArray(sub.aggIds) ? sub.aggIds.length : 0);
        v2.totalRounds += rounds;
        if (rounds > 1) v2.rerunSubmissions++;
        if (sub.bondReturnedWei && sub.bondReturnedWei !== '0') { v2.bondsReturned++; v2.bondReturnedWei += BigInt(sub.bondReturnedWei); }
        if (sub.bondForfeitedWei && sub.bondForfeitedWei !== '0') { v2.bondsForfeited++; v2.bondForfeitedWei += BigInt(sub.bondForfeitedWei); }
      }
    }

    logger.info('Submission status breakdown', { statusCounts });

    // Pass rate over the arbiters' decided outcomes: a pass (>= Q scores at the threshold) against a
    // hard fail (< R). Soft fails re-run and rounds with no result have no verdict, so neither counts;
    // creator approvals are not the arbiters' verdict.
    const passed = byOutcome.approvedPaid + byOutcome.approvedUnpaid + byOutcome.passPending - creatorApproved;
    const decided = passed + byOutcome.hardFail;
    const passRate = decided > 0 ? Math.round((passed / decided) * 100) : null;
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const avgPassCount = passCounts.length > 0 ? Math.round((passCounts.reduce((a, b) => a + b, 0) / passCounts.length) * 10) / 10 : null;

    return {
      total: totalSubmissions,
      byOutcome,
      creatorApproved,
      statusBreakdown: statusCounts, // Raw status counts for debugging
      evaluatingSamples, // Sample of submissions counted as evaluating for debugging
      passRate,
      avgScore,
      avgPassCount,
      v2: {
        rerunSubmissions: v2.rerunSubmissions,
        totalRounds: v2.totalRounds,
        bondsReturned: v2.bondsReturned,
        bondReturnedEth: ethers.formatEther(v2.bondReturnedWei),
        bondsForfeited: v2.bondsForfeited,
        bondForfeitedEth: ethers.formatEther(v2.bondForfeitedWei)
      },
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error('Failed to get submission analytics', { msg: error.message });
    throw error;
  }
}

/**
 * Round-level v2 facts from the score-spread collector's cache (no RPC): beacon stages, prepay lost
 * to the treasury, late reveals, how rounds ended.
 */
async function getRoundAnalytics() {
  try {
    return { ...scoreSpread.summarizeRounds(await scoreSpread.readState()), timestamp: Date.now() };
  } catch (error) {
    logger.warn('Failed to summarize rounds', { msg: error.message });
    return null;
  }
}

/**
 * Get system health information
 */
async function getSystemHealth() {
  const verdiktaService = getVerdiktaService();

  let aggregatorConfig = null;
  let aggregatorConfigs = null;
  let verdiktaHealth = null;

  if (verdiktaService) {
    try {
      verdiktaHealth = await verdiktaService.healthCheck();
      if (verdiktaHealth.healthy) {
        aggregatorConfig = verdiktaHealth.config;
        // The config of every aggregator the server is configured with.
        try {
          aggregatorConfigs = await verdiktaService.getAllAggregatorConfigs();
        } catch (error) {
          logger.warn('Failed to read the aggregator configs', { msg: error.message });
        }
      }
    } catch (error) {
      logger.warn('Failed to get Verdikta health', { msg: error.message });
      verdiktaHealth = { healthy: false, error: error.message };
    }
  }

  // Get sync service status if available
  let syncStatus = null;
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    if (syncService) {
      syncStatus = syncService.getStatus();
    }
  } catch {
    // Sync service not available
  }

  return {
    verdikta: {
      configured: isVerdiktaServiceAvailable(),
      healthy: verdiktaHealth?.healthy || false,
      aggregatorAddress: verdiktaHealth?.aggregatorAddress || null,
      // the aggregator(s) the server is configured with
      aggregators: verdiktaHealth?.aggregators || [],
      keeperAddress: verdiktaHealth?.keeperAddress || null,
      wvdkaAddress: verdiktaHealth?.wvdkaAddress || null,
      error: verdiktaHealth?.error || null
    },
    aggregatorConfig,
    // each configured aggregator: K/M/N/P, M+, T+, timeout (from the draw), reward fees, beacons,
    // spreadFloor, maxOracleFee
    aggregatorConfigs,
    sync: syncStatus ? {
      enabled: syncStatus.enabled,
      isSyncing: syncStatus.isSyncing,
      lastSync: syncStatus.lastSyncTime,
      intervalMinutes: syncStatus.intervalMinutes,
      consecutiveErrors: syncStatus.consecutiveErrors || 0
    } : null,
    bountyContract: config.bountyEscrowAddress || null,
    timestamp: Date.now()
  };
}

/**
 * Rubric template usage on the current contract (utils/templateUsage.js). Unlike
 * listJobs, unfunded creates are kept, so the "created" stage counts them.
 */
async function getTemplateUsageAnalytics() {
  try {
    const { jobs } = await jobStorage.readStorage();
    const current = (config.bountyEscrowAddress || '').toLowerCase();
    const onContract = current
      ? jobs.filter(j => (j.contractAddress || '').toLowerCase() === current && j.status !== 'CANCELLED')
      : jobs;
    return { ...summarizeTemplateUsage(onContract), timestamp: Date.now() };
  } catch (error) {
    logger.error('Failed to get template usage analytics', { msg: error.message });
    throw error;
  }
}

/**
 * Hunters on the current contract: every distinct address that has a submission
 * (prepared or evaluated), and which of them won. A win is a PassedPaid
 * submission, or the bounty's recorded winner, counted once per bounty.
 * ETH won is the amount actually paid (paidAmountEth), not the configured payments.
 */
async function getHunterAnalytics() {
  try {
    const jobs = await jobStorage.listJobs({});
    const jobList = jobs.jobs || jobs;
    const byAddress = new Map();

    const entryFor = (address) => {
      const key = address.toLowerCase();
      let h = byAddress.get(key);
      if (!h) {
        h = {
          address,
          submissions: 0,
          bounties: new Set(),
          wins: 0,
          ethWon: 0,
          wonBountyIds: [],
          firstSubmittedAt: null,
          lastSubmittedAt: null
        };
        byAddress.set(key, h);
      }
      return h;
    };

    for (const job of jobList) {
      const winners = new Set();
      const winningSubs = new Map();   // hunter (lowercased) -> its paid submission
      for (const sub of job.submissions || []) {
        if (!sub.hunter) continue;
        const h = entryFor(sub.hunter);
        h.submissions++;
        h.bounties.add(job.jobId);
        const at = Number(sub.submittedAt) || null;
        if (at) {
          if (h.firstSubmittedAt == null || at < h.firstSubmittedAt) h.firstSubmittedAt = at;
          if (h.lastSubmittedAt == null || at > h.lastSubmittedAt) h.lastSubmittedAt = at;
        }
        const status = (sub.onChainStatus || sub.status || '').toLowerCase();
        if (status === 'passedpaid') {
          winners.add(sub.hunter.toLowerCase());
          winningSubs.set(sub.hunter.toLowerCase(), sub);
        }
      }
      if (job.status === 'AWARDED' && job.winner) winners.add(job.winner.toLowerCase());

      for (const key of winners) {
        const h = byAddress.get(key) || entryFor(job.winner);
        h.wins++;
        h.ethWon += paidAmountEth(job, winningSubs.get(key));
        h.wonBountyIds.push(job.jobId);
      }
    }

    const hunters = [...byAddress.values()]
      .map(h => ({
        ...h,
        bounties: h.bounties.size,
        ethWon: Math.round(h.ethWon * 1e6) / 1e6,
        wonBountyIds: h.wonBountyIds.sort((a, b) => b - a)
      }))
      .sort((a, b) => b.wins - a.wins || b.submissions - a.submissions);

    return {
      hunters,
      totalSubmitters: hunters.filter(h => h.submissions > 0).length,
      totalWinners: hunters.filter(h => h.wins > 0).length,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error('Failed to get hunter analytics', { msg: error.message });
    throw error;
  }
}

/** Hunter connection groups from the cached analysis state (cheap; no RPC). */
async function getConnections(hunterData) {
  const state = await hunterLinks.readState();
  return hunterLinks.buildConnections(state, hunterData.hunters.map(h => h.address));
}

/** Counts for the overview; null until the first background run completes. */
async function getConnectionCounts(hunterData) {
  try {
    const { groups, coverage } = await getConnections(hunterData);
    if (!coverage.lastRunAt) return { linkedHunters: null, connectionGroups: null };
    return { linkedHunters: coverage.linkedHunters, connectionGroups: groups.length };
  } catch (error) {
    logger.warn('Failed to read hunter connections', { msg: error.message });
    return { linkedHunters: null, connectionGroups: null };
  }
}

/**
 * Get recently fulfilled (awarded) bounties
 */
async function getFulfilledBounties() {
  try {
    const jobs = await jobStorage.listJobs({});
    const jobList = jobs.jobs || jobs;

    const awarded = jobList
      .filter(j => j.status === 'AWARDED' && j.winner)
      .sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0))
      .slice(0, 10)
      .map(j => ({
        jobId: j.jobId,
        title: j.title,
        creator: j.creator,
        winner: j.winner,
        // Post-payout the on-chain payoutWei is zero, so j.bountyAmount loses
        // the original value. Fall back to the determination-payment fields
        // preserved on the Bounty struct so the row shows what was paid out.
        bountyAmount: paidAmountEth(j, (j.submissions || []).find(s =>
          s.hunter && j.winner && s.hunter.toLowerCase() === j.winner.toLowerCase() && (s.paidWinner || (s.onChainStatus || '').toLowerCase() === 'passedpaid'))),
        txHash: j.txHash || null,
        awardTxHash: j.awardTxHash || null,
        settledAt: j.settledAt,
        contractAddress: j.contractAddress || config.bountyEscrowAddress
      }));

    return awarded;
  } catch (error) {
    logger.error('Failed to get fulfilled bounties', { msg: error.message });
    return [];
  }
}

module.exports = router;
