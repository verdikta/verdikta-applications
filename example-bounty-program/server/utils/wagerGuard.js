/**
 * Mutual wagers on the server: the context a wager's terms are checked in, and the one check
 * POST /api/jobs/create runs on every description that carries a MUTUAL WAGER TERMS block.
 * POST /api/wagers/check runs the same function, so an agent sees exactly what create would
 * refuse. The terms logic itself is shared with the create page: shared/mutualWager.js.
 *
 * These are a bettor's own pre-funding protections. The jury never depends on them.
 */
const { ethers } = require('ethers');
const { config } = require('../config');
const wager = require('../../shared/mutualWager');

/** Site, escrow and chain as the create page writes them on the Site line, and the defaults a proposal fills in. */
function wagerContext() {
  const d = config.submissionDefaults || {};
  let escrow = config.bountyEscrowAddress || '';
  try { escrow = ethers.getAddress(escrow); } catch { /* keep it as configured */ }
  return {
    site: config.publicSiteUrl,
    escrow,
    chain: wager.wagerChainLabel(config.chainId),
    defaults: {
      oracle: {
        maxOracleFeeEth: wager.formatEthWei(BigInt(d.maxOracleFeeWei)),
        estimatedBaseCostEth: wager.formatEthWei(BigInt(d.estimatedBaseCostWei)),
        maxFeeBasedScaling: Number(d.maxFeeBasedScaling),
        alpha: Number(d.alpha),
      },
      jury: wager.DEFAULT_WAGER_JURY,
    },
  };
}

const sameAddress = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/**
 * What POST /api/jobs/create refuses about a mutual-wager body. Returns
 * { wager: false } for a description with no terms block, else
 * { wager: true, issues: [{ code, message }], terms, expect }; create only when issues is empty.
 *   body            the /jobs/create request body
 *   payments        normalizeBountyPayments(body)
 *   oracleSettings  resolveOracleSettings(body): { maxOracleFee, estimatedBaseCost (wei), alpha, maxFeeBasedScaling }
 *   rubric          the rubric that will be pinned (rubricJson, or the rubricCid's JSON)
 *   now             unix seconds
 *   readCounter(n)  -> { status, job }: GET /api/jobs/n/onchain-status's body (null if none)
 *                   and GET /api/jobs/n?includeRubric=true's job; throws if it cannot read them now
 *   listCreatorJobs(wallet) -> that wallet's linked bounties
 * Codes: WAGER_TERMS, WAGER_TARGET, WAGER_MISMATCH, WAGER_TIMING, WAGER_RUBRIC, WAGER_TEXT (the
 * terms vs this bounty; WAGER_TEXT: title, type or description not the canonical wager text), WAGER_DUPLICATE (another live bounty of the creator's has the Wager ID),
 * WAGER_COUNTER (the named counter does not match its live record), WAGER_COUNTER_UNVERIFIED and
 * WAGER_RUBRIC_UNVERIFIED (a record could not be read now; 503, retry).
 */
async function checkWagerCreate({ body, payments, oracleSettings, rubric, now, readCounter, listCreatorJobs, ctx = wagerContext() }) {
  if (!wager.looksLikeMutualWager(body?.description, rubric)) return { wager: false, issues: [] };
  // A rubricCid that could not be read now is not an edited rubric: say so, and let the caller retry.
  if (!rubric && body.rubricCid) {
    return { wager: true, issues: [{ code: 'WAGER_RUBRIC_UNVERIFIED', message: `Could not read rubric ${body.rubricCid} from IPFS to compare it with the template. Try again shortly, or pass rubricJson from GET /api/wagers/template.` }] };
  }
  const expect = {
    posterWallet: body.creator,
    targetHunter: body.targetHunter || '',
    // The jury reads the title and work product type too; /jobs/create defaults the type to 'Work Product'.
    title: body.title,
    workProductType: body.workProductType ?? 'Work Product',
    stake: wager.formatEthWei(BigInt(payments.bountyAmountWei)),
    threshold: Number(body.threshold),
    classId: Number(body.classId ?? 128),
    jury: Array.isArray(body.juryNodes) ? body.juryNodes : [],
    iterations: Number(body.iterations ?? 1),
    oracle: {
      maxOracleFeeEth: wager.formatEthWei(BigInt(oracleSettings.maxOracleFee)),
      estimatedBaseCostEth: wager.formatEthWei(BigInt(oracleSettings.estimatedBaseCost)),
      maxFeeBasedScaling: oracleSettings.maxFeeBasedScaling,
      alpha: oracleSettings.alpha,
    },
    approvalWindow: Number(payments.creatorAssessmentWindowSize) > 0,
    deadline: payments.submissionDeadline ?? now + payments.submissionWindowSeconds,
    now,
    site: ctx.site,
    escrow: ctx.escrow,
    chain: ctx.chain,
    rubric,
  };
  const { issues, terms } = wager.checkMutualWagerTerms(body.description, expect);
  if (issues.length) return { wager: true, issues, terms, expect };

  // One Wager ID backs one pair, so a counter bounty cannot stand behind two offers.
  const twin = wager.findWagerTwin(await listCreatorJobs(body.creator), terms.fields.wagerId);
  if (twin) issues.push({ code: 'WAGER_DUPLICATE', message: `Your bounty #${twin.jobId} already uses Wager ID ${terms.fields.wagerId}. Use a new Wager ID for every pair, so one counter bounty cannot back two offers.` });
  // The jury trusts a counter the terms name, so the server checks its live record instead.
  if (terms.counter) {
    let records = null;
    try { records = await readCounter(terms.counter.number); }
    catch (err) {
      issues.push({ code: 'WAGER_COUNTER_UNVERIFIED', message: `Could not read counter bounty #${terms.counter.number} to check it (${err.message}). Try again shortly.` });
    }
    if (records) {
      for (const message of wager.checkCounterBounty({ terms, status: records.status, job: records.job, expect })) {
        issues.push({ code: 'WAGER_COUNTER', message });
      }
    }
  }
  return { wager: true, issues, terms, expect };
}

/** The 400 (or 503 when only a record could not be read now) that create and the builders return. */
function wagerRefusal(issues) {
  const first = issues[0];
  return {
    status: issues.every((i) => /_UNVERIFIED$/.test(i.code)) ? 503 : 400,
    body: {
      success: false,
      error: 'Inconsistent mutual wager',
      code: first.code,
      details: first.message,
      problems: issues,
      fix: 'Build the body with POST /api/wagers/propose (first bettor) or POST /api/wagers/answer (second bettor) and post it unchanged. POST /api/wagers/check shows these problems for free: nothing is pinned and no job id is used.',
      tips: ['Mutual wagers: GET /agents.txt, section "Mutual wagers"'],
    },
  };
}

/** A wager bounty as the status and claim endpoints read it: linked on chain, with one terms block. */
function isLinkedWagerJob(job) {
  return !!job && (job.onChain || job.syncedFromBlockchain) && job.status !== 'ORPHANED' && wager.hasMutualWagerTerms(job.description);
}

module.exports = { wagerContext, checkWagerCreate, wagerRefusal, isLinkedWagerJob, sameAddress };
