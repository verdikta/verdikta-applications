/**
 * Analytics Routes
 * Provides analytics data for the bounty program dashboard
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const jobStorage = require('../utils/jobStorage');
const { analyticsCache } = require('../utils/analyticsCacheService');
const { getVerdiktaService, isVerdiktaServiceAvailable } = require('../utils/verdiktaService');
const { getContractService } = require('../utils/contractService');
const { classMap } = require('@verdikta/common');

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
    const [arbiterData, bountyData, submissionData, systemData] = await Promise.all([
      getArbiterAnalytics(),
      getBountyAnalytics(),
      getSubmissionAnalytics(),
      getSystemHealth()
    ]);

    const result = {
      arbiters: arbiterData,
      bounties: bountyData,
      submissions: submissionData,
      system: systemData,
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
 * Invalidates cache and forces a refresh
 */
router.post('/refresh', async (req, res) => {
  try {
    analyticsCache.clear();
    logger.info('Analytics cache manually cleared');

    return res.json({
      success: true,
      message: 'Cache cleared successfully'
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
async function getArbiterAnalytics() {
  const verdiktaService = getVerdiktaService();

  // If Verdikta service is not configured, return class data from classMap only
  if (!verdiktaService) {
    logger.info('Verdikta service not available, returning class-only data');
    return getClassOnlyAnalytics();
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

    return {
      byClass: enrichedByClass,
      totalOracles: arbiterData.totalOracles,
      verdiktaConnected: true,
      timestamp: arbiterData.timestamp
    };
  } catch (error) {
    logger.error('Failed to get arbiter analytics from contract', { msg: error.message });
    // Fall back to class-only data
    return getClassOnlyAnalytics();
  }
}

/**
 * Get class information without oracle data (fallback when Verdikta not available)
 */
function getClassOnlyAnalytics() {
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
    message: 'Verdikta aggregator not configured - showing class information only',
    timestamp: Date.now()
  };
}

/**
 * Get bounty statistics from job storage
 */
async function getBountyAnalytics() {
  try {
    const diagnostics = await jobStorage.getDiagnostics();
    const jobs = await jobStorage.listJobs({});

    // Calculate total ETH
    let totalETH = 0;
    let totalWithAmount = 0;

    for (const job of jobs.jobs || jobs) {
      const amount = parseFloat(job.bountyAmount) || 0;
      totalETH += amount;
      if (amount > 0) totalWithAmount++;
    }

    const avgBountyAmount = totalWithAmount > 0 ? totalETH / totalWithAmount : 0;

    return {
      byStatus: diagnostics.byStatus || {},
      totalBounties: diagnostics.totalJobs || 0,
      totalETH: Math.round(totalETH * 10000) / 10000,
      avgBountyAmount: Math.round(avgBountyAmount * 10000) / 10000,
      currentContract: diagnostics.currentContract,
      orphanedCount: diagnostics.orphanedCount || 0,
      legacyCount: diagnostics.legacyCount || 0,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error('Failed to get bounty analytics', { msg: error.message });
    throw error;
  }
}

/**
 * Get submission statistics from job storage
 */
async function getSubmissionAnalytics() {
  try {
    const jobs = await jobStorage.listJobs({});
    const jobList = jobs.jobs || jobs;

    let totalSubmissions = 0;
    let approvedPaid = 0;
    let approvedUnpaid = 0;
    let rejected = 0;
    let rejectedUnclosed = 0;
    let evaluating = 0;
    let prepared = 0;
    let timeout = 0;
    let unknown = 0;
    let scores = [];
    const statusCounts = {}; // Track all status values for debugging
    const evaluatingSamples = []; // Sample of submissions counted as evaluating for debugging

    for (const job of jobList) {
      if (!job.submissions) continue;

      // Get the bounty's pass threshold for comparison
      const passThreshold = job.passThreshold || job.threshold || 90;

      // Check if the bounty is expired or closed - no further evaluations can happen
      const bountyStatus = (job.status || '').toUpperCase();
      const bountyExpiredOrClosed = bountyStatus === 'EXPIRED' || bountyStatus === 'CLOSED';

      for (const sub of job.submissions) {
        totalSubmissions++;

        // Normalize status to handle different naming conventions
        const status = (sub.status || '').toLowerCase();

        // Track all statuses for debugging
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        // Check if submission has evaluation results
        // Results can be in sub.result (from updateSubmissionResult) or directly on sub (from sync)
        const hasResult = (sub.result && (sub.result.score != null || sub.result.acceptance != null)) ||
                          sub.acceptance > 0 || sub.rejection > 0 || sub.score != null;
        const score = sub.result?.score ?? sub.result?.acceptance ?? sub.acceptance ?? sub.score;
        const didPass = hasResult && score != null && score >= passThreshold;

        if (status === 'passedpaid') {
          approvedPaid++;
          if (hasResult) scores.push(score);
        } else if (status === 'passed' || status === 'passedunpaid' || status === 'approved' || status === 'accepted') {
          approvedUnpaid++;
          if (hasResult) scores.push(score);
        } else if (status === 'failed' || status === 'rejected') {
          rejected++;
        } else if (status === 'pending' || status === 'pendingverdikta' || status === 'pending_evaluation') {
          // Check if evaluation is actually complete but status wasn't updated
          if (hasResult) {
            if (didPass) {
              approvedUnpaid++; // Approved but unclosed
              scores.push(score);
            } else {
              rejectedUnclosed++; // Rejected but unclosed
            }
          } else {
            // Check Verdikta Aggregator for evaluation result
            // Need on-chain bountyId and submissionId to query the contract
            let evalResult = null;
            // Use onChainId (primary), then legacy field names
            const onChainBountyId = job.onChainId ?? job.onChainBountyId ?? job.bountyId;
            const onChainSubmissionId = sub.onChainSubmissionId ?? sub.submissionId;

            if (onChainBountyId != null && onChainSubmissionId != null) {
              try {
                const contractService = getContractService();
                evalResult = await contractService.checkEvaluationReady(onChainBountyId, onChainSubmissionId);
                if (evalResult?.ready) {
                  logger.info('Evaluation result found', {
                    bountyId: onChainBountyId,
                    submissionId: onChainSubmissionId,
                    acceptance: evalResult.scores.acceptance,
                    threshold: passThreshold
                  });
                }
              } catch (err) {
                // Contract service might not be available
                logger.warn('Could not check evaluation ready', {
                  bountyId: onChainBountyId,
                  submissionId: onChainSubmissionId,
                  msg: err.message
                });
              }
            } else {
              logger.debug('Missing on-chain IDs for submission', {
                jobId: job.jobId,
                submissionId: sub.submissionId,
                onChainBountyId,
                onChainSubmissionId
              });
            }

            if (evalResult?.ready) {
              // Evaluation is complete but submission wasn't updated
              const evalScore = evalResult.scores.acceptance;
              const evalPassed = evalScore >= passThreshold;
              if (evalPassed) {
                approvedUnpaid++;
                scores.push(evalScore);
              } else {
                rejectedUnclosed++;
              }
            } else if (bountyExpiredOrClosed) {
              // Bounty is expired/closed and no evaluation results exist
              // This submission timed out without getting results
              timeout++;
              // Log why this went to timeout instead of rejectedUnclosed
              if (evaluatingSamples.length < 5) {
                evaluatingSamples.push({
                  category: 'timeout',
                  jobId: job.jobId,
                  jobTitle: job.title,
                  submissionId: sub.submissionId,
                  onChainBountyId,
                  onChainSubmissionId,
                  status: sub.status,
                  bountyStatus: job.status,
                  evalResultReason: evalResult?.reason || evalResult?.error || 'no_result'
                });
              }
            } else {
              evaluating++; // Truly still waiting for evaluation
              // Capture sample for debugging (first 5)
              if (evaluatingSamples.length < 5) {
                evaluatingSamples.push({
                  jobId: job.jobId,
                  jobTitle: job.title,
                  submissionId: sub.submissionId,
                  onChainBountyId,
                  onChainSubmissionId,
                  status: sub.status,
                  onChainStatus: sub.onChainStatus,
                  bountyStatus: job.status,
                  hasResultObj: !!sub.result,
                  resultKeys: sub.result ? Object.keys(sub.result) : [],
                  acceptance: sub.acceptance,
                  rejection: sub.rejection,
                  score: sub.score,
                  verdiktaAggId: sub.verdiktaAggId
                });
              }
            }
          }
        } else if (status === 'prepared') {
          prepared++;
        } else if (status === 'timeout') {
          timeout++;
        } else {
          unknown++;
        }
      }
    }

    // Log status breakdown for debugging
    logger.info('Submission status breakdown', { statusCounts });

    const totalApproved = approvedPaid + approvedUnpaid;
    const totalRejected = rejected + rejectedUnclosed;
    const evaluated = totalApproved + totalRejected;
    const passRate = evaluated > 0 ? Math.round((totalApproved / evaluated) * 100) : null;
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null;

    return {
      total: totalSubmissions,
      byOutcome: {
        approvedPaid,
        approvedUnpaid,
        rejected,
        rejectedUnclosed,
        evaluating,
        prepared,
        timeout,
        unknown
      },
      statusBreakdown: statusCounts, // Raw status counts for debugging
      evaluatingSamples, // Sample of submissions counted as evaluating for debugging
      passRate,
      avgScore,
      timestamp: Date.now()
    };
  } catch (error) {
    logger.error('Failed to get submission analytics', { msg: error.message });
    throw error;
  }
}

/**
 * Get system health information
 */
async function getSystemHealth() {
  const verdiktaService = getVerdiktaService();

  let aggregatorConfig = null;
  let verdiktaHealth = null;

  if (verdiktaService) {
    try {
      verdiktaHealth = await verdiktaService.healthCheck();
      if (verdiktaHealth.healthy) {
        aggregatorConfig = verdiktaHealth.config;
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
      keeperAddress: verdiktaHealth?.keeperAddress || null,
      error: verdiktaHealth?.error || null
    },
    aggregatorConfig,
    sync: syncStatus ? {
      enabled: syncStatus.enabled,
      isSyncing: syncStatus.isSyncing,
      lastSync: syncStatus.lastSyncTime,
      intervalMinutes: syncStatus.intervalMinutes,
      consecutiveErrors: syncStatus.consecutiveErrors || 0
    } : null,
    bountyContract: process.env.BOUNTY_ESCROW_ADDRESS || null,
    timestamp: Date.now()
  };
}

module.exports = router;
