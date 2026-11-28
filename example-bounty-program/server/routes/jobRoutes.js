/**
 * Job Routes
 * Handles job/bounty creation, listing, and submission workflow
 */

const { untrustedContent } = require('../utils/untrustedContent');
const { ethers } = require('ethers');
const { readEntry, readEntryText, readBodyCapped, DEFAULT_BODY_MAX_BYTES: DEFAULT_CONTENT_READ_BYTES } = require('../utils/safeZip');
const { bountyAmountWei, bountyAmountFields } = require('../utils/bountyAmounts');
const express = require('express');
const { limitPins } = require('../utils/pinLimit');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const logger = require('../utils/logger');
const { getEthPriceUsd } = require('../utils/ethPrice');
const jobStorage = require('../utils/jobStorage');
const { packageRubricHash } = require('../utils/rubricSource');
const { extractTaskDescription } = require('../utils/taskDescription');
const { config } = require('../config');
const archiveGenerator = require('../utils/archiveGenerator');
const archiveShapeValidator = require('../utils/archiveShapeValidator');
const { findOversizedImages, OVERSIZED_IMAGE_FIX } = require('../utils/imageLimits');
const { validateRubric, validateJuryNodes, normalizeBountyPayments, validateProcurement, validateWagerTarget, isValidFileType, MAX_FILE_SIZE,
        oracleUnreadableReason, detectBinaryContainer, ALLOWED_ZIP_BASED_EXTENSIONS,
        parseFeeToWei, extractEvaluationWarnings } = require('../utils/validation');
const { lookupClass, registryModelMatcher, checkJuryAgainstClass, checkClassCoverage } = require('../utils/classPolicy');
const { getVerdiktaService, isVerdiktaServiceAvailable, LIKELY_MALFORMED_OUTCOME } = require('../utils/verdiktaService');
const { validateBounty, IssueSeverity, IssueType, chainStatusIssue, juryIssue, isGatingIssue, isTransientIssue, maxEvaluationQueryChars } = require('../utils/bountyValidator');
const { DRAW_GAS_LIMIT_FALLBACK, START_GAS_LIMIT } = require('../utils/gasLimits');
const { getContractService, normalizeOracleSettings, RESOLVE_GAS_LIMIT_FALLBACK, RESOLVE_GAS_NOTE } = require('../utils/contractService');
const { sendError, ErrorCodes } = require('../utils/apiErrors');
const { SUBMISSION_PREPARED_ABI, submissionPreparedEvent } = require('../utils/submissionEvents');
const { createTtlCache } = require('../utils/ttlCache');
const { createRateLimiter, clientAddress } = require('../utils/rateLimiter');
const { requireAdmin } = require('../utils/adminAuth');
const { sanitizeCreateAttempt, isUnlinked, appendAttempt, attemptSummary, ADDRESS_RE } = require('../utils/createAttempts');
const { rubricTemplateRecord, summarizeTemplateUsage, classifyRubric } = require('../utils/templateUsage');
const { expandRubricTemplate } = require('../utils/rubricTemplates');
const { findFinalizeBlockers, blockerCalldata, blockersHint } = require('../utils/finalizeBlockers');
const { buildActionRequired } = require('../utils/actionRequired');
const { checkWagerCreate, wagerRefusal, isLinkedWagerJob, sameAddress } = require('../utils/wagerGuard');
const { verifyWagerPackage } = require('../utils/wagerPackage');
const { looksLikeMutualWager } = require('../../shared/mutualWager');
const { CLASS_PRESETS, presetByKey, presetForBounty, usdToWei, toBountyParams } = require('../../shared/classPresets');
const { SUBMISSION_STATUSES } = require('../utils/aggregatorAbi');

/* ======================
   Helpers / configuration
   ====================== */

function readBool(v) { return /^(1|true|yes|on)$/i.test(String(v || '').trim()); }
const DEV_ENV_FAKE = readBool(process.env.DEV_FAKE_RUBRIC_CID);
// ?dev=1 (fake CIDs, nothing pinned) only on a development server: on a live one any
// client could mint unpinned jobs that still take a jobId.
const DEV_QUERY_ALLOWED = process.env.NODE_ENV === 'development' || DEV_ENV_FAKE;

// ---- Unevaluable-bounty gate (issue #39) ---------------------------------
// A job whose evaluation package has a deterministic ERROR (see
// utils/bountyValidator) can never produce an oracle result: every hunter who
// starts an evaluation against it pays the arbiters' base fees for nothing.
// ensureFreshValidation() is the single source of truth both the board
// (GET /:jobId/validate, persisted so job.validationStatus.hasIssues drives
// the existing "has-errors" card styling in the client) and the submission
// endpoints (submit / submit/prepare / submit/bundle) read from.
//
// Only deterministic package errors gate (bountyValidator's GATING_ISSUE_TYPES).
// A fetch failure ("could not look") is never a verdict: it is not persisted and
// it lets the submission through; class-registry ERRORs stay informational.
const VALIDATION_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — matches admin/validate-all's cadence
const UNCHECKED_VALIDATION = Object.freeze({ valid: true, issues: [], checkedAt: null, unchecked: true });

/**
 * Persist a validation result as the job's verdict, unless it is only a fetch
 * failure. Transient issues are stripped first so a gateway hiccup can neither
 * block submissions for the cache TTL nor paint a red error card on the board.
 * Returns the stored verdict, or null when nothing was stored.
 */
async function persistValidationVerdict(job, result) {
  const sawTransient = result.issues.some(isTransientIssue);
  const issues = result.issues.filter((i) => !isTransientIssue(i));
  if (sawTransient && !issues.some(isGatingIssue)) return null;

  const validationStatus = {
    valid: result.valid && !issues.some((i) => i.severity === IssueSeverity.ERROR),
    issues,
    checkedAt: new Date().toISOString(),
  };
  try {
    await jobStorage.updateJob(job.jobId, { validationStatus });
  } catch (e) {
    logger.warn('[validation] could not persist validationStatus', { jobId: job.jobId, msg: e.message });
  }
  return validationStatus;
}

async function ensureFreshValidation(job, req, { force = false } = {}) {
  const cached = job.validationStatus;
  const isFresh = !force && cached?.checkedAt &&
    (Date.now() - new Date(cached.checkedAt).getTime()) < VALIDATION_CACHE_TTL_MS;
  if (isFresh) return cached;

  // Fail-open: if IPFS isn't wired up (e.g. a route under test with no
  // app.locals.ipfsClient), don't block submissions over an infra gap that
  // has nothing to do with this bounty's own package.
  const ipfsClient = req.app.locals.ipfsClient;
  if (!ipfsClient) return cached || UNCHECKED_VALIDATION;

  let classMap;
  try {
    classMap = require('@verdikta/common').classMap;
  } catch (e) {
    logger.warn('[ensureFreshValidation] Could not load classMap:', e.message);
  }

  let result;
  try {
    result = await validateBounty({ evaluationCid: job.evaluationCid, classId: job.classId, ipfsClient, classMap });
  } catch (e) {
    // A validator crash is an infra problem, not proof the package is bad.
    logger.warn('[ensureFreshValidation] validateBounty threw', { jobId: job.jobId, msg: e.message });
    return cached || UNCHECKED_VALIDATION;
  }

  // On-chain terminal states (EXPIRED/AWARDED/CLOSED) are already gated
  // elsewhere by job.status — don't let a chain-read hiccup here mark an
  // otherwise-fine package as unevaluable.
  try {
    const contractService = getContractService();
    const onChain = await contractService.getBounty(job.jobId);
    const chainCheck = chainStatusIssue(onChain.status);
    if (chainCheck) {
      result.issues.push(chainCheck.issue);
      if (chainCheck.invalidatesPackage) result.valid = false;
    }
  } catch { /* chain read best-effort here; the route's own on-chain checks are authoritative */ }

  const verdict = await persistValidationVerdict(job, result);
  if (verdict) return verdict;

  // Only a fetch failure: we learned nothing about the package. It is immutable
  // (content-addressed), so the last real verdict still holds; with none, let
  // the submission through and say so.
  logger.warn('[ensureFreshValidation] package could not be fetched; not recording a verdict', {
    jobId: job.jobId,
    issues: result.issues.map((i) => i.type),
  });
  return cached?.checkedAt ? cached : UNCHECKED_VALIDATION;
}

/** The deterministic package errors in a validation status (what the gate acts on). */
function gatingErrors(validationStatus) {
  return (validationStatus?.issues || []).filter(isGatingIssue);
}

function unevaluableGateResponse(jobId, errors) {
  const reason = errors.map((i) => i.message).join(' ') || 'Evaluation package failed validation.';
  return {
    success: false,
    code: ErrorCodes.BOUNTY_UNEVALUABLE,
    error: 'This bounty\'s evaluation package cannot be evaluated and is not accepting submissions.',
    reason,
    issues: errors,
    fix: `Check GET /api/jobs/${jobId}/validate for full details. If you already started an evaluation and its round failed, use GET /api/jobs/${jobId}/submissions to find it and POST .../close-failed to close the round (the unspent prepay is refunded; the bond is returned once no re-run follows).`,
  };
}

/**
 * Shared gate for submit / submit/prepare / submit/bundle. Sends the 409 and
 * returns true when the package has a deterministic error. When the package
 * could not be checked at all, lets the request through and flags it with an
 * X-Verdikta-Validation: unchecked header.
 */
async function rejectIfUnevaluable(job, req, res, jobId) {
  const status = await ensureFreshValidation(job, req);
  const errors = gatingErrors(status);
  if (errors.length > 0) {
    res.status(409).json(unevaluableGateResponse(jobId, errors));
    return true;
  }
  if (status.unchecked) res.set('X-Verdikta-Validation', 'unchecked');
  return false;
}

// ---- Bounty oracle settings (creator-chosen, per bounty) ----------------------
// Since the September 2026 BountyEscrow revision the oracle request parameters are
// set by the CREATOR in createBounty's `oracle` struct and used verbatim for every
// evaluation of that bounty. These helpers resolve the optional request-body fields
// (oracleMaxOracleFee / oracleAlpha / oracleEstimatedBaseCost / oracleMaxFeeBasedScaling)
// against config.submissionDefaults and enforce the same bounds the contract does.
const ORACLE_MAX_ALPHA = 1000;
const ORACLE_MAX_FEE_SCALING = 1000;
// Aggregator per-oracle fee ceiling (BountyEscrow reverts "oracle fee above ceiling"
// when maxOracleFee exceeds verdikta.maxOracleFee()). Used as a static pre-check;
// the live value is read from the aggregator when available.
const ORACLE_FEE_CEILING_WEI = ethers.parseEther('0.0004');

// v2 (BountyEscrow on the v2 aggregator): the oracle struct gains the fee floor and the beacon
// flag; the bounty carries its own jury (K drawn, M promoted, N counted, P clustered, and the round
// timeout in seconds; item 15: one aggregator serves every jury size), item 12's pass quota Q and
// forfeit line R, and the hunter bond.
const CREATE_BOUNTY_ABI =
  'function createBounty((string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling, uint256 minOracleFee, bool withBeacons) oracle, (uint8 K, uint8 M, uint8 N, uint8 P, uint40 timeout) jury, uint8 quota, uint8 forfeitLine, uint256 bond, uint8 outcomes) p) payable returns (uint256 bountyId)';
const createBountyIface = new ethers.Interface([CREATE_BOUNTY_ABI]);
const UINT96_MAX = (1n << 96n) - 1n;

/** Parse a boolean request field ("true"/"false", 1/0, booleans); `fallback` when absent. */
function parseBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(t)) return true;
  if (['false', '0', 'no'].includes(t)) return false;
  throw new Error(`expected a boolean, got "${v}"`);
}

/**
 * Resolve + validate creator oracle settings from a request body.
 * Fee fields accept decimal ETH or integer wei (parseFeeToWei rule).
 * Returns { maxOracleFee (wei string), alpha, estimatedBaseCost (wei string), maxFeeBasedScaling }
 * or throws an Error with an actionable message.
 */
function resolveOracleSettings(body = {}, opts = {}) {
  const d = config.submissionDefaults;
  const feeCeilingWei = opts.feeCeilingWei != null ? BigInt(opts.feeCeilingWei) : ORACLE_FEE_CEILING_WEI;

  const maxOracleFeeWei = parseFeeToWei(
    body.oracleMaxOracleFee != null && body.oracleMaxOracleFee !== '' ? body.oracleMaxOracleFee : d.maxOracleFeeWei,
    'oracleMaxOracleFee'
  );
  const estimatedBaseCostWei = parseFeeToWei(
    body.oracleEstimatedBaseCost != null && body.oracleEstimatedBaseCost !== '' ? body.oracleEstimatedBaseCost : d.estimatedBaseCostWei,
    'oracleEstimatedBaseCost'
  );
  const alphaRaw = body.oracleAlpha != null && body.oracleAlpha !== '' ? body.oracleAlpha : d.alpha;
  const scalingRaw = body.oracleMaxFeeBasedScaling != null && body.oracleMaxFeeBasedScaling !== '' ? body.oracleMaxFeeBasedScaling : d.maxFeeBasedScaling;

  const alpha = Number(alphaRaw);
  const maxFeeBasedScaling = Number(scalingRaw);

  if (maxOracleFeeWei <= 0n) throw new Error('oracleMaxOracleFee must be > 0 (contract: "bad oracle fee")');
  if (maxOracleFeeWei > feeCeilingWei) {
    throw new Error(`oracleMaxOracleFee ${ethers.formatEther(maxOracleFeeWei)} ETH exceeds the aggregator ceiling of ${ethers.formatEther(feeCeilingWei)} ETH (contract: "oracle fee above ceiling")`);
  }
  if (estimatedBaseCostWei >= maxOracleFeeWei) {
    throw new Error(`oracleEstimatedBaseCost (${ethers.formatEther(estimatedBaseCostWei)} ETH) must be below oracleMaxOracleFee (${ethers.formatEther(maxOracleFeeWei)} ETH) (contract: "base cost must be below fee")`);
  }
  if (!Number.isInteger(maxFeeBasedScaling) || maxFeeBasedScaling < 1 || maxFeeBasedScaling > ORACLE_MAX_FEE_SCALING) {
    throw new Error(`oracleMaxFeeBasedScaling must be an integer between 1 and ${ORACLE_MAX_FEE_SCALING} (contract: "bad fee scaling")`);
  }
  if (!Number.isInteger(alpha) || alpha < 0 || alpha > ORACLE_MAX_ALPHA) {
    throw new Error(`oracleAlpha must be an integer between 0 and ${ORACLE_MAX_ALPHA} (contract: "bad alpha")`);
  }
  // v2: the fee floor (item 8; may exceed the ceiling — it prices jurors, not eligibility) and the
  // beacon flag (item 9). Defaults: opts.minOracleFeeWei / opts.withBeacons (a class preset), else
  // no floor and no beacons.
  const minOracleFeeWei = parseFeeToWei(
    body.oracleMinOracleFee != null && body.oracleMinOracleFee !== '' ? body.oracleMinOracleFee : (opts.minOracleFeeWei ?? '0'),
    'oracleMinOracleFee'
  );
  if (minOracleFeeWei < 0n || minOracleFeeWei > UINT96_MAX) throw new Error('oracleMinOracleFee is out of range (contract: "bad fee floor")');
  let withBeacons;
  try {
    withBeacons = parseBool(body.oracleWithBeacons, opts.withBeacons ?? false);
  } catch (e) {
    throw new Error(`oracleWithBeacons: ${e.message}`);
  }

  return {
    maxOracleFee: maxOracleFeeWei.toString(),
    alpha,
    estimatedBaseCost: estimatedBaseCostWei.toString(),
    maxFeeBasedScaling,
    minOracleFee: minOracleFeeWei.toString(),
    withBeacons
  };
}

const JURY_FIELDS = ['K', 'M', 'N', 'P', 'timeout'];
const UINT40_MAX = 2 ** 40 - 1;

/**
 * The creator's jury override (`body.jury`): an object (or its JSON) with any of K, M, N, P and
 * timeout, each replacing the preset's. Returns the override object (only the fields given), or
 * undefined when there is none. The pre-item-15 jury INDEX (a number) is refused with a hint.
 */
function parseJuryOverride(v) {
  if (v === undefined || v === null || v === '') return undefined;
  let o = v;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { o = Number(v); }
  }
  if (typeof o !== 'object' || Array.isArray(o)) {
    throw new Error('jury is the bounty\'s own jury { K, M, N, P, timeout } (an aggregator index is no longer used): pass an object, or omit it to use the class preset\'s');
  }
  const out = {};
  for (const f of JURY_FIELDS) {
    if (o[f] === undefined || o[f] === null || o[f] === '') continue;
    const n = Number(o[f]);
    const max = f === 'timeout' ? UINT40_MAX : 255;
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`jury.${f} must be an integer between 0 and ${max}`);
    out[f] = n;
  }
  const unknown = Object.keys(o).filter((k) => !JURY_FIELDS.includes(k));
  if (unknown.length) throw new Error(`jury has unknown field(s) ${unknown.join(', ')}: use ${JURY_FIELDS.join(', ')}`);
  return out;
}

/**
 * BountyEscrow.createBounty's jury rule (the aggregator's structural one): K >= M >= N >= P >= 1,
 * 2M > K (more than half of the seats are promoted), N <= 40, P >= 2 unless N = 1, and a timeout. Returns an error string or null. The aggregator's
 * live limits (K <= maxJury and the keeper's shortlist, T+ < timeout <= maxTimeout and <= 1 day) are checked
 * separately when it can be read; each request checks them again.
 */
function juryRuleError(j) {
  if (!j || typeof j !== 'object') return 'jury is missing';
  const { K, M, N, P, timeout } = j;
  if (!(P >= 1 && P <= N && N <= M && M <= K && 2 * M > K && N <= 40 && (P !== 1 || N === 1))) {
    return `jury ${K}/${M}/${N}/${P} must satisfy K >= M >= N >= P >= 1, 2M > K, N <= 40 and P >= 2 unless N = 1 (contract: "bad jury")`;
  }
  if (!(timeout > 0)) return 'jury.timeout must be a positive number of seconds';
  return null;
}

/**
 * Resolve the creator's v2 decision settings (TODO item 15's size classes, item 12's rule): the
 * jury { K, M, N, P, timeout }, pass quota Q, forfeit line R and hunter bond, plus the class's fee
 * floor and beacon flag as defaults for resolveOracleSettings. The preset is `bountyClass` if given,
 * else the smallest class offered for the bounty's USD amount (shared/classPresets.js); every field
 * the creator passes overrides it (the jury field by field, through toBountyParams). USD amounts
 * convert at `ethUsd`; with no price, a preset that needs one throws (pass bond and
 * oracleMinOracleFee explicitly).
 *
 * `outcomes` (1 or 2) is how many values each juror answers with: the preset's (Jumbo 1, the others
 * 2) unless the creator passes it. The evaluation package is built to ask for that many, and
 * createBounty stores it: the escrow reads a result of any other length as no result.
 *
 * @returns {{ bountyClass, jury: {K, M, N, P, timeout}, quota, forfeitLine, bond (wei string), minOracleFeeWei, withBeacons, outcomes }}
 */
function resolveDecisionSettings(body = {}, { bountyUsd = null, ethUsd = null } = {}) {
  const key = body.bountyClass || presetForBounty(bountyUsd)?.key || 'small';
  const preset = presetByKey(key);
  if (!preset) throw new Error(`bountyClass must be one of ${CLASS_PRESETS.map((c) => c.key).join(', ')}`);
  const priced = (usd, field) => {
    if (!usd) return 0n;
    if (!(Number(ethUsd) > 0)) throw new Error(`the ETH price is unavailable, so the ${preset.name} preset's ${field} can't be converted: pass ${field === 'bond' ? 'bond' : 'oracleMinOracleFee'} explicitly`);
    return usdToWei(usd, ethUsd);
  };
  const int = (v, fallback, name) => {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`${name} must be an integer between 0 and 255`);
    return n;
  };
  const juryOverride = parseJuryOverride(body.jury);
  // The creator's jury, Q and R over the preset's (toBountyParams). Its bond and fee floor are
  // priced below, with the price-missing message, so any positive price serves here.
  const fromPreset = toBountyParams(preset.key, Number(ethUsd) > 0 ? ethUsd : 1, {
    jury: juryOverride ? { ...preset.jury, ...juryOverride } : undefined,
    quota: int(body.quota, undefined, 'quota'),
    forfeitLine: int(body.forfeitLine, undefined, 'forfeitLine'),
  });
  const { jury, quota, forfeitLine } = fromPreset;
  const outcomes = body.outcomes === undefined || body.outcomes === null || body.outcomes === '' ? preset.outcomes : Number(body.outcomes);
  if (outcomes !== 1 && outcomes !== 2) throw new Error('outcomes must be 1 (one number, the FUND score) or 2 ([DONT_FUND, FUND]) (contract: "bad outcomes")');
  const juryErr = juryRuleError(jury);
  if (juryErr) throw new Error(juryErr);
  if (quota < 1 || forfeitLine > quota) throw new Error('quota must be at least 1 and forfeitLine at most quota (contract: "bad quota")');
  if (quota > jury.N) throw new Error(`quota ${quota} exceeds the jury's N (${jury.N}) (contract: "bad quota")`);
  const bond = body.bond != null && body.bond !== '' ? parseFeeToWei(body.bond, 'bond', { maxWei: BOND_SANITY_MAX_WEI }) : priced(preset.bondUsd, 'bond');
  if (bond < 0n || bond > UINT96_MAX) throw new Error('bond is out of range (contract: "bad bond")');
  const minOracleFeeWei = body.oracleMinOracleFee != null && body.oracleMinOracleFee !== ''
    ? null   // resolveOracleSettings reads the creator's own value
    : priced(preset.feeFloorUsd, 'fee floor').toString();
  // The same flag resolveOracleSettings encodes: the creator's override, else the preset's.
  const withBeacons = parseBool(body.oracleWithBeacons, preset.withBeacons);
  return { bountyClass: preset.key, jury, quota, forfeitLine, bond: bond.toString(), minOracleFeeWei, withBeacons, outcomes };
}

// A bond is an amount, not a per-juror fee: allow far more than the fee parser's 0.01 ETH, but still
// catch a units mix-up (wei passed as ETH).
const BOND_SANITY_MAX_WEI = ethers.parseEther('100');

/** Does resolving these settings need an ETH price (a preset USD amount the body doesn't override)? */
function presetNeedsPrice(body = {}, bountyUsd = null) {
  const preset = presetByKey(body.bountyClass || presetForBounty(bountyUsd)?.key || 'small');
  if (!preset) return false;
  const bondGiven = body.bond != null && body.bond !== '';
  const floorGiven = body.oracleMinOracleFee != null && body.oracleMinOracleFee !== '';
  return (!bondGiven && preset.bondUsd > 0) || (!floorGiven && preset.feeFloorUsd > 0);
}

/**
 * A job record's jury { K, M, N, P, timeout }: its own (from the API or getBounty's juryK..juryTimeout,
 * via the sync), else its class preset's, else the Small preset's (records from before item 15
 * stored an aggregator index).
 */
function jobJury(job) {
  const d = job?.decisionSettings;
  const j = d?.jury;
  if (j && typeof j === 'object' && Number(j.K) > 0) {
    return { K: Number(j.K), M: Number(j.M), N: Number(j.N), P: Number(j.P), timeout: Number(j.timeout) };
  }
  return { ...(presetByKey(d?.bountyClass) || presetByKey('small')).jury };
}

/** Decision settings of a job record (v1-era records: v1's rule, the Small jury, no bond). */
function jobDecisionSettings(job) {
  const d = job?.decisionSettings;
  if (d && d.quota != null) {
    return { bountyClass: d.bountyClass || null, jury: jobJury(job), quota: Number(d.quota), forfeitLine: Number(d.forfeitLine ?? 0), bond: String(d.bond ?? '0'),
      outcomes: Number(d.outcomes) === 1 ? 1 : 2 };
  }
  return { bountyClass: null, jury: jobJury(job), quota: 1, forfeitLine: 1, bond: '0', outcomes: 2 };
}

/**
 * Oracle settings for a job record, falling back to config defaults for records
 * that predate per-bounty settings (the sync service backfills from getBounty()).
 */
function jobOracleSettings(job) {
  const o = job?.oracleSettings;
  if (o && o.maxOracleFee != null) {
    return {
      maxOracleFee: String(o.maxOracleFee),
      alpha: Number(o.alpha ?? config.submissionDefaults.alpha),
      estimatedBaseCost: String(o.estimatedBaseCost ?? config.submissionDefaults.estimatedBaseCostWei),
      maxFeeBasedScaling: Number(o.maxFeeBasedScaling ?? config.submissionDefaults.maxFeeBasedScaling),
      minOracleFee: String(o.minOracleFee ?? '0'),
      withBeacons: Boolean(o.withBeacons)
    };
  }
  return {
    maxOracleFee: String(config.submissionDefaults.maxOracleFeeWei),
    alpha: Number(config.submissionDefaults.alpha),
    estimatedBaseCost: String(config.submissionDefaults.estimatedBaseCostWei),
    maxFeeBasedScaling: Number(config.submissionDefaults.maxFeeBasedScaling),
    minOracleFee: '0',
    withBeacons: false
  };
}

/**
 * Build the exact createBounty(CreateParams) struct + calldata for a job record so
 * agents send the on-chain create with the same values the API persisted.
 * msg.value == max(creatorDeterminationPayment, arbiterDeterminationPayment); for a
 * non-windowed bounty both equal bountyAmount and the window is 0.
 */
function buildCreateBountyTx(job) {
  const oracle = jobOracleSettings(job);
  const decision = jobDecisionSettings(job);
  const amountWei = bountyAmountWei(job);
  const windowed = Number(job.creatorAssessmentWindowSize || 0) > 0 && job.creatorDeterminationPayment != null;
  const creatorPayWei = windowed ? ethers.parseEther(String(job.creatorDeterminationPayment)) : amountWei;
  const arbiterPayWei = windowed ? ethers.parseEther(String(job.arbiterDeterminationPayment)) : amountWei;
  const valueWei = creatorPayWei > arbiterPayWei ? creatorPayWei : arbiterPayWei;

  const params = {
    evaluationCid: job.evaluationCid,
    requestedClass: String(job.classId),
    threshold: String(job.threshold),
    submissionDeadline: String(job.submissionCloseTime),
    targetHunter: job.targetHunter || ethers.ZeroAddress,
    creatorDeterminationPayment: creatorPayWei.toString(),
    arbiterDeterminationPayment: arbiterPayWei.toString(),
    creatorAssessmentWindowSize: String(windowed ? job.creatorAssessmentWindowSize : 0),
    oracle: {
      maxOracleFee: oracle.maxOracleFee,
      alpha: String(oracle.alpha),
      estimatedBaseCost: oracle.estimatedBaseCost,
      maxFeeBasedScaling: String(oracle.maxFeeBasedScaling),
      minOracleFee: oracle.minOracleFee,
      withBeacons: oracle.withBeacons
    },
    jury: Object.fromEntries(JURY_FIELDS.map((f) => [f, String(decision.jury[f])])),
    quota: String(decision.quota),
    forfeitLine: String(decision.forfeitLine),
    bond: decision.bond,
    outcomes: String(decision.outcomes)
  };

  let data = null;
  try {
    data = createBountyIface.encodeFunctionData('createBounty', [[
      params.evaluationCid,
      BigInt(params.requestedClass),
      BigInt(params.threshold),
      BigInt(params.submissionDeadline),
      params.targetHunter,
      creatorPayWei,
      arbiterPayWei,
      BigInt(params.creatorAssessmentWindowSize),
      [BigInt(oracle.maxOracleFee), BigInt(oracle.alpha), BigInt(oracle.estimatedBaseCost), BigInt(oracle.maxFeeBasedScaling),
        BigInt(oracle.minOracleFee), Boolean(oracle.withBeacons)],
      JURY_FIELDS.map((f) => BigInt(decision.jury[f])),
      BigInt(decision.quota),
      BigInt(decision.forfeitLine),
      BigInt(decision.bond),
      BigInt(decision.outcomes)
    ]]);
  } catch (e) {
    logger.warn('[buildCreateBountyTx] encode failed', { jobId: job.jobId, msg: e.message });
  }

  return {
    method: 'createBounty',
    abi: CREATE_BOUNTY_ABI,
    params,
    transaction: {
      to: config.bountyEscrowAddress || null,
      data,
      value: valueWei.toString(),
      chainId: config.chainId
    },
    note: 'createBounty takes ONE struct argument (no overloads). msg.value must equal max(creatorDeterminationPayment, arbiterDeterminationPayment). jury is the bounty\'s own (K drawn, M promoted, N counted, P clustered, timeout in seconds), sent with every request to the escrow\'s one aggregator; quota/forfeitLine are item 12\'s pass quota Q and forfeit line R; bond is what each hunter posts at start (returned unless a hard fail forfeits it to you). Parse the BountyCreated event on the receipt for bountyId, then PATCH /api/jobs/:jobId/bountyId { bountyId, txHash }.'
  };
}

/**
 * Guard (review 2026-11-26 #19): refuse hunter work on a bounty whose jury the aggregator would
 * refuse under its live, owner-set limits (lens juryProblem): every start would revert, so the
 * hunter should not upload, prepare or start. Sends 409 JURY_NOT_RUNNABLE and returns true when
 * it refuses. A failed chain read does not refuse (the contract's own checks still apply).
 */
async function rejectIfJuryUnrunnable(res, job, jobId) {
  let problem = '';
  try {
    problem = await getContractService().getJuryProblem(Number(job.jobId));
  } catch (e) {
    logger.warn('[juryProblem] chain read failed; not refusing', { jobId, msg: e.message });
    return false;
  }
  if (!problem) return false;
  sendError(res, 409, {
    code: ErrorCodes.JURY_NOT_RUNNABLE,
    message: 'This bounty\'s jury cannot run under the aggregator\'s current limits',
    details: `The aggregator refuses a request with this bounty's jury (${problem}), so every start would revert and no submission can be evaluated. Do not work on it. The creator recovers the escrow at the deadline (closeExpiredBounty).`,
    fix: 'Choose another bounty. The live check is the escrow\'s juryProblem(bountyId) view (empty when the jury can run).',
    extra: { juryProblem: problem },
  });
  return true;
}

/**
 * Guard: a job is linked to an on-chain bounty if PATCH /bountyId set onChain,
 * or the sync service auto-linked it via BountyCreated event.
 * Without this, calldata endpoints happily encode the API-local jobId as the
 * on-chain bountyId, producing transactions that revert on-chain.
 * Returns true and sends a structured error if the job is not linked.
 */
function rejectIfNotOnChain(res, job, jobId, extra) {
  if (job.onChain || job.syncedFromBlockchain) return false;
  sendError(res, 400, {
    code: ErrorCodes.BOUNTY_NOT_ONCHAIN,
    message: 'Bounty not linked to on-chain contract',
    details: `Bounty #${jobId} was created via the API but has no corresponding on-chain bounty. This usually means createBounty() was never called on the BountyEscrow contract, or the link step was skipped. Calldata endpoints would otherwise emit a transaction that references the wrong on-chain bountyId — this is the silent-failure mode this guard prevents.`,
    fix: `PATCH /api/jobs/${jobId}/bountyId with { bountyId, txHash } to link this job to the on-chain bountyId. If you don't know which API jobId matches your on-chain bounty, call GET /api/jobs/lookup first.`,
    tips: [
      `If you already called createBounty(): PATCH /api/jobs/${jobId}/bountyId with { bountyId, txHash } to link.`,
      `If you're not sure which API jobId matches your on-chain bounty: GET /api/jobs/lookup?txHash=<your-tx> (or ?bountyId=<n> or ?evaluationCid=<cid>).`,
      `To diagnose drift between local and on-chain ids: GET /api/jobs/${jobId}/onchain-status and read the "linkage" field.`,
      `If you have not yet created the on-chain bounty: call createBounty() on the BountyEscrow contract, then PATCH /bountyId.`
    ],
    extra: {
      ...(extra || {}),
      recoveryEndpoints: {
        lookup: '/api/jobs/lookup',
        linkageDiagnostic: `/api/jobs/${jobId}/onchain-status`,
        link: `PATCH /api/jobs/${jobId}/bountyId`
      }
    }
  });
  return true;
}

// Loose IPFS CID check; we still try a HEAD fetch later when possible.
const CID_REGEX =
  /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[0-9A-Za-z]{50,}|z[1-9A-HJ-NP-Za-km-z]{46,}|ba[ef]y[0-9A-Za-z]{50,}|b[A-Za-z2-7]{58,}|B[A-Z2-7]{58,}|F[0-9A-F]{50,})$/i;

// One temp base OUTSIDE the project tree
const TMP_BASE = process.env.VERDIKTA_TMP_DIR || path.join(os.tmpdir(), 'verdikta');
async function ensureTmpBase() {
  await fs.mkdir(TMP_BASE, { recursive: true });
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}
function stringifyErr(e) {
  if (!e) return 'Unknown error';
  if (e.response?.data) {
    try { return JSON.stringify(e.response.data); } catch {}
    return String(e.response.data);
  }
  if (e.data) {
    try { return JSON.stringify(e.data); } catch {}
    return String(e.data);
  }
  return e.message || String(e);
}

// Direct, minimal JSON‑pin helper (Pinata). Expects RAW JWT in env; we add "Bearer ".
const PIN_TIMEOUT_MS = Number(process.env.PIN_TIMEOUT_MS || 20000);
function withTimeout(p, ms, label='operation') {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

/**
 * Gas guidance for a resolve call (finalize / force-fail): live estimateGas + margin via
 * the contract service, or the safe fallback when the service is down or the call would
 * revert right now. Never throws — see ContractService.estimateResolveGas for the why.
 */
async function resolveGasGuidance(data, from, { fallbackLimit = RESOLVE_GAS_LIMIT_FALLBACK } = {}) {
  try {
    return await getContractService().estimateResolveGas({ data, from }, { fallbackLimit });
  } catch (err) {
    return { gasLimit: fallbackLimit.toString(), estimatedGas: null, source: 'fallback', reason: err.message };
  }
}
/**
 * When nextAction is AWAIT_EARLIER: the earlier submissions by other hunters that hold
 * payout priority, each with the transaction that resolves it now (FINALIZE /
 * CLOSE_FAILED / EXPIRE_RERUN; anyone may send it) or none if it is still in evaluation. Never throws.
 */
async function finalizeBlockersFor(onChainBountyId, onChainSubmissionId, from) {
  try {
    const blockers = await findFinalizeBlockers(getContractService().contract, onChainBountyId, onChainSubmissionId);
    const blockedBy = await Promise.all(blockers.map(async (b) => {
      const data = blockerCalldata(onChainBountyId, b);
      const entry = { submissionId: b.submissionId, hunter: b.hunter, nextAction: b.nextAction };
      if (data) {
        const gas = await resolveGasGuidance(data, from);
        entry.method = b.method;
        entry.transaction = { to: config.bountyEscrowAddress, data, value: '0', chainId: config.chainId, gasLimit: gas.gasLimit };
      }
      return entry;
    }));
    return { blockedBy, hint: blockersHint(blockers) };
  } catch (err) {
    logger.warn('[finalize-blockers] lookup failed', { onChainBountyId, onChainSubmissionId, msg: err.message });
    return null;
  }
}

async function pinJsonToPinata(contentObj, name = 'verdikta-json') {
  const PINATA_BASE = (process.env.IPFS_PINNING_SERVICE || 'https://api.pinata.cloud').replace(/\/+$/,'');
  const jwt = process.env.IPFS_PINNING_KEY || '';
  if (!jwt) throw new Error('IPFS_PINNING_KEY not set');
  const authHeader = jwt.toLowerCase().startsWith('bearer ') ? jwt : `Bearer ${jwt}`;

  const url = `${PINATA_BASE}/pinning/pinJSONToIPFS`;
  const res = await withTimeout(fetch(url, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinataContent: contentObj, pinataMetadata: { name } })
  }), PIN_TIMEOUT_MS, 'Pinata pinJSONToIPFS');

  const text = await res.text();
  if (!res.ok) {
    let data; try { data = JSON.parse(text); } catch { data = text; }
    const err = new Error(`Pinata returned ${res.status}`);
    err.status = res.status;
    err.response = { status: res.status, data };
    throw err;
  }
  const parsed = JSON.parse(text);
  if (!parsed?.IpfsHash) throw new Error('Pinata response missing IpfsHash');
  return parsed.IpfsHash;
}

// The creator's USD estimate, stored in whole cents (ETH x price is a float,
// e.g. 0.24484899999999998). Anything not a positive number is stored as 0.
function roundUsdCents(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/* ==============
   CREATE A JOB
   ============== */

/**
 * POST /api/jobs/create
 * Accepts ONE OF:
 *  - rubricJson: object (server pins & returns real rubricCid), OR
 *  - rubricCid:  string (already pinned), OR
 *  - rubricTemplate: string (a GET /api/templates key; the server fills in its rubric)
 * Uses ipfsClient.uploadToIPFS for the Primary archive.
 */
router.post('/create', limitPins, async (req, res) => {
  const keys = Object.keys(req.body || {});
  logger.info('[jobs/create] incoming keys', { keys });

  try {
    // A rubric named by template key becomes that template's exact rubricJson, with its
    // recommended threshold and classId unless the caller sent their own.
    let createBody = req.body || {};
    let referencedTemplate = null;
    if (createBody.rubricTemplate != null) {
      const expanded = expandRubricTemplate(createBody);
      if (expanded.error) return res.status(400).json(expanded.error);
      createBody = expanded.body;
      referencedTemplate = expanded.template.key;
    }
    const {
      title,
      description,
      workProductType = 'Work Product',
      creator,
      bountyAmount,
      bountyAmountUSD,
      threshold,
      rubricJson,              // optional (server pins json)
      rubricCid: rubricCidIn,  // optional (already pinned)
      classId = 128,
      juryNodes = [],
      iterations = 1,
      submissionWindowHours = 24,
      targetHunter,
      creatorDeterminationPayment,
      arbiterDeterminationPayment,
      creatorAssessmentWindowHours,
      publicSubmissions,
      rubricSource,            // optional create-page hint: { source, templateKey }
    } = createBody;

    // ---- Decision + oracle settings (creator-chosen, per bounty; defaults from the size-class
    // preset, shared/classPresets.js, and config) ----
    let oracleSettings;
    let decisionSettings;
    try {
      // The ETH price the creator saw: bountyAmountUSD / bountyAmount when both are given (the
      // website computes one from the other), else the server's price feed — fetched only when a
      // preset's USD amounts actually need converting.
      const ethAmt = Number(bountyAmount);
      const usdAmt = Number(bountyAmountUSD);
      let ethUsd = ethAmt > 0 && usdAmt > 0 ? usdAmt / ethAmt : null;
      if (ethUsd == null && presetNeedsPrice(req.body || {}, usdAmt || null)) ethUsd = (await getEthPriceUsd()).usd;
      decisionSettings = resolveDecisionSettings(req.body || {}, { bountyUsd: Number(bountyAmountUSD) || null, ethUsd });
      let feeCeilingWei = null;
      if (isVerdiktaServiceAvailable()) {
        try {
          const aggConfig = await getVerdiktaService().getAggregatorConfig();
          if (aggConfig?.maxOracleFee) feeCeilingWei = ethers.parseEther(String(aggConfig.maxOracleFee));
          // The aggregator's live jury limits: every request would revert BadJury otherwise.
          const j = decisionSettings.jury;
          if (aggConfig?.maxJury && j.K > aggConfig.maxJury) {
            throw new Error(`jury.K ${j.K} exceeds the aggregator's maxJury (${aggConfig.maxJury}) (aggregator: "BadJury")`);
          }
          // AggregatorLib also caps every timeout at one day (MAX_TIMEOUT), whatever maxTimeout says
          if (aggConfig?.tPlus && aggConfig?.maxTimeout && !(j.timeout > aggConfig.tPlus && j.timeout <= aggConfig.maxTimeout && j.timeout <= 86400)) {
            throw new Error(`jury.timeout ${j.timeout} s must be above T+ (${aggConfig.tPlus} s) and at most the aggregator's maxTimeout (${aggConfig.maxTimeout} s) and one day (86400 s) (aggregator: "BadJury")`);
          }
        } catch (e) {
          if (/BadJury/.test(e.message)) throw e;
          logger.debug('[jobs/create] aggregator config read failed; using static checks', { msg: e.message });
        }
      }
      oracleSettings = resolveOracleSettings(req.body || {}, {
        feeCeilingWei, minOracleFeeWei: decisionSettings.minOracleFeeWei, withBeacons: decisionSettings.withBeacons
      });
      delete decisionSettings.minOracleFeeWei;
      delete decisionSettings.withBeacons;
    } catch (oracleErr) {
      return res.status(400).json({
        error: 'Invalid oracle settings',
        details: oracleErr.message,
        fix: 'Optional fields: bountyClass (' + CLASS_PRESETS.map((c) => c.key).join(' | ') + '; presets the rest, by default the smallest class offered for bountyAmountUSD), jury ({ K, M, N, P, timeout }: any of them, over the preset\'s; K >= M >= N >= P >= 1, 2M > K, N <= 40), quota (1 <= Q <= N), forfeitLine (R <= Q), bond (decimal ETH or integer wei), oracleMaxOracleFee (decimal ETH or integer wei, > 0, <= the aggregator\'s ceiling), oracleMinOracleFee (fee floor, decimal ETH or wei), oracleWithBeacons (bool), oracleAlpha (0..1000), oracleEstimatedBaseCost (decimal ETH or wei, < oracleMaxOracleFee), oracleMaxFeeBasedScaling (1..1000). Omit them to use the preset and the server defaults. GET /api/classes/presets lists the presets.',
        defaults: {
          oracleMaxOracleFee: config.submissionDefaults.maxOracleFeeWei,
          oracleAlpha: config.submissionDefaults.alpha,
          oracleEstimatedBaseCost: config.submissionDefaults.estimatedBaseCostWei,
          oracleMaxFeeBasedScaling: config.submissionDefaults.maxFeeBasedScaling
        }
      });
    }

    // ---- Validate commons ----
    if (!title || !description || !creator) {
      return res.status(400).json({ error: 'Missing required fields', details: 'title, description, creator required' });
    }
    // Strings only: an array title broke every /api/jobs?search= (title.toLowerCase) for an hour.
    if (typeof title !== 'string' || typeof description !== 'string' || typeof creator !== 'string' ||
        (workProductType != null && typeof workProductType !== 'string') || title.length > 300) {
      return res.status(400).json({ error: 'Invalid fields', details: 'title (at most 300 characters), description, creator and workProductType must be strings' });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(creator)) {
      return res.status(400).json({ error: 'Invalid creator address', details: 'Must be a valid Ethereum address' });
    }
    const procurementError = validateProcurement(req.body?.procurementMode, targetHunter);
    if (procurementError) return res.status(400).json({ error: req.body?.procurementMode == null ? 'Invalid targetHunter address' : 'Invalid procurement intent', details: procurementError });
    const wagerError = validateWagerTarget(description, creator, targetHunter);
    if (wagerError) return res.status(400).json({ error: 'Invalid mutual-wager target', code: 'WAGER_TARGET', details: wagerError });
    let payments;
    let exactDeadline = null;
    try { ({ submissionDeadline: exactDeadline, ...payments } = normalizeBountyPayments(req.body)); }
    catch (error) {
      const label = error.code === 'INVALID_BOUNTY_WINDOW' ? 'Invalid bounty window'
        : error.field === 'bountyAmount' && req.body?.procurementMode == null ? 'Invalid bountyAmount'
        : 'Invalid bounty payment';
      return res.status(400).json({ error: label, details: error.message });
    }
    const normalizedTarget = !targetHunter || ethers.getAddress(targetHunter) === ethers.ZeroAddress ? null : ethers.getAddress(targetHunter);
    if (!Number.isFinite(Number(threshold)) || Number(threshold) < 0 || Number(threshold) > 100) {
      return res.status(400).json({ error: 'Invalid threshold', details: 'Threshold must be between 0 and 100' });
    }
    // Catch the most common shape mistake: agents pre-stringifying nested JSON
    // fields. The request body is already JSON; nested objects must be passed
    // as native objects, not as JSON-encoded strings.
    if (typeof juryNodes === 'string') {
      return res.status(400).json({
        error: 'Invalid jury configuration',
        details: 'juryNodes must be a JSON array, received a string. The request body is already JSON — do not pre-stringify nested fields. Pass it as a native array, e.g. "juryNodes": [ ... ], not "juryNodes": "[ ... ]".'
      });
    }
    if (typeof rubricJson === 'string') {
      return res.status(400).json({
        error: 'Invalid rubric',
        details: 'rubricJson must be a JSON object, received a string. The request body is already JSON — do not pre-stringify the rubric. Pass it as a native object, e.g. "rubricJson": { "criteria": [...] }, not "rubricJson": "{\\"criteria\\":[...]}". To debug rubric shape without side effects, use POST /api/jobs/rubric/validate.'
      });
    }
    // ---- Class + jury (see utils/classPolicy.js) ----
    // Classes are permissionless: a class outside the @verdikta/common registry is
    // allowed with warnings. Refusals are limited to a jury the registry rules out
    // for a listed class, and to a class no arbiter could serve.
    const classIdNum = Number(classId);
    if (!Number.isSafeInteger(classIdNum) || classIdNum < 0) {
      return res.status(400).json({ error: 'Invalid classId', details: 'classId must be a non-negative integer' });
    }
    const { listed: classListed } = lookupClass(classIdNum);
    // Model-id format is a typo heuristic: ids the registry lists exactly skip it, and
    // for a class outside the registry its arbiter operators define the ids, so it only warns.
    const juryValidation = validateJuryNodes(juryNodes, {
      modelFormat: classListed === false ? 'warn' : 'error',
      isRegistryModel: registryModelMatcher(classIdNum) || undefined
    });
    if (!juryValidation.valid) {
      return res.status(400).json({
        error: 'Invalid jury configuration',
        details: 'Jury validation failed',
        errors: juryValidation.errors
      });
    }

    const juryCheck = checkJuryAgainstClass(juryNodes, classIdNum);
    if (juryCheck.errors.length > 0) {
      return res.status(400).json({
        error: 'Invalid jury configuration',
        details: juryCheck.invalidNodes.length > 0
          ? 'One or more jury models are not supported for this class'
          : juryCheck.errors[0],
        classId: classIdNum,
        invalidNodes: juryCheck.invalidNodes,
        allowedModels: juryCheck.allowedModels || []
      });
    }

    const coverageCheck = await checkClassCoverage(classIdNum, oracleSettings, { creator, jury: decisionSettings.jury });
    if (coverageCheck.refusal) {
      return res.status(400).json({
        error: 'No arbiters can serve this class',
        code: 'CLASS_UNSERVABLE',
        details: coverageCheck.refusal,
        classId: classIdNum,
        coverage: coverageCheck.coverage
      });
    }

    const classPolicy = {
      classId: classIdNum,
      listed: juryCheck.listed,
      juryModelsVerified: juryCheck.juryModelsVerified,
      coverage: coverageCheck.coverage,
      warnings: [...juryValidation.warnings, ...juryCheck.warnings, ...coverageCheck.warnings]
    };
    if (classPolicy.warnings.length > 0) {
      logger.info('[jobs/create] class warnings', { classId: classIdNum, listed: classPolicy.listed, warnings: classPolicy.warnings });
    }

    if (!rubricJson && !rubricCidIn) {
      return res.status(400).json({ error: 'Missing rubric', details: 'Provide rubricJson, rubricCid or rubricTemplate (a key from GET /api/templates)' });
    }

    await ensureTmpBase();

    // ---- Check the rubric input (nothing is pinned until the query fits) ----
    if (rubricJson) {
      const validation = validateRubric(rubricJson);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Invalid rubric', details: 'Rubric validation failed', errors: validation.errors });
      }
    } else {
      if (typeof rubricCidIn !== 'string' || !CID_REGEX.test(rubricCidIn)) {
        return res.status(400).json({ error: 'Invalid rubricCid', details: 'Provide a valid IPFS CID' });
      }

      // Optional: non-fatal HEAD check if your IPFS client supports it
      try {
        const ipfsClient = req.app.locals.ipfsClient;
        if (ipfsClient?.headFromIPFS && typeof ipfsClient.headFromIPFS === 'function') {
          await ipfsClient.headFromIPFS(rubricCidIn);
        }
      } catch (e) {
        logger.warn('[jobs/create] rubricCid HEAD check failed (continuing)', { cid: rubricCidIn, msg: e.message });
      }
    }

    // ---- Extract rubric criteria for two-phase query ----
    let rubricCriteria = null;
    let forbiddenContent = null;
    let rubricDoc = rubricJson || null;   // the whole rubric, for the mutual-wager check

    if (rubricJson) {
      rubricCriteria = rubricJson.criteria || null;
      forbiddenContent = rubricJson.forbiddenContent || rubricJson.forbidden_content || null;
    } else {
      // rubricCid path: try to fetch rubric from IPFS to extract criteria
      try {
        const ipfsClient = req.app.locals.ipfsClient;
        if (ipfsClient?.fetchFromIPFS) {
          const rubricBuffer = await ipfsClient.fetchFromIPFS(rubricCidIn);
          const rubricData = JSON.parse(rubricBuffer.toString('utf8'));
          rubricDoc = rubricData;
          rubricCriteria = rubricData.criteria || null;
          forbiddenContent = rubricData.forbiddenContent || rubricData.forbidden_content || null;
          logger.info('[jobs/create] rubric criteria extracted from IPFS', {
            criteriaCount: rubricCriteria?.length || 0,
            mustPassCount: (rubricCriteria || []).filter(c => c.must).length
          });
        }
      } catch (e) {
        logger.warn('[jobs/create] Could not fetch rubric from IPFS for criteria extraction (continuing with fallback query)', {
          cid: rubricCidIn, msg: e.message
        });
      }
    }

    // ---- Mutual wager (shared/mutualWager.js, utils/wagerGuard.js) ----
    // A description with a MUTUAL WAGER TERMS block must describe exactly this bounty (stake,
    // threshold, class, jury, oracle settings, a deadline that covers settlement, a start at
    // least 10 minutes away), with the template rubric unchanged, and a counter bounty the
    // terms name must match its live record, because the jury then skips its own counter
    // checks. The create page runs the same check before funding; this covers every other
    // client. POST /api/wagers/check is the free dry run of exactly this.
    if (looksLikeMutualWager(description, rubricDoc || { criteria: rubricCriteria })) {
      const wagerCheck = await checkWagerCreate({
        body: { ...createBody, classId: classIdNum },
        // The deadline that goes on chain: an exact one is checked as given, not re-derived from now.
        payments: { ...payments, submissionDeadline: exactDeadline },
        oracleSettings,
        decisionSettings,
        rubric: rubricDoc,
        now: Math.floor(Date.now() / 1000),
        readCounter: (n) => readWagerRecords(n, req.app.locals.ipfsClient),
        listCreatorJobs: (wallet) => linkedWagerJobs((j) => sameAddress(j.creator, wallet)),
      });
      if (wagerCheck.issues.length) {
        logger.info('[jobs/create] mutual wager refused', { creator, codes: wagerCheck.issues.map((i) => i.code) });
        const refusal = wagerRefusal(wagerCheck.issues);
        return res.status(refusal.status).json(refusal.body);
      }
    }

    // Which template the rubric came from, for GET /admin/template-usage.
    const rubricTemplate = rubricTemplateRecord({ criteria: rubricCriteria, forbiddenContent }, rubricSource, { reference: referencedTemplate });

    // ---- Composed query length (issue #36) ----
    // The arbiters reject an evaluation query over their cap and never commit,
    // so a bounty built from it can never be won. Refuse it before any pinning.
    const measured = archiveGenerator.measureEvaluationQuery({
      workProductType,
      jobTitle: title,
      jobDescription: description,
      rubricCriteria,
      forbiddenContent,
      outcomes: decisionSettings.outcomes
    });
    const queryCap = maxEvaluationQueryChars();
    if (measured.composedLength > queryCap) {
      const over = measured.composedLength - queryCap;
      const longest = [...measured.breakdown.criteria].sort((a, b) => b.chars - a.chars)[0];
      logger.info('[jobs/create] evaluation query over cap', { composedLength: measured.composedLength, limit: queryCap });
      return res.status(400).json({
        success: false,
        error: 'Evaluation query too long',
        code: ErrorCodes.QUERY_TOO_LONG,
        details: `The evaluation query built from this bounty is ${measured.composedLength} characters; arbiters reject a query over ${queryCap}, so no submission could ever be evaluated.`,
        fix: `Cut at least ${over} characters from the title, description or rubric criterion text (all of them are copied into the query; the template part is fixed). Nothing was pinned and no calldata was returned.`,
        composedLength: measured.composedLength,
        limit: queryCap,
        over,
        breakdown: measured.breakdown,
        tips: longest
          ? [`Longest criterion: "${longest.id}" (${longest.chars} characters).`, 'Check a draft first with POST /api/jobs/rubric/validate, which is free and pins nothing.']
          : ['Check a draft first with POST /api/jobs/rubric/validate, which is free and pins nothing.']
      });
    }

    // ---- Resolve rubricCid ----
    let rubricCid;

    if (rubricJson) {
      // Enrich and pin as JSON (no temp file needed)
      const rubricWithMeta = {
        ...rubricJson,
        version: rubricJson.version || '1.0',
        createdAt: new Date().toISOString(),
        classId
      };

      try {
        const devQuery = DEV_QUERY_ALLOWED && readBool(req.query?.dev);
        const devBypass = devQuery || DEV_ENV_FAKE;
        if (devBypass) {
          rubricCid = `dev-rubric-${Date.now()}.json`;
          logger.warn('[jobs/create] DEV bypass — fake rubricCid', { rubricCid });
        } else {
          rubricCid = await pinJsonToPinata(rubricWithMeta, `rubric-${rubricWithMeta.title || 'untitled'}`);
          logger.info('[jobs/create] rubric pinned (JSON)', { rubricCid });
        }
      } catch (err) {
        const msg = stringifyErr(err);
        logger.error('[jobs/create] rubric JSON pin failed', { msg });
        return res.status(500).json({ success: false, error: `Rubric upload failed: ${msg}` });
      }

    } else {
      rubricCid = rubricCidIn; // checked above
    }

    // ---- Create Primary archive ----
    let primaryArchive;
    try {
      primaryArchive = await archiveGenerator.createPrimaryCIDArchive({
        rubricCid,
        jobTitle: title,
        jobDescription: description,
        workProductType,
        classId,
        juryNodes,
        iterations,
        rubricCriteria,
        forbiddenContent,
        outcomes: decisionSettings.outcomes     // the package asks for what createBounty will store
      });
    } catch (e) {
      logger.error('[jobs/create] primary archive creation failed', { msg: e.message });
      return res.status(500).json({ success: false, error: `Primary archive build failed: ${e.message}` });
    }

    // ---- Pin evaluation archive (file) ----
    let evaluationCid;
    try {
      const devQuery = DEV_QUERY_ALLOWED && readBool(req.query?.dev);
      const devBypass = devQuery || DEV_ENV_FAKE;

      if (devBypass) {
        evaluationCid = `dev-${path.basename(primaryArchive.archivePath)}`;
        logger.warn('[jobs/create] DEV bypass — fake evaluationCid', { evaluationCid });
      } else {
        const ipfsClient = req.app.locals.ipfsClient;
        if (!ipfsClient || typeof ipfsClient.uploadToIPFS !== 'function') {
          throw new Error('IPFS client not initialized on server');
        }
        evaluationCid = await ipfsClient.uploadToIPFS(primaryArchive.archivePath);
        logger.info('[jobs/create] evaluation archive pinned', { evaluationCid });
      }
    } catch (err) {
      const msg = stringifyErr(err);
      logger.error('[jobs/create] primary archive upload failed', { msg });
      return res.status(500).json({ success: false, error: `Primary archive upload failed: ${msg}` });
    } finally {
      if (primaryArchive?.archivePath) {
        await fs.unlink(primaryArchive.archivePath).catch(e =>
          logger.warn('[jobs/create] failed to clean primary archive', { msg: e.message })
        );
      }
    }

    // ---- Dedup: reuse existing job with same evaluationCid ----
    // Prevents ghost duplicates when the user retries the create flow
    // (e.g. on-chain tx failed, user navigates back and resubmits).
    if (evaluationCid) {
      const storage = await jobStorage.readStorage();
      const existing = storage.jobs.find(j =>
        j.evaluationCid === evaluationCid &&
        j.status !== 'ORPHANED' &&
        !j.syncedFromBlockchain &&
        !j.onChain
      );
      if (existing) {
        logger.info('[jobs/create] reusing existing job with same evaluationCid', {
          jobId: existing.jobId, evaluationCid
        });
        // A retry that names an exact deadline gets that deadline, not the first
        // attempt's: the calldata below is built from the stored record.
        if (exactDeadline != null && existing.submissionCloseTime !== exactDeadline) {
          const updated = await jobStorage.updateJob(existing.jobId, {
            submissionCloseTime: exactDeadline,
            plannedSubmissionCloseTime: exactDeadline,
            submissionWindowSeconds: payments.submissionWindowSeconds,
            submissionDeadlineExact: true,
          });
          Object.assign(existing, updated);
        }
        return res.json({
          success: true,
          job: {
            jobId: existing.jobId,
            title: existing.title,
            description: existing.description,
            ...bountyAmountFields(existing),
            bountyAmountUSD: existing.bountyAmountUSD,
            threshold: existing.threshold,
            rubricCid: existing.rubricCid,
            evaluationCid: existing.evaluationCid,
            status: existing.status,
            submissionOpenTime: existing.submissionOpenTime,
            submissionCloseTime: existing.submissionCloseTime,
            submissionCloseTimeIso: isoFromUnix(existing.submissionCloseTime),
            createdAt: existing.createdAt,
            oracleSettings: jobOracleSettings(existing)
          },
          onChain: buildCreateBountyTx(existing),
          classPolicy,
          message: 'Reusing existing job (same evaluation package).'
        });
      }
    }

    // ---- Times ----
    const now = Math.floor(Date.now() / 1000);
    const submissionOpenTime = now;
    const submissionCloseTime = exactDeadline ?? now + payments.submissionWindowSeconds;

    // ---- Persist job ----
    const job = await jobStorage.createJob({
      title,
      description,
      workProductType,
      creator,
      ...payments,
      bountyAmountUSD: roundUsdCents(bountyAmountUSD),
      threshold: Number(threshold),
      rubricCid,
      evaluationCid,
      classId: classIdNum,
      juryNodes,
      iterations: Number(iterations),
      submissionOpenTime,
      submissionCloseTime,
      // What onChain.transaction encodes. The sync overwrites submissionCloseTime with
      // the chain's value, so PATCH /bountyId compares the chain against this copy.
      plannedSubmissionCloseTime: submissionCloseTime,
      // PATCH /bountyId holds an exact deadline to the second; a window may drift
      // by the minutes between this call and the createBounty transaction.
      ...(exactDeadline != null && { submissionDeadlineExact: true }),
      targetHunter: normalizedTarget,
      publicSubmissions: !!publicSubmissions,
      // Creator-chosen oracle request settings (wei strings + integers). Passed
      // verbatim into createBounty's `oracle` struct and used for every evaluation.
      oracleSettings,
      // v2: jury { K, M, N, P, timeout }, Q, R and bond (wei string), passed into createBounty.
      decisionSettings,
      rubricTemplate,
      // Which client created it (website or an agent's key), for the template-usage report.
      createdByClientType: req.clientType || 'unknown',
      createdByClientId: req.clientId || null,
    });

    logger.info('[jobs/create] job created', { jobId: job.jobId, oracleSettings, decisionSettings, rubricTemplate });

    return res.json({
      success: true,
      job: {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        bountyAmount: job.bountyAmount,
        bountyAmountWei: job.bountyAmountWei,
        bountyAmountUSD: job.bountyAmountUSD,
        threshold: job.threshold,
        rubricCid: job.rubricCid,
        evaluationCid: job.evaluationCid,
        status: job.status,
        submissionOpenTime: job.submissionOpenTime,
        submissionCloseTime: job.submissionCloseTime,
        submissionCloseTimeIso: isoFromUnix(job.submissionCloseTime),
        createdAt: job.createdAt,
        oracleSettings: job.oracleSettings,
        decisionSettings: job.decisionSettings,
        // Which template the rubric matched (GET /api/templates), if any.
        rubricTemplate: { key: rubricTemplate.key, version: rubricTemplate.version, match: rubricTemplate.match, source: rubricTemplate.source }
      },
      // Exact createBounty(CreateParams) struct + calldata matching this record.
      onChain: buildCreateBountyTx(job),
      // Registry status, live arbiter coverage, and anything the creator should
      // know before funding (e.g. a class outside the registry).
      classPolicy,
      message: 'Job created successfully! Now call createBounty on-chain (see onChain.transaction) and PATCH /api/jobs/:jobId/bountyId to link.'
    });

  } catch (error) {
    logger.error('[jobs/create] fatal', { msg: error.message, stack: error.stack?.split('\n')[0] });
    return res.status(500).json({ error: 'Failed to create job', details: error.message });
  }
});

/* =======================
   SYNC STATUS - MUST BE BEFORE /:jobId routes!
   ======================= */

router.get('/sync/status', (req, res) => {
  if (process.env.USE_BLOCKCHAIN_SYNC !== 'true') {
    return res.json({ enabled: false, message: 'Blockchain sync is disabled. Set USE_BLOCKCHAIN_SYNC=true in .env to enable.' });
  }
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    return res.json({ enabled: true, status: syncService.getStatus() });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get sync status', details: error.message });
  }
});

router.post('/sync/now', async (req, res) => {
  if (process.env.USE_BLOCKCHAIN_SYNC !== 'true') {
    return res.status(400).json({ error: 'Blockchain sync not enabled', message: 'Set USE_BLOCKCHAIN_SYNC=true in .env to enable sync functionality.' });
  }
  try {
    const { getSyncService } = require('../utils/syncService');
    const syncService = getSyncService();
    const pending = syncService.requestSync();
    pending.catch(() => {});
    return res.json({ success: true, message: 'Blockchain sync requested (at most one manual sync per 30 s)', status: syncService.getStatus() });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to trigger sync', details: error.message });
  }
});

/* =======================
   ADMIN ROUTES - MUST BE BEFORE /:jobId routes!
   ======================= */

router.get('/admin/diagnostics', async (req, res) => {
  try {
    const diagnostics = await jobStorage.getDiagnostics();
    return res.json({ success: true, diagnostics });
  } catch (error) {
    logger.error('[admin/diagnostics] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to get diagnostics', details: error.message });
  }
});

/**
 * GET /api/jobs/admin/stuck
 * Find all stuck submissions and diagnose them.
 * A submission is listed as "stuck" if it has been pending for more than 10 minutes
 * (a listing heuristic only). `canCloseFailed` is decided by the AGGREGATOR's state,
 * exactly as BountyEscrow.closeFailedRound does: no result, and none can come (failed,
 * cancelled, past its deadline, or undrawn for a day). A pending submission WITH a result is
 * reported as needing finalizeSubmission; one still moving, with the step that moves it
 * (draw, close commits, promote). `canTimeout` is kept as an alias of canCloseFailed.
 */
router.get('/admin/stuck', async (req, res) => {
  const TIMEOUT_SECONDS = 10 * 60; // listing heuristic only — see canTimeout

  try {
    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const stuckSubmissions = [];
    const summary = {
      totalJobs: jobList.length,
      totalSubmissions: 0,
      stuckCount: 0,
      byStatus: {},
      byJob: {}
    };

    // Use singleton provider for on-chain checks (only for specific stuck submissions)
    let contract = null;
    let cs = null;
    try {
      cs = getContractService();
      contract = cs.contract;
    } catch (e) {
      logger.warn('[admin/stuck] Could not get contract service', { msg: e.message });
    }

    for (const job of jobList) {
      if (!job.submissions || job.submissions.length === 0) continue;

      const onChainBountyId = job.jobId;

      for (const sub of job.submissions) {
        summary.totalSubmissions++;
        const status = (sub.status || '').toLowerCase();
        summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;

        // Check if stuck (pending + timeout elapsed)
        const isPending = ['pending', 'pendingverdikta', 'pending_evaluation', 'no_result_pending_close',
          'soft_fail_pending_finalization', 'awaiting_rerun'].includes(status);
        const submittedAt = sub.submittedAt || 0;
        const elapsedSeconds = nowSeconds - submittedAt;
        const isStuck = isPending && elapsedSeconds >= TIMEOUT_SECONDS;

        if (isStuck) {
          summary.stuckCount++;
          summary.byJob[job.jobId] = (summary.byJob[job.jobId] || 0) + 1;

          const stuckInfo = {
            jobId: job.jobId,
            jobTitle: job.title,
            submissionId: sub.submissionId,
            hunter: sub.hunter,
            localStatus: sub.status,
            submittedAt,
            elapsedMinutes: Math.floor(elapsedSeconds / 60),
            hunterCid: sub.hunterCid,
            onChainBountyId,
            onChainStatus: null,
            canTimeout: false,
            issue: null
          };

          // Check on-chain status if possible
          if (contract && onChainBountyId != null) {
            try {
              const chainSub = await contract.getSubmission(onChainBountyId, sub.submissionId);
              stuckInfo.onChainStatus = SUBMISSION_STATUSES[Number(chainSub.status)] || `Unknown(${chainSub.status})`;
              stuckInfo.verdiktaAggId = chainSub.verdiktaAggId;

              if (stuckInfo.onChainStatus === 'Prepared') {
                stuckInfo.issue = 'Never started - startPreparedSubmission not called';
                stuckInfo.canTimeout = false;
              } else if (stuckInfo.onChainStatus === 'PendingVerdikta') {
                const gate = await cs.getCloseFailedEligibility(onChainBountyId, sub.submissionId);
                stuckInfo.closeFailed = gate;
                stuckInfo.nextAction = gate.nextAction || null;
                stuckInfo.canCloseFailed = gate.eligible === true;
                stuckInfo.canTimeout = stuckInfo.canCloseFailed;
                if (gate.hasResult) {
                  stuckInfo.canFinalize = true;
                  stuckInfo.issue = 'Oracle result available - needs finalizeSubmission';
                } else if (gate.eligible) {
                  stuckInfo.issue = 'Round has no result and can get none - eligible for closeFailedRound (then the submission may re-run)';
                } else {
                  stuckInfo.issue = `In evaluation - ${gate.hint || gate.reason}`;
                }
              } else if (stuckInfo.onChainStatus === 'AwaitingRerun') {
                const rerunDeadline = Number(chainSub.rerunDeadline);
                stuckInfo.rerunDeadline = rerunDeadline;
                stuckInfo.canExpireRerun = nowSeconds > rerunDeadline;
                stuckInfo.issue = stuckInfo.canExpireRerun
                  ? 'Re-run window closed - anyone may expireRerun (returns the bond, frees the place)'
                  : `Awaiting a re-run until unix ${rerunDeadline} (rerunSubmission by the hunter or funder)`;
              } else {
                stuckInfo.issue = `Already finalized on-chain as ${stuckInfo.onChainStatus}`;
                stuckInfo.canTimeout = false;
              }
            } catch (chainErr) {
              stuckInfo.onChainStatus = 'error';
              stuckInfo.issue = `Chain read failed: ${chainErr.message}`;
            }
          } else {
            stuckInfo.issue = 'Cannot verify on-chain - missing bountyId or RPC';
          }

          stuckSubmissions.push(stuckInfo);
        }
      }
    }

    // Group recommendations
    const recommendations = [];
    const canTimeoutCount = stuckSubmissions.filter(s => s.canCloseFailed).length;
    const canExpireCount = stuckSubmissions.filter(s => s.canExpireRerun).length;
    const canFinalizeCount = stuckSubmissions.filter(s => s.canFinalize).length;
    const neverStartedCount = stuckSubmissions.filter(s => s.onChainStatus === 'Prepared').length;
    const alreadyFinalizedCount = stuckSubmissions.filter(s =>
      ['Failed', 'PassedPaid', 'PassedUnpaid'].includes(s.onChainStatus)
    ).length;

    if (canTimeoutCount > 0) {
      recommendations.push(`${canTimeoutCount} submission(s) have a dead round: closeFailedRound (anyone; the submission may then re-run)`);
    }
    if (canExpireCount > 0) {
      recommendations.push(`${canExpireCount} submission(s) did not re-run in time: expireRerun (anyone; returns the bond)`);
    }
    if (canFinalizeCount > 0) {
      recommendations.push(`${canFinalizeCount} submission(s) have an oracle result and need finalizeSubmission`);
    }
    if (neverStartedCount > 0) {
      recommendations.push(`${neverStartedCount} submission(s) were never started - check ETH funding (msg.value on start) and startPreparedSubmission`);
    }
    if (alreadyFinalizedCount > 0) {
      recommendations.push(`${alreadyFinalizedCount} submission(s) are finalized on-chain but local status is stale - run sync`);
    }

    return res.json({
      success: true,
      summary,
      recommendations,
      stuckSubmissions
    });

  } catch (error) {
    logger.error('[admin/stuck] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to find stuck submissions', details: error.message });
  }
});

router.get('/admin/orphans', async (req, res) => {
  try {
    const orphans = await jobStorage.findOrphanedJobs();
    return res.json({ 
      success: true, 
      count: orphans.length,
      orphans: orphans.map(j => ({
        jobId: j.jobId,
        title: j.title,
        status: j.status,
        contractAddress: j.contractAddress,
        creator: j.creator,
        createdAt: j.createdAt,
        ...attemptSummary(j)
      }))
    });
  } catch (error) {
    logger.error('[admin/orphans] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to find orphaned jobs', details: error.message });
  }
});

/**
 * GET /api/jobs/admin/create-attempts?limit=50
 * Website creates that never reached the chain but reported what happened
 * (POST /:jobId/create-attempt), newest first. The reports are hints from the
 * browser, not evidence: see utils/createAttempts.js.
 */
router.get('/admin/create-attempts', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const storage = await jobStorage.readStorage();
    const jobs = storage.jobs
      .filter((j) => isUnlinked(j) && Array.isArray(j.createAttempts) && j.createAttempts.length)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit);
    return res.json({
      success: true,
      count: jobs.length,
      jobs: jobs.map((j) => ({
        jobId: j.jobId,
        title: j.title,
        status: j.status,
        creator: j.creator,
        createdAt: j.createdAt,
        orphanReason: j.orphanReason,
        createAttempts: j.createAttempts,
      })),
    });
  } catch (error) {
    logger.error('[admin/create-attempts] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to list create attempts', details: error.message });
  }
});

/**
 * GET /api/jobs/admin/template-usage?since=<unix seconds | ISO-8601>
 * How often each rubric template is used, by stage (created, on chain, awarded),
 * exact or modified, version and how the creator started the rubric. Jobs created
 * before tracking are classified from their stored rubric (inferred).
 */
router.get('/admin/template-usage', async (req, res) => {
  try {
    let since = null;
    if (req.query.since != null && req.query.since !== '') {
      const raw = String(req.query.since);
      since = /^\d+$/.test(raw) ? Number(raw) : Math.floor(Date.parse(raw) / 1000);
      if (!Number.isSafeInteger(since)) {
        return res.status(400).json({ error: 'Invalid since', details: 'Pass unix seconds or an ISO-8601 time, e.g. since=2026-10-01T00:00:00Z' });
      }
    }
    const storage = await jobStorage.readStorage();
    return res.json({ success: true, network: config.network, ...summarizeTemplateUsage(storage.jobs, { since }) });
  } catch (error) {
    logger.error('[admin/template-usage] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to summarize template usage', details: error.message });
  }
});

router.post('/admin/orphans/mark', requireAdmin, async (req, res) => {
  try {
    const result = await jobStorage.markOrphanedJobs();
    return res.json({ 
      success: true, 
      message: `Marked ${result.marked} jobs as orphaned`,
      ...result
    });
  } catch (error) {
    logger.error('[admin/orphans/mark] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to mark orphaned jobs', details: error.message });
  }
});

router.delete('/admin/orphans', requireAdmin, async (req, res) => {
  try {
    // Require confirmation query param to prevent accidental deletion
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({
        error: 'Confirmation required',
        details: 'Add ?confirm=yes to confirm deletion of orphaned jobs'
      });
    }

    const result = await jobStorage.deleteOrphanedJobs();
    return res.json({
      success: true,
      message: `Deleted ${result.deleted} orphaned jobs`,
      ...result
    });
  } catch (error) {
    logger.error('[admin/orphans] delete error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to delete orphaned jobs', details: error.message });
  }
});

/**
 * GET /api/jobs/admin/expired
 * List all expired bounties and their close eligibility.
 * An expired bounty can be closed if:
 * 1. On-chain status is Open
 * 2. Deadline has passed
 * 3. No submission is pending: in PendingVerdikta or AwaitingRerun (closeExpiredBounty requires
 *    the escrow's pending list, which holds both, to be empty)
 */
router.get('/admin/expired', async (req, res) => {
  try {
    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const expiredBounties = [];
    const summary = {
      totalExpired: 0,
      canCloseNow: 0,
      blockedByPendingEval: 0,
      alreadyClosed: 0,
      notOnChain: 0
    };

    // Use singleton contract service for on-chain checks
    let contract = null;
    try {
      const cs = getContractService();
      contract = cs.contract;
    } catch (e) {
      logger.warn('[admin/expired] Could not get contract service', { msg: e.message });
    }

    for (const job of jobList) {
      // Check if deadline has passed
      const deadline = job.submissionCloseTime || 0;
      if (deadline === 0 || nowSeconds < deadline) continue;

      summary.totalExpired++;
      const onChainBountyId = job.jobId;

      const bountyInfo = {
        jobId: job.jobId,
        title: job.title,
        creator: job.creator,
        bountyAmount: job.bountyAmount,
        bountyAmountWei: job.bountyAmountWei,
        deadline,
        expiredMinutesAgo: Math.floor((nowSeconds - deadline) / 60),
        localStatus: job.status,
        onChainStatus: null,
        canClose: false,
        blockedBy: null,
        pendingSubmissions: []
      };

      if (!job.onChain && !job.syncedFromBlockchain) {
        bountyInfo.blockedBy = 'Not linked to on-chain bounty';
        summary.notOnChain++;
        expiredBounties.push(bountyInfo);
        continue;
      }

      // Check on-chain status
      if (contract) {
        try {
          const chainBounty = await contract.getBounty(onChainBountyId);
          const statusNames = ['Open', 'Awarded', 'Closed'];
          bountyInfo.onChainStatus = statusNames[Number(chainBounty.status)] || `Unknown(${chainBounty.status})`;
          bountyInfo.payoutWei = chainBounty.payoutWei.toString();

          if (bountyInfo.onChainStatus === 'Closed') {
            bountyInfo.blockedBy = 'Already closed';
            summary.alreadyClosed++;
          } else if (bountyInfo.onChainStatus === 'Awarded') {
            bountyInfo.blockedBy = 'Already awarded to winner';
            summary.alreadyClosed++;
          } else if (bountyInfo.onChainStatus === 'Open') {
            // Check for pending submissions
            const subCount = Number(await contract.submissionCount(onChainBountyId));
            let hasPending = false;
            let subReadFailed = 0;

            for (let i = 0; i < subCount; i++) {
              try {
                const chainSub = await contract.getSubmission(onChainBountyId, i);
                // PendingVerdikta, or AwaitingRerun: both keep closeExpiredBounty reverting
                const st = Number(chainSub.status);
                if (st === 1 || st === 6) {
                  hasPending = true;
                  bountyInfo.pendingSubmissions.push({
                    submissionId: i,
                    hunter: chainSub.hunter,
                    submittedAt: Number(chainSub.submittedAt),
                    onChainStatus: st === 1 ? 'PendingVerdikta' : 'AwaitingRerun',
                    action: st === 1 ? 'finalize or close_failed' : 'expire_rerun'
                  });
                }
              } catch (subErr) {
                // An unread submission might be pending — never report canClose on partial data.
                subReadFailed++;
              }
            }

            if (subReadFailed > 0) {
              bountyInfo.canClose = false;
              bountyInfo.blockedBy = `Chain read failed for ${subReadFailed} submission(s) — retry`;
            } else if (hasPending) {
              bountyInfo.blockedBy = `${bountyInfo.pendingSubmissions.length} submission(s) still pending (in evaluation or awaiting a re-run)`;
              bountyInfo.canClose = false;
              summary.blockedByPendingEval++;
            } else {
              bountyInfo.canClose = true;
              summary.canCloseNow++;
            }
          }
        } catch (chainErr) {
          bountyInfo.onChainStatus = 'error';
          bountyInfo.blockedBy = `Chain read failed: ${chainErr.message}`;
        }
      }

      expiredBounties.push(bountyInfo);
    }

    return res.json({
      success: true,
      summary,
      expiredBounties
    });

  } catch (error) {
    logger.error('[admin/expired] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to list expired bounties', details: error.message });
  }
});

/**
 * GET /api/jobs/mine/action-required?creator=0x...
 * Creator-scoped list of bounties that need the creator's attention.
 *
 * Returns expired bounties owned by `creator` along with a per-bounty verdict:
 *   - canClose: true  → ready for `closeExpiredBounty` (no pending evaluations)
 *   - canClose: false → first resolve `pendingSubmissions` (each one needs
 *                       `finalizeSubmission` if the oracle responded (`hasResult`),
 *                       `closeFailedRound` if its round has no result and can get none
 *                       (`closeFailedEligible`), or `expireRerun` if it awaits a re-run
 *                       (`awaitingRerun`; anyone may expire it once the deadline has
 *                       passed); then the bounty can be closed)
 *
 * Bounties whose on-chain state could not be read (RPC failure) are NOT in
 * `bounties`/`count`; they are listed in `unverified` (`unverifiedCount`) so a
 * flaky RPC never raises a false "needs your attention" banner.
 *
 * Designed to be safe to poll (e.g., from a nav badge) — small response, no
 * mutations. Returns 200 with empty list when the creator has nothing to do.
 */
router.get('/mine/action-required', async (req, res) => {
  try {
    const creator = String(req.query.creator || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(creator)) {
      return res.status(400).json({
        error: 'Invalid or missing creator address',
        details: 'Pass ?creator=0x... (40 hex chars)'
      });
    }
    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;

    let contract = null;
    let cs = null;
    try {
      cs = getContractService();
      contract = cs.contract;
    } catch (e) {
      logger.warn('[mine/action-required] Could not get contract service', { msg: e.message });
    }

    const body = await buildActionRequired({
      jobs: jobList, creator, contract, cs, nowSeconds: Math.floor(Date.now() / 1000)
    });
    if (body.unverifiedCount > 0) {
      logger.warn('[mine/action-required] chain read failed for some bounties', {
        creator, unverified: body.unverified.map(b => b.jobId)
      });
    }
    return res.json(body);
  } catch (error) {
    logger.error('[mine/action-required] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to list action-required bounties', details: error.message });
  }
});

/**
 * GET /api/jobs/lookup
 * Discover which API job corresponds to an on-chain bounty.
 *
 * Accepts one of (in priority order):
 *   ?bountyId=<N>          → look up by on-chain bountyId (== local jobId for linked jobs)
 *   ?txHash=0x<hash>       → look up by stored createBounty txHash
 *   ?evaluationCid=<cid>   → look up by evaluation-archive CID
 *
 * This endpoint exists because in the "drift" case — where /jobs/create has
 * been called but PATCH /:jobId/bountyId has not, or counters got out of sync
 * during testing — agents can otherwise have no way to tell which API jobId
 * actually corresponds to the bounty they created on-chain. After the PATCH
 * is performed, jobId always equals on-chain bountyId, so a 200 response
 * here means "you can safely route subsequent API calls by `job.jobId`".
 *
 * Returns 200 with the matched job and a `linkage` field, or 404 with a hint
 * to call sync / PATCH if the on-chain bounty exists but no local job tracks
 * it yet.
 */
router.get('/lookup', async (req, res) => {
  try {
    const { bountyId, txHash, evaluationCid } = req.query || {};
    if (!bountyId && !txHash && !evaluationCid) {
      return res.status(400).json({
        success: false,
        error: 'Missing lookup key',
        details: 'Provide exactly one of ?bountyId=N, ?txHash=0x..., or ?evaluationCid=...'
      });
    }

    const storage = await jobStorage.readStorage();
    const jobs = storage.jobs || [];

    let match = null;
    let by = null;
    if (bountyId !== undefined && bountyId !== '') {
      const n = parseInt(bountyId, 10);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid bountyId',
          details: `"${bountyId}" is not a non-negative integer`
        });
      }
      // After PATCH /bountyId, jobId == on-chain bountyId — direct match.
      // Pre-PATCH (drifted), an API-only row may sit at this jobId without
      // being on-chain; we still surface it so the caller sees the conflict.
      match = jobs.find(j => Number(j.jobId) === n) || null;
      by = 'bountyId';
    } else if (txHash) {
      const lc = String(txHash).toLowerCase();
      match = jobs.find(j => (j.txHash || '').toLowerCase() === lc) || null;
      by = 'txHash';
    } else if (evaluationCid) {
      match = jobs.find(j => j.evaluationCid === evaluationCid) || null;
      by = 'evaluationCid';
    }

    if (!match) {
      // For bountyId lookups, check on-chain so we can distinguish
      // "doesn't exist" from "exists but not tracked locally yet".
      let onChainExists = null;
      let hint = 'No local job matches that key.';
      if (by === 'bountyId') {
        try {
          const cs = getContractService();
          const chainBounty = await cs.getBounty(parseInt(bountyId, 10));
          onChainExists = !!(chainBounty && chainBounty.creator && chainBounty.creator !== '0x0000000000000000000000000000000000000000');
        } catch (_) {
          onChainExists = false;
        }
        if (onChainExists) {
          hint = 'Bounty exists on-chain but the local sync service has not picked it up yet. Try POST /api/jobs/sync/now, or PATCH /api/jobs/<your-local-jobId>/bountyId with { bountyId, txHash } to link manually.';
        } else {
          hint = `No bounty with id ${bountyId} exists on the active BountyEscrow contract. Verify the id and the contract address (GET /api/docs).`;
        }
      } else if (by === 'txHash') {
        hint = 'No local job has that txHash. If the createBounty transaction has confirmed but no job is tracking it yet, call POST /api/jobs/sync/now, then PATCH /api/jobs/<your-local-jobId>/bountyId with { bountyId, txHash }.';
      } else if (by === 'evaluationCid') {
        hint = 'No local job has that evaluationCid. This means the job was never created via POST /api/jobs/create on this server; the rubric/archive may belong to a different deployment.';
      }
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        lookedUpBy: by,
        onChainExists,
        hint
      });
    }

    const linkage = buildLinkageReport(match);

    return res.json({
      success: true,
      lookedUpBy: by,
      job: {
        jobId: match.jobId,
        title: match.title,
        creator: match.creator,
        evaluationCid: match.evaluationCid,
        rubricCid: match.rubricCid,
        txHash: match.txHash || null,
        blockNumber: match.blockNumber || null,
        status: match.status,
        onChain: !!match.onChain,
        syncedFromBlockchain: !!match.syncedFromBlockchain,
        contractAddress: match.contractAddress || null,
        submissionOpenTime: match.submissionOpenTime,
        submissionCloseTime: match.submissionCloseTime,
        createdAt: match.createdAt
      },
      linkage,
      note: linkage.state === 'linked'
        ? 'jobId is safe to use as the on-chain bountyId for all subsequent API calls.'
        : 'jobId may NOT match the on-chain bountyId yet — see linkage.fix before routing transactions through it.'
    });
  } catch (error) {
    logger.error('[jobs/lookup] error', { msg: error.message });
    return res.status(500).json({ success: false, error: 'Lookup failed', details: error.message });
  }
});

/**
 * Build a structured linkage health report for a local job.
 * `state` is the single-string verdict; `mismatch` is set only when the local
 * jobId doesn't agree with what's on-chain (rare, but the failure mode the
 * lookup endpoint exists to surface).
 */
function buildLinkageReport(job, options = {}) {
  const { onChainBountyId = null } = options;
  if (job.syncedFromBlockchain) {
    return {
      state: 'linked',
      onChain: true,
      syncedFromBlockchain: true,
      detail: 'Sync service has confirmed this job matches an on-chain bounty with the same id.'
      // No `fix` key: the field is optional (`fix?`) and is OMITTED — never null —
      // when nothing needs doing, so strict clients can type it as `string | undefined`.
    };
  }
  if (job.onChain) {
    return {
      state: 'patched-not-synced',
      onChain: true,
      syncedFromBlockchain: false,
      detail: 'PATCH /bountyId set onChain=true, but the sync service has not yet observed the BountyCreated event. Calldata endpoints will work; sync will confirm shortly.',
      fix: 'Optional: call POST /api/jobs/sync/now to force a sync pass.'
    };
  }
  if (onChainBountyId !== null && Number(job.jobId) !== Number(onChainBountyId)) {
    return {
      state: 'mismatch',
      onChain: false,
      syncedFromBlockchain: false,
      detail: `Local jobId ${job.jobId} disagrees with the on-chain bountyId ${onChainBountyId}. Submissions routed through this job will reference the wrong on-chain bounty.`,
      mismatch: { localJobId: job.jobId, onChainBountyId: Number(onChainBountyId) },
      fix: `Call PATCH /api/jobs/${job.jobId}/bountyId with { bountyId: ${onChainBountyId}, txHash } to reconcile.`
    };
  }
  return {
    state: 'not-on-chain',
    onChain: false,
    syncedFromBlockchain: false,
    detail: 'This job was created via the API but is not linked to any on-chain bounty yet. createBounty() may not have been called, or the link step was skipped.',
    fix: `Call createBounty() on the BountyEscrow contract, then PATCH /api/jobs/${job.jobId}/bountyId with { bountyId, txHash } to link.`
  };
}

/**
 * POST /api/jobs/:jobId/close
 * Prepare transaction to close an expired bounty.
 * Returns encoded calldata for client to execute.
 *
 * On-chain requirements (from BountyEscrow.closeExpiredBounty):
 * - Bounty status must be Open
 * - Deadline must have passed
 * - No submissions in PendingVerdikta status
 * - Anyone can call (returns ETH to creator)
 */
router.post('/:jobId/close', async (req, res) => {
  const { jobId } = req.params;

  try {
    logger.info('[close] check', { jobId });

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId, { canClose: false })) return;
    const onChainBountyId = job.jobId;

    // Check deadline
    const nowSeconds = Math.floor(Date.now() / 1000);
    const deadline = job.submissionCloseTime || 0;

    if (nowSeconds < deadline) {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Deadline not passed',
        details: `Bounty expires in ${Math.ceil((deadline - nowSeconds) / 60)} minutes`,
        deadline
      });
    }

    // Check on-chain status and pending submissions
    let cs;
    try {
      cs = getContractService();
    } catch (e) {
      return res.status(500).json({
        success: false,
        canClose: false,
        error: 'Blockchain not configured'
      });
    }

    const contract = cs.contract;
    const chainBounty = await contract.getBounty(onChainBountyId);
    const statusNames = ['Open', 'Awarded', 'Closed'];
    const onChainStatus = statusNames[Number(chainBounty.status)] || `Unknown(${chainBounty.status})`;

    if (onChainStatus === 'Closed') {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Already closed',
        details: 'This bounty has already been closed'
      });
    }

    if (onChainStatus === 'Awarded') {
      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Already awarded',
        details: 'This bounty was awarded to a winner'
      });
    }

    // Check for pending submissions and classify them: every submission on the pending list (in
    // evaluation, or awaiting a re-run) blocks closeExpiredBounty.
    const pendingIds = (await contract.pendingSubmissionIds(onChainBountyId)).map(Number);
    const needsFinalize = [];
    const needsCloseFailed = [];
    const needsExpireRerun = [];
    const stillEvaluating = [];

    for (const i of pendingIds) {
      try {
        const chainSub = await contract.getSubmission(onChainBountyId, i);
        const entry = { submissionId: i, hunter: chainSub.hunter };
        if (Number(chainSub.status) === 6) { // AwaitingRerun: past the deadline anyone may expire it
          needsExpireRerun.push(entry);
          continue;
        }
        const state = await cs.getRoundState(onChainBountyId, i);
        entry.nextAction = state.nextAction || null;
        if (state.hasResult) needsFinalize.push(entry);
        else if (state.nextAction === 'CLOSE_FAILED') needsCloseFailed.push(entry);
        else stillEvaluating.push(entry);
      } catch (subErr) {
        // Ignore individual submission errors
      }
    }

    if (needsFinalize.length || needsCloseFailed.length || needsExpireRerun.length || stillEvaluating.length) {
      const hints = [];
      if (needsFinalize.length > 0) {
        hints.push(`${needsFinalize.length} submission(s) have completed evaluation - call POST /api/jobs/${jobId}/submissions/:subId/finalize for each first`);
      }
      if (needsCloseFailed.length > 0) {
        hints.push(`${needsCloseFailed.length} submission(s) have a dead round - call POST /api/jobs/${jobId}/submissions/:subId/close-failed for each`);
      }
      if (needsExpireRerun.length > 0) {
        hints.push(`${needsExpireRerun.length} submission(s) are awaiting a re-run that can no longer happen - call POST /api/jobs/${jobId}/submissions/:subId/expire-rerun for each`);
      }
      if (stillEvaluating.length > 0) {
        hints.push(`${stillEvaluating.length} submission(s) are still evaluating - wait for their rounds to finish or fail (see GET .../diagnose)`);
      }

      return res.status(400).json({
        success: false,
        canClose: false,
        error: 'Pending submissions',
        details: hints.join('. '),
        needsFinalize,
        needsCloseFailed,
        needsExpireRerun,
        stillEvaluating,
        // v1 name, kept: everything that isn't a finalize
        needsTimeout: [...needsCloseFailed, ...needsExpireRerun, ...stillEvaluating],
        hint: hints[0]
      });
    }

    // All conditions met - return transaction data
    const iface = new ethers.Interface([
      'function closeExpiredBounty(uint256 bountyId)'
    ]);
    const calldata = iface.encodeFunctionData('closeExpiredBounty', [onChainBountyId]);

    logger.info('[close] conditions met', { jobId, onChainBountyId });

    return res.json({
      success: true,
      canClose: true,
      message: 'Bounty can be closed. Execute the transaction to return funds to creator.',
      transaction: {
        to: config.bountyEscrowAddress,
        data: calldata,
        value: '0',
        chainId: config.chainId
      },
      contractCall: {
        method: 'closeExpiredBounty',
        args: [onChainBountyId],
        abi: 'function closeExpiredBounty(uint256 bountyId)'
      },
      bounty: {
        jobId: job.jobId,
        title: job.title,
        creator: job.creator,
        payoutWei: chainBounty.payoutWei.toString(),
        expiredMinutesAgo: Math.floor((nowSeconds - deadline) / 60)
      }
    });

  } catch (error) {
    logger.error('[close] error', { jobId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, canClose: false, error: 'Job not found' });
    }
    return res.status(500).json({
      success: false,
      canClose: false,
      error: 'Failed to check close conditions',
      details: error.message
    });
  }
});

/* ===============================
   SUBMISSION CALLDATA ENDPOINTS
   =============================== */

// POST /api/jobs/:jobId/submit/prepare
// Encodes prepareSubmission(bountyId, evaluationCid, hunterCid) calldata — deploys
// an EvaluationWallet.
//
// The oracle request parameters (maxOracleFee, alpha, estimatedBaseCost,
// maxFeeBasedScaling) are CREATOR-chosen at createBounty and stored on the bounty
// (`oracleSettings` on GET /api/jobs/:id); the contract uses them verbatim with an
// empty addendum, and ethMaxBudget = maxTotalFee(bounty.oracle..., the bounty's K and P) is the
// same for every submission. The legacy hunter-side fields (addendum, alpha,
// maxOracleFee, estimatedBaseCost, maxFeeBasedScaling) are accepted and IGNORED for
// one release; they are not forwarded anywhere.
// Time allowed for the hunterCid shape check on the calldata routes. An archive
// the server can't fetch doesn't block the caller, so there is no point waiting
// out every gateway: Pinata usually answers in ~6s.
const CALLDATA_SHAPE_CHECK_BUDGET_MS = 20000;

/**
 * Shape-check a caller-supplied hunterCid before handing out prepareSubmission
 * calldata (#34). A malformed archive is refused with a 400, since the evaluation
 * prepay would be wasted on it. An archive the server cannot FETCH is not refused:
 * public gateways throttle this host, so a fetch failure says nothing about the
 * archive. That caller gets the calldata plus an unverified warning.
 *
 * Returns null when it has already sent the 400; otherwise
 * { archiveShape: 'ok' | 'unknown', warnings: [] }.
 */
async function gateHunterArchive(res, hunterCid, logLabel) {
  const result = await archiveShapeValidator.fetchAndValidateArchiveShape(hunterCid, {
    totalTimeoutMs: CALLDATA_SHAPE_CHECK_BUDGET_MS,
  });
  if (result.ok) return { archiveShape: 'ok', warnings: [] };

  if (result.gatewayFailure) {
    logger.warn(`[${logLabel}] hunterCid could not be fetched for the shape check; returning calldata unverified`, {
      hunterCid, error: result.message
    });
    return {
      archiveShape: 'unknown',
      warnings: [{
        code: 'HUNTER_CID_UNVERIFIED',
        message: `The server could not fetch hunterCid to check its archive shape (${result.message}). The calldata is returned anyway, but the archive was NOT verified.`,
        fix: 'If you pinned this archive yourself, make sure it matches conformingShape before broadcasting: a malformed archive gets DONT_FUND from the arbiters after the prepay is spent. Archives built by POST /submit always conform.',
        conformingShape: archiveShapeValidator.CONFORMING_SHAPE_EXAMPLE
      }]
    };
  }

  if (result.check === 'cid-invalid') {
    res.status(400).json({
      success: false,
      code: 'INVALID_HUNTER_CID',
      error: 'hunterCid must be a bare IPFS CID: 46-100 alphanumeric characters, no path, comma, colon or whitespace (contract: "bad hunterCid")'
    });
    return null;
  }

  res.status(400).json({
    success: false,
    code: 'MALFORMED_HUNTER_CID',
    error: `Submission archive failed shape check: ${result.check}`,
    details: result.message,
    conformingShape: archiveShapeValidator.CONFORMING_SHAPE_EXAMPLE,
    fix: 'Use POST /:jobId/submit to build a conforming archive automatically, or match the shape shown in conformingShape.'
  });
  return null;
}

router.post('/:jobId/submit/prepare', async (req, res) => {
  const { jobId } = req.params;

  try {
    logger.info('[submit/prepare] request', { jobId });

    const { hunter, hunterCid } = req.body || {};
    const ignoredFields = ['addendum', 'alpha', 'maxOracleFee', 'estimatedBaseCost', 'maxFeeBasedScaling']
      .filter(k => req.body && req.body[k] != null);
    if (ignoredFields.length) {
      logger.info('[submit/prepare] ignoring legacy hunter-side oracle fields', { jobId, ignoredFields });
    }

    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing hunter address' });
    }
    if (!hunterCid) {
      return res.status(400).json({ success: false, error: 'Missing hunterCid (from /api/jobs/:jobId/submit response)' });
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    if (await rejectIfJuryUnrunnable(res, job, jobId)) return;
    const onChainBountyId = job.jobId;

    if (job.status !== 'OPEN') {
      return res.status(400).json({ success: false, error: `Job is not open (status: ${job.status})` });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const deadline = job.submissionCloseTime || 0;
    if (deadline > 0 && nowSeconds > deadline) {
      return res.status(400).json({ success: false, error: 'Submission window has closed' });
    }

    if (!job.evaluationCid) {
      return res.status(400).json({ success: false, error: 'Job missing evaluationCid' });
    }
    const evaluationCid = job.evaluationCid;

    if (await rejectIfUnevaluable(job, req, res, jobId)) return;

    const contractAddress = config.bountyEscrowAddress;
    if (!contractAddress) {
      return res.status(500).json({ success: false, error: 'Contract not configured' });
    }

    // hunterCid must be a bare CID (46–100 alphanumeric chars) or the contract
    // reverts "bad hunterCid" — catch it here with a clearer message.
    if (!/^[A-Za-z0-9]{46,100}$/.test(String(hunterCid))) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_HUNTER_CID',
        error: 'hunterCid must be a bare IPFS CID: 46-100 alphanumeric characters, no path, comma, colon or whitespace (contract: "bad hunterCid")'
      });
    }

    // Shape-check the archive BEFORE spending the evaluation prepay on a
    // doomed submission (see #34 — bounties 57/58/59 each pinned a
    // differently-malformed archive and every arbiter aborted).
    const archiveGate = await gateHunterArchive(res, hunterCid, 'submit/prepare');
    if (!archiveGate) return;

    const iface = new ethers.Interface([
      'function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid) returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget)'
    ]);

    const calldata = iface.encodeFunctionData('prepareSubmission', [
      onChainBountyId,
      evaluationCid,
      hunterCid
    ]);

    logger.info('[submit/prepare] encoded', { jobId, onChainBountyId, hunter });

    return res.json({
      success: true,
      transaction: {
        to: contractAddress,
        data: calldata,
        value: '0',
        chainId: config.chainId
      },
      info: {
        bountyId: onChainBountyId,
        evaluationCid,
        hunterCid,
        // Creator-chosen; the contract applies these — hunters cannot change them.
        oracleSettings: jobOracleSettings(job)
      },
      archiveShape: archiveGate.archiveShape,
      ...(archiveGate.warnings.length ? { warnings: archiveGate.warnings } : {}),
      ...(ignoredFields.length ? { ignoredFields, ignoredFieldsNote: 'These hunter-side oracle fields are no longer part of prepareSubmission; the bounty creator set the oracle settings at createBounty.' } : {}),
      // Canonical topic0 + ABI for the event this tx emits — filter the receipt logs
      // on `event.topic0` and decode with `event.abi` rather than deriving either.
      event: submissionPreparedEvent,
      nextStep: 'After tx confirms, parse SubmissionPrepared (full ABI) for submissionId, evalWallet, ethMaxBudget. Match the receipt log by `event.topic0` above and decode with `event.abi` — do not derive either yourself; ethMaxBudget is data word 1 (before the dynamic string evaluationCid). Simplest: call /submissions/:submissionId/start and use the `transaction.value` it returns as msg.value (the server reads the real budget from chain). No LINK approval is needed.'
    });

  } catch (error) {
    logger.error('[submit/prepare] error', { jobId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    return res.status(500).json({ success: false, error: 'Failed to encode prepareSubmission', details: error.message });
  }
});

// POST /api/jobs/:jobId/submit/approve  (DEPRECATED)
// The oracle is ETH-funded now: there is no LINK approval step. Fund the
// evaluation by attaching startValue (prepay + bond) as msg.value on /submissions/:submissionId/start.
router.post('/:jobId/submit/approve', async (req, res) => {
  const { jobId } = req.params;
  logger.info('[submit/approve] called (deprecated, ETH migration)', { jobId });
  return res.status(410).json({
    success: false,
    error: 'LINK approval is no longer required',
    code: 'APPROVE_DEPRECATED_ETH',
    details: 'The oracle is now ETH-funded. Skip this step. Call /submissions/:submissionId/start and attach the transaction.value it returns (startValue: the prepay plus the hunter bond) as msg.value.',
    nextStep: 'POST /submissions/:submissionId/start'
  });
});

// POST /api/jobs/:jobId/submissions/:submissionId/start
// Encodes startPreparedSubmission() calldata — triggers oracle evaluation
// ---- Chain-truth helpers for the submission routes ---------------------------------
// Load-balanced RPC nodes can lag a block or two behind the receipt a caller just got,
// so getSubmission may answer the escrow's "bad submissionId" revert for a submission
// that exists. Retry that one case briefly before believing it; any other error is real.
// Generic form: retry `fn` while it either throws a revert whose reason contains
// `revertSubstring`, or resolves to null/undefined when `retryOnEmpty` is set (a receipt the
// node has not indexed yet). Everything else is a real error and is thrown immediately.
async function readWithLagRetry(fn, { revertSubstring = null, retryOnEmpty = false, label = 'chain read',
  attempts = Number(process.env.CHAIN_READ_RETRIES || 6),
  delayMs = Number(process.env.CHAIN_READ_RETRY_MS || 1500),
} = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const v = await fn();
      if (!(retryOnEmpty && (v === null || v === undefined))) return v;
      last = null;
    } catch (e) {
      last = e;
      const reason = (e.reason || e.shortMessage || e.message || '').toLowerCase();
      if (!(revertSubstring && reason.includes(revertSubstring))) throw e;
    }
    if (i === attempts) break;
    logger.debug(`[chain] ${label}: not visible yet (RPC may lag the receipt); retrying`, { attempt: i });
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (last instanceof Error) throw last;
  return last; // null: retried out on an empty result
}

async function readChainSubmissionWithRetry(bountyId, submissionId, opts = {}) {
  const contract = getContractService().contract;
  return readWithLagRetry(() => contract.getSubmission(Number(bountyId), Number(submissionId)),
    { revertSubstring: 'bad submissionid', label: `getSubmission(${bountyId},${submissionId})`, ...opts });
}

const SUB_STATUS_MAP = { 0: 'Prepared', 1: 'PENDING_EVALUATION', 2: 'REJECTED', 3: 'APPROVED', 4: 'APPROVED', 5: 'PendingCreatorApproval' };
const SUB_ONCHAIN_STATUS_MAP = { 0: 'Prepared', 1: 'PendingVerdikta', 2: 'Failed', 3: 'PassedPaid', 4: 'PassedUnpaid', 5: 'PendingCreatorApproval' };
const ZERO_ADDR_RE = /^0x0{40}$/i;
const ZERO_HASH = '0x' + '0'.repeat(64);

// Build a local submission record from the on-chain struct (the same mapping /confirm
// applies), with optional caller-supplied extras (files, client attribution).
function submissionRecordFromChain(job, submissionId, chainSub, extras = {}) {
  const statusIndex = Number(chainSub.status);
  const rec = {
    submissionId: Number(submissionId),
    hunter: chainSub.hunter,
    hunterCid: chainSub.hunterCid || extras.hunterCid || null,
    evalWallet: (chainSub.evalWallet && !ZERO_ADDR_RE.test(chainSub.evalWallet)) ? chainSub.evalWallet : (extras.evalWallet || null),
    evaluationCid: job.evaluationCid || null,
    fileCount: extras.fileCount || 0,
    files: extras.files || [],
    submittedAt: Number(chainSub.submittedAt) || Math.floor(Date.now() / 1000),
    status: SUB_STATUS_MAP[statusIndex] || 'UNKNOWN',
    onChainStatus: SUB_ONCHAIN_STATUS_MAP[statusIndex] || null,
    creatorWindowEnd: Number(chainSub.creatorWindowEnd) || null,
    ethMaxBudget: chainSub.ethMaxBudget?.toString() || null,
    paidWinner: statusIndex === 3,
    passedUnpaid: statusIndex === 4,
    clientType: extras.clientType || 'unknown',
    clientId: extras.clientId || null,
  };
  if (chainSub.verdiktaAggId && chainSub.verdiktaAggId !== ZERO_HASH) rec.verdiktaAggId = chainSub.verdiktaAggId;
  if (chainSub.funder && !ZERO_ADDR_RE.test(chainSub.funder)) rec.funder = chainSub.funder;
  return rec;
}

// Make sure the local job has this submission. If the sync service has not observed the
// SubmissionPrepared event yet (it polls every ~20 s) and the caller skipped /confirm,
// read the submission from chain (lag-tolerant) and persist it, so the calldata routes
// never depend on the indexer. Returns the record, or null if the submission does not
// exist on-chain either. Mutates `job` (a getJob() copy) so the caller can continue.
async function ensureLocalSubmission(job, submissionId, extras = {}, opts = {}) {
  const existing = job.submissions?.find((s) => s.submissionId === Number(submissionId));
  if (existing) return existing;
  let chainSub;
  try {
    chainSub = await readChainSubmissionWithRetry(job.jobId, submissionId, opts);
  } catch (e) {
    const reason = (e.reason || e.shortMessage || e.message || '').toLowerCase();
    if (reason.includes('bad submissionid')) return null;
    throw e;
  }
  const rec = submissionRecordFromChain(job, submissionId, chainSub, extras);
  const stored = await jobStorage.withStorage((s, ctx) => {
    const fresh = s.jobs.find((j) => j.jobId === job.jobId);
    if (!fresh) { ctx.skipWrite = true; return null; }
    if (!fresh.submissions) fresh.submissions = [];
    const dup = fresh.submissions.find((x) => x.submissionId === Number(submissionId));
    if (dup) { ctx.skipWrite = true; return dup; }
    fresh.submissions.push(rec);
    fresh.submissionCount = fresh.submissions.length;
    return rec;
  });
  if (stored) {
    if (!job.submissions) job.submissions = [];
    job.submissions.push(stored);
    logger.info('[submissions] local record created from chain (indexer had not caught up)', { jobId: job.jobId, submissionId });
  }
  return stored;
}

router.post('/:jobId/submissions/:submissionId/start', async (req, res) => {
  const { jobId, submissionId } = req.params;

  try {
    logger.info('[submit/start] request', { jobId, submissionId });

    const { hunter } = req.body || {};

    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing hunter address' });
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    if (await rejectIfJuryUnrunnable(res, job, jobId)) return;
    const onChainBountyId = job.jobId;
    const subId = parseInt(submissionId, 10);
    // Local record, or — if the indexer has not caught up and /confirm was skipped — the
    // on-chain submission persisted on the spot. /confirm is optional bookkeeping now.
    const submission = await ensureLocalSubmission(job, subId, { clientType: req.clientType, clientId: req.clientId });

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: `Submission ${submissionId} not found for job ${jobId} — not on-chain either`,
        hint: 'Use the submissionId from the SubmissionPrepared event of your prepare tx receipt (0-indexed per bounty). If that tx was mined seconds ago, retry: the read is lag-tolerant but bounded.'
      });
    }

    const onChainSubmissionId = submission.onChainSubmissionId ?? submission.submissionId;

    // Authoritative gate: trust live on-chain status over the cached `submission.status`,
    // which lags prepareSubmission by a sync cycle. For windowed bounties a freshly
    // prepared submission is PendingCreatorApproval on-chain while the cache may still
    // read PENDING_EVALUATION/Prepared — handing out startPreparedSubmission calldata
    // then would revert. On RPC failure we fall back to the cached-status guard.
    let liveStatusIndex = null, liveWindowEnd = 0, liveEthMaxBudget = null;
    try {
      const chainSub = await getContractService().contract.getSubmission(onChainBountyId, onChainSubmissionId);
      liveStatusIndex = Number(chainSub.status);
      liveWindowEnd = Number(chainSub.creatorWindowEnd) || 0;
      liveEthMaxBudget = chainSub.ethMaxBudget?.toString() || null;
    } catch (e) {
      logger.warn('[submit/start] live status read failed; using cached status', { jobId, submissionId, msg: e.message });
    }

    const now = Math.floor(Date.now() / 1000);
    let effectiveIsPrepared;

    if (liveStatusIndex !== null) {
      // 0 Prepared · 1 PendingVerdikta · 2 Failed · 3 PassedPaid · 4 PassedUnpaid · 5 PendingCreatorApproval
      if (liveStatusIndex === 5 && liveWindowEnd > now) {
        return res.status(400).json({
          success: false,
          code: 'CREATOR_WINDOW_OPEN',
          error: `Submission is in the creator-approval window (expires ${new Date(liveWindowEnd * 1000).toISOString()}). startPreparedSubmission reverts until the window closes.`,
          creatorWindowEnd: liveWindowEnd,
          secondsRemaining: liveWindowEnd - now,
          nextStep: `Creator can approve now: POST /api/jobs/${jobId}/submissions/${submissionId}/approve-as-creator. Otherwise wait for the window to expire, then retry this endpoint.`
        });
      }
      if (liveStatusIndex !== 0 && liveStatusIndex !== 5) {
        return res.status(400).json({
          success: false,
          code: 'SUBMISSION_ALREADY_STARTED',
          error: `Submission is past the start step (on-chain status: ${SUBMISSION_STATUSES[liveStatusIndex] || liveStatusIndex}). startPreparedSubmission would revert.`,
          nextStep: liveStatusIndex === 1
            ? `Oracle evaluation is in progress — GET /api/jobs/${jobId}/submissions/${submissionId}/diagnose for the round's state and next step, then POST /api/jobs/${jobId}/submissions/${submissionId}/finalize`
            : liveStatusIndex === 6
              ? `The submission awaits a re-run — POST /api/jobs/${jobId}/submissions/${submissionId}/rerun`
              : `This submission is finalized — GET /api/jobs/${jobId}/submissions for its result.`
        });
      }
      // Prepared (0), or PendingCreatorApproval (5) with an expired window → startable.
      effectiveIsPrepared = liveStatusIndex === 0;
    } else {
      // Fallback: chain unreachable — gate on the cached status as before.
      const status = (submission.status || '').toLowerCase();
      const isPrepared = status === 'prepared';
      const isPendingCreatorApproval = status === 'pendingcreatorapproval';
      if (!isPrepared && !isPendingCreatorApproval) {
        return res.status(400).json({
          success: false,
          error: `Submission not in a startable state (current: ${submission.status}). Must be Prepared or PendingCreatorApproval (with expired window).`
        });
      }
      if (isPendingCreatorApproval) {
        const windowEnd = submission.creatorWindowEnd || 0;
        if (windowEnd > now) {
          return res.status(400).json({
            success: false,
            error: `Creator approval window is still open (expires ${new Date(windowEnd * 1000).toISOString()}). Cannot start evaluation until window closes.`,
            creatorWindowEnd: windowEnd,
            secondsRemaining: windowEnd - now
          });
        }
      }
      effectiveIsPrepared = isPrepared;
    }

    // For Prepared submissions, only the original hunter can start.
    // For PendingCreatorApproval (expired window), anyone can fund (ETH) and start.
    if (effectiveIsPrepared && submission.hunter && submission.hunter.toLowerCase() !== hunter.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Hunter address does not match submission hunter' });
    }

    const contractAddress = config.bountyEscrowAddress;
    if (!contractAddress) {
      return res.status(500).json({ success: false, error: 'Contract not configured' });
    }

    // The evaluation is funded by attaching ETH as msg.value (no LINK approval): the round's
    // prepay plus the bounty's hunter bond (v2, item 12) — startValue(bountyId). The contract
    // checks it against the LIVE requirement (the aggregator's maxTotalFee for the bounty's
    // settings can change with aggregator parameters), so read it live. There is no fallback to
    // the prepare-time estimate: it would miss the bond and revert "wrong eth amount".
    let valueWei = null;
    let prepayWei = null;
    try {
      const c = getContractService().contract;
      [valueWei, prepayWei] = (await Promise.all([c.startValue(onChainBountyId), c.requiredPrepay(onChainBountyId)])).map(String);
    } catch (e) {
      logger.warn('[submit/start] startValue read failed', { jobId, msg: e.message });
      return res.status(503).json({
        success: false,
        error: 'Could not read startValue(bountyId) from the escrow (the prepay plus the hunter bond); retry shortly',
        code: 'START_VALUE_UNREADABLE'
      });
    }
    const bondWei = (BigInt(valueWei) - BigInt(prepayWei)).toString();

    const iface = new ethers.Interface([
      'function startPreparedSubmission(uint256 bountyId, uint256 submissionId) payable'
    ]);
    const calldata = iface.encodeFunctionData('startPreparedSubmission', [
      onChainBountyId,
      onChainSubmissionId
    ]);

    logger.info('[submit/start] encoded', { jobId, submissionId, onChainBountyId, onChainSubmissionId, valueWei });

    return res.json({
      success: true,
      transaction: {
        to: contractAddress,
        data: calldata,
        value: valueWei,   // startValue(bountyId) read live: the round's prepay + the hunter bond
        chainId: config.chainId,
        gasLimit: START_GAS_LIMIT.toString()   // the request may settle up to 2 due rounds first
      },
      prepayWei,          // escrowed with the aggregator; the unspent part is refunded to the funder
      bondWei,            // held by the escrow; returned unless a hard fail forfeits it to the creator
      nextStep: 'After tx confirms, the round must be drawn: POST /submissions/:id/draw (anyone may send it; the server\'s keeper usually does) from two blocks on. Then poll /diagnose for the round and its result.'
    });

  } catch (error) {
    logger.error('[submit/start] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to encode startPreparedSubmission', details: error.message });
  }
});

// POST /api/jobs/:jobId/submissions/:submissionId/finalize
// Encodes finalizeSubmission() calldata — pulls oracle results and claims payout
router.post('/:jobId/submissions/:submissionId/finalize', async (req, res) => {
  const { jobId, submissionId } = req.params;

  try {
    logger.info('[submit/finalize] request', { jobId, submissionId });

    const { hunter } = req.body || {};

    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing hunter address' });
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    const onChainBountyId = job.jobId;
    const subId = parseInt(submissionId, 10);
    // Local record, or — if the indexer has not caught up and /confirm was skipped — the
    // on-chain submission persisted on the spot. /confirm is optional bookkeeping now.
    const submission = await ensureLocalSubmission(job, subId, { clientType: req.clientType, clientId: req.clientId });

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: `Submission ${submissionId} not found for job ${jobId} — not on-chain either`,
        hint: 'Use the submissionId from the SubmissionPrepared event of your prepare tx receipt (0-indexed per bounty). If that tx was mined seconds ago, retry: the read is lag-tolerant but bounded.'
      });
    }

    if (submission.hunter && submission.hunter.toLowerCase() !== hunter.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Hunter address does not match submission hunter' });
    }

    const onChainSubmissionId = submission.onChainSubmissionId ?? submission.submissionId;

    // Check oracle readiness
    let oracleResult = null;
    try {
      const contractService = getContractService();
      const evalResult = await contractService.checkEvaluationReady(onChainBountyId, onChainSubmissionId);

      if (!evalResult.ready) {
        const noResult = evalResult.reason === 'no_result';
        return res.status(400).json({
          success: false,
          error: noResult ? 'The round has no result and can get none' : 'Evaluation not ready',
          reason: evalResult.reason || 'unknown',
          phase: evalResult.phaseName || null,
          nextAction: evalResult.nextAction || null,
          hint: noResult
            ? `Close the round first: POST /api/jobs/${jobId}/submissions/${submissionId}/close-failed (anyone). The submission then awaits a re-run, keeping its place and bond.`
            : 'Wait for the round to finish (the server\'s keeper draws and promotes it; anyone may), or check its state via GET /api/jobs/:jobId/submissions/:subId/diagnose'
        });
      }

      // item 12: the contract judges the round by Q-of-N, not by the mean score
      const d = jobDecisionSettings(job);
      oracleResult = {
        acceptance: evalResult.scores.acceptance,
        rejection: evalResult.scores.rejection,
        outcome: evalResult.outcome,
        passCount: evalResult.passCount,
        quota: d.quota,
        forfeitLine: d.forfeitLine,
        passed: evalResult.outcome === 'pass',
        threshold: job.threshold || 0,
        effect: {
          pass: 'paid (subject to payout priority); the bond is returned',
          soft_fail: 'the submission awaits a re-run (2-hour window), keeping its place and bond',
          no_result: 'the result is unusable: the submission awaits a re-run, keeping its place and bond',
          hard_fail: 'the submission fails and the bond goes to the bounty creator'
        }[evalResult.outcome] || null
      };
    } catch (csError) {
      // contractService may not be initialized (blockchain sync disabled) — skip check
      logger.warn('[submit/finalize] contractService unavailable, skipping readiness check', { msg: csError.message });
    }

    const contractAddress = config.bountyEscrowAddress;
    if (!contractAddress) {
      return res.status(500).json({ success: false, error: 'Contract not configured' });
    }

    const iface = new ethers.Interface([
      'function finalizeSubmission(uint256 bountyId, uint256 submissionId)'
    ]);
    const calldata = iface.encodeFunctionData('finalizeSubmission', [
      onChainBountyId,
      onChainSubmissionId
    ]);

    logger.info('[submit/finalize] encoded', { jobId, submissionId, onChainBountyId, onChainSubmissionId });

    // Best-effort: surface oracle warnings (esp. attachment_skipped — a file the models
    // never saw) at finalize time, so the agent sees WHY a score may be low rather than
    // just recording it. Non-blocking — never fails the finalize on an IPFS hiccup.
    let oracleWarnings = [];
    try {
      const ipfsClient = req.app.locals.ipfsClient;
      if (ipfsClient && submission.justificationCids) {
        const cids = submission.justificationCids.split(',').map(c => c.trim()).filter(Boolean);
        // Bounded best-effort: warnings are a bonus, so a slow IPFS gateway must never
        // delay the finalize calldata. Short per-fetch timeout + overall deadline.
        const deadline = Date.now() + 6000;
        for (const cid of cids) {
          if (Date.now() >= deadline) break;
          try {
            const raw = await withTimeout(ipfsClient.fetchFromIPFS(cid), 4000, 'IPFS warnings fetch');
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
            if (parsed) oracleWarnings.push(...extractEvaluationWarnings(parsed));
          } catch { /* ignore per-CID fetch errors (timeout/unavailable) */ }
        }
        oracleWarnings = [...new Set(oracleWarnings)];
      }
    } catch (warnErr) {
      logger.debug('[submit/finalize] warnings fetch skipped', { msg: warnErr.message });
    }

    const gas = await resolveGasGuidance(calldata, hunter);

    const response = {
      success: true,
      transaction: {
        to: contractAddress,
        data: calldata,
        value: '0',
        chainId: config.chainId,
        gasLimit: gas.gasLimit
      },
      gas: { ...gas, note: RESOLVE_GAS_NOTE }
    };

    if (oracleResult) {
      response.oracleResult = oracleResult;
      if (oracleResult.passed && Number(job.bountyAmount) > 0) {
        response.expectedPayout = job.bountyAmount;
      }
    }

    // Payout priority: a passing finalize reverts while an earlier submission by another
    // hunter is still PendingVerdikta, often one whose (failing) result is in and was
    // never finalized. Say which, and hand over the calls that clear them.
    try {
      const action = String(await getContractService().contract.nextAction(onChainBountyId, onChainSubmissionId));
      response.nextAction = action;
      if (action === 'AWAIT_EARLIER') {
        const blockers = await finalizeBlockersFor(onChainBountyId, onChainSubmissionId, hunter);
        if (blockers) {
          response.blockedBy = blockers.blockedBy;
          response.hint = blockers.hint;
        }
      }
    } catch (naErr) {
      logger.debug('[submit/finalize] nextAction unavailable', { msg: naErr.message });
    }

    if (oracleWarnings.length > 0) {
      response.warnings = oracleWarnings;
      response.warningsNote = 'The oracle reported warnings for this submission (e.g. attachment_skipped = a file the models never saw). These often explain a low/zero score — log them, do not just record the score. Full report: GET /api/jobs/' + jobId + '/submissions/' + submissionId + '/evaluation';
    }

    return res.json(response);

  } catch (error) {
    logger.error('[submit/finalize] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to encode finalizeSubmission', details: error.message });
  }
});

/**
 * POST /api/jobs/:jobId/submissions/:submissionId/approve-as-creator
 * Encode creatorApproveSubmission calldata for the bounty creator to sign.
 * Only works for PendingCreatorApproval submissions within the approval window.
 */
router.post('/:jobId/submissions/:submissionId/approve-as-creator', async (req, res) => {
  const { jobId, submissionId } = req.params;

  try {
    logger.info('[approve-as-creator] request', { jobId, submissionId });

    const { creator } = req.body || {};

    if (!creator || !/^0x[a-fA-F0-9]{40}$/.test(creator)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing creator address' });
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    const onChainBountyId = job.jobId;
    const subId = parseInt(submissionId, 10);
    // Local record, or — if the indexer has not caught up and /confirm was skipped — the
    // on-chain submission persisted on the spot. /confirm is optional bookkeeping now.
    const submission = await ensureLocalSubmission(job, subId, { clientType: req.clientType, clientId: req.clientId });

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: `Submission ${submissionId} not found for job ${jobId} — not on-chain either`,
        hint: 'Use the submissionId from the SubmissionPrepared event of your prepare tx receipt (0-indexed per bounty). If that tx was mined seconds ago, retry: the read is lag-tolerant but bounded.'
      });
    }

    // Verify caller is the bounty creator
    if (!job.creator || job.creator.toLowerCase() !== creator.toLowerCase()) {
      return res.status(403).json({ success: false, error: 'Only the bounty creator can approve submissions' });
    }

    // Verify submission is in the right state
    const status = (submission.status || '').toLowerCase();
    if (status !== 'pendingcreatorapproval') {
      return res.status(400).json({
        success: false,
        error: `Submission not in PendingCreatorApproval state (current: ${submission.status}). Cannot approve.`
      });
    }

    // Check window hasn't expired (optional — contract enforces this too, but better UX to catch early)
    const now = Math.floor(Date.now() / 1000);
    const windowEnd = submission.creatorWindowEnd || 0;
    if (windowEnd > 0 && windowEnd <= now) {
      return res.status(400).json({
        success: false,
        error: 'Creator approval window has expired. The submission can now be started for oracle evaluation instead.',
        hint: `POST /api/jobs/${jobId}/submissions/${submissionId}/start`
      });
    }

    const contractAddress = config.bountyEscrowAddress;
    if (!contractAddress) {
      return res.status(500).json({ success: false, error: 'Contract not configured' });
    }

    const onChainSubmissionId = submission.onChainSubmissionId ?? submission.submissionId;

    const iface = new ethers.Interface([
      'function creatorApproveSubmission(uint256 bountyId, uint256 submissionId)'
    ]);
    const calldata = iface.encodeFunctionData('creatorApproveSubmission', [
      onChainBountyId,
      onChainSubmissionId
    ]);

    logger.info('[approve-as-creator] encoded', { jobId, submissionId, onChainBountyId, onChainSubmissionId });

    return res.json({
      success: true,
      transaction: {
        to: contractAddress,
        data: calldata,
        value: '0',
        chainId: config.chainId
      },
      approvalDetails: {
        creatorPayment: job.creatorDeterminationPayment || null,
        arbiterPayment: job.arbiterDeterminationPayment || null,
        windowEnd,
        windowEndISO: windowEnd ? new Date(windowEnd * 1000).toISOString() : null,
        secondsRemaining: windowEnd > now ? windowEnd - now : 0
      },
      note: 'Sign and broadcast this transaction with the creator wallet to approve the submission and pay the hunter.'
    });

  } catch (error) {
    logger.error('[approve-as-creator] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to encode creatorApproveSubmission', details: error.message });
  }
});

router.patch('/admin/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    const validStatuses = ['OPEN', 'EXPIRED', 'AWARDED', 'CLOSED', 'ORPHANED', 'CANCELLED'];
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ 
        error: 'Invalid status', 
        details: `Valid statuses: ${validStatuses.join(', ')}`
      });
    }
    
    // Security: any client can call this (the website key is public, bot keys are free),
    // so the body is a hint, never the truth. A linked bounty takes the CHAIN's status
    // (that is what the website pushes); an unlinked one may only be closed or cancelled,
    // after the same 5-minute grace as DELETE. It used to set any status on any job:
    // AWARDED/CLOSED/CANCELLED hid live, funded bounties from the listing.
    const requested = String(status).toUpperCase();
    let job;
    try { job = await jobStorage.getJob(jobId); } catch { return res.status(404).json({ error: `Job ${jobId} not found` }); }
    if (job.onChain || job.syncedFromBlockchain) {
      let chainStatus;
      try {
        chainStatus = String((await getContractService().getBounty(Number(job.jobId))).status || '').toUpperCase();
      } catch (e) {
        return res.status(503).json({ error: 'Could not read the bounty status on chain', details: e.message, retryAfterSeconds: 10 });
      }
      if (!validStatuses.includes(chainStatus)) {
        return res.status(503).json({ error: 'Unexpected on-chain status', details: chainStatus });
      }
      const updated = job.status === chainStatus ? job : await jobStorage.updateJobStatus(job.jobId, chainStatus);
      if (requested !== chainStatus) {
        return res.status(409).json({ error: 'Status differs from the chain', details: `On-chain status is ${chainStatus}; the stored status follows the chain.`, job: updated });
      }
      return res.json({ success: true, job: updated });
    }
    if (!['CLOSED', 'CANCELLED'].includes(requested)) {
      return res.status(400).json({ error: 'Invalid status for an unlinked job', details: 'A job that never went on chain can only be set to CLOSED or CANCELLED.' });
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - (job.createdAt || 0);
    if (ageSeconds < 300) {
      return res.status(400).json({ error: `Job ${jobId} was created ${ageSeconds}s ago. Wait 5 minutes (on-chain creation may still be in progress).` });
    }
    const updated = await jobStorage.updateJobStatus(job.jobId, requested);
    return res.json({ success: true, job: updated });
  } catch (error) {
    logger.error('[admin/status] error', { msg: error.message });
    return res.status(500).json({ error: 'Failed to update job status', details: error.message });
  }
});

router.delete('/admin/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await jobStorage.deleteJob(jobId);
    return res.json({ success: true, message: `Deleted job ${jobId}`, job: result.job });
  } catch (error) {
    logger.error('[admin/delete] error', { jobId: req.params.jobId, msg: error.message });
    const status = error.message.includes('not found') ? 404
      : error.message.includes('on-chain') ? 400
      : 500;
    return res.status(status).json({ error: error.message });
  }
});

/* ==============
   VALIDATE RUBRIC (side-effect free)
   ============== */

/**
 * POST /api/jobs/rubric/validate
 * Validate a rubric JSON object's shape without pinning, creating a job, or
 * incrementing the jobId counter. Use this to debug rubric shapes before
 * calling /jobs/create — never use /jobs/create as a debugging tool.
 *
 * Body: { rubricJson: object }
 * Response: { valid: boolean, errors: string[] }
 */
router.post('/rubric/validate', async (req, res) => {
  const { rubricJson } = req.body || {};

  if (rubricJson === undefined || rubricJson === null) {
    return res.status(400).json({
      valid: false,
      errors: ['rubricJson is required']
    });
  }

  if (typeof rubricJson === 'string') {
    return res.status(400).json({
      valid: false,
      errors: [
        'rubricJson must be a JSON object, received a string. The request body is already JSON — do not pre-stringify the rubric. Pass it as a native object, e.g. { "rubricJson": { "criteria": [...] } }, not { "rubricJson": "{\\"criteria\\":[...]}" }.'
      ]
    });
  }

  if (typeof rubricJson !== 'object' || Array.isArray(rubricJson)) {
    return res.status(400).json({
      valid: false,
      errors: [`rubricJson must be a JSON object, received ${Array.isArray(rubricJson) ? 'array' : typeof rubricJson}.`]
    });
  }

  const rubricResult = validateRubric(rubricJson);

  // Optional jury-node check for callers following the recommended
  // "validate before create" flow. /rubric/validate used to ignore
  // juryNodes entirely, which made the validator strictly less strict
  // than /jobs/create and missed the dotted/underscore model-id failure
  // mode (issue #16). When juryNodes is provided we run the same
  // validator /jobs/create uses and merge errors so callers can fix
  // everything before paying gas. Backward-compatible: a body without
  // juryNodes still gets the rubric-only check.
  const errors = [...rubricResult.errors];
  const { juryNodes, classId } = req.body || {};
  const tips = [];
  const warnings = [];
  let allowedModels = null;
  let juryWasChecked = false;
  let classListed;
  let coverage;

  if (juryNodes !== undefined && juryNodes !== null) {
    juryWasChecked = true;
    const classIdProvided = classId !== undefined && classId !== null;
    const classIdValid = typeof classId === 'number' && Number.isInteger(classId) && classId >= 0;
    if (classIdProvided && !classIdValid) {
      errors.push(`classId must be a non-negative integer (received ${typeof classId})`);
    }
    // Same rule as /jobs/create: ids the registry lists exactly skip the model-id
    // format heuristic, and for a class outside the registry it only warns.
    if (classIdValid) classListed = lookupClass(classId).listed;
    const juryResult = validateJuryNodes(juryNodes, {
      modelFormat: classListed === false ? 'warn' : 'error',
      isRegistryModel: (classIdValid && registryModelMatcher(classId)) || undefined
    });
    errors.push(...juryResult.errors);
    warnings.push(...juryResult.warnings);

    // Availability check (issue #16 follow-up), the same class policy /jobs/create
    // applies (utils/classPolicy.js), so a clean bill here means the jury and class
    // are create-safe, not merely well-formed: registry classes get their jury
    // checked against the registry; a class outside it passes with a warning; and
    // any class with no arbiter able to serve it is an error.
    if (classIdValid) {
      const juryCheck = checkJuryAgainstClass(juryNodes, classId);
      errors.push(...juryCheck.errors);
      warnings.push(...juryCheck.warnings);
      if (juryCheck.invalidNodes.length > 0) allowedModels = juryCheck.allowedModels;
      if (juryCheck.listed === null) {
        tips.push(`Could not load the class map to verify jury models against class ${classId}; /jobs/create performs this check at creation time.`);
      }

      // Coverage depends on the fee limit: only the caller's own oracle* fields can
      // be their error; failing server defaults just skip the coverage check.
      let oracleSettings = null;
      try {
        oracleSettings = resolveOracleSettings(req.body || {});
      } catch (oracleErr) {
        const body = req.body || {};
        const callerSent = ['oracleMaxOracleFee', 'oracleAlpha', 'oracleEstimatedBaseCost', 'oracleMaxFeeBasedScaling']
          .some(k => body[k] != null && body[k] !== '');
        if (callerSent) errors.push(`Invalid oracle settings: ${oracleErr.message}`);
        else logger.warn('[rubric/validate] default oracle settings unavailable — skipping coverage', { msg: oracleErr.message });
      }
      if (oracleSettings) {
        // the jury the create would use (bountyClass / jury override; the Small preset's otherwise)
        let jury = null;
        try {
          const b = req.body || {};
          const preset = presetByKey(b.bountyClass) || presetForBounty(Number(b.bountyAmountUSD) || null) || presetByKey('small');
          jury = { ...preset.jury, ...(parseJuryOverride(b.jury) || {}) };
        } catch (juryErr) {
          errors.push(`Invalid jury: ${juryErr.message}`);
        }
        const coverageCheck = await checkClassCoverage(classId, oracleSettings, { creator: req.body?.creator, jury });
        coverage = coverageCheck.coverage;
        if (coverageCheck.refusal) errors.push(coverageCheck.refusal);
        warnings.push(...coverageCheck.warnings);
      }
    } else if (!classIdProvided) {
      tips.push('Pass classId alongside juryNodes to also verify each jury model is supported by the class — without it, /rubric/validate only checks jury structure and /jobs/create may still reject unsupported models (issue #16).');
    }
  }

  if (!juryWasChecked) {
    tips.push('Pass juryNodes (and optionally classId) to also validate the jury configuration — /rubric/validate previously ignored jury, so a clean bill here did not mean the bounty was create-safe (issue #16).');
  }

  // Which template the draft matches (GET /api/templates). A one-criterion rubric
  // gives the jury little to judge by; a template is usually a better start.
  const match = classifyRubric(rubricJson);
  const templateMatch = match ? { key: match.key, version: match.version, match: match.match } : null;
  if (Array.isArray(rubricJson.criteria) && rubricJson.criteria.length === 1 && !match?.key) {
    tips.push('This rubric has one criterion. GET /api/templates lists ready rubrics with must-pass gates and weighted criteria; pass "rubricTemplate": "<key>" to /jobs/create to use one as is.');
  }

  const body = {
    valid: errors.length === 0,
    errors,
    templateMatch,
    checkedAt: new Date().toISOString()
  };
  if (warnings.length) body.warnings = warnings;
  if (classListed !== undefined) body.classListed = classListed;
  if (coverage) body.coverage = coverage;
  if (allowedModels) body.allowedModels = allowedModels;
  if (tips.length) body.tips = tips;
  return res.json(body);
});

/* ==============
   VALIDATE BOUNTY
   ============== */

/**
 * POST /api/jobs/validate
 * Validate an evaluation package CID before creating a bounty.
 * Use this to check format before committing ETH to a bounty.
 *
 * Body: { evaluationCid: "Qm...", classId?: number }
 * Response: { valid: boolean, errors: string[], warnings: string[] }
 */
router.post('/validate', async (req, res) => {
  const { evaluationCid, classId } = req.body;

  if (!evaluationCid) {
    return res.status(400).json({
      valid: false,
      errors: ['evaluationCid is required']
    });
  }

  try {
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        valid: false,
        errors: ['IPFS client not available']
      });
    }

    let classMap;
    try {
      const common = require('@verdikta/common');
      classMap = common.classMap;
    } catch (e) {
      logger.warn('Could not load classMap for validation:', e.message);
    }

    const result = await validateBounty({
      evaluationCid,
      classId: classId || 128, // Default to class 128 if not specified
      ipfsClient,
      classMap
    });

    // Format response as simple errors/warnings arrays
    const errors = result.issues
      .filter(i => i.severity === 'error')
      .map(i => i.message);
    const warnings = result.issues
      .filter(i => i.severity === 'warning')
      .map(i => i.message);

    return res.json({
      valid: result.valid,
      errors,
      warnings,
      evaluationCid,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    logger.error('[validate-cid] error', { evaluationCid, msg: error.message });
    return res.status(500).json({
      valid: false,
      errors: [`Validation failed: ${error.message}`]
    });
  }
});

// For a bounty that is not on-chain, the website's last report of how its
// create failed (POST /:jobId/create-attempt). Response-only: never persisted
// into validationStatus, which public reads can return.
function notOnChainAttempt(job, issues) {
  if (!issues.some((i) => i.type === IssueType.NOT_ON_CHAIN)) return {};
  const { lastCreateAttempt } = attemptSummary(job);
  return lastCreateAttempt ? { lastCreateAttempt } : {};
}

/**
 * GET /api/jobs/admin/validate-all
 * Batch validate all open bounties for format issues.
 * Stores validation results in job storage.
 */
router.get('/admin/validate-all', async (req, res) => {
  try {
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({ error: 'IPFS client not available' });
    }

    let classMap;
    try {
      const common = require('@verdikta/common');
      classMap = common.classMap;
    } catch (e) {
      logger.warn('Could not load classMap for validation:', e.message);
    }

    const jobs = await jobStorage.listJobs({ includeOrphans: false });
    const jobList = jobs.jobs || jobs;

    // Only validate OPEN and EXPIRED bounties (ones people might submit to)
    const toValidate = jobList.filter(j =>
      j.status === 'OPEN' || j.status === 'EXPIRED'
    );

    const results = [];
    let validCount = 0;
    let invalidCount = 0;

    // Get contract service once for all on-chain checks
    let contractService = null;
    try {
      contractService = getContractService();
    } catch (e) {
      logger.warn('[admin/validate-all] Contract service unavailable:', e.message);
    }

    for (const job of toValidate) {
      try {
        const evaluationCid = job.evaluationCid;

        const result = await validateBounty({
          evaluationCid,
          classId: job.classId,
          ipfsClient,
          classMap
        });

        // Check if bounty exists on-chain
        if (contractService) {
          try {
            const onChain = await contractService.getBounty(job.jobId);
            if (onChain.status !== 'OPEN') {
              result.issues.push({
                type: IssueType.CHAIN_STATUS,
                severity: IssueSeverity.ERROR,
                message: `Bounty is "${onChain.status}" on-chain and cannot accept submissions or pay out.`
              });
              result.valid = false;
            }
          } catch (chainErr) {
            const msg = chainErr.message || '';
            if (msg.includes('bad bountyId') || msg.includes('CALL_EXCEPTION')) {
              result.issues.push({
                type: IssueType.NOT_ON_CHAIN,
                severity: IssueSeverity.ERROR,
                message: 'Bounty does not exist on-chain. It cannot accept submissions or pay out.'
              });
              result.valid = false;
            }
          }
        }

        // Store validation result in job, unless it is only a fetch failure: that
        // must not paint a red error card on the board (see persistValidationVerdict).
        const verdict = await persistValidationVerdict(job, result);

        if (result.valid) {
          validCount++;
        } else {
          invalidCount++;
        }

        results.push({
          jobId: job.jobId,
          title: job.title,
          valid: result.valid,
          errorCount: result.issues.filter(i => i.severity === 'error').length,
          warningCount: result.issues.filter(i => i.severity === 'warning').length,
          ...(verdict ? {} : { unchecked: true }),
          ...notOnChainAttempt(job, result.issues)
        });

      } catch (e) {
        results.push({
          jobId: job.jobId,
          title: job.title,
          valid: false,
          error: e.message
        });
        invalidCount++;
      }
    }

    return res.json({
      success: true,
      summary: {
        total: toValidate.length,
        valid: validCount,
        invalid: invalidCount
      },
      results
    });

  } catch (error) {
    logger.error('[admin/validate-all] error', { msg: error.message });
    return res.status(500).json({ error: 'Batch validation failed', details: error.message });
  }
});

/**
 * GET /api/jobs/:jobId/validate
 * Validate a bounty's evaluation package format.
 * Checks if the package is a properly formatted ZIP with valid rubric.
 *
 * Returns:
 * - valid: boolean - Whether the bounty is properly formatted
 * - issues: Array<{type, severity, message}> - List of issues found
 * - format: object - Format detection info
 */
router.get('/:jobId/validate', async (req, res) => {
  const { jobId } = req.params;

  try {
    const job = await jobStorage.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({ error: 'IPFS client not available' });
    }

    // Try to get classMap for model validation
    let classMap;
    try {
      const common = require('@verdikta/common');
      classMap = common.classMap;
    } catch (e) {
      logger.warn('Could not load classMap for validation:', e.message);
    }

    const evaluationCid = job.evaluationCid;

    const result = await validateBounty({
      evaluationCid,
      classId: job.classId,
      ipfsClient,
      classMap
    });

    // Check if bounty exists on-chain and is in a payable state
    try {
      const contractService = getContractService();
      const onChain = await contractService.getBounty(job.jobId);

      const chainCheck = chainStatusIssue(onChain.status);
      if (chainCheck) {
        result.issues.push(chainCheck.issue);
        if (chainCheck.invalidatesPackage) {
          result.valid = false;
        }
      }
      if (onChain.status === 'OPEN') {
        try {
          const jury = juryIssue(await contractService.getJuryProblem(job.jobId));
          if (jury) { result.issues.push(jury); result.valid = false; }
        } catch { /* best-effort: the start's own check still applies */ }
      }
    } catch (chainErr) {
      const msg = chainErr.message || '';
      if (msg.includes('bad bountyId') || msg.includes('CALL_EXCEPTION')) {
        result.issues.push({
          type: IssueType.NOT_ON_CHAIN,
          severity: IssueSeverity.ERROR,
          message: 'Bounty does not exist on-chain. It cannot accept submissions or pay out.'
        });
        result.valid = false;
      } else {
        result.issues.push({
          type: IssueType.CHAIN_STATUS,
          severity: IssueSeverity.WARNING,
          message: `Could not verify on-chain status: ${msg}`
        });
      }
    }

    // Persist so job.validationStatus.hasIssues (GET /jobs, GET /:jobId) and
    // the submission gate (ensureFreshValidation) see this result without
    // waiting for the next admin/validate-all sweep — issue #39: a bounty
    // whose package is broken must look and behave unevaluable everywhere,
    // not just in this one-off response.
    // A fetch failure is reported in the response but never persisted as a verdict.
    await persistValidationVerdict(job, result);
    const checkedAt = new Date().toISOString();

    return res.json({
      success: true,
      jobId: job.jobId,
      evaluationCid,
      valid: result.valid,
      issues: result.issues,
      ...notOnChainAttempt(job, result.issues),
      checkedAt
    });

  } catch (error) {
    logger.error('[validate] error', { jobId, msg: error.message });
    return res.status(500).json({
      error: 'Validation failed',
      details: error.message
    });
  }
});

/**
 * GET /api/jobs/:jobId/oracle-check
 * Read-only check of the arbiter pool for the bounty's class under its creator-
 * chosen oracle settings (fee ceiling, alpha, price boost). Reads the
 * ReputationKeeper via the aggregator. Never errors on a keeper read failure —
 * returns { available:false } so the UI can degrade gracefully.
 *
 * Response: { available, classId, classListed, oracleSettings, totalInClass, eligibleCount,
 *   distinctOwnersEligible, creatorOperatedCount, priceBoostEnabled, alphaExtreme, warnings[] , ... }
 * classListed: whether the class is in the @verdikta/common registry (null if unreadable).
 * creatorOperatedCount: eligible arbiters whose operator is owned by the bounty creator.
 */
router.get('/:jobId/oracle-check', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await jobStorage.getJob(jobId);
    const oracleSettings = jobOracleSettings(job);
    const classId = Number(job.classId ?? 128);
    const classListed = lookupClass(classId).listed;

    if (!isVerdiktaServiceAvailable()) {
      return res.json({
        available: false,
        jobId: job.jobId,
        classId,
        classListed,
        oracleSettings,
        reason: 'Verdikta service not configured on this server',
        warnings: []
      });
    }

    try {
      const result = await getVerdiktaService().getClassOracleEligibility(classId, oracleSettings, { jury: jobDecisionSettings(job).jury });
      const creator = String(job.creator || '').toLowerCase();
      const creatorOperatedCount = creator
        ? (result.eligibleArbiters || []).filter(a => a.owner && String(a.owner).toLowerCase() === creator).length
        : 0;
      return res.json({ success: true, jobId: job.jobId, classListed, creatorOperatedCount, ...result });
    } catch (keeperErr) {
      logger.warn('[oracle-check] keeper read failed', { jobId, msg: keeperErr.message });
      return res.json({
        available: false,
        jobId: job.jobId,
        classId,
        classListed,
        oracleSettings,
        reason: `Could not read the arbiter registry: ${keeperErr.message}`,
        warnings: []
      });
    }
  } catch (error) {
    if ((error.message || '').includes('not found')) {
      return res.status(404).json({ available: false, error: 'Job not found' });
    }
    logger.error('[oracle-check] error', { jobId, msg: error.message });
    return res.status(500).json({ available: false, error: 'Oracle check failed', details: error.message });
  }
});

/* ==============
   LIST JOBS
   ============== */

router.get('/', async (req, res) => {
  try {
    const {
      status, creator, minPayout, search, submissionStatus,
      hideEnded, excludeStatuses, includeOrphans, limit = 50, offset = 0,
      // New filters for agents
      workProductType,    // Filter by type: "code", "writing", "research", etc. (comma-separated)
      minHoursLeft,       // Minimum hours until deadline (e.g., "2" = at least 2 hours left)
      maxHoursLeft,       // Maximum hours until deadline (e.g., "24" = deadline within 24 hours)
      excludeSubmittedBy, // Exclude jobs this address has already submitted to
      minBountyUSD,       // Minimum bounty in USD
      maxBountyUSD,       // Maximum bounty in USD
      classId,            // Filter by Verdikta class ID
      hasWinner,          // "true" = only jobs with winner, "false" = only jobs without winner
      targetHunter,       // Filter by targeted bounties: address = only bounties targeting this address, "any" = only targeted bounties, "none" = only open bounties
    } = req.query;
    logger.info('[jobs/list] filters', {
      status, creator, search, submissionStatus, hideEnded, excludeStatuses, includeOrphans,
      workProductType, minHoursLeft, maxHoursLeft, excludeSubmittedBy, minBountyUSD, maxBountyUSD, classId, hasWinner
    });

    const filters = {
      // By default, don't show orphaned jobs
      includeOrphans: String(includeOrphans).toLowerCase() === 'true'
    };
    if (status) filters.status = String(status).toUpperCase();
    if (creator) filters.creator = creator;
    if (minPayout) filters.minPayout = minPayout;
    if (search) filters.search = search;

    let allJobs = await jobStorage.listJobs(filters);

    // Filter by work product type (comma-separated list, case-insensitive)
    if (workProductType) {
      const types = workProductType.split(',').map(t => t.trim().toLowerCase());
      allJobs = allJobs.filter(j => {
        const jobType = (j.workProductType || '').toLowerCase();
        return types.some(t => jobType.includes(t));
      });
    }

    // Filter by time remaining until deadline
    const nowSec = Math.floor(Date.now() / 1000);
    if (minHoursLeft) {
      const minSeconds = parseFloat(minHoursLeft) * 3600;
      allJobs = allJobs.filter(j => {
        const remaining = (j.submissionCloseTime || 0) - nowSec;
        return remaining >= minSeconds;
      });
    }
    if (maxHoursLeft) {
      const maxSeconds = parseFloat(maxHoursLeft) * 3600;
      allJobs = allJobs.filter(j => {
        const remaining = (j.submissionCloseTime || 0) - nowSec;
        return remaining <= maxSeconds && remaining > 0;
      });
    }

    // Exclude jobs that a specific address has already submitted to
    if (excludeSubmittedBy) {
      const excludeAddr = excludeSubmittedBy.toLowerCase();
      allJobs = allJobs.filter(j => {
        if (!j.submissions || j.submissions.length === 0) return true;
        return !j.submissions.some(s => (s.hunter || '').toLowerCase() === excludeAddr);
      });
    }

    // Filter by bounty amount in USD
    if (minBountyUSD) {
      const minUSD = parseFloat(minBountyUSD);
      allJobs = allJobs.filter(j => (j.bountyAmountUSD || 0) >= minUSD);
    }
    if (maxBountyUSD) {
      const maxUSD = parseFloat(maxBountyUSD);
      allJobs = allJobs.filter(j => (j.bountyAmountUSD || 0) <= maxUSD);
    }

    // Filter by Verdikta class ID
    if (classId) {
      const cid = parseInt(classId, 10);
      allJobs = allJobs.filter(j => j.classId === cid);
    }

    // Filter by targetHunter
    if (targetHunter) {
      if (targetHunter.toLowerCase() === 'any') {
        allJobs = allJobs.filter(j => j.targetHunter != null);
      } else if (targetHunter.toLowerCase() === 'none') {
        allJobs = allJobs.filter(j => !j.targetHunter);
      } else {
        const addr = targetHunter.toLowerCase();
        allJobs = allJobs.filter(j => (j.targetHunter || '').toLowerCase() === addr);
      }
    }

    // Filter by whether job has a winner
    if (hasWinner === 'true') {
      allJobs = allJobs.filter(j => j.winner != null);
    } else if (hasWinner === 'false') {
      allJobs = allJobs.filter(j => j.winner == null);
    }

    const excludeSet = new Set();
    if (String(hideEnded).toLowerCase() === 'true') {
      excludeSet.add('CANCELLED');
      excludeSet.add('COMPLETED');
    }
    // Always exclude ORPHANED unless explicitly requested
    if (!filters.includeOrphans) {
      excludeSet.add('ORPHANED');
    }
    if (excludeStatuses) {
      for (const s of String(excludeStatuses).split(',')) {
        const v = s.trim().toUpperCase();
        if (v) excludeSet.add(v);
      }
    }
    if (excludeSet.size > 0) {
      allJobs = allJobs.filter(j => !excludeSet.has(String(j.status).toUpperCase()));
    }

    if (submissionStatus) {
      const wanted = String(submissionStatus).toUpperCase();
      allJobs = allJobs.filter(j =>
        (j.submissions || []).some(s => String(s.status).toUpperCase() === wanted)
      );
    }

    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginatedJobs = allJobs.slice(offsetNum, offsetNum + limitNum);

    const jobSummaries = paginatedJobs.map(job => {
      // Compute time remaining for agent convenience
      const remainingSeconds = (job.submissionCloseTime || 0) - nowSec;
      const hoursLeft = remainingSeconds > 0 ? Math.round(remainingSeconds / 360) / 10 : 0; // 1 decimal place

      // Include validation status if available
      const validationIssues = job.validationStatus?.issues || [];
      const validationInfo = job.validationStatus ? {
        hasIssues: !job.validationStatus.valid,
        issueCount: validationIssues.length,
        errorCount: validationIssues.filter(i => i.severity === 'error').length,
        errorMessages: validationIssues.filter(i => i.severity === 'error').map(i => i.message),
        warningMessages: validationIssues.filter(i => i.severity === 'warning').map(i => i.message)
      } : null;

      return {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        workProductType: job.workProductType,
        bountyAmount: job.bountyAmount,
        bountyAmountWei: job.bountyAmountWei,
        bountyAmountUSD: job.bountyAmountUSD,
        threshold: job.threshold,
        classId: job.classId,
        status: job.status,
        submissionCount: job.submissionCount,
        submissionOpenTime: job.submissionOpenTime,
        submissionCloseTime: job.submissionCloseTime,
        hoursLeft, // Computed field for agent convenience
        createdAt: job.createdAt,
        creator: job.creator, // Bounty creator address
        winner: job.winner,
        targetHunter: job.targetHunter || null,
        // Creator approval window fields (zero/undefined for non-windowed bounties)
        creatorAssessmentWindowSize: job.creatorAssessmentWindowSize || 0,
        creatorDeterminationPayment: job.creatorDeterminationPayment || null,
        arbiterDeterminationPayment: job.arbiterDeterminationPayment || null,
        contractAddress: job.contractAddress, // Include for debugging
        // On-chain confirmation flags — needed by client to render the
        // "Pending on-chain" badge. `syncedFromBlockchain` is set by the
        // sync service after it sees a BountyCreated event; `onChain` is
        // set by the PATCH /bountyId/resolve endpoint. Either = confirmed.
        syncedFromBlockchain: !!job.syncedFromBlockchain,
        onChain: !!job.onChain,
        // Creator-controlled visibility flag (off-chain). When true, the
        // client may render preview/download buttons for submitted work
        // to non-creators. CIDs themselves are public regardless.
        publicSubmissions: !!job.publicSubmissions,
        validationStatus: validationInfo, // Include validation info if available
        submissions: job.submissions // Include for pending evaluation check
      };
    });

    return res.json({
      success: true,
      untrustedContent: untrustedContent(['jobs[].title', 'jobs[].description', 'jobs[].workProductType', 'jobs[].validationStatus']),
      jobs: jobSummaries,
      total: allJobs.length,
      limit: limitNum,
      offset: offsetNum,
      tips: [
        'Filter by status: GET /api/jobs?status=OPEN',
        'Filter by type: GET /api/jobs?workProductType=code',
        'To submit work: POST /api/jobs/:id/submit with files + hunter address',
        'View rubric: GET /api/jobs/:id/rubric',
        'Plain text list: GET /api/jobs.txt',
        'Full docs: GET /api/docs'
      ]
    });

  } catch (error) {
    logger.error('[jobs/list] error', { msg: error.message });
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to list jobs',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health',
      tips: ['Plain text list: GET /api/jobs.txt']
    });
  }
});

/* =================
   LIST SUBMISSIONS FOR A JOB
   ================= */

/**
 * GET /api/jobs/:jobId/submissions
 * List all submissions for a bounty with simplified status.
 * Public endpoint - no authentication required.
 *
 * Statuses:
 * - PENDING_CREATOR_APPROVAL: Windowed bounty — in the creator-approval window.
 *     Do NOT call startPreparedSubmission yet (it reverts until the window closes).
 * - PENDING_EVALUATION: Submitted, awaiting AI evaluation
 * - EVALUATED_PASSED: Evaluation complete, passed threshold (but didn't win)
 * - EVALUATED_FAILED: Evaluation complete, failed threshold
 * - WINNER: Passed threshold and received payout
 * - TIMED_OUT: Oracle timeout, no evaluation result
 * - NO_RESULT: the round produced no result (failed or cancelled), or its re-run window expired (v2)
 * - EVALUATED_SOFT_FAIL: some arbiters passed it but fewer than the bounty's quota; a re-run may follow (v2)
 * - AWAITING_RERUN: in its 2-hour re-run window; the hunter or bond funder may start another round (v2)
 *
 * Note: PREPARED submissions (not yet started on-chain) are excluded.
 */
router.get('/:jobId/submissions', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/submissions] list', { jobId });

    const job = await jobStorage.getJob(jobId);
    const threshold = job.threshold || 0;

    // Map internal status to simplified public status
    function mapStatus(sub) {
      const status = (sub.status || '').toLowerCase();
      const onChainStatus = (sub.onChainStatus || '').toLowerCase();
      const score = sub.acceptance ?? sub.score ?? null;
      const hasScore = score !== null && score !== undefined && score > 0;

      // Check for winner (PassedPaid). The high-level `status` field collapses
      // PassedPaid and PassedUnpaid into 'APPROVED', so we also key off the
      // low-level `onChainStatus` and the `paidWinner` flag set by the
      // PayoutSent event handler.
      if (status === 'passedpaid' || status === 'winner' ||
          onChainStatus === 'passedpaid' || sub.paidWinner === true) {
        return 'WINNER';
      }

      // v2 (item 12): awaiting a re-run, or evaluated but not yet finalized as a soft fail / no result
      if (status === 'awaiting_rerun' || onChainStatus === 'awaitingrerun') return 'AWAITING_RERUN';
      if (status === 'soft_fail_pending_finalization') return 'EVALUATED_SOFT_FAIL';
      if (status === 'no_result_pending_close') return 'NO_RESULT';

      // Failed: the escrow's marker says why (v2); older records fall back to zero scores and no justification
      if (status === 'failed' || status === 'rejected') {
        if (sub.failureReason === 'NO_RESULT' || sub.failureReason === 'RERUN_EXPIRED') return 'NO_RESULT';
        if (sub.failureReason === 'ORACLE_TIMEOUT') return 'TIMED_OUT';
        const hasZeroScores = (sub.acceptance === 0 || sub.acceptance == null) &&
                             (sub.rejection === 0 || sub.rejection == null);
        const hasNoJustification = !sub.justificationCids || sub.justificationCids === '';
        if (hasZeroScores && hasNoJustification) {
          return 'TIMED_OUT';
        }
        return 'EVALUATED_FAILED';
      }

      // Check for passed but not winner (PassedUnpaid, Approved)
      if (status === 'passedunpaid' || status === 'passed' || status === 'approved' || status === 'accepted') {
        return 'EVALUATED_PASSED';
      }

      // Oracle evaluated but not yet finalized on BountyEscrow
      if (status === 'accepted_pending_claim') {
        return 'EVALUATED_PASSED';
      }
      if (status === 'rejected_pending_finalization') {
        return 'EVALUATED_FAILED';
      }

      // Windowed bounty: submission sits in the creator-approval window. This is
      // NOT PENDING_EVALUATION — the hunter must not call startPreparedSubmission
      // while the window is open (the contract reverts). The creator may approve
      // directly; once the window expires, anyone can fund + start the oracle.
      if (status === 'pendingcreatorapproval') {
        return 'PENDING_CREATOR_APPROVAL';
      }

      // Check pending states
      if (status === 'pending' || status === 'pendingverdikta' || status === 'pending_evaluation') {
        // If has score, evaluation completed but status wasn't updated
        if (hasScore) {
          return score >= threshold ? 'EVALUATED_PASSED' : 'EVALUATED_FAILED';
        }
        return 'PENDING_EVALUATION';
      }

      // Prepared submissions are filtered out below, but handle edge case
      if (status === 'prepared') {
        return null; // Will be filtered
      }

      // Unknown status - treat as pending if no score, otherwise evaluate
      if (hasScore) {
        return score >= threshold ? 'EVALUATED_PASSED' : 'EVALUATED_FAILED';
      }
      return 'PENDING_EVALUATION';
    }

    // Filter out PREPARED submissions and map to response format
    const submissions = (job.submissions || [])
      .map(sub => {
        const mappedStatus = mapStatus(sub);
        if (!mappedStatus) return null; // Filter out PREPARED

        // Don't report score for pending/timed-out submissions — acceptance defaults
        // to 0 on-chain, which is misleading (looks like 0% instead of "not yet scored")
        const rawAcceptance = sub.acceptance ?? sub.score ?? null;
        const rawRejection = sub.rejection ?? null;
        const suppressScore = mappedStatus === 'PENDING_EVALUATION' || mappedStatus === 'TIMED_OUT' || mappedStatus === 'NO_RESULT' || mappedStatus === 'PENDING_CREATOR_APPROVAL';
        const score = suppressScore ? null : rawAcceptance;
        const rejection = suppressScore ? null : rawRejection;

        // Whether a detailed AI evaluation report is fetchable via the /evaluation endpoint
        const hasEvaluationReport = !!sub.justificationCids && sub.justificationCids !== '';

        return {
          id: sub.submissionId,
          hunter: sub.hunter,
          hunterCid: sub.hunterCid || null,
          status: mappedStatus,
          score,
          rejection,
          failureReason: sub.failureReason || null,
          // Payment record (on-chain PassedPaid == paid) and who attached the prepay
          // (receives the unspent refund) — both mirrored from chain by the sync service.
          paidWinner: sub.paidWinner === true,
          funder: sub.funder || null,
          onChainStatus: sub.onChainStatus || null,
          justificationCids: sub.justificationCids || null,
          hasEvaluationReport,
          evaluationEndpoint: hasEvaluationReport
            ? `/api/jobs/${job.jobId}/submissions/${sub.submissionId}/evaluation`
            : null,
          submittedAt: sub.submittedAt || null,
          evaluatedAt: sub.finalizedAt || null,
          // Surfaced for windowed bounties so agents can see how long the creator
          // window has left before startPreparedSubmission becomes valid.
          creatorWindowEnd: sub.creatorWindowEnd || null,
          creatorWindowSecondsRemaining: (mappedStatus === 'PENDING_CREATOR_APPROVAL' && sub.creatorWindowEnd)
            ? Math.max(0, sub.creatorWindowEnd - Math.floor(Date.now() / 1000))
            : null
        };
      })
      .filter(Boolean); // Remove nulls (PREPARED submissions)

    return res.json({
      success: true,
      jobId: job.jobId,
      threshold,
      submissions,
      tips: [
        `View bounty details: GET /api/jobs/${job.jobId}`,
        `Get full AI evaluation report (scores + justification): GET /api/jobs/${job.jobId}/submissions/:subId/evaluation`,
        `Submit work: POST /api/jobs/${job.jobId}/submit`
      ]
    });

  } catch (error) {
    logger.error('[jobs/submissions] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${req.params.jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to list submissions',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  }
});

/* ============================
   GET EVALUATION PACKAGE DETAILS
   ============================ */

/**
 * GET /api/jobs/:jobId/evaluation-package
 * Fetches and parses the full evaluation package from IPFS.
 * Returns the manifest, primary query, rubric, and jury config
 * so bidders can see exactly what oracles receive.
 */
router.get('/:jobId/evaluation-package', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/evaluation-package] get', { jobId });

    let job;
    try {
      job = await jobStorage.getJob(jobId);
    } catch (e) {
      const numId = parseInt(jobId);
      if (numId > 0) {
        try { job = await jobStorage.getJob(numId - 1); } catch {}
      }
      if (!job) throw e;
    }

    if (!job.evaluationCid) {
      return res.status(404).json({
        success: false,
        error: 'No evaluation package available',
        details: 'This job does not have an evaluation CID'
      });
    }

    if (job.evaluationCid.startsWith('dev-')) {
      return res.status(400).json({
        success: false,
        error: 'Dev evaluation package',
        details: 'Evaluation details are not available for dev-mode bounties'
      });
    }

    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        success: false,
        error: 'IPFS client not available'
      });
    }

    // Fetch and parse the evaluation ZIP archive
    let archiveBuffer;
    try {
      archiveBuffer = await withTimeout(
        ipfsClient.fetchFromIPFS(job.evaluationCid),
        PIN_TIMEOUT_MS * 2,
        'IPFS evaluation package fetch'
      );
    } catch (err) {
      logger.error('[jobs/evaluation-package] IPFS fetch failed', { jobId, cid: job.evaluationCid, msg: err.message });
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch evaluation package from IPFS',
        details: err.message,
        evaluationCid: job.evaluationCid
      });
    }

    const zip = new AdmZip(archiveBuffer);
    const entries = zip.getEntries();

    // Extract manifest.json
    let manifest = null;
    const manifestEntry = entries.find(e =>
      e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
    );
    if (manifestEntry) {
      manifest = JSON.parse(readEntryText(manifestEntry));
    }

    // Extract primary_query.json
    let primaryQuery = null;
    const queryEntry = entries.find(e =>
      e.entryName === 'primary_query.json' || e.entryName.endsWith('/primary_query.json')
    );
    if (queryEntry) {
      primaryQuery = JSON.parse(readEntryText(queryEntry));
    }

    // Fetch the grading rubric from IPFS if referenced
    let rubric = null;
    let rubricCid = null;
    if (manifest?.additional) {
      const rubricRef = manifest.additional.find(a => a.name === 'gradingRubric');
      if (rubricRef?.hash) {
        rubricCid = rubricRef.hash;
        try {
          const rubricBuffer = await withTimeout(
            ipfsClient.fetchFromIPFS(rubricRef.hash),
            PIN_TIMEOUT_MS,
            'IPFS rubric fetch'
          );
          rubric = JSON.parse(rubricBuffer.toString('utf8'));
        } catch (err) {
          logger.warn('[jobs/evaluation-package] rubric fetch failed', { hash: rubricRef.hash, msg: err.message });
        }
      }
    }

    // Build jury config from manifest
    const juryConfig = manifest?.juryParameters ? {
      nodes: (manifest.juryParameters.AI_NODES || []).map(node => ({
        provider: node.AI_PROVIDER,
        model: node.AI_MODEL,
        runs: node.NO_COUNTS || 1,
        weight: node.WEIGHT || 1
      })),
      iterations: manifest.juryParameters.ITERATIONS || 1,
      numberOfOutcomes: manifest.juryParameters.NUMBER_OF_OUTCOMES || 2
    } : null;

    return res.json({
      success: true,
      evaluationCid: job.evaluationCid,
      manifest,
      primaryQuery,
      rubric,
      rubricCid,
      juryConfig,
      threshold: job.threshold || null,
      classId: job.classId || null,
      meta: {
        jobId: job.jobId,
        title: job.title,
        workProductType: job.workProductType || 'Work Product'
      }
    });

  } catch (error) {
    logger.error('[jobs/evaluation-package] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ error: 'Failed to get evaluation package', details: error.message });
  }
});

/* ============================
   GET TASK SPEC (lazy)
   ============================ */

/**
 * GET /api/jobs/:jobId/task-spec
 * Lazily fetches and extracts the full task description from the evaluation
 * package on IPFS. Split out from GET /:jobId so the bounty-detail page can
 * render quickly without waiting on the (often slow) evaluation ZIP fetch —
 * the expanded description is loaded only when the user explicitly opens it.
 */
router.get('/:jobId/task-spec', async (req, res) => {
  try {
    const { jobId } = req.params;
    let job;
    try {
      job = await jobStorage.getJob(jobId);
    } catch (e) {
      const numId = parseInt(jobId);
      if (numId > 0) {
        try { job = await jobStorage.getJob(numId - 1); } catch {}
      }
      if (!job) throw e;
    }

    if (!job.evaluationCid || job.evaluationCid.startsWith('dev-')) {
      return res.json({ success: true, taskSpec: null });
    }

    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({ success: false, error: 'IPFS client not available' });
    }

    let taskSpec = null;
    try {
      const archiveBuffer = await ipfsClient.fetchFromIPFS(job.evaluationCid);
      const zip = new AdmZip(archiveBuffer);
      const primaryEntry = zip.getEntries().find(e =>
        e.entryName === 'primary_query.json' || e.entryName.endsWith('/primary_query.json')
      );
      if (primaryEntry) {
        const primary = JSON.parse(readEntryText(primaryEntry));
        // Same reader as the chain sync, so the expanded text and a synced
        // job's description agree.
        taskSpec = extractTaskDescription(primary?.query);
      }
    } catch (err) {
      logger.warn('[jobs/task-spec] failed to extract', { jobId, msg: err.message });
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch evaluation package from IPFS',
        details: err.message
      });
    }

    return res.json({ success: true, taskSpec });
  } catch (error) {
    logger.error('[jobs/task-spec] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to get task spec', details: error.message });
  }
});

// ==========================================================================
// Utility: ETH price proxy (Coinbase spot, CoinGecko fallback; see utils/ethPrice).
// Must be above /:jobId to avoid "eth-price" being matched as a job ID.
// ==========================================================================

router.get('/eth-price', async (req, res) => {
  // Response contract: { usd, source?, cached? } on success; { usd, stale: true, ... }
  // when every source fails (usd is 0 if no price has been seen since startup).
  return res.json(await getEthPriceUsd());
});

/* =================
   GET JOB DETAILS
   ================= */

/**
 * The rubric (and jury) of a job as GET /:jobId?includeRubric=true serves them: read from the
 * evaluationCid package first (authoritative), the loose rubricCid only as a fallback, and
 * persisted on the job so later loads need no IPFS. Never throws: rubricContent is null when
 * nothing could be read. The mutual-wager checks read counter bounties through it too.
 */
async function loadJobRubric(job, ipfsClient) {
  let rubricContent = null;
  let extractedJuryNodes = job.juryNodes || [];

  // Source identity for the persisted-rubric cache. evaluationCid is the
  // authoritative, immutable on-chain pointer (the package determines the
  // gradingRubric); fall back to the loose rubricCid for legacy jobs.
  const rubricSource = job.evaluationCid || job.rubricCid || null;

  // Fast path (Option B): a rubric persisted on a previous load is still
  // valid as long as its source CID matches — serve it with NO IPFS round
  // trips. This is the bounty-detail load-time optimization.
  // Only a rubric read from the package itself is cached under the package CID (rubricProvenance), so a
  // copy from the loose rubricCid fallback is never served later as the package's rubric.
  const cacheHit = !!(job.rubricContent && rubricSource && job.rubricSourceCid === rubricSource
    && (job.rubricProvenance === 'package' || !job.evaluationCid));
  let fromPackage = false;
  if (cacheHit) {
    rubricContent = job.rubricContent;
  }

  // Hash of the gradingRubric referenced INSIDE the evaluationCid package.
  // This is the authoritative rubric pointer — the package is content-
  // addressed/immutable and is exactly what the oracle grades against.
  let packageRubricHash = null;

  // AUTHORITATIVE SOURCE: open the evaluationCid package FIRST and derive the
  // rubric (and jury) from it. The loose job.rubricCid field is only a
  // fallback because it can drift out of sync with the package — e.g. after
  // an ID-renumber/heal that repaired the package + title but not rubricCid.
  // Re-issue (?clone=) prefills the create form from this response, so
  // trusting the drift-prone pointer here silently mints new bounties whose
  // graded criteria don't match the task.
  if (!cacheHit && job.evaluationCid) {
    try {
      const archiveBuffer = await ipfsClient.fetchFromIPFS(job.evaluationCid);
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(archiveBuffer);
      const entries = zip.getEntries();

      // Look for manifest.json first (new Verdikta format)
      const manifestEntry = entries.find(e =>
        e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json')
      );

      if (manifestEntry) {
        const manifestText = readEntryText(manifestEntry);
        const manifest = JSON.parse(manifestText);

        // Extract jury nodes from manifest.juryParameters.AI_NODES
        if (manifest.juryParameters?.AI_NODES && extractedJuryNodes.length === 0) {
          extractedJuryNodes = manifest.juryParameters.AI_NODES.map(node => ({
            provider: node.AI_PROVIDER,
            model: node.AI_MODEL,
            runs: node.NO_COUNTS || 1,
            weight: node.WEIGHT || 1
          }));
        }

        // Look for grading rubric reference in manifest.additional
        const gradingRubricRef = manifest.additional?.find(a => a.name === 'gradingRubric');
        if (gradingRubricRef?.hash) {
          packageRubricHash = gradingRubricRef.hash;
          try {
            const rubricBuffer = await ipfsClient.fetchFromIPFS(gradingRubricRef.hash);
            const rubricText = rubricBuffer.toString('utf8');
            rubricContent = JSON.parse(rubricText);
            fromPackage = true;
          } catch (err) {
            logger.warn('[jobs/details] failed to fetch grading rubric from IPFS', {
              hash: gradingRubricRef.hash,
              msg: err.message
            });
          }
        }
      }

      // Fallback: look for rubric.json directly in ZIP (older format)
      if (!rubricContent) {
        const rubricEntry = entries.find(e =>
          e.entryName === 'rubric.json' || e.entryName.endsWith('/rubric.json')
        );
        if (rubricEntry) {
          const rubricText = readEntryText(rubricEntry);
          rubricContent = JSON.parse(rubricText);
          fromPackage = true;

          // Extract jury from rubric if present
          if (rubricContent.jury && Array.isArray(rubricContent.jury) && extractedJuryNodes.length === 0) {
            extractedJuryNodes = rubricContent.jury;
          }
        }
      }

    } catch (err) {
      logger.warn('[jobs/details] failed to extract from evaluationCid', { msg: err.message });
    }
  }

  // Cross-check + last-resort fallback to the loose rubricCid pointer.
  // If it disagrees with the package's gradingRubric, the stored pointer is
  // stale — surface it loudly but keep serving the authoritative package
  // rubric. Only fetch from the loose pointer when the package gave nothing.
  if (!cacheHit && job.rubricCid) {
    if (packageRubricHash && job.rubricCid !== packageRubricHash) {
      logger.warn('[jobs/details] rubricCid drift: stored rubricCid disagrees with evaluationCid package gradingRubric — using package (authoritative)', {
        jobId: job.jobId,
        storedRubricCid: job.rubricCid,
        packageRubricHash
      });
    }
    if (!rubricContent) {
      try {
        const rawRubric = await ipfsClient.fetchFromIPFS(job.rubricCid);
        rubricContent = JSON.parse(rawRubric);
      } catch (err) {
        logger.warn('[jobs/details] failed to fetch rubric from rubricCid (fallback)', { msg: err.message });
      }
    }
  }

  // Persist the authoritative rubric (+ jury) onto the job so future loads
  // serve it locally with zero IPFS. Keyed on the immutable source CID and
  // race-safe via jobStorage.updateJob -> withStorage. Best-effort: a failed
  // write just means the next load re-fetches and retries the persist.
  if (!cacheHit && rubricContent && rubricSource && (fromPackage || !job.evaluationCid)) {
    const updates = { rubricContent, rubricSourceCid: rubricSource, rubricProvenance: fromPackage ? 'package' : 'rubricCid' };
    if (extractedJuryNodes.length > 0) updates.juryNodes = extractedJuryNodes;
    try {
      await jobStorage.updateJob(job.jobId, updates);
    } catch (persistErr) {
      logger.warn('[jobs/details] failed to persist rubric cache', { jobId: job.jobId, error: persistErr.message });
    }
  }

  return { rubricContent, juryNodes: extractedJuryNodes };
}

router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/details] get', { jobId });

    let job;
    try {
      job = await jobStorage.getJob(jobId);
    } catch (e) {
      // Fallback: try jobId - 1 for legacy URLs (old 1-based IDs)
      const numId = parseInt(jobId);
      if (numId > 0) {
        try { job = await jobStorage.getJob(numId - 1); } catch {}
      }
      if (!job) throw e;
    }

    // Ghost guard: direct-by-ID lookups must not leak phantom bounties that
    // the list endpoint is already hiding. If the job was never confirmed
    // on-chain and has exceeded the 1h grace window, treat it as not found
    // so agents calling closeExpiredBounty / finalizeSubmission don't try
    // to act on a non-existent bounty. The sync service's orphan sweep will
    // mark these ORPHANED on the next cycle — this guard is the read-time
    // backstop for the window between creation and that sweep.
    const GHOST_GRACE_SECS = 3600;
    const nowSec = Math.floor(Date.now() / 1000);
    // An anonymous read gets no grace at all (sec4-outside): anyone with a free key can create a job
    // that never goes on chain, with any title, amount and creator address, and jurors and link
    // holders read this path to verify a bounty. Only its creator's tools (keyed) see it pending.
    const unconfirmed = !job.onChain && !job.syncedFromBlockchain && job.status !== 'ORPHANED';
    const isUnconfirmedGhost = unconfirmed &&
      (req.clientType === 'public' || (nowSec - (job.createdAt || 0)) > GHOST_GRACE_SECS);
    if (isUnconfirmedGhost) {
      logger.warn('[jobs/details] ghost job served as 404', {
        jobId: job.jobId, ageSec: nowSec - (job.createdAt || 0)
      });
      return res.status(404).json({
        success: false,
        error: 'Bounty not found',
        details: req.clientType === 'public'
          ? `Job ${jobId} is not confirmed on-chain.`
          : `Job ${jobId} was never confirmed on-chain and has exceeded the 1h grace window.`
      });
    }

    // ============================================================
    // Read-side invariant: heal impossible-state submissions inline
    // ============================================================
    // A windowed bounty's submission can NEVER legitimately be in
    // 'Prepared' state on chain — the contract transitions it directly
    // to PendingCreatorApproval (state 5). If we see local='Prepared'
    // on a windowed bounty, the local record is stale (chain-read
    // fallback fired during the original write). Heal it inline before
    // serving the response so the client never sees the impossible
    // state. This is the read-time backstop for the prevention fixes
    // in POST /submissions/confirm and the SubmissionPrepared event
    // handler. See bounty 46 / bounty 52 incidents.
    //
    // Cost: zero RPC calls in the common case (in-memory filter pass).
    // Only when stuck records are detected do we hit the chain.
    if (Number(job.creatorAssessmentWindowSize || 0) > 0 && Array.isArray(job.submissions)) {
      const stuckSubs = job.submissions.filter(s =>
        s.status === 'Prepared' || s.status === 'PREPARED'
      );
      if (stuckSubs.length > 0) {
        try {
          const cs = getContractService();
          const contract = cs.contract;
          const statusMap = {
            0: 'Prepared',
            1: 'PENDING_EVALUATION',
            2: 'REJECTED',
            3: 'APPROVED',
            4: 'APPROVED',
            5: 'PendingCreatorApproval',
          };
          const onChainStatusMap = {
            0: 'Prepared',
            1: 'PendingVerdikta',
            2: 'Failed',
            3: 'PassedPaid',
            4: 'PassedUnpaid',
            5: 'PendingCreatorApproval',
          };
          let healedAny = false;
          // Run reads in parallel — usually 1 stuck record, but be safe
          const healResults = await Promise.allSettled(
            stuckSubs.map(s => contract.getSubmission(Number(job.jobId), Number(s.submissionId)))
          );
          for (let i = 0; i < stuckSubs.length; i++) {
            const result = healResults[i];
            const sub = stuckSubs[i];
            if (result.status !== 'fulfilled') {
              logger.warn('[jobs/details] read-side heal: chain read failed', {
                jobId, submissionId: sub.submissionId, error: result.reason?.message
              });
              continue;
            }
            const chainSub = result.value;
            const chainStatus = statusMap[Number(chainSub.status)] || 'UNKNOWN';
            const chainOnChainStatus = onChainStatusMap[Number(chainSub.status)] || null;
            if (chainStatus !== sub.status) {
              sub.status = chainStatus;
              // Low-level chain enum name (PassedPaid/PassedUnpaid/Failed),
              // not the collapsed high-level form, so analytics can tell
              // paid winners from passed-but-unpaid submissions.
              if (chainOnChainStatus) {
                sub.onChainStatus = chainOnChainStatus;
              }
              sub.creatorWindowEnd = Number(chainSub.creatorWindowEnd) || null;
              if (chainSub.hunterCid && !sub.hunterCid) {
                sub.hunterCid = chainSub.hunterCid;
              }
              if (chainSub.ethMaxBudget != null) {
                sub.ethMaxBudget = chainSub.ethMaxBudget.toString();
              }
              if (chainSub.submittedAt != null) {
                sub.submittedAt = Number(chainSub.submittedAt) || sub.submittedAt;
              }
              healedAny = true;
              logger.info('[jobs/details] read-side heal: updated submission from chain', {
                jobId, submissionId: sub.submissionId, newStatus: chainStatus,
                creatorWindowEnd: sub.creatorWindowEnd,
              });
            }
          }
          // Persist the heal so future reads don't need to re-check.
          if (healedAny) {
            try {
              await jobStorage.updateJob(job.jobId, { submissions: job.submissions });
            } catch (persistErr) {
              logger.warn('[jobs/details] read-side heal: persist failed (in-memory still healed)', {
                jobId, error: persistErr.message
              });
            }
          }
        } catch (healErr) {
          // Non-fatal: serve whatever we have rather than blocking the response.
          logger.warn('[jobs/details] read-side heal: outer error (serving stale)', {
            jobId, error: healErr.message
          });
        }
      }
    }

    let rubricContent = null;
    let extractedJuryNodes = job.juryNodes || [];

    if (req.query.includeRubric === 'true') {
      ({ rubricContent, juryNodes: extractedJuryNodes } = await loadJobRubric(job, req.app.locals.ipfsClient));
    }

    // Strip internal sync bookkeeping fields before sending to client.
    // Keep `syncedFromBlockchain` — the UI needs it to render the
    // "Pending on-chain" badge on bounties that haven't been confirmed yet.
    const { lastSyncedAt: _lsa, _chainFieldsHealed: _cfh, _metadataHealDone: _mhd, _metadataHealAttempts: _mha, _metadataHealNextAt: _mhn, ...jobForClient } = job;
    if (req.clientType === 'public') {
      delete jobForClient.createdByClientType;
      delete jobForClient.createdByClientId;
    }
    // Anonymous callers (no key: an AI juror following a link) also lose the
    // internal attribution of who submitted through which client, and the file
    // list of a bounty whose creator kept submissions private. Work CIDs stay:
    // they are public on-chain regardless.
    if (req.clientType === 'public' && Array.isArray(job.submissions)) {
      jobForClient.submissions = job.submissions.map(({ clientId: _ci, clientType: _ct, files, ...sub }) =>
        (job.publicSubmissions === true ? { ...sub, files } : sub));
    }
    const jobIdVal = job.jobId;
    return res.json({
      success: true,
      untrustedContent: untrustedContent(['job.title', 'job.description', 'job.workProductType', 'job.rubricContent',
        'job.submissions[].narrative', 'job.submissions[].files', 'job.validationStatus']),
      job: {
        ...jobForClient,
        rubricContent: rubricContent || null,
        juryNodes: extractedJuryNodes.length > 0 ? extractedJuryNodes : (job.juryNodes || [])
      },
      tips: [
        `Read the rubric carefully — 'must: true' criteria are gates`,
        `View rubric: GET /api/jobs/${jobIdVal}/rubric`,
        `Submit: POST /api/jobs/${jobIdVal}/submit`,
        `Check submissions: GET /api/jobs/${jobIdVal}/submissions`,
        `Evaluation package: GET /api/jobs/${jobIdVal}/evaluation-package`
      ]
    });

  } catch (error) {
    logger.error('[jobs/details] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${req.params.jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN',
        tips: ['Job IDs are 0-based — legacy 1-based URLs are auto-resolved']
      });
    }
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to get job',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  }
});

/* =================
   GET ON-CHAIN STATUS (Agent-friendly, trust-minimized)
   ================= */

/**
 * GET /api/jobs/:jobId/onchain-status
 *
 * IMPORTANT: the path param is the ON-CHAIN bountyId, not the API jobId. They
 * are equal for linked jobs (after PATCH /bountyId has reconciled the local
 * row), but differ during the drift window between /jobs/create and the link
 * step. If you are debugging a job in drift, call GET /api/jobs/lookup first
 * to discover the on-chain bountyId, then pass that here. The 404 response
 * for a missing bounty checks for a local API job at the same id and points
 * you at /lookup if it finds one.
 *
 * Returns a fresh on-chain snapshot of a bounty, with the server performing
 * the ABI decoding. An optional convenience for AI agents: the contract is the
 * source of truth and agents can make the same getBounty read themselves with
 * any ABI-aware library. What this endpoint saves them is hand-written raw-byte
 * decoding (a common source of off-by-one field offset bugs, since the tuple
 * contains a dynamic string).
 *
 * One getBounty RPC call, plus three small views in parallel (requiredPrepay,
 * prepareCutoff, effectiveOracleParams); status/effectiveStatus/canBeClosed are
 * derived locally from the struct to avoid extra round trips.
 *
 * Public: callers with no API key (e.g. an AI juror following a link) may read
 * it (see PUBLIC_READ_ROUTES in middleware/clientIdentification.js). They share
 * one snapshot per bounty for config.publicOnchainStatusCacheMs (default 30 s,
 * 200s and 404s only) and get Cache-Control: public, max-age=<ttl>. Keyed
 * callers always get a live read.
 *
 * Response shape:
 *   {
 *     bountyId: number,
 *     status: "OPEN" | "EXPIRED" | "AWARDED" | "CLOSED",  // effective status
 *     rawStatus: 0 | 1 | 2,                                // on-chain enum
 *     creator: "0x...",
 *     winner: "0x..." | null,
 *     payoutWei: string,                                   // still-escrowed ETH (0 once paid/refunded)
 *     payoutEth: string,                                   // human-readable
 *     bountyAmountWei: string,                             // funded amount; constant for life
 *     bountyAmount: string,                                // human-readable
 *     createdAt: number,                                   // unix seconds (block time of createBounty)
 *     createdAtIso: ISO-8601 string | null,
 *     submissionDeadline: number,                          // unix seconds
 *     submissionDeadlineIso: ISO-8601 string | null,
 *     deadlinePassed: boolean,
 *     submissionCount: number,
 *     isAcceptingSubmissions: boolean,
 *     canBeClosed: boolean,                                // approximate; contract
 *                                                         //   also checks pending subs
 *     targetHunter: "0x..." | null,
 *     evaluationCid: string,
 *     classId: number,
 *     threshold: number,
 *     creatorAssessmentWindowSize: number,
 *     creatorDeterminationPaymentEth: string,
 *     arbiterDeterminationPaymentEth: string,
 *     oracleSettings: {                                    // creator-chosen bounty.oracle, fixed at creation
 *       maxOracleFee: string,                              //   wei; per-arbiter fee ceiling (arbiters
 *       maxOracleFeeEth: string,                           //   priced above it are never selected)
 *       alpha: number,                                     //   0-1000
 *       estimatedBaseCost: string,                         //   wei
 *       estimatedBaseCostEth: string,
 *       maxFeeBasedScaling: number                         //   1-1000
 *     } | null,
 *     effectiveOracleSettings: { ...same keys } | null,    // effectiveOracleParams(bountyId): what a
 *                                                         //   start would forward now (clamped to the
 *                                                         //   aggregator's live fee ceiling); null if unreadable
 *     fetchedAt: ISO-8601 string,                          // when the chain was read
 *     cached: boolean                                      // true = shared anonymous snapshot
 *   }
 */
const PUBLIC_ONCHAIN_STATUS_TTL_MS = config.publicOnchainStatusCacheMs || 30000;
const publicOnchainStatusCache = createTtlCache({
  ttlMs: PUBLIC_ONCHAIN_STATUS_TTL_MS,
  // A missing bounty is cached too (so unknown ids are not an RPC amplifier); a
  // failed read is not.
  shouldCache: (r) => r.status === 200 || r.status === 404,
});

const isoFromUnix = (sec) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);

// normalizeOracleSettings() output (the job.oracleSettings keys, wei strings) plus
// decimal-ETH copies of the two fee amounts.
const oracleSettingsWithEth = (o) => (o ? {
  maxOracleFee: o.maxOracleFee,
  maxOracleFeeEth: ethers.formatEther(o.maxOracleFee),
  alpha: o.alpha,
  estimatedBaseCost: o.estimatedBaseCost,
  estimatedBaseCostEth: ethers.formatEther(o.estimatedBaseCost),
  maxFeeBasedScaling: o.maxFeeBasedScaling,
  minOracleFee: o.minOracleFee ?? '0',
  minOracleFeeEth: ethers.formatEther(o.minOracleFee ?? '0'),
  withBeacons: Boolean(o.withBeacons)
} : null);

router.get('/:jobId/onchain-status', async (req, res) => {
  const { jobId } = req.params;
  const bountyId = parseInt(jobId, 10);
  if (!Number.isInteger(bountyId) || bountyId < 0) {
    return res.status(400).json({ success: false, error: 'Invalid bountyId', details: `"${jobId}" is not a non-negative integer` });
  }

  if (req.clientType === 'public') {
    const { value, cached } = await publicOnchainStatusCache.get(bountyId, () => readOnchainStatus(bountyId));
    res.set('Cache-Control', `public, max-age=${Math.round(PUBLIC_ONCHAIN_STATUS_TTL_MS / 1000)}`);
    return res.status(value.status).json({ ...value.body, cached });
  }
  const { status, body } = await readOnchainStatus(bountyId);
  return res.status(status).json({ ...body, cached: false });
});

// One live onchain-status read. Never throws: resolves to { status, body }.
async function readOnchainStatus(bountyId) {
  try {
    logger.info('[jobs/onchain-status] get', { bountyId });
    const contractService = getContractService();
    const b = await contractService.getBounty(bountyId);

    const now = Math.floor(Date.now() / 1000);
    const deadline = Number(b.submissionCloseTime) || 0;

    // Re-derive rawStatus: contractService.getBounty returns effective-only.
    // Effective → raw mapping:
    //   OPEN or EXPIRED → rawStatus 0 (Open)
    //   AWARDED         → rawStatus 1
    //   CLOSED          → rawStatus 2
    const eff = String(b.status || '').toUpperCase();
    const rawStatus = eff === 'AWARDED' ? 1 : eff === 'CLOSED' ? 2 : 0;

    // Build a linkage report so agents can diagnose ID drift in one call.
    // We look up by the caller-supplied id; an evaluationCid match is the
    // strongest signal that local and on-chain are talking about the same
    // bounty, so we prefer that when the id-based row disagrees.
    let linkage;
    try {
      const storage = await jobStorage.readStorage();
      const byId = (storage.jobs || []).find(j => Number(j.jobId) === bountyId) || null;
      const byCid = b.evaluationCid
        ? (storage.jobs || []).find(j => j.evaluationCid === b.evaluationCid)
        : null;
      // Prefer the row that actually matches the on-chain bounty's evaluationCid.
      // If the id-based row has a different evaluationCid, that's drift — surface it.
      const localJob = byCid || byId;
      if (!localJob) {
        linkage = {
          state: 'untracked',
          onChain: true,
          syncedFromBlockchain: false,
          detail: `Bounty #${bountyId} exists on-chain but no local job tracks it. The sync service has not picked it up yet.`,
          fix: 'Call POST /api/jobs/sync/now to force a sync pass, or look up via GET /api/jobs/lookup?evaluationCid=... if you have the CID.'
        };
      } else {
        linkage = buildLinkageReport(localJob, { onChainBountyId: bountyId });
        if (byCid && byId && byCid !== byId) {
          linkage.idDriftWarning = `Local job at id ${bountyId} has a different evaluationCid than the on-chain bounty. The job that actually matches this bounty is at jobId ${byCid.jobId}. Route API calls through that id instead.`;
          linkage.correctJobId = byCid.jobId;
        }
      }
    } catch (linkErr) {
      linkage = { state: 'unknown', detail: `Linkage check failed: ${linkErr.message}` };
    }

    // Agent conveniences read straight from the contract's own views, in
    // parallel. Each is best-effort: a failed read is null, not a failed response.
    const c = contractService.contract;
    const [[requiredPrepay, prepareCutoff, startValue], effectiveOracleSettings] = await Promise.all([
      (async () => {
        try {
          return (await Promise.all([c.requiredPrepay(bountyId), c.prepareCutoff(bountyId), c.startValue(bountyId)])).map(v => v.toString());
        } catch (e) {
          logger.warn('[jobs/onchain-status] requiredPrepay/prepareCutoff/startValue read failed', { bountyId, msg: e.message });
          return [null, null, null];
        }
      })(),
      (async () => {
        try {
          return oracleSettingsWithEth(normalizeOracleSettings(await c.effectiveOracleParams(bountyId)));
        } catch (e) {
          logger.warn('[jobs/onchain-status] effectiveOracleParams read failed', { bountyId, msg: e.message });
          return null;
        }
      })()
    ]);

    return { status: 200, body: {
      success: true,
      bountyId,
      requiredPrepay,                            // wei: one round's prepay RIGHT NOW (attach to rerunSubmission; null if unreadable)
      startValue,                                // wei to attach at startPreparedSubmission RIGHT NOW: prepay + bond
      decisionSettings: b.decisionSettings,      // v2: jury, quota (Q), forfeitLine (R), bondWei
      prepareCutoff,                             // last unix second at which prepareSubmission can succeed (0 if not Open)
      status: eff,                               // OPEN | EXPIRED | AWARDED | CLOSED
      rawStatus,                                 // 0=Open, 1=Awarded, 2=Closed (enum)
      creator: b.creator,
      winner: b.winner,
      payoutWei: b.escrowWei,                    // live escrow: 0 once paid out or refunded
      payoutEth: ethers.formatEther(b.escrowWei),
      bountyAmountWei: b.bountyAmountWei,        // funded amount, unchanged by payout
      bountyAmount: b.bountyAmount,
      createdAt: b.createdAt,                    // unix seconds: block time of createBounty
      createdAtIso: isoFromUnix(b.createdAt),
      submissionDeadline: deadline,
      submissionDeadlineIso: isoFromUnix(deadline),
      deadlinePassed: deadline > 0 && now > deadline,
      submissionCount: b.submissionCount,
      isAcceptingSubmissions: b.isAcceptingSubmissions,
      canBeClosed: b.canBeClosed,                // local approximation; contract
                                                 //   also rejects if any submission
                                                 //   is still PendingVerdikta
      targetHunter: b.targetHunter,
      evaluationCid: b.evaluationCid,
      classId: b.classId,
      threshold: b.threshold,
      creatorAssessmentWindowSize: b.creatorAssessmentWindowSize,
      creatorDeterminationPaymentEth: b.creatorDeterminationPayment,
      arbiterDeterminationPaymentEth: b.arbiterDeterminationPayment,
      // bounty.oracle as created. maxOracleFee is the per-arbiter fee ceiling: a
      // bounty whose class has no arbiter priced at or below it can never be evaluated.
      oracleSettings: oracleSettingsWithEth(b.oracleSettings),
      effectiveOracleSettings,                   // effectiveOracleParams(bountyId): clamped to the
                                                 //   aggregator's live ceiling (null if unreadable)
      linkage,                                   // see buildLinkageReport — state is
                                                 //   linked | patched-not-synced |
                                                 //   not-on-chain | mismatch | untracked
      fetchedAt: new Date().toISOString(),
      note: 'Live read of the BountyEscrow contract, ABI-decoded server-side as a convenience. The contract itself is the source of truth: the same read can be made with any ABI-aware library and re-checked against it. If this disagrees with GET /api/jobs/:jobId the sync service has not yet observed the change; the live read wins.'
    } };
  } catch (err) {
    const msg = (err?.message || '').toLowerCase();
    if (msg.includes('bad bountyid') || msg.includes('badbountyid') || msg.includes('call_exception')) {
      // Check whether a local job exists at this id — if so, the caller is
      // probably hitting the drift case (API jobId != on-chain bountyId).
      let localJob = null;
      let identityHint = null;
      try {
        const storage = await jobStorage.readStorage();
        localJob = (storage.jobs || []).find(j => Number(j.jobId) === bountyId) || null;
      } catch (_) { /* non-fatal */ }

      if (localJob && !localJob.onChain && !localJob.syncedFromBlockchain) {
        identityHint = `A local API job #${bountyId} exists but is not linked to any on-chain bounty. The path param of /onchain-status is the on-chain bountyId — NOT the API jobId — and they only match after PATCH /bountyId reconciles them. To find the real on-chain bountyId for this job, call GET /api/jobs/lookup?txHash=<your-createBounty-tx> (or ?evaluationCid=${localJob.evaluationCid || '<your-cid>'}).`;
      } else if (!localJob) {
        identityHint = `No on-chain bounty #${bountyId} exists, and no local API job has that jobId either. Verify the id (the path param is the on-chain bountyId, which equals the API jobId only for linked jobs).`;
      } else {
        identityHint = `Local API job #${bountyId} exists and is marked on-chain, but the contract has no bounty at that id. This is a stale-link state — call GET /api/jobs/lookup?evaluationCid=${localJob.evaluationCid || '<cid>'} to find the correct on-chain id, or POST /api/jobs/sync/now to re-reconcile.`;
      }

      return { status: 404, body: {
        success: false,
        error: 'Bounty not found on current contract',
        details: `Bounty #${bountyId} does not exist on the active BountyEscrow contract. Note: this endpoint's path param is the on-chain bountyId, which differs from the API jobId when there is drift.`,
        fix: identityHint,
        localJobExists: !!localJob,
        localJobLinked: !!(localJob && (localJob.onChain || localJob.syncedFromBlockchain)),
        recoveryEndpoints: {
          lookup: '/api/jobs/lookup',
          forceSync: '/api/jobs/sync/now'
        }
      } };
    }
    logger.error('[jobs/onchain-status] fatal', { bountyId, msg: err.message });
    return { status: 500, body: { success: false, error: 'Failed to read on-chain status', details: err.message } };
  }
}

/**
 * The two records a mutual-wager check reads about a bounty, exactly as GET /:id/onchain-status
 * (`status`, null when the escrow has no such bounty) and GET /:id?includeRubric=true (`job`,
 * null when the site has no record) return them, plus `wagerPackage` for a wager: its on-chain
 * evaluation package checked against its terms. Throws when any of these cannot be read right now,
 * so a check fails closed instead of judging a bounty it could not see.
 */
async function readWagerRecords(bountyId, ipfsClient) {
  const { status, body } = await readOnchainStatus(bountyId);
  if (status === 404) return { status: null, job: null };
  if (status !== 200) throw new Error(body?.details || body?.error || `on-chain status read failed (${status})`);
  let job;
  try { job = await jobStorage.getJob(bountyId); } catch { return { status: body, job: null }; }
  const { lastSyncedAt: _lsa, _chainFieldsHealed: _cfh, _metadataHealDone: _mhd, _metadataHealAttempts: _mha, _metadataHealNextAt: _mhn, ...rest } = job;
  // A wager is checked against what its jury will read: the package named on chain, rebuilt from its
  // terms (utils/wagerPackage.js), with the rubric and jury that package attaches. Nothing from the site
  // record's rubric cache or loose rubricCid enters the check. It throws when either cannot be read now.
  if (looksLikeMutualWager(job.description)) {
    const pkg = await verifyWagerPackage({ evaluationCid: body.evaluationCid, description: job.description, ipfsClient });
    return { status: body, job: {
      ...rest,
      rubricContent: pkg.rubric ?? null,
      juryNodes: pkg.juryNodes ?? rest.juryNodes,
      iterations: pkg.iterations ?? rest.iterations,
      wagerPackage: { ok: pkg.ok, problems: pkg.problems, verifier: pkg.verifier, rubricCid: pkg.rubricCid ?? null },
    } };
  }
  const { rubricContent, juryNodes } = await loadJobRubric(job, ipfsClient);
  if (!rubricContent && (job.evaluationCid || job.rubricCid)) throw new Error(`its rubric could not be read from IPFS`);
  return { status: body, job: { ...rest, rubricContent, juryNodes } };
}

/** Linked bounties whose description carries a MUTUAL WAGER TERMS block and that pass `filter`. */
async function linkedWagerJobs(filter = () => true) {
  const storage = await jobStorage.readStorage();
  return (storage.jobs || []).filter((j) => isLinkedWagerJob(j) && filter(j));
}

/* =================
   GET JOB RUBRIC (Agent-friendly endpoint)
   ================= */

/**
 * GET /api/jobs/:jobId/rubric
 * Returns the rubric content directly (not wrapped in job object).
 * Designed for AI agents that need to understand evaluation criteria.
 *
 * Response includes:
 * - rubric: The full rubric JSON with criteria, weights, etc.
 * - meta: Job context (title, threshold, classId) for reference
 */
router.get('/:jobId/rubric', async (req, res) => {
  try {
    const { jobId } = req.params;
    logger.info('[jobs/rubric] get', { jobId });

    const job = await jobStorage.getJob(jobId);
    const ipfsClient = req.app.locals.ipfsClient;

    // Effective rubric pointer. `job.rubricCid` is only a convenience cache:
    // the chain-sync service never writes it, so bounties created directly
    // on-chain arrive here with it empty even though their rubric exists in
    // the (authoritative, immutable) evaluationCid package. When the cache is
    // empty, derive the pointer from the package — the same direction
    // scripts/healRubricCid.js repairs — and persist the heal so the next
    // read is pointer-direct. (A stored pointer is served as-is; wrong-value
    // drift remains the healer's offline job.)
    let rubricCid = job.rubricCid || null;
    if (!rubricCid && job.evaluationCid && ipfsClient) {
      rubricCid = await packageRubricHash(ipfsClient, job.evaluationCid);
      if (rubricCid) {
        logger.info('[jobs/rubric] derived rubricCid from evaluationCid package (cache was empty)', {
          jobId, rubricCid, evaluationCid: job.evaluationCid
        });
        try {
          await jobStorage.updateJob(job.jobId, { rubricCid });
        } catch (persistErr) {
          // Best-effort: a failed write just means the next read re-derives.
          logger.warn('[jobs/rubric] failed to persist healed rubricCid (still serving)', {
            jobId, error: persistErr.message
          });
        }
      }
    }

    if (!rubricCid) {
      return sendError(res, 404, {
        code: ErrorCodes.NOT_FOUND,
        message: 'No rubric available',
        details: `Bounty #${jobId} does not have a rubric CID`,
        fix: 'Try GET /api/jobs/:id/evaluation-package for the full evaluation details instead'
      });
    }

    if (!ipfsClient) {
      return sendError(res, 500, {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'IPFS client not available',
        details: 'Server IPFS client is not initialized',
        fix: 'Try again shortly or check server health: GET /health'
      });
    }

    let rubricContent;
    try {
      const rawContent = await withTimeout(
        ipfsClient.fetchFromIPFS(rubricCid),
        PIN_TIMEOUT_MS,
        'IPFS rubric fetch'
      );
      rubricContent = JSON.parse(rawContent);
    } catch (ipfsErr) {
      logger.error('[jobs/rubric] IPFS fetch failed', { jobId, cid: rubricCid, msg: ipfsErr.message });
      return sendError(res, 502, {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Failed to fetch rubric from IPFS',
        details: ipfsErr.message,
        fix: `You can try fetching directly from an IPFS gateway: https://ipfs.io/ipfs/${rubricCid}`,
        extra: { rubricCid }
      });
    }

    // Return rubric with useful job context
    return res.json({
      success: true,
      rubric: rubricContent,
      meta: {
        jobId: job.jobId,
        title: job.title,
        description: job.description,
        workProductType: job.workProductType,
        threshold: job.threshold,
        classId: job.classId,
        rubricCid,
        submissionCloseTime: job.submissionCloseTime,
        status: job.status
      }
    });

  } catch (error) {
    logger.error('[jobs/rubric] error', { msg: error.message });
    if (error.message.includes('not found')) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${req.params.jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to get rubric',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  }
});

/* ==============
   SUBMIT WORK
   ============== */

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_BASE),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}-${file.originalname}`)
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => isValidFileType(file.mimetype, file.originalname)
    ? cb(null, true)
    : cb(new Error(`Invalid file type: ${file.mimetype} for file ${file.originalname}. Allowed: code files (.py, .sol, .cpp, .js, etc.), documents (.txt, .md, .pdf, .docx), images (.jpg, .png), and data files (.json, .xml, .yaml, .csv)`)),
  limits: { fileSize: MAX_FILE_SIZE, files: 10 }
}).array('files', 10);

/**
 * Translate a multer upload error (wrong field name, too many files, oversized
 * file, rejected type) into a 400 with a fix hint. These are client mistakes;
 * without this they fell through to the generic 500 INTERNAL_ERROR and agents
 * read "check server health" as a site outage.
 * @returns {boolean} true if the error was an upload-shape error and a response was sent
 */
function sendUploadError(res, error) {
  const maxMB = MAX_FILE_SIZE / (1024 * 1024);
  let details, fix;
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_UNEXPECTED_FILE':
        details = `Unexpected multipart field "${error.field || '?'}". Files must be sent under the field name "files".`;
        fix = 'Use the field name "files" for every attachment (repeat it for multiple files): curl -F "files=@a.txt" -F "files=@b.md" -F "hunter=0x..."';
        break;
      case 'LIMIT_FILE_COUNT':
        details = 'More than 10 files were attached.';
        fix = 'Attach at most 10 files per submission; combine small files or drop non-essential ones.';
        break;
      case 'LIMIT_FILE_SIZE':
        details = `A file exceeds the ${maxMB}MB per-file limit.`;
        fix = `Reduce the file below ${maxMB}MB or split it into smaller files (10 files max).`;
        break;
      default:
        details = error.message;
        fix = 'Send a multipart/form-data body with attachments under the field name "files" and the hunter address under "hunter".';
    }
  } else if (typeof error?.message === 'string' && error.message.startsWith('Invalid file type')) {
    details = error.message;
    fix = 'Submit readable files (text/code/markdown, PDF, .docx, images, JSON/CSV). Do not attach archives or executables.';
  } else if (isMalformedMultipart(error)) {
    // busboy's own parse failures. "Multipart: Boundary not found" used to fall
    // through to the routes' `includes('not found')` check and come back as a
    // 404 BOUNTY_NOT_FOUND for a bounty that exists.
    details = `The multipart body could not be read: ${error.message}`;
    fix = 'Send a well-formed multipart/form-data body (let your HTTP client set the Content-Type with its boundary): files under "files", the wallet under "hunter".';
  } else {
    return false;
  }
  sendError(res, 400, {
    code: ErrorCodes.SUBMISSION_BAD_UPLOAD,
    message: 'Upload rejected',
    details,
    fix
  });
  return true;
}

/** busboy parse failures on a malformed multipart body — client mistakes, never a server fault. */
function isMalformedMultipart(error) {
  const msg = typeof error?.message === 'string' ? error.message : '';
  return /^Multipart: |Unexpected end of (?:form|multipart data)|Malformed part header|Malformed urlencoded form/.test(msg);
}

/**
 * Flag work-product files the oracle would silently skip (archives/binaries),
 * which yields a score of 0 with no upload-time error. Checks extension + mimetype,
 * then sniffs leading bytes to catch renamed/generic-mimetype archives (e.g. a .zip
 * sent as application/octet-stream — the exact gap that lets it past isValidFileType).
 * @param {Array<{path:string, originalname:string, mimetype:string}>} files
 * @returns {Promise<string[]>} human-readable reasons (empty if all evaluable)
 */
async function findOracleUnreadableFiles(files) {
  const problems = [];
  for (const f of files || []) {
    const reason = oracleUnreadableReason(f.mimetype, f.originalname);
    if (reason) { problems.push(reason); continue; }
    // Content sniff for renamed/generic-mimetype archives.
    const ext = '.' + (f.originalname || '').toLowerCase().split('.').pop();
    let fh;
    try {
      fh = await fs.open(f.path, 'r');
      const buf = Buffer.alloc(8);
      await fh.read(buf, 0, 8, 0);
      const container = detectBinaryContainer(buf);
      if (container && !(container === 'ZIP archive' && ALLOWED_ZIP_BASED_EXTENSIONS.includes(ext))) {
        problems.push(`${f.originalname} is actually a ${container} (detected by content) — the oracle skips it and evaluates no content (score 0)`);
      }
    } catch { /* head unreadable — other checks cover it */ } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }
  return problems;
}

/**
 * Names of any 0-byte attachments. An empty file means the oracle sees no content
 * for it → must-pass-override → score 0, with no error today. This is the reported
 * silent failure: a fiddly multipart client uploads an empty body and the API still
 * returns a CID.
 * @param {Array<{originalname?:string, size?:number}>} files
 * @returns {string[]}
 */
function emptyFileNames(files) {
  return (files || []).filter(f => !f || !f.size).map(f => (f && f.originalname) || '(unnamed)');
}

/**
 * Confirm the archive we're about to pin is non-empty. We check the LOCAL archive byte
 * size rather than reading the CID back from a gateway: a post-pin IPFS readback proved
 * unreliable (a freshly-pinned binary archive can take >20s to propagate to public
 * gateways, adding latency and false negatives). Because CIDs are content-addressed, a
 * non-empty local archive guarantees non-empty pinned content. Returns bytes on disk.
 * @param {string} archivePath
 * @returns {Promise<number>} archive size in bytes (0 if missing/empty/unstattable)
 */
async function pinnedArchiveSize(archivePath) {
  try {
    const { size } = await fs.stat(archivePath);
    return size || 0;
  } catch {
    return 0;
  }
}

/**
 * The error body for a built submission archive larger than the arbiters download
 * (archiveShapeValidator.MAX_ARCHIVE_BYTES), or null. Such an archive fails every honest
 * arbiter's fetch: no commit, so the submission is never evaluated, and honest jurors are
 * charged the no-commit penalty whenever another slot commits. Refused before pinning.
 */
function oversizedArchiveError(archiveSize) {
  const max = archiveShapeValidator.MAX_ARCHIVE_BYTES;
  if (archiveSize <= max) return null;
  return {
    code: ErrorCodes.PAYLOAD_TOO_LARGE,
    message: 'Submission archive is larger than arbiters download',
    details: `The work product archive is ${archiveSize} bytes; arbiters download at most ${max} bytes of a submission and could not evaluate it.`,
    fix: `Keep the files under ${Math.floor(max / (1024 * 1024))} MiB in total (they are zipped as sent). Use POST /api/jobs/:id/submit/dry-run to pre-check.`
  };
}


/**
 * POST /api/jobs/:jobId/submit/dry-run
 *
 * Validates a submission against bounty requirements WITHOUT submitting on-chain.
 * Read-only — nothing is written to IPFS, database, or blockchain.
 * Agents can test their work before paying gas + the ETH evaluation prepay.
 *
 * Request: same multipart/form-data as regular submit (files + hunter).
 * Response: { valid, checks[], errors[], warnings[], nextStep, estimatedCost }
 */
router.post('/:jobId/submit/dry-run', async (req, res) => {
  let uploadedFiles = [];
  try {
    await ensureTmpBase();
    await new Promise((resolve, reject) => upload(req, res, (err) => err ? reject(err) : resolve()));
    uploadedFiles = req.files || [];

    const { jobId } = req.params;
    const hunter = req.body.hunter;
    const checks = [];
    const errors = [];
    const warnings = [];

    // ---- 1. files_present ----
    if (uploadedFiles.length === 0) {
      checks.push({ name: 'files_present', passed: false, details: 'No files uploaded' });
      errors.push({
        code: 'SUBMISSION_NO_FILES',
        message: 'No files provided',
        fix: 'Include files in multipart form: curl -F "files=@solution.txt" -F "hunter=0x..."'
      });
    } else {
      const fileList = uploadedFiles.map(f => `${f.originalname} (${(f.size / 1024).toFixed(1)}KB)`).join(', ');
      checks.push({ name: 'files_present', passed: true, details: `${uploadedFiles.length} file${uploadedFiles.length > 1 ? 's' : ''} uploaded: ${fileList}` });
    }

    // ---- 2. file_size ----
    const totalSize = uploadedFiles.reduce((s, f) => s + f.size, 0);
    const maxSizeMB = MAX_FILE_SIZE / (1024 * 1024);
    if (totalSize > MAX_FILE_SIZE) {
      checks.push({ name: 'file_size', passed: false, details: `Total size ${(totalSize / (1024 * 1024)).toFixed(1)}MB exceeds ${maxSizeMB}MB limit` });
      errors.push({
        code: 'SUBMISSION_FILE_TOO_LARGE',
        message: `Total file size exceeds ${maxSizeMB}MB limit`,
        fix: 'Reduce file size or split into multiple smaller files'
      });
    } else {
      checks.push({ name: 'file_size', passed: true, details: `Total size ${(totalSize / 1024).toFixed(1)}KB is under ${maxSizeMB}MB limit` });
    }

    // ---- 2b. non_empty (0-byte files are silently skipped by the oracle → score 0) ----
    const emptyNames = emptyFileNames(uploadedFiles);
    if (emptyNames.length > 0) {
      checks.push({ name: 'non_empty', passed: false, details: `${emptyNames.join(', ')} ${emptyNames.length > 1 ? 'are' : 'is'} 0 bytes` });
      errors.push({
        code: 'SUBMISSION_EMPTY_FILE',
        message: 'One or more attachments are empty (0 bytes)',
        details: `${emptyNames.join(', ')} — the oracle would see no content and score the submission 0.`,
        fix: 'Re-create the file(s) with content. An empty file usually means a multipart upload didn\'t attach the body (curl -F "files=@path" is reliable).'
      });
    } else if (uploadedFiles.length > 0) {
      checks.push({ name: 'non_empty', passed: true, details: 'All attachments have content' });
    }

    // ---- 3. file_type / file_readable ----
    for (const f of uploadedFiles) {
      const ext = f.originalname.toLowerCase().split('.').pop();
      const textExts = ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'py', 'js', 'ts', 'jsx', 'tsx',
        'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'go', 'rs', 'php', 'sol', 'html', 'css', 'sh', 'sql',
        'toml', 'bat', 'ps1', 'swift', 'kt', 'r', 'm', 'scss', 'sass'];
      if (textExts.includes(ext)) {
        // (0-byte files are caught by the non_empty check above.)
        try {
          await fs.readFile(f.path, 'utf8');
        } catch {
          warnings.push(`File "${f.originalname}" could not be read as UTF-8 text — may be binary`);
        }
      } else if (['pdf', 'docx', 'jpg', 'jpeg', 'png', 'bmp'].includes(ext)) {
        // Binary formats — valid but note it
      } else {
        warnings.push(`File "${f.originalname}" has extension .${ext} — verify this is the intended format`);
      }
    }
    if (uploadedFiles.length > 0) {
      checks.push({ name: 'file_readable', passed: true, details: 'File content is accessible' });
    }

    // ---- 3b. oracle_readable (archives/binaries are silently skipped → score 0) ----
    if (uploadedFiles.length > 0) {
      const unreadable = await findOracleUnreadableFiles(uploadedFiles);
      if (unreadable.length > 0) {
        checks.push({ name: 'oracle_readable', passed: false, details: unreadable.join('; ') });
        errors.push({
          code: 'SUBMISSION_ORACLE_UNREADABLE',
          message: 'One or more attachments are archives/binaries the oracle cannot read',
          details: unreadable.join('; '),
          fix: 'Submit the work as readable files (text/code/markdown, PDF, .docx, or images). Do NOT zip or archive the deliverable — the oracle skips archive/binary attachments and scores the submission 0. Unpack the contents and attach the individual files instead.'
        });
      } else {
        checks.push({ name: 'oracle_readable', passed: true, details: 'All attachments are in oracle-readable formats' });
      }

      // ---- 3c. image_size (oversized images fail every jury model → ORACLE_TIMEOUT) ----
      const oversized = await findOversizedImages(uploadedFiles);
      if (oversized.length > 0) {
        checks.push({ name: 'image_size', passed: false, details: oversized.join('; ') });
        errors.push({
          code: 'SUBMISSION_IMAGE_TOO_LARGE',
          message: 'One or more images are too large for the AI models to read',
          details: oversized.join('; '),
          fix: OVERSIZED_IMAGE_FIX
        });
      } else {
        checks.push({ name: 'image_size', passed: true, details: 'All images are within the AI models\' size limits' });
      }
    }

    // ---- 4. hunter_address ----
    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      checks.push({ name: 'hunter_address', passed: false, details: `"${hunter || ''}" is not a valid Ethereum address` });
      errors.push({
        code: 'SUBMISSION_INVALID_HUNTER',
        message: 'Invalid hunter address',
        fix: 'Provide a valid 0x-prefixed Ethereum address (42 characters)'
      });
    } else {
      checks.push({ name: 'hunter_address', passed: true, details: 'Valid Ethereum address' });
    }

    // ---- 5. bounty_open ----
    let job;
    try {
      job = await jobStorage.getJob(jobId);
    } catch (e) {
      const numId = parseInt(jobId);
      if (numId > 0) {
        try { job = await jobStorage.getJob(numId - 1); } catch {}
      }
    }

    if (!job) {
      checks.push({ name: 'bounty_open', passed: false, details: `No bounty found with ID ${jobId}` });
      errors.push({
        code: 'BOUNTY_NOT_FOUND',
        message: 'Bounty not found',
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    } else {
      const nowSec = Math.floor(Date.now() / 1000);
      const remainingSec = (job.submissionCloseTime || 0) - nowSec;
      const hoursLeft = remainingSec > 0 ? Math.round(remainingSec / 360) / 10 : 0;
      const deadline = job.submissionCloseTime ? new Date(job.submissionCloseTime * 1000).toISOString() : 'unknown';

      if (job.status !== 'OPEN') {
        checks.push({ name: 'bounty_open', passed: false, details: `Bounty #${job.jobId} status is ${job.status}` });
        errors.push({
          code: job.status === 'EXPIRED' ? 'BOUNTY_EXPIRED' : 'BOUNTY_CLOSED',
          message: job.status === 'EXPIRED'
            ? 'This bounty is no longer accepting submissions'
            : `This bounty has been ${job.status.toLowerCase()}`,
          fix: 'Check open bounties with GET /api/jobs?status=OPEN'
        });
      } else if (remainingSec <= 0) {
        checks.push({ name: 'bounty_open', passed: false, details: `Bounty #${job.jobId} deadline was ${deadline}` });
        errors.push({
          code: 'BOUNTY_EXPIRED',
          message: 'Submission deadline has passed',
          fix: 'Check open bounties with GET /api/jobs?status=OPEN'
        });
      } else {
        checks.push({ name: 'bounty_open', passed: true, details: `Bounty #${job.jobId} is open with ${hoursLeft}h remaining (deadline: ${deadline})` });
      }

      // ---- 6. prior_submissions (informational only — resubmission is allowed) ----
      // The contract permits any address to submit repeatedly to the same bounty, including
      // after a prior rejection (no prepare cap on non-windowed bounties; windowed bounties cap prepares at
      // MAX_SUBMISSIONS_PER_BOUNTY = 128; every bounty caps concurrent evaluations at 256). We surface prior submissions as a warning so the
      // hunter is aware (and to discourage redundant evaluation costs while a prior submission
      // is still pending), but we never block the dry-run on this.
      if (job && hunter && /^0x[a-fA-F0-9]{40}$/.test(hunter)) {
        const priors = (job.submissions || []).filter(s =>
          (s.hunter || '').toLowerCase() === hunter.toLowerCase()
        );
        if (priors.length > 0) {
          const summary = priors.map(s => `#${s.submissionId} (${(s.status || 'unknown').toUpperCase()})`).join(', ');
          const pending = priors.filter(s => {
            const st = (s.status || '').toUpperCase();
            return st === 'PREPARED' || st === 'PENDING_EVALUATION' || st === 'PENDINGCREATORAPPROVAL' ||
                   st === 'ACCEPTED_PENDING_CLAIM' || st === 'REJECTED_PENDING_FINALIZATION';
          });
          checks.push({
            name: 'prior_submissions',
            passed: true,
            details: `${priors.length} prior submission(s) from this hunter: ${summary}`
          });
          if (pending.length > 0) {
            warnings.push(
              `You have ${pending.length} unresolved prior submission(s) to this bounty. Resubmission is allowed, but each submission costs an ETH evaluation prepay (usually spent in full) plus gas — consider waiting for the pending one(s) to resolve first.`
            );
          }
        } else {
          checks.push({ name: 'prior_submissions', passed: true, details: 'No prior submissions from this hunter' });
        }
      }

      // ---- 7. hunter_not_creator (warning only, not enforced) ----
      if (job && hunter && /^0x[a-fA-F0-9]{40}$/.test(hunter)) {
        if (job.creator && hunter.toLowerCase() === job.creator.toLowerCase()) {
          checks.push({ name: 'hunter_not_creator', passed: true, details: 'Hunter address matches the bounty creator (allowed)' });
        } else {
          checks.push({ name: 'hunter_not_creator', passed: true, details: 'Hunter is not the bounty creator' });
        }
      }

      // ---- 8. rubric_basic_check (best effort) ----
      if (job && uploadedFiles.length > 0) {
        try {
          // Read text content from uploaded files
          let combinedText = '';
          for (const f of uploadedFiles) {
            const ext = f.originalname.toLowerCase().split('.').pop();
            const textExts = ['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'py', 'js', 'ts',
              'jsx', 'tsx', 'java', 'c', 'cpp', 'sol', 'html', 'css', 'sh', 'sql', 'go', 'rs', 'rb', 'php'];
            if (textExts.includes(ext)) {
              try {
                combinedText += await fs.readFile(f.path, 'utf8') + '\n';
              } catch { /* skip unreadable */ }
            }
          }

          const wordCount = combinedText.trim().split(/\s+/).filter(Boolean).length;

          // Try to fetch rubric for deeper checks
          let rubric = null;
          if (job.rubricCid) {
            try {
              const ipfsClient = req.app.locals.ipfsClient;
              if (ipfsClient) {
                const raw = await withTimeout(ipfsClient.fetchFromIPFS(job.rubricCid), PIN_TIMEOUT_MS, 'rubric fetch');
                rubric = JSON.parse(raw);
              }
            } catch { /* rubric fetch is best-effort */ }
          }

          if (combinedText.trim().length === 0 && uploadedFiles.some(f => {
            const ext = f.originalname.toLowerCase().split('.').pop();
            return !['pdf', 'docx', 'jpg', 'jpeg', 'png', 'bmp'].includes(ext);
          })) {
            warnings.push('Submission text content appears empty. Ensure your files contain the expected work product.');
          } else if (wordCount > 0 && wordCount < 50) {
            warnings.push(`Your submission is ${wordCount} words. If the task expects depth, consider expanding.`);
          }

          if (rubric) {
            const criteria = rubric.criteria || rubric.rubricJson?.criteria || [];
            const mustCriteria = criteria.filter(c => c.must === true);

            // Check for required criteria keywords
            const textLower = combinedText.toLowerCase();
            for (const criterion of mustCriteria) {
              const desc = (criterion.description || '').toLowerCase();
              // Check for common keywords that suggest required content
              if (desc.includes('source') || desc.includes('citation') || desc.includes('reference')) {
                const hasCitations = /\b(http|https|doi|ref|source|citation|bibliography|\[\d+\])/i.test(combinedText);
                if (!hasCitations) {
                  warnings.push(`Rubric criterion "${criterion.id}" (required) mentions sources/citations. Make sure you included them.`);
                }
              }
              if (desc.includes('original') || desc.includes('plagiari')) {
                // Can't check plagiarism, but can note it
                warnings.push(`Rubric criterion "${criterion.id}" requires originality — ensure your work is original.`);
              }
            }

            // Check deliverable requirements if present
            const delivReqs = rubric.deliverable_requirements || rubric.rubricJson?.deliverable_requirements;
            if (delivReqs) {
              if (delivReqs.min_words && wordCount > 0 && wordCount < delivReqs.min_words) {
                warnings.push(`Rubric requires minimum ${delivReqs.min_words} words. Your submission has ${wordCount} words.`);
              }
              if (delivReqs.format && Array.isArray(delivReqs.format)) {
                const fileExts = uploadedFiles.map(f => f.originalname.toLowerCase().split('.').pop());
                const expectedFormats = delivReqs.format.map(f => f.toLowerCase());
                const hasMatch = fileExts.some(ext => expectedFormats.some(fmt =>
                  ext === fmt || (fmt === 'markdown' && ext === 'md') || (fmt === 'text' && ext === 'txt')
                ));
                if (!hasMatch) {
                  warnings.push(`Rubric expects format: ${delivReqs.format.join(' or ')}. Your files: ${fileExts.join(', ')}`);
                }
              }
            }

            checks.push({ name: 'rubric_basic_check', passed: true, details: `Checked against ${criteria.length} rubric criteria (${mustCriteria.length} required). See warnings for details.` });
          } else {
            checks.push({ name: 'rubric_basic_check', passed: true, details: 'Basic content check passed (rubric not available for deep check)' });
          }
        } catch (rubricErr) {
          checks.push({ name: 'rubric_basic_check', passed: true, details: 'Rubric check skipped (could not parse)' });
        }
      }
    }

    // ---- Build response ----
    const valid = errors.length === 0;
    const response = {
      success: true,
      valid,
      message: valid
        ? 'Submission looks good and is ready to submit'
        : `Submission has ${errors.length} issue${errors.length > 1 ? 's' : ''} that need${errors.length === 1 ? 's' : ''} to be fixed`,
      checks,
    };

    if (errors.length > 0) response.errors = errors;
    if (warnings.length > 0) response.warnings = warnings;

    if (valid && job) {
      response.nextStep = `Ready to submit. Use POST /api/jobs/${job.jobId}/submit with the same files, or POST /api/jobs/${job.jobId}/submit/bundle for pre-encoded transactions.`;
      response.estimatedCost = {
        gasEth: '~0.005 (gas for the on-chain transactions)',
        oraclePrepayEth: 'requiredPrepay(bountyId), attached with the hunter bond as msg.value on start (startValue); the unspent part of the prepay is refunded when the round resolves, and the bond comes back unless a hard fail forfeits it — both depend on the bounty\'s settings',
        note: `ETH-funded — there is no LINK. GET /api/jobs/${job.jobId}/onchain-status returns requiredPrepay and startValue live; GET /api/jobs/${job.jobId}/estimate-fee breaks the prepay down.`
      };
    } else {
      response.nextStep = 'Fix the errors above and try dry-run again';
    }

    if (job) {
      const nowSec = Math.floor(Date.now() / 1000);
      const remainingSec = (job.submissionCloseTime || 0) - nowSec;
      const hoursLeft = remainingSec > 0 ? Math.round(remainingSec / 360) / 10 : 0;
      response.bounty = {
        jobId: job.jobId,
        title: job.title,
        threshold: job.threshold,
        deadline: job.submissionCloseTime ? new Date(job.submissionCloseTime * 1000).toISOString() : null,
        hoursLeft
      };
    }

    return res.json(response);

  } catch (error) {
    logger.error('[jobs/submit/dry-run] error', { msg: error.message });
    if (sendUploadError(res, error)) return;
    if (error.message.includes('not found')) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${req.params.jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Dry-run validation failed',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  } finally {
    for (const f of uploadedFiles) {
      if (f?.path) await fs.unlink(f.path).catch(() => {});
    }
  }
});

router.post('/:jobId/submit', limitPins, async (req, res) => {
  let uploadedFiles = [];
  try {
    await new Promise((resolve, reject) => upload(req, res, (err) => err ? reject(err) : resolve()));

    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_NO_FILES,
        message: 'No files provided',
        details: 'Submission requires at least one file',
        fix: 'Include files in multipart form, for example: curl -F "files=@solution.txt" -F "hunter=0x..." /api/jobs/:id/submit',
        tips: [
          'Content-Type must be multipart/form-data',
          'hunter must be a valid Ethereum address (0x...)'
        ]
      });
    }
    uploadedFiles = req.files;

    const { jobId } = req.params;
    const { hunter, submissionNarrative } = req.body;

    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_INVALID_HUNTER,
        message: 'Invalid hunter address',
        details: `"${hunter || ''}" is not a valid Ethereum address`,
        fix: 'Provide a valid 0x-prefixed Ethereum address (42 characters total)',
        tips: ['Example: 0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18']
      });
    }

    if (submissionNarrative) {
      const wordCount = submissionNarrative.trim().split(/\s+/).length;
      if (wordCount > 200) {
        return sendError(res, 400, {
          code: ErrorCodes.SUBMISSION_NARRATIVE_LONG,
          message: 'Submission narrative too long',
          details: `Narrative is ${wordCount} words. Maximum allowed is 200 words.`,
          fix: 'Shorten your submissionNarrative to 200 words or fewer'
        });
      }
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    if (await rejectIfJuryUnrunnable(res, job, jobId)) return;
    if (job.status !== 'OPEN') {
      const codeMap = { EXPIRED: ErrorCodes.BOUNTY_EXPIRED, AWARDED: ErrorCodes.BOUNTY_CLOSED, CLOSED: ErrorCodes.BOUNTY_CLOSED };
      return sendError(res, 400, {
        code: codeMap[job.status] || ErrorCodes.BOUNTY_NOT_OPEN,
        message: job.status === 'EXPIRED'
          ? 'This bounty is no longer accepting submissions'
          : job.status === 'AWARDED' || job.status === 'CLOSED'
            ? 'This bounty has been closed'
            : `Bounty is not open (status: ${job.status})`,
        details: `Bounty #${jobId} status is ${job.status}${job.submissionCloseTime ? '. Deadline was ' + new Date(job.submissionCloseTime * 1000).toISOString() : ''}`,
        fix: 'Check open bounties with GET /api/jobs?status=OPEN'
      });
    }
    const now = Math.floor(Date.now()/1000);
    if (now < job.submissionOpenTime || now > job.submissionCloseTime) {
      const deadline = job.submissionCloseTime ? new Date(job.submissionCloseTime * 1000).toISOString() : 'unknown';
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_WINDOW_CLOSED,
        message: 'Submission window closed',
        details: `Bounty #${jobId} deadline was ${deadline}`,
        fix: 'Check open bounties with GET /api/jobs?status=OPEN'
      });
    }

    if (await rejectIfUnevaluable(job, req, res, jobId)) return;

    // Reject 0-byte attachments BEFORE pinning — an empty file means the oracle sees
    // no content and scores 0, but the upload would otherwise "succeed" silently.
    const emptyNames = emptyFileNames(uploadedFiles);
    if (emptyNames.length > 0) {
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_EMPTY_FILE,
        message: 'Empty attachment in submission',
        details: `${emptyNames.join(', ')} ${emptyNames.length > 1 ? 'are' : 'is'} 0 bytes — the oracle would see no content and score the submission 0. This usually means a multipart upload didn't attach the file body.`,
        fix: 'Re-upload with non-empty content. With a programmatic multipart client, verify the file stream is attached (curl -F "files=@path" is reliable). Pre-check with POST /api/jobs/:id/submit/dry-run.'
      });
    }

    // Reject archive/binary attachments BEFORE pinning to IPFS — the oracle silently
    // skips them, scoring the submission 0, and the ETH prepay would be wasted.
    const unreadable = await findOracleUnreadableFiles(uploadedFiles);
    if (unreadable.length > 0) {
      return sendError(res, 400, {
        code: ErrorCodes.VALIDATION_INVALID_FORMAT,
        message: 'Attachment is an archive/binary the oracle cannot read',
        details: unreadable.join('; '),
        fix: 'Do NOT zip or archive the deliverable — the oracle skips archive/binary attachments and scores the submission 0. Submit readable files (text/code/markdown, PDF, .docx, images); unpack archives and attach the individual files. Use POST /api/jobs/:id/submit/dry-run to pre-check.'
      });
    }
    const oversized = await findOversizedImages(uploadedFiles);
    if (oversized.length > 0) {
      return sendError(res, 400, {
        code: ErrorCodes.VALIDATION_INVALID_FORMAT,
        message: 'Image is too large for the AI models to read',
        details: oversized.join('; '),
        fix: `${OVERSIZED_IMAGE_FIX} Use POST /api/jobs/:id/submit/dry-run to pre-check.`
      });
    }

    const fileDescriptions = (() => {
      try { return req.body.fileDescriptions ? JSON.parse(req.body.fileDescriptions) : {}; }
      catch { return {}; }
    })();

    const workProducts = uploadedFiles.map(f => ({
      path: f.path,
      name: f.originalname,
      type: f.mimetype,
      description: fileDescriptions[f.originalname] || `Work product file: ${f.originalname}`
    }));

    const hunterArchive = await archiveGenerator.createHunterSubmissionCIDArchive({
      workProducts,
      submissionNarrative: submissionNarrative || undefined
    });

    // Confirm the archive is non-empty (locally, before pinning) — catches a silent
    // empty/corrupt archive without the latency/false-negatives of a post-pin gateway
    // readback. CID is content-addressed, so non-empty archive ⟹ non-empty pinned content.
    const archiveSize = await pinnedArchiveSize(hunterArchive.archivePath);
    const tooLarge = oversizedArchiveError(archiveSize);
    if (tooLarge) {
      await fs.unlink(hunterArchive.archivePath).catch(() => {});
      return sendError(res, 413, tooLarge);
    }

    const ipfsClient = req.app.locals.ipfsClient;
    let hunterCid;
    try {
      hunterCid = await ipfsClient.uploadToIPFS(hunterArchive.archivePath);
      logger.info('[jobs/submit] hunter submission pinned', { hunterCid, fileCount: uploadedFiles.length, archiveSize });
    } finally {
      await fs.unlink(hunterArchive.archivePath).catch(err =>
        logger.warn('[jobs/submit] failed to clean hunter archive', { msg: err.message })
      );
    }

    if (archiveSize === 0) {
      return sendError(res, 502, {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Built submission archive is empty',
        details: `The work product archive for ${hunterCid} came out empty (0 bytes) — it was not stored correctly.`,
        fix: 'Re-submit. Verify your files have content; if this persists, the IPFS/archive pipeline may be failing.'
      });
    }
    const hunterCidVerified = archiveSize > 0;

    // Note: We no longer create an "updated primary" archive at submission time.
    // The evaluation package (evaluationCid) was created at bounty creation and is stored in the contract.
    // The hunterCid is passed to startPreparedSubmission() and sent to Verdikta along with
    // the bounty's evaluationCid (which the contract retrieves from storage).

    // NOTE: We do NOT create the submission record here anymore.
    // The submission record is created by POST /api/jobs/:jobId/submissions/confirm
    // AFTER the on-chain prepareSubmission transaction succeeds.
    // This prevents orphaned "Prepared" submissions when on-chain tx fails.

    return res.json({
      success: true,
      message: 'Files uploaded to IPFS successfully! Call /submissions/confirm after on-chain prepareSubmission succeeds.',
      // Top-level alias of submission.hunterCid. The nested copy is the historical
      // shape and stays; callers kept reading a top-level `hunterCid` off this
      // response, getting undefined, and carrying that into /submit/prepare.
      hunterCid,
      submission: {
        hunter,
        hunterCid,
        // True once the pinned archive is confirmed non-empty (verified locally before pinning).
        hunterCidVerified,
        // Note: evaluationCid is stored in the bounty on-chain (job.evaluationCid)
        fileCount: uploadedFiles.length,
        files: uploadedFiles.map(f => ({ filename: f.originalname, size: f.size, description: fileDescriptions[f.originalname] })),
        totalSize: uploadedFiles.reduce((s, f) => s + f.size, 0)
      },
      tips: [
        'Next: call prepareSubmission on-chain, then POST /api/jobs/:id/submissions/confirm',
        `Check submission status: GET /api/jobs/${jobId}/submissions`
      ]
    });

  } catch (error) {
    logger.error('[jobs/submit] error', { msg: error.message });
    if (sendUploadError(res, error)) return;
    if (error.message.includes('not found')) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${req.params.jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to submit work',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  } finally {
    for (const f of uploadedFiles) {
      if (f?.path) await fs.unlink(f.path).catch(err =>
        logger.warn('[jobs/submit] failed to clean tmp file', { msg: err.message })
      );
    }
  }
});

/* ==========================================
   CONFIRM SUBMISSION (after on-chain success)
   ========================================== */

/**
 * Create the backend submission record AFTER on-chain prepareSubmission succeeds.
 * This prevents orphaned "Prepared" submissions when on-chain tx fails.
 */
// Time allowed for /submissions/confirm's non-blocking archive shape check.
const CONFIRM_SHAPE_CHECK_BUDGET_MS = 15000;

router.post('/:jobId/submissions/confirm', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { submissionId, hunter, hunterCid, evalWallet, fileCount, files } = req.body;

    if (submissionId === undefined || submissionId === null) {
      return sendError(res, 400, {
        code: ErrorCodes.VALIDATION_MISSING_FIELD,
        message: 'Required field missing: submissionId',
        details: 'submissionId from on-chain SubmissionPrepared event is required',
        fix: 'Parse the SubmissionPrepared event from the prepareSubmission tx receipt to get the submissionId'
      });
    }
    if (!hunter || !/^0x[a-fA-F0-9]{40}$/.test(hunter)) {
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_INVALID_HUNTER,
        message: 'Invalid hunter address',
        details: `"${hunter || ''}" is not a valid Ethereum address`,
        fix: 'Provide a valid 0x-prefixed Ethereum address (42 characters total)'
      });
    }
    if (!hunterCid) {
      return sendError(res, 400, {
        code: ErrorCodes.VALIDATION_MISSING_FIELD,
        message: 'Required field missing: hunterCid',
        details: 'hunterCid is the IPFS CID of the submitted work product',
        fix: 'Use the hunterCid returned from POST /api/jobs/:id/submit or /submit/bundle'
      });
    }

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));
    if (!job) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }

    // Check if submission with this ID already exists
    const existingSubmission = job.submissions.find(s => s.submissionId === Number(submissionId));
    if (existingSubmission) {
      // Already confirmed - return success (idempotent)
      logger.info('[submissions/confirm] Submission already exists', { jobId, submissionId });
      return res.json({ success: true, submission: existingSubmission, alreadyExists: true });
    }

    // Non-blocking: the on-chain submission already exists by the time /confirm
    // is called, so a bad shape here can't be prevented — only flagged for the
    // UI/hunter to see (see #34). /submit/prepare is the blocking check. Runs
    // alongside the chain read below, on a short budget so the browser's 30s
    // request timeout isn't hit; a gateway that can't deliver in time yields
    // 'unknown', never 'malformed'.
    const archiveShapePromise = archiveShapeValidator
      .fetchAndValidateArchiveShape(hunterCid, { totalTimeoutMs: CONFIRM_SHAPE_CHECK_BUDGET_MS })
      .then(archiveShapeValidator.archiveShapeLabel)
      .catch((e) => {
        logger.warn('[submissions/confirm] archive shape check threw', { jobId, submissionId, error: e.message });
        return 'unknown';
      });

    // Create the submission record with the on-chain submissionId.
    // Start with a conservative default of 'Prepared'; below we try to read
    // chain truth and overwrite with the real status. If the chain read
    // succeeds and the bounty is windowed, this will already be
    // 'PendingCreatorApproval' with creatorWindowEnd set — no follow-up
    // refreshSubmission call needed from the client.
    const submission = {
      submissionId: Number(submissionId),
      hunter,
      hunterCid,
      archiveShape: 'unknown',
      evalWallet: evalWallet || null,
      fileCount: fileCount || 0,
      files: files || [],
      submittedAt: Math.floor(Date.now() / 1000),
      status: 'Prepared',
      // Track which client type submitted this work
      clientType: req.clientType || 'unknown',
      clientId: req.clientId || null,
    };

    // Read chain truth and overwrite the skeleton fields. This closes the
    // hole where the confirm write locked in status='Prepared' for windowed
    // bounties (real chain status: 5=PendingCreatorApproval), leaving the
    // local cache permanently wrong until someone manually refreshed. See
    // bounty 46 sub 0 incident.
    //
    // Non-fatal: on RPC failure, we keep the 'Prepared' default and the
    // background sync service / a manual refresh will heal later.
    try {
      // Lag-tolerant: retries the "bad submissionId" revert a few times, since the RPC
      // node may not have the prepare block the caller's receipt came from yet.
      const chainSub = await readChainSubmissionWithRetry(jobId, submissionId);

      const statusMap = {
        0: 'Prepared',
        1: 'PENDING_EVALUATION',      // PendingVerdikta
        2: 'REJECTED',                // Failed
        3: 'APPROVED',                // PassedPaid
        4: 'APPROVED',                // PassedUnpaid
        5: 'PendingCreatorApproval',
      };
      const onChainStatusMap = {
        0: 'Prepared',
        1: 'PendingVerdikta',
        2: 'Failed',
        3: 'PassedPaid',
        4: 'PassedUnpaid',
        5: 'PendingCreatorApproval',
      };
      const statusIndex = Number(chainSub.status);
      const chainStatus = statusMap[statusIndex] || 'UNKNOWN';
      const chainOnChainStatus = onChainStatusMap[statusIndex] || null;

      submission.status = chainStatus;
      // Low-level chain enum name — analytics needs this to distinguish
      // PassedPaid (winner) from PassedUnpaid (passed but didn't win).
      if (chainOnChainStatus) {
        submission.onChainStatus = chainOnChainStatus;
      }
      // Security: who submitted what is the CHAIN's record. Anyone can call /confirm first for
      // someone else's prepared submission, and the first record wins (the sync only fills a
      // missing hunterCid), so a body hunter/hunterCid used to replace the real work on the
      // page the creator reviews before approving.
      if (chainSub.hunter && !/^0x0{40}$/i.test(String(chainSub.hunter))) submission.hunter = String(chainSub.hunter);
      if (chainSub.hunterCid) submission.hunterCid = String(chainSub.hunterCid);
      if (String(hunter).toLowerCase() !== String(submission.hunter).toLowerCase() || hunterCid !== submission.hunterCid) {
        logger.warn('[submissions/confirm] body hunter/hunterCid differ from the chain; using the chain', { jobId, submissionId });
        submission.files = [];
        submission.fileCount = 0;
      }
      submission.creatorWindowEnd = Number(chainSub.creatorWindowEnd) || null;
      submission.ethMaxBudget = chainSub.ethMaxBudget?.toString() || submission.ethMaxBudget;
      submission.submittedAt = Number(chainSub.submittedAt) || submission.submittedAt;
      if (chainSub.evalWallet && chainSub.evalWallet !== '0x0000000000000000000000000000000000000000') {
        submission.evalWallet = chainSub.evalWallet;
      }
      // The Submission struct no longer carries evaluationCid; it is the bounty's.
      if (!submission.evaluationCid && job.evaluationCid) submission.evaluationCid = job.evaluationCid;

      logger.info('[submissions/confirm] chain truth applied', {
        jobId, submissionId,
        chainStatus,
        creatorWindowEnd: submission.creatorWindowEnd,
      });
    } catch (chainErr) {
      // Distinguish a genuine "this submissionId does not exist on-chain" revert
      // from a transient RPC/network error. The escrow reverts with
      // "bad submissionId" for an out-of-range index. When that happens the
      // client almost certainly mis-decoded the SubmissionPrepared event (e.g.
      // passed the bountyId as the submissionId) — fail CLOSED so we never
      // persist an un-actionable phantom submission that /start and /finalize
      // can't touch and the sync service never cleans (see bounty 71 sub 71).
      // For any OTHER read failure (RPC blip, timeout) keep the historical
      // fail-open behavior: persist the skeleton and let sync heal it later.
      const reason = (chainErr.reason || chainErr.shortMessage || chainErr.message || '').toLowerCase();
      if (reason.includes('bad submissionid')) {
        logger.warn('[submissions/confirm] rejecting: submissionId does not exist on-chain', {
          jobId, submissionId, error: chainErr.message
        });
        return sendError(res, 400, {
          code: ErrorCodes.SUBMISSION_BAD_ID,
          message: `submissionId ${submissionId} does not exist on-chain for bounty ${jobId}`,
          details: 'The escrow contract reverted with "bad submissionId" — the on-chain bounty has no submission at that index. This usually means the SubmissionPrepared event was mis-decoded and the bountyId (or another field) was passed as the submissionId.',
          fix: 'Re-parse the SubmissionPrepared event from your prepareSubmission tx receipt and use its submissionId (submissions are 0-indexed per bounty), not the bountyId.'
        });
      }
      // Nothing from the body is stored unverified: the record would never be corrected.
      logger.warn('[submissions/confirm] chain read failed; asking the caller to retry', {
        jobId, submissionId, error: chainErr.message
      });
      return sendError(res, 503, {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'Could not read the submission on chain right now',
        details: 'The submission is recorded from its on-chain record; the read failed. Nothing was changed.',
        fix: 'Retry in a few seconds with the same body (the sync also records it on its own).',
      });
    }

    // The shape check ran on the body CID; re-run it if the chain names another.
    const shapePromise = submission.hunterCid === hunterCid ? archiveShapePromise
      : archiveShapeValidator.fetchAndValidateArchiveShape(submission.hunterCid, { totalTimeoutMs: CONFIRM_SHAPE_CHECK_BUDGET_MS })
        .then(archiveShapeValidator.archiveShapeLabel).catch(() => 'unknown');

    submission.archiveShape = await shapePromise;
    if (submission.archiveShape.startsWith('malformed')) {
      logger.warn('[submissions/confirm] hunter archive failed shape check', {
        jobId, submissionId, hunterCid, archiveShape: submission.archiveShape
      });
    }

    // Apply under the storage lock: re-find the job in a fresh copy and re-check
    // idempotency before appending, so a concurrent sync/confirm write can't be
    // lost and two racing confirms can't double-insert. The chain read above
    // built `submission` without touching storage, so the lock is held only for
    // the append + write.
    const applyResult = await jobStorage.withStorage((s, ctx) => {
      const freshJob = s.jobs.find(j => j.jobId === parseInt(jobId));
      if (!freshJob) { ctx.skipWrite = true; return { notFound: true }; }
      const dup = freshJob.submissions.find(x => x.submissionId === Number(submissionId));
      if (dup) { ctx.skipWrite = true; return { existing: dup }; }
      freshJob.submissions.push(submission);
      freshJob.submissionCount = freshJob.submissions.length;
      return { added: true };
    });

    if (applyResult.notFound) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }
    if (applyResult.existing) {
      logger.info('[submissions/confirm] Submission already exists (raced)', { jobId, submissionId });
      return res.json({ success: true, submission: applyResult.existing, alreadyExists: true });
    }

    logger.info('[submissions/confirm] Submission confirmed', { jobId, submissionId, hunter });
    return res.json({ success: true, submission });

  } catch (error) {
    logger.error('[submissions/confirm] error', { msg: error.message });
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to confirm submission',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  }
});

/* =============================================
   TRANSACTION BUNDLE FOR AGENT SUBMISSIONS
   ============================================= */

/**
 * ABI fragments for encoding transaction calldata.
 * Mirrors the on-chain BountyEscrow interface. The oracle is ETH-funded now —
 * startPreparedSubmission is payable and there is no LINK/ERC-20 approval.
 */
const BUNDLE_ESCROW_ABI = [
  "function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid) returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget)",
  "function startPreparedSubmission(uint256 bountyId, uint256 submissionId) payable",
  "function finalizeSubmission(uint256 bountyId, uint256 submissionId)",
  "function creatorApproveSubmission(uint256 bountyId, uint256 submissionId)",
  SUBMISSION_PREPARED_ABI
];
const bundleEscrowIface = new ethers.Interface(BUNDLE_ESCROW_ABI);

/**
 * POST /api/jobs/:jobId/submit/bundle
 *
 * Returns pre-encoded transaction calldata for the full submission flow.
 * Agent signs and broadcasts each transaction in order.
 *
 * Accepts JSON body (if hunterCid already uploaded) or multipart/form-data (with files).
 *
 * Request body:
 *   hunterAddress   - Ethereum address (required)
 *   hunterCid       - IPFS CID of already-uploaded work (optional if files provided)
 *   files           - multipart file uploads (optional if hunterCid provided)
 *   addendum, alpha, maxOracleFee, estimatedBaseCost, maxFeeBasedScaling
 *                   - DEPRECATED and IGNORED. Since the September 2026 revision the
 *                     oracle request settings are chosen by the bounty CREATOR at
 *                     createBounty (see `oracleSettings` on GET /api/jobs/:id) and
 *                     prepareSubmission takes only (bountyId, evaluationCid, hunterCid).
 *                     The fields are accepted for one release and not forwarded anywhere.
 *
 * Response: step-1 transaction (prepareSubmission) + templates for steps 2-3.
 * After broadcasting step 1, call POST /submit/bundle/complete with the txHash
 * to get exact calldata for the remaining steps (start funded with ETH, then finalize).
 */
router.post('/:jobId/submit/bundle', limitPins, async (req, res) => {
  let uploadedFiles = [];
  try {
    // Support both JSON and multipart
    const isMultipart = (req.headers['content-type'] || '').includes('multipart');
    if (isMultipart) {
      await new Promise((resolve, reject) => upload(req, res, (err) => err ? reject(err) : resolve()));
      uploadedFiles = req.files || [];
    }

    const { jobId } = req.params;
    const hunterAddress = req.body.hunterAddress || req.body.hunter;
    let { hunterCid } = req.body;
    // null = no upload happened here (hunterCid supplied directly); true/false = readback result.
    let hunterCidVerified = null;
    // Legacy hunter-side oracle fields: accepted, logged, and IGNORED (never forwarded).
    const ignoredFields = ['addendum', 'alpha', 'maxOracleFee', 'estimatedBaseCost', 'maxFeeBasedScaling']
      .filter(k => req.body && req.body[k] != null && req.body[k] !== '');
    if (ignoredFields.length) {
      logger.info('[submit/bundle] ignoring legacy hunter-side oracle fields', { jobId, ignoredFields });
    }

    // ---- Validate inputs ----
    if (!hunterAddress || !/^0x[a-fA-F0-9]{40}$/.test(hunterAddress)) {
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_INVALID_HUNTER,
        message: 'Invalid or missing hunterAddress',
        details: `"${hunterAddress || ''}" is not a valid Ethereum address`,
        fix: 'Provide a valid 0x-prefixed Ethereum address (42 characters total)',
        tips: ['POST /api/jobs/:id/submit/bundle with { "hunterAddress": "0x...", "hunterCid": "Qm..." }']
      });
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    if (await rejectIfJuryUnrunnable(res, job, jobId)) return;
    if (job.status !== 'OPEN') {
      const codeMap = { EXPIRED: ErrorCodes.BOUNTY_EXPIRED, AWARDED: ErrorCodes.BOUNTY_CLOSED, CLOSED: ErrorCodes.BOUNTY_CLOSED };
      return sendError(res, 400, {
        code: codeMap[job.status] || ErrorCodes.BOUNTY_NOT_OPEN,
        message: job.status === 'EXPIRED'
          ? 'This bounty is no longer accepting submissions'
          : `Bounty #${jobId} is ${job.status}`,
        details: `Bounty #${jobId} status is ${job.status}${job.submissionCloseTime ? '. Deadline was ' + new Date(job.submissionCloseTime * 1000).toISOString() : ''}`,
        fix: 'Check open bounties with GET /api/jobs?status=OPEN'
      });
    }
    const now = Math.floor(Date.now() / 1000);
    if (now < job.submissionOpenTime || now > job.submissionCloseTime) {
      const deadline = job.submissionCloseTime ? new Date(job.submissionCloseTime * 1000).toISOString() : 'unknown';
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_WINDOW_CLOSED,
        message: 'Submission window closed',
        details: `Bounty #${jobId} deadline was ${deadline}`,
        fix: 'Check open bounties with GET /api/jobs?status=OPEN'
      });
    }

    if (!job.evaluationCid) {
      return sendError(res, 400, {
        code: ErrorCodes.ONCHAIN_NO_EVAL_PKG,
        message: 'Bounty has no evaluation package',
        details: `Bounty #${jobId} is missing an evaluationCid and cannot accept submissions`,
        fix: 'This bounty was not configured correctly. Try a different open bounty: GET /api/jobs?status=OPEN'
      });
    }

    if (await rejectIfUnevaluable(job, req, res, jobId)) return;

    // ---- Upload files to IPFS if provided (no hunterCid yet) ----
    if (!hunterCid && uploadedFiles.length > 0) {
      // Reject 0-byte attachments before pinning — empty content scores 0 but would
      // otherwise pin and return a CID silently.
      const emptyNames = emptyFileNames(uploadedFiles);
      if (emptyNames.length > 0) {
        return sendError(res, 400, {
          code: ErrorCodes.SUBMISSION_EMPTY_FILE,
          message: 'Empty attachment in submission',
          details: `${emptyNames.join(', ')} ${emptyNames.length > 1 ? 'are' : 'is'} 0 bytes — the oracle would see no content and score the submission 0. This usually means a multipart upload didn't attach the file body.`,
          fix: 'Re-upload with non-empty content. With a programmatic multipart client, verify the file stream is attached (curl -F "files=@path" is reliable). Pre-check with POST /api/jobs/:id/submit/dry-run.'
        });
      }

      // Reject archive/binary attachments before pinning — the oracle silently skips
      // them (score 0), wasting the ETH prepay on a doomed submission.
      const unreadable = await findOracleUnreadableFiles(uploadedFiles);
      if (unreadable.length > 0) {
        return sendError(res, 400, {
          code: ErrorCodes.VALIDATION_INVALID_FORMAT,
          message: 'Attachment is an archive/binary the oracle cannot read',
          details: unreadable.join('; '),
          fix: 'Do NOT zip or archive the deliverable — the oracle skips archive/binary attachments and scores the submission 0. Submit readable files (text/code/markdown, PDF, .docx, images); unpack archives and attach the individual files. Use POST /api/jobs/:id/submit/dry-run to pre-check.'
        });
      }
      const oversized = await findOversizedImages(uploadedFiles);
      if (oversized.length > 0) {
        return sendError(res, 400, {
          code: ErrorCodes.VALIDATION_INVALID_FORMAT,
          message: 'Image is too large for the AI models to read',
          details: oversized.join('; '),
          fix: `${OVERSIZED_IMAGE_FIX} Use POST /api/jobs/:id/submit/dry-run to pre-check.`
        });
      }
      const fileDescriptions = (() => {
        try { return req.body.fileDescriptions ? JSON.parse(req.body.fileDescriptions) : {}; }
        catch { return {}; }
      })();
      const workProducts = uploadedFiles.map(f => ({
        path: f.path,
        name: f.originalname,
        type: f.mimetype,
        description: fileDescriptions[f.originalname] || `Work product file: ${f.originalname}`
      }));
      const hunterArchive = await archiveGenerator.createHunterSubmissionCIDArchive({
        workProducts,
        submissionNarrative: req.body.submissionNarrative || undefined
      });
      // Confirm the archive is non-empty (locally, before pinning) — deterministic, no
      // gateway-readback latency/false-negatives. CID is content-addressed, so a non-empty
      // archive ⟹ non-empty pinned content.
      const archiveSize = await pinnedArchiveSize(hunterArchive.archivePath);
      const tooLarge = oversizedArchiveError(archiveSize);
      if (tooLarge) {
        await fs.unlink(hunterArchive.archivePath).catch(() => {});
        return sendError(res, 413, tooLarge);
      }
      const ipfsClient = req.app.locals.ipfsClient;
      try {
        hunterCid = await ipfsClient.uploadToIPFS(hunterArchive.archivePath);
        logger.info('[bundle] hunter submission pinned', { hunterCid, fileCount: uploadedFiles.length, archiveSize });
      } finally {
        await fs.unlink(hunterArchive.archivePath).catch(() => {});
      }

      if (archiveSize === 0) {
        return sendError(res, 502, {
          code: ErrorCodes.INTERNAL_ERROR,
          message: 'Built submission archive is empty',
          details: `The work product archive for ${hunterCid} came out empty (0 bytes) — it was not stored correctly.`,
          fix: 'Re-submit. Verify your files have content; if this persists, the IPFS/archive pipeline may be failing.'
        });
      }
      hunterCidVerified = archiveSize > 0;
    }

    if (!hunterCid) {
      return sendError(res, 400, {
        code: ErrorCodes.SUBMISSION_MISSING_CID,
        message: 'No work product provided',
        details: 'Provide either a hunterCid (pre-uploaded IPFS CID) or files (multipart upload)',
        fix: 'Option 1: POST with JSON { "hunterAddress": "0x...", "hunterCid": "Qm..." }. Option 2: POST with multipart/form-data including files + hunterAddress.',
        tips: [
          'Upload files first via POST /api/jobs/:id/submit to get a hunterCid',
          'Or include files directly in this request as multipart/form-data'
        ]
      });
    }

    // A caller-supplied hunterCid gets the same shape check as /submit/prepare
    // (#34). An archive built just above by createHunterSubmissionCIDArchive is
    // conforming by construction, and a fresh pin may not have reached the
    // gateways yet, so it is not re-fetched.
    let archiveGate = { archiveShape: 'ok', warnings: [] };
    if (hunterCidVerified === null) {
      archiveGate = await gateHunterArchive(res, hunterCid, 'submit/bundle');
      if (!archiveGate) return;
    }

    // ---- Build transaction calldata ----
    const escrowAddress = config.bountyEscrowAddress;
    const chainId       = config.chainId;
    const bountyIdNum   = parseInt(jobId);

    // The bounty's creator-chosen oracle settings size the prepay:
    // ethMaxBudget = aggregator.maxTotalFee(oracle fees, beacons, the bounty's jury K and P), identical for every
    // submission to this bounty.
    const bountyOracle = jobOracleSettings(job);
    const maxOracleFeeWei = BigInt(bountyOracle.maxOracleFee);

    // Step 1: prepareSubmission calldata (3 args — the contract reads the bounty's
    // oracle settings itself and forwards an empty addendum).
    const prepareData = bundleEscrowIface.encodeFunctionData('prepareSubmission', [
      bountyIdNum,
      job.evaluationCid,
      hunterCid
    ]);

    return res.json({
      success: true,
      hunterCid,
      hunterCidVerified,
      archiveShape: archiveGate.archiveShape,
      ...(archiveGate.warnings.length ? { warnings: archiveGate.warnings } : {}),
      oracleSettings: bountyOracle,
      ...(ignoredFields.length ? { ignoredFields, ignoredFieldsNote: 'These hunter-side oracle fields are no longer part of prepareSubmission; the bounty creator set the oracle settings at createBounty. They were not forwarded.' } : {}),
      transactions: [
        {
          step: 1,
          name: 'prepareSubmission',
          description: 'Creates submission record on-chain. Parse SubmissionPrepared event from tx receipt to get evalWallet, submissionId, and ethMaxBudget.',
          to: escrowAddress,
          data: prepareData,
          value: '0',
          chainId,
          gasLimit: 1000000
        },
        {
          step: 2,
          name: 'startPreparedSubmission',
          description: 'Starts the oracle round. Replace {SUBMISSION_ID} from step 1 event, and attach {START_VALUE} = startValue(bountyId) (the round\'s prepay plus the hunter bond) as the transaction value (msg.value). No LINK approval needed.',
          to: escrowAddress,
          data: null,
          dataTemplate: 'startPreparedSubmission({BOUNTY_ID}, {SUBMISSION_ID})',
          value: '{START_VALUE}',
          chainId,
          gasLimit: Number(START_GAS_LIMIT),
          note: 'Use POST /api/jobs/:id/submit/bundle/complete with step 1 txHash to get exact calldata + value'
        }
      ],
      roundSteps: {
        description: 'After step 2 the round must be drawn (drawJury, from two blocks on; twice for a beacon bounty) and later promoted. Anyone may send each step and the server\'s keeper usually does; POST /api/jobs/:id/submissions/:submissionId/round-step returns the one that succeeds now.',
        endpoint: `POST /api/jobs/${jobId}/submissions/{SUBMISSION_ID}/round-step`
      },
      postEvaluation: {
        step: 3,
        name: 'finalizeSubmission',
        description: 'Call after oracle completes to claim reward (if passed) or close submission (if failed). Replace {SUBMISSION_ID}.',
        to: escrowAddress,
        data: null,
        dataTemplate: 'finalizeSubmission({BOUNTY_ID}, {SUBMISSION_ID})',
        value: '0',
        chainId,
        gasLimit: Number(RESOLVE_GAS_LIMIT_FALLBACK),
        note: 'Only call after GET /api/jobs/:id/submissions/:submissionId/diagnose shows the round has a result. A pass is paid and returns the bond; a soft fail lets you re-run (POST .../rerun, within 2 hours; keeps your place and bond); a hard fail forfeits the bond to the creator.'
      },
      contracts: {
        escrow: escrowAddress
      },
      requirements: {
        ethForGas: '~0.005 ETH (estimate for both transactions)',
        ethForOracle: 'attach startValue(bountyId) as msg.value on step 2 (POST /start or /submit/bundle/complete returns it): the round\'s prepay, of which the unspent part is refunded when the round resolves, plus the hunter bond, returned unless a hard fail forfeits it'
      },
      // Canonical topic0 + ABI for the event step 1 emits — filter the receipt logs
      // on `event.topic0` and decode with `event.abi` rather than deriving either.
      event: submissionPreparedEvent,
      abis: {
        SubmissionPrepared: SUBMISSION_PREPARED_ABI,
        prepareSubmission: 'function prepareSubmission(uint256 bountyId, string evaluationCid, string hunterCid) returns (uint256 submissionId, address evalWallet, uint256 ethMaxBudget)',
        startPreparedSubmission: 'function startPreparedSubmission(uint256 bountyId, uint256 submissionId) payable',
        finalizeSubmission: 'function finalizeSubmission(uint256 bountyId, uint256 submissionId)',
        drawJury: 'function drawJury(uint256 bountyId, uint256 submissionId)',
        closeFailedRound: 'function closeFailedRound(uint256 bountyId, uint256 submissionId)',
        rerunSubmission: 'function rerunSubmission(uint256 bountyId, uint256 submissionId) payable',
        expireRerun: 'function expireRerun(uint256 bountyId, uint256 submissionId)'
      },
      nextStep: `POST /api/jobs/${jobId}/submit/bundle/complete with { "txHash": "0x..." } after broadcasting step 1`,
      tips: [
        'Execute step 1 first, then call /submit/bundle/complete with the txHash',
        '/submit/bundle/complete parses step 1 logs and returns exact calldata + the ETH value for steps 2 and 3',
        'PREFER the ethMaxBudget that /submit/bundle/complete returns (parsed.ethMaxBudget) — do not hand-decode the event for the budget.',
        'If you DO parse SubmissionPrepared yourself: use the full event ABI above and named access (args.ethMaxBudget). Field order is evalWallet, ethMaxBudget, then the dynamic string evaluationCid LAST; the topic0 is the keccak256 of event.signature.',
        'The oracle and decision settings (fee ceiling and floor, beacons, alpha, estimatedBaseCost, maxFeeBasedScaling; jury, pass quota Q, forfeit line R, bond) are fixed by the bounty creator — see oracleSettings above and decisionSettings on GET /api/jobs/:id. prepareSubmission takes only (bountyId, evaluationCid, hunterCid); hunterCid must be a bare 46-100 char alphanumeric CID or it reverts "bad hunterCid". Windowed bounties accept at most 128 submissions ("submission limit reached").',
        'If you can parse event logs yourself, extract evalWallet + submissionId + ethMaxBudget from SubmissionPrepared (full ABI)',
        'Step 2 (startPreparedSubmission) is payable — attach the LIVE startValue(bountyId) as msg.value (the /start transaction.value): the round\'s prepay plus the hunter bond. The prepare event\'s ethMaxBudget is only the prepay estimate, without the bond. There is NO LINK approval step.',
        `Confirm submission with POST /api/jobs/${jobId}/submissions/confirm after step 1`,
        `Poll GET /api/jobs/${jobId}/submissions after step 2 until evaluation completes, then execute step 3`,
        'Step 3 (finalizeSubmission) is REQUIRED — oracle completion does NOT trigger payment automatically',
        'If finalizeSubmission reverts with "Verdikta not ready", the round has no result yet — wait (it must be drawn and promoted; the keeper or anyone does it: POST .../round-step). If it reverts "no oracle result - use closeFailedRound", the round can get no result: closeFailedRound (POST .../close-failed; anyone) closes it and you may re-run. Finalize can revert "earlier submission pending - retry after it resolves" (nextAction AWAIT_EARLIER) — that is NOT a failure. The earlier submission is often already resolvable (nextAction FINALIZE, CLOSE_FAILED or EXPIRE_RERUN); anyone may resolve it, and it cannot change who wins. POST /finalize (and /diagnose) list them in blockedBy[], each with the transaction that resolves it: send those, then your own finalize. Check GET /api/jobs/:id/submissions/:subId/diagnose for the exact state.',
        ...(job.creatorAssessmentWindowSize > 0 ? [
          `WINDOWED BOUNTY: After step 1, the submission enters PendingCreatorApproval for ${job.creatorAssessmentWindowSize}s. The creator may approve directly. If the window expires, proceed with steps 2-3.`,
          `Poll GET /api/jobs/${jobId}/submissions/:subId/diagnose to check window status before executing step 2.`
        ] : [])
      ],
      ...(job.creatorAssessmentWindowSize > 0 ? {
        windowedBounty: {
          note: 'This bounty has a creator approval window. After step 1, the submission enters PendingCreatorApproval status. The creator may approve directly during the window. If the window expires without approval, proceed with steps 2-3 to start (ETH-funded) oracle evaluation.',
          creatorAssessmentWindowSize: job.creatorAssessmentWindowSize,
          creatorDeterminationPayment: job.creatorDeterminationPayment || null,
          arbiterDeterminationPayment: job.arbiterDeterminationPayment || null,
        }
      } : {})
    });

  } catch (error) {
    logger.error('[bundle] error', { msg: error.message });
    if (sendUploadError(res, error)) return;
    if (error.message.includes('not found')) {
      return sendError(res, 404, {
        code: ErrorCodes.BOUNTY_NOT_FOUND,
        message: 'Bounty not found',
        details: `No bounty exists with ID ${req.params.jobId}`,
        fix: 'List available bounties with GET /api/jobs?status=OPEN'
      });
    }
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to build transaction bundle',
      details: error.message,
      fix: 'Try again shortly or check server health: GET /health'
    });
  } finally {
    for (const f of uploadedFiles) {
      if (f?.path) await fs.unlink(f.path).catch(() => {});
    }
  }
});

/**
 * POST /api/jobs/:jobId/submit/bundle/complete
 *
 * After the agent broadcasts the prepareSubmission transaction (step 1),
 * this endpoint parses the transaction receipt to extract evalWallet,
 * submissionId, and ethMaxBudget, then returns exact calldata for steps 2-3
 * (the ETH-funded start, then finalize).
 *
 * Request body: { "txHash": "0x..." }
 */
router.post('/:jobId/submit/bundle/complete', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { txHash } = req.body;

    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return sendError(res, 400, {
        code: ErrorCodes.VALIDATION_INVALID_FORMAT,
        message: 'Invalid or missing txHash',
        details: `"${txHash || ''}" is not a valid transaction hash. Expected 0x + 64 hex characters.`,
        fix: 'Provide the transaction hash from step 1 (prepareSubmission), e.g. "0xabc123..."'
      });
    }

    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId)) return;
    if (await rejectIfJuryUnrunnable(res, job, jobId)) return;

    // We need blockchain access to parse the receipt
    let cs;
    try {
      cs = getContractService();
    } catch (e) {
      return sendError(res, 503, {
        code: ErrorCodes.ONCHAIN_NOT_AVAILABLE,
        message: 'Blockchain service not available',
        details: 'Server cannot access blockchain to parse transaction receipt',
        fix: 'Parse the SubmissionPrepared event yourself using the FULL ABI from /submit/bundle response. Extract: evalWallet, submissionId, ethMaxBudget (data words 0 and 1; the dynamic string evaluationCid is last).'
      });
    }

    // Fetch transaction receipt
    const receipt = await cs.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return sendError(res, 404, {
        code: ErrorCodes.ONCHAIN_TX_NOT_FOUND,
        message: 'Transaction not found or not yet mined',
        details: `No receipt for txHash ${txHash}`,
        fix: 'Wait for the transaction to be mined (usually 2-5 seconds on Base), then retry this request'
      });
    }

    if (receipt.status === 0) {
      return sendError(res, 400, {
        code: ErrorCodes.ONCHAIN_TX_REVERTED,
        message: 'Transaction reverted',
        details: 'The prepareSubmission transaction failed on-chain',
        fix: `Check the transaction on block explorer for revert reason: ${config.explorer}/tx/${txHash}`
      });
    }

    // Parse SubmissionPrepared event from logs
    const escrowAddress = config.bountyEscrowAddress;
    let evalWallet, submissionId, ethMaxBudget;

    for (const log of receipt.logs) {
      if ((log.address || '').toLowerCase() !== (escrowAddress || '').toLowerCase()) continue;
      try {
        const parsed = bundleEscrowIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === 'SubmissionPrepared') {
          // Named access — the field order changed in the September 2026 revision
          // (ethMaxBudget now precedes the dynamic string), so never index positionally.
          submissionId  = parsed.args.submissionId;
          evalWallet    = parsed.args.evalWallet;
          ethMaxBudget  = parsed.args.ethMaxBudget;
          break;
        }
      } catch { /* skip non-matching logs */ }
    }

    if (submissionId === undefined || !evalWallet) {
      return sendError(res, 400, {
        code: ErrorCodes.ONCHAIN_PARSE_FAILED,
        message: 'Could not parse SubmissionPrepared event',
        details: `Transaction succeeded but SubmissionPrepared event not found in logs. Expected escrow contract: ${escrowAddress}`,
        fix: 'Verify the txHash is for a prepareSubmission call to the correct escrow contract. You can parse the event yourself using the ABI from /submit/bundle.'
      });
    }

    const bountyIdNum = parseInt(jobId);
    const chainId     = config.chainId;
    // v2: the start takes startValue(bountyId) — the live prepay plus the hunter bond. The event's
    // ethMaxBudget is only the prepay at prepare time; without the bond the start would revert.
    let startValue;
    try {
      startValue = (await getContractService().contract.startValue(bountyIdNum)).toString();
    } catch (svErr) {
      return res.status(503).json({
        success: false,
        error: 'Could not read startValue(bountyId) from the escrow (the prepay plus the hunter bond); retry shortly',
        code: 'START_VALUE_UNREADABLE',
        details: svErr.message
      });
    }

    // Encode exact calldata for steps 2 (ETH-funded start) and 3 (finalize)
    const startData = bundleEscrowIface.encodeFunctionData('startPreparedSubmission', [
      bountyIdNum,
      submissionId
    ]);

    const finalizeData = bundleEscrowIface.encodeFunctionData('finalizeSubmission', [
      bountyIdNum,
      submissionId
    ]);

    const confirmBlock = {
      description: 'Register this submission with the API server for status tracking',
      method: 'POST',
      url: `/api/jobs/${jobId}/submissions/confirm`,
      body: {
        submissionId: Number(submissionId),
        hunter: receipt.from,
        hunterCid: '(the hunterCid from /submit/bundle response)',
        evalWallet
      }
    };

    // Windowed-bounty guard: after prepareSubmission a windowed submission is in
    // PendingCreatorApproval on-chain, and startPreparedSubmission reverts until the
    // creator approves or the window expires. Detect that here so we don't hand back
    // step-2 start calldata that's guaranteed to revert (the reported failure mode).
    let windowHold = null;
    try {
      const chainSub = await cs.contract.getSubmission(bountyIdNum, submissionId);
      if (Number(chainSub.status) === 5) {
        const windowEnd = Number(chainSub.creatorWindowEnd) || 0;
        const nowSec = Math.floor(Date.now() / 1000);
        if (windowEnd > nowSec) windowHold = { windowEnd, secondsRemaining: windowEnd - nowSec };
      }
    } catch (e) {
      logger.warn('[bundle/complete] live status read failed; returning start calldata unguarded', { jobId, msg: e.message });
    }

    if (windowHold) {
      const creatorApproveData = bundleEscrowIface.encodeFunctionData('creatorApproveSubmission', [
        bountyIdNum,
        submissionId
      ]);
      return res.json({
        success: true,
        parsed: {
          submissionId: Number(submissionId),
          evalWallet,
          ethMaxBudget: ethMaxBudget.toString(),
          ethMaxBudgetFormatted: ethers.formatEther(ethMaxBudget) + ' ETH'
        },
        // No step-2 transaction yet: the submission is in the creator-approval window,
        // so startPreparedSubmission would revert. Do NOT broadcast a start tx now.
        transactions: [],
        pendingCreatorApproval: {
          status: 'PENDING_CREATOR_APPROVAL',
          note: `This bounty has a creator-approval window. Submission #${Number(submissionId)} is awaiting the creator's decision; startPreparedSubmission reverts until the creator approves or the window expires.`,
          creatorWindowEnd: windowHold.windowEnd,
          secondsRemaining: windowHold.secondsRemaining,
          creatorApprove: {
            name: 'creatorApproveSubmission',
            description: 'Creator-only: approve and pay this submission directly, skipping oracle evaluation. Reverts if called by anyone other than the bounty creator.',
            to: escrowAddress,
            data: creatorApproveData,
            value: '0',
            chainId,
            gasLimit: 300000
          },
          deferredStart: {
            name: 'startPreparedSubmission',
            description: `Only valid AFTER the window expires (or if the creator declines). Attach ${ethers.formatEther(ethMaxBudget)} ETH as msg.value.`,
            to: escrowAddress,
            data: startData,
            value: startValue,
            chainId,
            gasLimit: Number(START_GAS_LIMIT)
          }
        },
        postEvaluation: {
          step: 3,
          name: 'finalizeSubmission',
          description: `Finalize submission #${Number(submissionId)} after oracle completes (only reached if the window expires and you start evaluation)`,
          to: escrowAddress,
          data: finalizeData,
          value: '0',
          chainId,
          gasLimit: Number(RESOLVE_GAS_LIMIT_FALLBACK)
        },
        confirm: confirmBlock,
        tips: [
          'WINDOWED BOUNTY: do NOT broadcast a start transaction yet — the submission is in the creator-approval window and startPreparedSubmission would revert.',
          `Register the submission now: POST /api/jobs/${jobId}/submissions/confirm`,
          `Poll GET /api/jobs/${jobId}/submissions — when submission #${Number(submissionId)} leaves PENDING_CREATOR_APPROVAL, the creator either approved (done) or the window expired (then broadcast pendingCreatorApproval.deferredStart).`,
          'The creator can approve + pay directly with pendingCreatorApproval.creatorApprove (creator wallet only).'
        ]
      });
    }

    return res.json({
      success: true,
      parsed: {
        submissionId: Number(submissionId),
        evalWallet,
        ethMaxBudget: ethMaxBudget.toString(),
        ethMaxBudgetFormatted: ethers.formatEther(ethMaxBudget) + ' ETH'
      },
      transactions: [
        {
          step: 2,
          name: 'startPreparedSubmission',
          description: `Start oracle evaluation for submission #${Number(submissionId)}, attaching ${ethers.formatEther(ethMaxBudget)} ETH as msg.value (no LINK approval; unspent ETH is refunded to the hunter)`,
          to: escrowAddress,
          data: startData,
          value: startValue,
          chainId,
          gasLimit: Number(START_GAS_LIMIT)
        }
      ],
      postEvaluation: {
        step: 3,
        name: 'finalizeSubmission',
        description: `Finalize submission #${Number(submissionId)} after oracle completes`,
        to: escrowAddress,
        data: finalizeData,
        value: '0',
        chainId,
        gasLimit: Number(RESOLVE_GAS_LIMIT_FALLBACK)
      },
      confirm: confirmBlock,
      tips: [
        'Execute step 2 (start evaluation) — it is payable; attach the value field (ethMaxBudget) as msg.value. No LINK approval is needed.',
        `After step 2, poll GET /api/jobs/${jobId}/submissions until status is EVALUATED_PASSED or EVALUATED_FAILED`,
        'Then execute step 3 (finalize) to claim reward or close submission',
        `Also call POST /api/jobs/${jobId}/submissions/confirm to register the submission for API tracking`
      ]
    });

  } catch (error) {
    logger.error('[bundle/complete] error', { msg: error.message });
    return sendError(res, 500, {
      code: ErrorCodes.INTERNAL_ERROR,
      message: 'Failed to parse transaction',
      details: error.message,
      fix: 'Verify the txHash and try again. You can also parse the SubmissionPrepared event yourself using the ABI from /submit/bundle.'
    });
  }
});

/* ===============================
   GET publicSubmissions sign-payload helper
   Returns the canonical message string that the bounty creator must sign
   (via personal_sign / ethers signer.signMessage, or a smart account's
   signMessage for EIP-1271 wallets) to toggle the flag.
   Removes the "build the message text by hand" foot-gun — the agent fetches
   the message, signs it with the creator wallet, then PATCHes back.
   =============================== */

router.get('/:jobId/public-submissions/sign-payload', async (req, res) => {
  try {
    const { jobId } = req.params;
    const valueParam = String(req.query.value ?? '').toLowerCase();
    if (valueParam !== 'true' && valueParam !== 'false') {
      return res.status(400).json({
        success: false,
        error: 'Query param "value" must be "true" or "false"',
        example: `${req.path}?value=true`
      });
    }
    const publicSubmissions = valueParam === 'true';

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId, 10));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!job.creator) return res.status(400).json({ success: false, error: 'Job has no creator on record' });

    const { buildPublicSubmissionsMessage } = require('../utils/messageAuth');
    const timestamp = new Date().toISOString();
    const message = buildPublicSubmissionsMessage({
      bountyId: parseInt(jobId, 10),
      publicSubmissions,
      timestamp
    });

    return res.json({
      success: true,
      bountyId: parseInt(jobId, 10),
      creator: job.creator,
      publicSubmissions,
      message,
      timestamp,
      validForSeconds: 300,
      next: {
        sign: 'Sign `message` verbatim with the bounty creator wallet (ethers: signer.signMessage(message); web3: personal_sign). Smart-contract wallets (Coinbase Smart Wallet, Base Account, agent CDP smart accounts) sign with their own signMessage; the server verifies via EIP-1271 isValidSignature.',
        submit: `PATCH /api/jobs/${jobId}/public-submissions with { publicSubmissions: ${publicSubmissions}, message, signature }`
      }
    });
  } catch (err) {
    logger.error('[public-submissions/sign-payload] fatal', { msg: err.message });
    return res.status(500).json({ success: false, error: 'Failed to build sign payload', details: err.message });
  }
});

/* ===============================
   PATCH publicSubmissions (creator-signed, off-chain)
   Toggles the off-chain "publicSubmissions" flag on a bounty. Requires a
   personal_sign message from the bounty creator — an EOA signature or an
   EIP-1271 smart-wallet signature. CIDs on the blockchain /
   in API responses are public regardless — this flag only controls whether
   the website surfaces convenient preview/download buttons to non-creators.
   =============================== */

router.patch('/:jobId/public-submissions', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { publicSubmissions, message, signature } = req.body || {};

    if (typeof publicSubmissions !== 'boolean') {
      return res.status(400).json({ success: false, error: 'publicSubmissions must be true or false' });
    }
    if (!message || !signature) {
      return res.status(400).json({ success: false, error: 'message and signature required' });
    }

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId, 10));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!job.creator) return res.status(400).json({ success: false, error: 'Job has no creator on record' });

    const { verifyPublicSubmissionsAction } = require('../utils/messageAuth');
    let parsed;
    try {
      // Async: EOA creators verify via ecrecover; smart-wallet creators
      // (Coinbase Smart Wallet / Base Account / agent CDP wallets) verify via
      // EIP-1271 isValidSignature on the creator contract. Any verifier
      // failure — including RPC errors — lands here as a 401, never a 500.
      parsed = await verifyPublicSubmissionsAction({
        message,
        signature,
        expectedSigner: job.creator,
        expectedBountyId: parseInt(jobId, 10),
      });
    } catch (err) {
      logger.warn('[public-submissions] signature rejected', { jobId, msg: err.message });
      return res.status(401).json({ success: false, error: err.message });
    }

    if (parsed.publicSubmissions !== publicSubmissions) {
      return res.status(400).json({ success: false, error: 'body.publicSubmissions does not match signed message' });
    }

    // Apply under the storage lock (re-find the job in a fresh copy) so this
    // PATCH can't be lost to a concurrent sync/mutation write.
    const updatedAt = Math.floor(Date.now() / 1000);
    // Each signed change must be newer than the last one applied. A signature stays valid for five
    // minutes, so without this anyone who saw a "Public: true" request could replay it right after
    // the creator revoked, and undo the revocation (sec4-outside).
    const applied = await jobStorage.withStorage((s, ctx) => {
      const freshJob = s.jobs.find(j => j.jobId === parseInt(jobId, 10));
      if (!freshJob) { ctx.skipWrite = true; return false; }
      if (Number(freshJob.publicSubmissionsSignedAtMs) >= parsed.timestampMs) { ctx.skipWrite = true; return 'stale'; }
      freshJob.publicSubmissions = publicSubmissions;
      freshJob.publicSubmissionsUpdatedAt = updatedAt;
      freshJob.publicSubmissionsSignedAtMs = parsed.timestampMs;
      return true;
    });
    if (applied === 'stale') {
      return res.status(409).json({ success: false, error: 'A newer signed change was already applied',
        details: 'This message is not newer than the last publicSubmissions change for this bounty.',
        fix: 'GET /api/jobs/:id/public-submissions/sign-payload for a fresh message and sign it.' });
    }
    if (!applied) return res.status(404).json({ success: false, error: 'Job not found' });

    logger.info('[public-submissions] updated', { jobId, publicSubmissions, creator: job.creator });

    return res.json({
      success: true,
      job: { jobId: parseInt(jobId, 10), publicSubmissions }
    });
  } catch (err) {
    logger.error('[public-submissions] fatal', { msg: err.message });
    return res.status(500).json({ success: false, error: 'Failed to update public submissions flag', details: err.message });
  }
});

/**
 * POST /api/jobs/:jobId/create-attempt
 * The create page reports how far an on-chain create got and how it failed, so
 * an unlinked job no longer hides why the wallet step never happened (see
 * utils/createAttempts.js). Body: { creator, event, at, ...fields } with event
 * sign_requested | tx_sent | failed. Accepted only for an unlinked job whose
 * creator matches; the newest 10 events are kept on job.createAttempts.
 * Frontend auth like every other write; never a public path.
 */
const createAttemptJobLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
const createAttemptIpLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 120 });

router.post('/:jobId/create-attempt', async (req, res) => {
  const { jobId } = req.params;
  const ip = clientAddress(req);
  for (const limit of [createAttemptIpLimiter.hit(ip), createAttemptJobLimiter.hit(`${ip}|${jobId}`)]) {
    if (!limit.allowed) {
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return sendError(res, 429, {
        code: ErrorCodes.RATE_LIMIT,
        message: 'Too many create-attempt reports',
        details: `Retry after ${limit.retryAfterSeconds}s`,
      });
    }
  }

  const id = Number(jobId);
  const creator = req.body?.creator;
  if (!Number.isInteger(id) || id < 0) {
    return sendError(res, 400, { code: ErrorCodes.BAD_REQUEST, message: 'Invalid job id', details: `"${String(jobId).slice(0, 40)}" is not a job id` });
  }
  if (typeof creator !== 'string' || !ADDRESS_RE.test(creator)) {
    return sendError(res, 400, { code: ErrorCodes.VALIDATION_INVALID_FORMAT, message: 'creator must be a 0x address' });
  }
  const { event, error } = sanitizeCreateAttempt(req.body);
  if (error) return sendError(res, 400, { code: ErrorCodes.VALIDATION_INVALID_FORMAT, message: error });

  let outcome;
  try {
    // Check and append under the storage lock, so a link landing at the same
    // moment can't be overwritten and two reports can't drop each other.
    outcome = await jobStorage.withStorage((storage, ctx) => {
      // Same preference as jobStorage.getJob when an id exists on two contracts.
      const current = jobStorage.getCurrentContractAddress();
      const job = storage.jobs.find((j) => j.jobId === id && (j.contractAddress || '').toLowerCase() === current)
        || storage.jobs.find((j) => j.jobId === id);
      ctx.skipWrite = true;
      if (!job) return { status: 404 };
      if (!isUnlinked(job)) return { status: 409, reason: 'linked' };
      if (String(job.creator || '').toLowerCase() !== creator.toLowerCase()) return { status: 409, reason: 'creator' };
      job.createAttempts = appendAttempt(job.createAttempts, event);
      ctx.skipWrite = false;
      return { status: 200, count: job.createAttempts.length };
    });
  } catch (e) {
    logger.error('[jobs/create-attempt] store failed', { jobId: id, msg: e.message });
    return sendError(res, 500, { code: ErrorCodes.INTERNAL_ERROR, message: 'Could not store the report', details: e.message });
  }

  if (outcome.status === 404) {
    return sendError(res, 404, { code: ErrorCodes.BOUNTY_NOT_FOUND, message: 'Job not found', details: `No job ${id}` });
  }
  if (outcome.status === 409) {
    return sendError(res, 409, {
      code: ErrorCodes.BAD_REQUEST,
      message: outcome.reason === 'linked' ? 'Job is already on-chain' : 'creator does not match the job',
      details: outcome.reason === 'linked'
        ? 'Create-attempt reports are only kept for jobs that never reached the chain.'
        : 'Only the job\'s creator address can report its create attempts.',
    });
  }

  const log = event.event === 'failed' ? logger.warn : logger.info;
  log.call(logger, '[jobs/create-attempt]', {
    jobId: id, creator: creator.toLowerCase(), event: event.event, step: event.step,
    category: event.category, code: event.code, rpcCode: event.rpcCode, txHash: event.txHash,
    wallet: event.wallet, accountType: event.accountType, chainId: event.chainId,
    message: event.message, walletMessage: event.walletMessage,
  });
  return res.json({ success: true, jobId: id, stored: outcome.count });
});

/* ===============================
   PATCH bountyId + resolve helper
   =============================== */

// A window-based deadline may drift by the time between POST /jobs/create and the
// createBounty transaction (the website computes its own from the same window when it
// signs); an exact one must match to the second.
const DEADLINE_DRIFT_TOLERANCE_SEC = 15 * 60;

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m || 1}m`;
}

/**
 * Warn when the bounty went on chain with a deadline other than the one POST /jobs/create
 * planned. Mainnet #302 (2026-10-19): an agent hand-encoded its own deadline and the
 * bounty closed 22 hours before the date its wager terms promised. The contract has no
 * way to change a deadline, so the caller has to know now. Call before the chain fields
 * are applied (that overwrites submissionCloseTime).
 */
function deadlineMismatchWarning(job, chainBounty) {
  const planned = Number(job.plannedSubmissionCloseTime ?? (job.syncedFromBlockchain ? 0 : job.submissionCloseTime));
  const onChain = Number(chainBounty.submissionCloseTime);
  if (!(planned > 0) || !(onChain > 0)) return null;
  const difference = onChain - planned;
  const tolerance = job.submissionDeadlineExact ? 0 : DEADLINE_DRIFT_TOLERANCE_SEC;
  if (Math.abs(difference) <= tolerance) return null;
  const plannedIso = isoFromUnix(planned);
  const onChainIso = isoFromUnix(onChain);
  return {
    code: 'DEADLINE_MISMATCH',
    plannedSubmissionDeadline: planned,
    plannedSubmissionDeadlineIso: plannedIso,
    onChainSubmissionDeadline: onChain,
    onChainSubmissionDeadlineIso: onChainIso,
    differenceSeconds: difference,
    message: `The bounty went on chain with submission deadline ${onChainIso}, ${formatDuration(Math.abs(difference))} ${difference < 0 ? 'earlier' : 'later'} than the ${plannedIso} that POST /jobs/create planned. The contract enforces the on-chain deadline and it cannot be changed.`,
    fix: 'If the description or terms name the planned date, the bounty does not match them. Create a new bounty and sign onChain.transaction from POST /jobs/create as returned (pass submissionDeadline to /jobs/create for an exact date) instead of encoding your own deadline. An unused bounty refunds its creator through closeExpiredBounty after its deadline.'
  };
}

router.patch('/:jobId/bountyId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { bountyId, txHash } = req.body || {};

    // Security: a link must be proven by the createBounty receipt. Without txHash this
    // route used to renumber any job to any bountyId and mark it onChain, so a caller
    // could pin its own title/description on someone else's escrow (or fake an on-chain
    // bounty that does not exist). Every caller (website, skill, scripts) sends it.
    if (!Number.isSafeInteger(Number(bountyId)) || Number(bountyId) < 0) {
      return res.status(400).json({ success: false, error: 'Invalid bountyId', details: 'bountyId must be a non-negative integer (from the BountyCreated event)' });
    }
    // (shape only; the receipt lookup below is the proof)
    if (typeof txHash !== 'string' || !/^0x[0-9A-Za-z]{1,128}$/.test(txHash)) {
      return res.status(400).json({
        success: false,
        error: 'txHash required',
        details: 'Send txHash: the 0x-prefixed 32-byte hash of your createBounty transaction. The server reads its BountyCreated event to link this job.',
        fix: 'PATCH /api/jobs/:jobId/bountyId with { bountyId, txHash, blockNumber } from the createBounty receipt.'
      });
    }

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobId));
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    // Verify the txHash actually emitted a BountyCreated event with the claimed bountyId
    // on the current contract. This prevents phantom entries from old/wrong contracts.
    const currentContract = jobStorage.getCurrentContractAddress();
    if (!currentContract) {
      return res.status(503).json({ success: false, error: 'Server has no escrow address configured', details: 'Cannot verify the createBounty receipt.' });
    }
    let eventEvaluationCid = null; // from the receipt's BountyCreated — identifies the job authoritatively
    let eventCreator = null;       // ...and its creator, which must be the job's (sec4-outside)
    let receiptBlock = null;       // the receipt's block: what is stored (the body's blockNumber is ignored)
    if (txHash && currentContract) {
      try {
        const contractService = getContractService();
        const provider = contractService.provider;
        // Lag-tolerant: a load-balanced RPC node can trail the receipt the caller just got
        // by a block or two and answer null. Retry briefly instead of proceeding unverified
        // (an unverified claim once let a parallel-create link delete a live sibling job).
        const receipt = await readWithLagRetry(() => provider.getTransactionReceipt(txHash),
          { retryOnEmpty: true, label: `getTransactionReceipt(${txHash.slice(0, 10)})` });

        if (!receipt) {
          return res.status(409).json({
            success: false,
            code: ErrorCodes.ONCHAIN_TX_NOT_FOUND,
            error: 'Transaction not visible on chain yet',
            details: `No receipt for txHash ${txHash} after retrying for several seconds. The tx may still be pending, or the RPC node is behind.`,
            fix: 'Retry this PATCH in a few seconds with the same body. Nothing was changed.',
            retryAfterSeconds: 3
          });
        }

        // Parse BountyCreated event from the receipt
        const iface = new ethers.Interface([
          'event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)'
        ]);
        let foundBountyId = null;
        let emittingContract = null;
        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === 'BountyCreated') {
              foundBountyId = Number(parsed.args.bountyId);
              emittingContract = log.address.toLowerCase();
              eventEvaluationCid = parsed.args.evaluationCid || null;
              eventCreator = parsed.args.creator || null;
              break;
            }
          } catch {}
        }

        if (foundBountyId === null) {
          return res.status(400).json({
            success: false,
            error: 'No BountyCreated event found in transaction',
            details: `txHash ${txHash} did not emit a BountyCreated event.`,
            fix: 'Verify you are passing the correct transaction hash from the createBounty call.'
          });
        }

        if (foundBountyId !== Number(bountyId)) {
          return res.status(400).json({
            success: false,
            error: 'BountyId mismatch',
            details: `txHash emitted BountyCreated with bountyId=${foundBountyId}, but you claimed bountyId=${bountyId}.`,
            fix: 'Use the bountyId from the BountyCreated event in the transaction receipt.'
          });
        }

        if (emittingContract !== currentContract) {
          return res.status(400).json({
            success: false,
            error: 'Wrong contract',
            details: `BountyCreated was emitted by ${emittingContract}, but this server expects ${currentContract}. The bounty was created on a different contract.`,
            fix: 'Ensure your wallet/frontend is targeting the correct BountyEscrow contract for this network.'
          });
        }

        receiptBlock = Number(receipt.blockNumber);
        logger.info('[jobs/bountyId] txHash verified', { txHash, foundBountyId, emittingContract });
      } catch (verifyErr) {
        // Do NOT proceed on an unverified claim: with several bounties created in parallel
        // the caller's (jobId → bountyId) pairing is exactly what needs checking, and an
        // unchecked one can renumber or displace a sibling job. Ask for a retry instead.
        logger.warn('[jobs/bountyId] txHash verification failed — asking the caller to retry', {
          txHash, error: verifyErr.message
        });
        return res.status(503).json({
          success: false,
          error: 'Could not verify the transaction right now',
          details: `RPC error while reading txHash ${txHash}: ${verifyErr.message}`,
          fix: 'Retry this PATCH in a few seconds with the same body. Nothing was changed.',
          retryAfterSeconds: 3
        });
      }
    }

    // Pre-fetch chain-authoritative backfill fields OUTSIDE the storage lock —
    // network I/O must never be held under the lock. The pure mapping
    // (applyChainBountyFields) is applied to the fresh job inside the critical
    // section below. Non-fatal: on RPC failure the sync service heals later.
    let chainBounty = null;
    try {
      const cs = getContractService();
      chainBounty = await readWithLagRetry(() => cs.getBounty(Number(bountyId)),
        { revertSubstring: 'bad bountyid', label: `getBounty(${bountyId})` });
    } catch (chainErr) {
      logger.warn('[jobs/bountyId] chain backfill fetch failed (non-fatal, sync will heal later)', {
        bountyId: Number(bountyId), error: chainErr.message
      });
    }

    // Apply the field updates, jobId reconcile + collision-splice, and chain
    // backfill as ONE serialized critical section on a FRESH storage copy, so
    // the linked job (and the splice) can't be lost to — or clobber — a
    // concurrent sync/API write. All chain I/O happened above, outside the lock.
    const { applyChainBountyFields, creatorMatches } = require('../utils/syncService');
    const nowSec = Math.floor(Date.now() / 1000);
    const outcome = await jobStorage.withStorage((store, ctx) => {
      // Locate the job. The caller names it by the id it got from POST /jobs/create, but a
      // sibling's reconcile may already have moved it (parallel creates whose on-chain ids
      // landed in a different order). The receipt's evaluationCid is the authoritative
      // identity, so prefer an UNLINKED job carrying that CID when the record at the named
      // id is not it.
      let freshJob = store.jobs.find(j => j.jobId === parseInt(jobId));
      const isUnlinked = (j) => !j.onChain && !j.syncedFromBlockchain && j.status !== 'ORPHANED';
      // A record with another package, or none, is not this bounty's job.
      if (!eventEvaluationCid || !freshJob || freshJob.evaluationCid !== eventEvaluationCid) {
        const byCid = eventEvaluationCid && (store.jobs.find(j => isUnlinked(j) && j.evaluationCid === eventEvaluationCid)
          || store.jobs.find(j => j.evaluationCid === eventEvaluationCid && j.jobId === Number(bountyId)));
        if (byCid) {
          logger.info('[jobs/bountyId] located job by the receipt evaluationCid (record at the named id is a different job)', {
            namedJobId: parseInt(jobId), foundJobId: byCid.jobId, bountyId: Number(bountyId)
          });
          freshJob = byCid;
        } else if (freshJob) {
          // The named record is a different, real job and nothing carries this CID: refuse
          // rather than relabel someone else's bounty.
          ctx.skipWrite = true;
          return { conflict: { collidingEvaluationCid: freshJob.evaluationCid, jobEvaluationCid: eventEvaluationCid, namedRecordIsOtherJob: true } };
        }
      }
      if (!freshJob) { ctx.skipWrite = true; return { notFound: true }; }
      // A job already linked to a bounty (by an earlier PATCH or by the sync) is never moved: the
      // receipt may only confirm the link it has. An evaluationCid is public, so anyone can create a
      // dust bounty that carries it and send that receipt here; before this check such a receipt
      // renumbered the victim's record onto the attacker's bounty (review 2026-11-27, item 4).
      if (freshJob.onChain || freshJob.syncedFromBlockchain) {
        if (freshJob.jobId !== Number(bountyId) || freshJob.evaluationCid !== eventEvaluationCid) {
          ctx.skipWrite = true;
          return { alreadyLinked: { jobId: freshJob.jobId } };
        }
      } else if (!creatorMatches(freshJob, eventCreator)) {
        // Unlinked (or orphaned): the evaluationCid of a pending job is public too, so the
        // createBounty must come from the creator the job names.
        ctx.skipWrite = true;
        return { creatorMismatch: { jobCreator: freshJob.creator, eventCreator } };
      }

      // Both from the verified receipt, never from the body (blockNumber used to be stored as sent:
      // any JSON value up to the body limit, kept by the sync).
      freshJob.txHash      = txHash;
      freshJob.blockNumber = receiptBlock;
      freshJob.onChain     = true;

      // Reconcile jobId to match on-chain ID (aligned ID system)
      if (freshJob.jobId !== Number(bountyId)) {
        logger.info('[jobs/bountyId] reconciling jobId to match on-chain ID', {
          oldJobId: freshJob.jobId, newJobId: Number(bountyId)
        });

        // Remove any existing job with the target ID to avoid duplicates
        const collisionIdx = store.jobs.findIndex(j =>
          j !== freshJob && j.jobId === Number(bountyId)
        );
        if (collisionIdx !== -1) {
          const colliding = store.jobs[collisionIdx];
          // Only remove a colliding record if it's genuinely a removable
          // phantom/duplicate of THIS bounty. A colliding job that is itself
          // on-chain/synced with a DIFFERENT evaluationCid is a separate, REAL
          // bounty — deleting it and stealing its id is the data-corruption bug
          // that clobbered bounty #245 (a wrong bountyId in the PATCH body made
          // the reconcile delete an unrelated live bounty). When that's the case
          // the claimed bountyId cannot belong to this job, so refuse the
          // reconcile and change nothing.
          const sameEvalCid = colliding.evaluationCid && freshJob.evaluationCid &&
            colliding.evaluationCid === freshJob.evaluationCid;
          const collidingIsRealDistinct =
            (colliding.syncedFromBlockchain || colliding.onChain) && !sameEvalCid;
          if (collidingIsRealDistinct) {
            logger.error('[jobs/bountyId] refusing reconcile: claimed bountyId belongs to a different on-chain bounty', {
              jobId: freshJob.jobId,
              claimedBountyId: Number(bountyId),
              jobEvaluationCid: freshJob.evaluationCid,
              collidingEvaluationCid: colliding.evaluationCid,
              collidingTitle: colliding.title
            });
            ctx.skipWrite = true;
            return {
              conflict: {
                collidingEvaluationCid: colliding.evaluationCid,
                jobEvaluationCid: freshJob.evaluationCid
              }
            };
          }
          if (sameEvalCid) {
            // A duplicate record of THIS bounty (create-dedup miss, or a re-link): drop it.
            logger.warn('[jobs/bountyId] removing colliding duplicate of the same bounty', {
              collidingJobId: colliding.jobId, collidingTitle: colliding.title, reason: 'same_evaluationCid_duplicate'
            });
            store.jobs.splice(collisionIdx, 1);
          } else {
            // An UNLINKED sibling (its own createBounty landed in a different order and its
            // PATCH is in flight or the sync has not reached it). It is a live job, not a
            // phantom: move it to the id this job vacates instead of deleting it. Its own
            // PATCH (receipt-verified) will move it again if that is not its final id.
            const vacated = freshJob.jobId;
            logger.warn('[jobs/bountyId] swapping ids with an unlinked sibling job', {
              siblingJobId: colliding.jobId, siblingTitle: colliding.title, siblingMovedTo: vacated
            });
            colliding.jobId = vacated;
          }
        }

        freshJob.jobId = Number(bountyId);
      }

      // Track which contract this job was created on
      if (currentContract && !freshJob.contractAddress) {
        freshJob.contractAddress = currentContract;
      }

      // Backfill chain-authoritative fields (targetHunter, creator approval
      // window payments and duration) from the contract read above. The local
      // pending job may lack these (older client, or the dedup branch in POST
      // /jobs/create reused a stale pending row); applying them here makes the
      // GUI see a windowed/targeted bounty as such immediately.
      let deadlineWarning = null;
      if (chainBounty) {
        deadlineWarning = deadlineMismatchWarning(freshJob, chainBounty);
        const changed = applyChainBountyFields(freshJob, chainBounty);
        if (changed) {
          logger.info('[jobs/bountyId] backfilled chain fields', {
            bountyId: Number(bountyId),
            targetHunter: freshJob.targetHunter,
            creatorAssessmentWindowSize: freshJob.creatorAssessmentWindowSize
          });
        }
        // We've read chain truth — mark synced so the sync service's stale-check
        // doesn't redundantly hit the chain for it.
        freshJob.syncedFromBlockchain = true;
        freshJob.lastSyncedAt = nowSec;
      }

      return { ok: true, job: freshJob, deadlineWarning };
    });

    if (outcome.creatorMismatch) {
      return res.status(409).json({
        success: false,
        error: 'createBounty was sent by a different creator',
        details: `This job was created for ${outcome.creatorMismatch.jobCreator}, but the BountyCreated event in this transaction names ${outcome.creatorMismatch.eventCreator}. Nothing was changed.`,
        fix: 'Link the job with the txHash of the createBounty you sent from the creator address the job names.'
      });
    }
    if (outcome.notFound) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    if (outcome.alreadyLinked) {
      return res.status(409).json({
        success: false,
        error: 'Job already linked to another bounty',
        details: `Job ${outcome.alreadyLinked.jobId} is already linked on chain and this receipt is for bounty #${Number(bountyId)}. A linked job is never moved.`,
        fix: 'Use the jobId returned by your own POST /jobs/create, or GET /api/jobs/lookup?txHash=<your-createBounty-tx>.'
      });
    }
    if (outcome.conflict) {
      return res.status(409).json({
        success: false,
        error: 'bountyId already linked to a different bounty',
        details: `On-chain bounty #${Number(bountyId)} is already tracked by a different bounty (evaluationCid ${outcome.conflict.collidingEvaluationCid}). This job's evaluationCid is ${outcome.conflict.jobEvaluationCid}. You likely passed the wrong bountyId.`,
        fix: 'Use the bountyId from your own createBounty receipt (the BountyCreated event), or GET /api/jobs/lookup?txHash=<your-createBounty-tx> to find the correct on-chain bountyId for this job.'
      });
    }

    logger.info('[jobs/bountyId] updated', { jobId, bountyId, contractAddress: outcome.job.contractAddress });
    if (outcome.deadlineWarning) {
      logger.warn('[jobs/bountyId] on-chain deadline differs from the planned one', {
        bountyId: Number(bountyId),
        planned: outcome.deadlineWarning.plannedSubmissionDeadlineIso,
        onChain: outcome.deadlineWarning.onChainSubmissionDeadlineIso,
        differenceSeconds: outcome.deadlineWarning.differenceSeconds
      });
      return res.json({ success: true, job: outcome.job, warnings: [outcome.deadlineWarning] });
    }
    return res.json({ success: true, job: outcome.job });
  } catch (error) {
    logger.error('[jobs/bountyId] error', { msg: error.message });
    return res.status(500).json({ success: false, error: error.message });
  }
});


// Resolve endpoint — uses singleton provider and targeted event query
router.patch('/:id/bountyId/resolve', async (req, res) => {
  const jobIdParam = req.params.id;
  try {
    logger.info('[resolve] hit', { id: jobIdParam, body: req.body });

    const { creator, rubricCid, submissionCloseTime, txHash } = req.body || {};
    if (!creator || !submissionCloseTime) {
      return res.status(400).json({ success: false, error: 'creator and submissionCloseTime are required' });
    }

    const storage = await jobStorage.readStorage();
    const job = storage.jobs.find(j => j.jobId === parseInt(jobIdParam));
    if (!job) return res.status(404).json({ success: false, error: `Job ${jobIdParam} not found` });

    const deadlineSec = Number(submissionCloseTime) > 1e12
      ? Math.floor(Number(submissionCloseTime) / 1000)
      : Number(submissionCloseTime);

    let cs;
    try {
      cs = getContractService();
    } catch (e) {
      return res.status(500).json({ success: false, error: 'Blockchain not configured' });
    }
    const ESCROW = config.bountyEscrowAddress;

    // Backfill chain-authoritative fields after we've resolved a bountyId.
    // Mirrors PATCH /:jobId/bountyId: fetch OUTSIDE the storage lock
    // (fetchChainBounty), apply to the fresh job INSIDE it (applyBackfill).
    // Non-fatal on RPC failure.
    const { applyChainBountyFields } = require('../utils/syncService');
    const fetchChainBounty = async (resolvedBountyId) => {
      try {
        return await cs.getBounty(resolvedBountyId);
      } catch (chainErr) {
        logger.warn('[resolve] chain backfill fetch failed (non-fatal, sync will heal later)', {
          bountyId: resolvedBountyId, error: chainErr.message
        });
        return null;
      }
    };
    const applyBackfill = (freshJob, chainBounty, resolvedBountyId) => {
      if (!chainBounty) return;
      const changed = applyChainBountyFields(freshJob, chainBounty);
      if (changed) {
        logger.info('[resolve] backfilled chain fields', {
          bountyId: resolvedBountyId,
          targetHunter: freshJob.targetHunter,
          creatorAssessmentWindowSize: freshJob.creatorAssessmentWindowSize
        });
      }
      freshJob.syncedFromBlockchain = true;
      freshJob.lastSyncedAt = Math.floor(Date.now() / 1000);
    };

    // Security: link only the job that IS this bounty (its own evaluationCid equals the
    // BountyCreated event's), and never onto an id another linked record holds. Before
    // this, any caller could renumber its own job onto someone else's bounty (from their
    // txHash, or a creator address it names) and the site showed its title and description.
    const linkResolved = async (resolvedBountyId, eventCid, chainBounty, extra = {}) => {
      if (!eventCid) return { status: 409, error: 'BountyCreated event has no evaluationCid' };
      return jobStorage.withStorage((store, ctx) => {
        ctx.skipWrite = true;
        const freshJob = store.jobs.find(j => j.jobId === parseInt(jobIdParam));
        if (!freshJob) return { status: 404, error: `Job ${jobIdParam} not found` };
        if (freshJob.evaluationCid !== eventCid) {
          return { status: 409, error: `On-chain bounty #${resolvedBountyId} has evaluationCid ${eventCid}; job ${jobIdParam} has ${freshJob.evaluationCid}. It is a different bounty.` };
        }
        const colliding = store.jobs.find(j => j !== freshJob && j.jobId === resolvedBountyId);
        if (colliding) {
          if (colliding.onChain || colliding.syncedFromBlockchain) {
            return { status: 409, error: `On-chain bounty #${resolvedBountyId} is already tracked by another record` };
          }
          colliding.jobId = freshJob.jobId; // unlinked sibling: swap ids, as PATCH /bountyId does
        }
        freshJob.jobId = resolvedBountyId;
        freshJob.onChain = true;
        Object.assign(freshJob, extra);
        const currentContract = jobStorage.getCurrentContractAddress();
        if (currentContract) freshJob.contractAddress = currentContract;
        applyBackfill(freshJob, chainBounty, resolvedBountyId);
        ctx.skipWrite = false;
        return { status: 200, job: freshJob };
      });
    };

    if (txHash) {
      try {
        const receipt = await cs.provider.getTransactionReceipt(txHash);
        if (receipt && Array.isArray(receipt.logs)) {
          const iface = new ethers.Interface([
            "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)"
          ]);
          let resolvedBountyId = null;
          let resolvedCid = null;
          for (const log of receipt.logs) {
            if ((log.address || '').toLowerCase() !== (ESCROW || '').toLowerCase()) continue;
            try {
              const ev = iface.parseLog(log);
              resolvedBountyId = Number(ev.args.bountyId);
              resolvedCid = ev.args.evaluationCid || null;
              break;
            } catch {}
          }
          if (resolvedBountyId != null) {
            // Chain I/O outside the lock, then apply to the fresh job inside it.
            const chainBounty = await fetchChainBounty(resolvedBountyId);
            const linked = await linkResolved(resolvedBountyId, resolvedCid, chainBounty, { txHash: (job.txHash ?? txHash) });
            if (linked.status !== 200) return res.status(linked.status).json({ success: false, error: linked.error });
            logger.info('[resolve] via tx', { jobId: jobIdParam, bountyId: resolvedBountyId });
            return res.json({ success: true, method: 'tx', bountyId: resolvedBountyId, job: linked.job });
          }
        }
      } catch (txErr) {
        logger.warn('[resolve] txHash path failed', { msg: txErr?.message });
      }
    }

    // Use targeted BountyCreated event query filtered by creator address
    // This replaces the old sequential scan of up to 300 bounties
    try {
      const currentBlock = await cs.getBlockNumber();
      const deploymentBlock = config.deploymentBlock || 0;
      const wantCreator = String(creator).toLowerCase();
      // Only this job's own evaluation package can match (the client's rubricCid hint is
      // not an evaluationCid, and "no CID" used to match any bounty by that creator).
      const wantCid = String(job.evaluationCid || '');
      void rubricCid;

      // Query BountyCreated events indexed by creator
      const creatorTopic = ethers.zeroPadValue(wantCreator, 32);
      const iface = new ethers.Interface([
        "event BountyCreated(uint256 indexed bountyId, address indexed creator, string evaluationCid, uint64 classId, uint8 threshold, uint256 payoutWei, uint64 submissionDeadline)"
      ]);
      const eventTopic = iface.getEvent('BountyCreated').topicHash;

      const logs = await cs.provider.getLogs({
        address: ESCROW,
        topics: [eventTopic, null, creatorTopic],
        fromBlock: deploymentBlock,
        toBlock: currentBlock
      });

      let best = null;
      let bestCid = null;
      let bestDelta = Number.POSITIVE_INFINITY;

      for (const log of logs) {
        try {
          const ev = iface.parseLog(log);
          const bountyId = Number(ev.args.bountyId);
          const bCid = ev.args.evaluationCid || '';
          const bDeadline = Number(ev.args.submissionDeadline || 0);
          const delta = Math.abs(bDeadline - deadlineSec);
          const cidOk = !!wantCid && wantCid === bCid;
          const deadlineOk = delta <= 300;
          if ((cidOk && deadlineOk) || (cidOk && delta < bestDelta)) {
            best = bountyId;
            bestCid = bCid;
            bestDelta = delta;
            if (delta === 0) break;
          }
        } catch {}
      }

      if (best != null) {
        // Chain I/O outside the lock, then apply to the fresh job inside it.
        const chainBounty = await fetchChainBounty(best);
        const linked = await linkResolved(best, bestCid, chainBounty);
        if (linked.status !== 200) return res.status(linked.status).json({ success: false, error: linked.error });
        logger.info('[resolve] via event query', { jobId: jobIdParam, resolvedId: best, delta: bestDelta });
        return res.json({ success: true, method: 'event', bountyId: best, delta: bestDelta, job: linked.job });
      }

      await jobStorage.withStorage((store, ctx) => {
        const freshJob = store.jobs.find(j => j.jobId === parseInt(jobIdParam));
        // A failed lookup (any caller can make one) never unlinks a linked job.
        if (!freshJob || freshJob.onChain || freshJob.syncedFromBlockchain) { ctx.skipWrite = true; return; }
        freshJob.onChain = false;
      });
      return res.status(404).json({ success: false, error: 'No matching on-chain bounty', onChain: false });
    } catch (scanErr) {
      logger.error('[resolve] event query error', { msg: scanErr?.message });
      return res.status(500).json({ success: false, error: `Event query failed: ${scanErr?.message}` });
    }
  } catch (e) {
    logger.error('[resolve] fatal', { msg: e?.message });
    return res.status(500).json({ success: false, error: e?.message || 'Internal error' });
  }
});


/* =======================
   CANCEL SUBMISSION
   - Only works for Prepared (not on-chain) submissions
   - Removes the submission from local storage
   ======================= */

router.delete('/:jobId/submissions/:submissionId', async (req, res) => {
  const { jobId, submissionId } = req.params;

  logger.info('[cancel] Request received', { jobId, submissionId });

  try {
    const job = await jobStorage.cancelSubmission(jobId, submissionId);

    return res.json({
      success: true,
      message: 'Submission cancelled',
      job
    });
  } catch (error) {
    logger.error('[cancel] Error', { jobId, submissionId, error: error.message });

    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('Cannot cancel')) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to cancel submission', details: error.message });
  }
});


/* =======================
   REFRESH SUBMISSION FROM BLOCKCHAIN
   - Works even without full sync enabled
   - Reads single submission status from chain and updates local storage
   ======================= */

router.post('/:jobId/submissions/:submissionId/refresh', async (req, res) => {
  const { jobId, submissionId } = req.params;

  logger.info('[refresh] Request received', { jobId, submissionId });
  
  try {
    // Get the job to find the on-chain bountyId
    const job = await jobStorage.getJob(jobId);
    if (!job) {
      logger.error('[refresh] Job not found', { jobId });
      return res.status(404).json({ error: 'Job not found', details: `No job with ID ${jobId}` });
    }
    
    logger.info('[refresh] Found job', { 
      jobId, 
      title: job.title,
      submissionsCount: job.submissions?.length || 0
    });

    const onChainId = job.jobId;

    if (onChainId == null) {
      logger.error('[refresh] No on-chain ID found', { jobId });
      return res.status(400).json({
        error: 'No on-chain bounty ID',
        details: 'This job has not been registered on-chain yet. Please check that the bounty was created on-chain.'
      });
    }

    logger.info('[refresh] Using on-chain bounty ID', { jobId, onChainId });

    const subId = parseInt(submissionId, 10);

    // Check if this submission was ever started on-chain
    const localSubmission = job.submissions?.find(s => s.submissionId === subId);
    if (localSubmission) {
      const isPreparedOnly = (localSubmission.status === 'Prepared' || localSubmission.status === 'PREPARED')
                             && !localSubmission.evalWallet
                             && !localSubmission.verdiktaAggId;
      if (isPreparedOnly) {
        logger.info('[refresh] Submission never started on-chain', { jobId, submissionId: subId });
        return res.status(400).json({
          error: 'Submission not on-chain',
          details: 'This submission was prepared but never started on-chain. It may be orphaned from a failed transaction.',
          submission: localSubmission
        });
      }
    }

    // Read submission from blockchain using singleton provider
    const cs = getContractService();
    const contract = cs.contract;

    const sub = await contract.getSubmission(onChainId, subId);
    
    // Debug: log raw struct fields
    logger.info('[refresh] Raw submission data from chain', {
      jobId,
      onChainId,
      submissionId: subId,
      hunter: sub.hunter,
      status: sub.status?.toString?.() ?? sub.status,
      acceptance: sub.acceptance?.toString?.() ?? sub.acceptance,
      rejection: sub.rejection?.toString?.() ?? sub.rejection,
      hunterCid: sub.hunterCid,
      funder: sub.funder
    });
    
    // Map status enum to string (ethers v6 returns BigInt for enums)
    // Contract enum: 0=Prepared, 1=PendingVerdikta, 2=Failed, 3=PassedPaid, 4=PassedUnpaid, 5=PendingCreatorApproval
    // Frontend expects: PENDING_EVALUATION (still pending), APPROVED/REJECTED (final states)
    const statusMap = {
      0: 'Prepared',
      1: 'PENDING_EVALUATION',  // PendingVerdikta
      2: 'REJECTED',            // Failed
      3: 'APPROVED',            // PassedPaid (winner!)
      4: 'APPROVED',            // PassedUnpaid (passed but someone else won)
      5: 'PendingCreatorApproval',
      6: 'AWAITING_RERUN',      // v2, item 12: soft fail or no result; may re-run
    };
    // Low-level (chain enum) names — preserved alongside the high-level
    // status so analytics and the public submissions endpoint can
    // distinguish PassedPaid (winner) from PassedUnpaid (didn't win) even
    // when both collapse to 'APPROVED' in the high-level field. See bug:
    // 23 finalized submissions stuck as EVALUATED_PASSED because refresh
    // never wrote onChainStatus.
    const onChainStatusMap = {
      0: 'Prepared',
      1: 'PendingVerdikta',
      2: 'Failed',
      3: 'PassedPaid',
      4: 'PassedUnpaid',
      5: 'PendingCreatorApproval',
      6: 'AwaitingRerun',
    };
    const statusIndex = Number(sub.status);
    let chainStatus = statusMap[statusIndex] || 'UNKNOWN';
    let chainOnChainStatus = onChainStatusMap[statusIndex] || null;

    // Receipt eligibility helpers
    const paidWinner = statusIndex === 3;      // PassedPaid
    const passedUnpaid = statusIndex === 4;    // PassedUnpaid

    // Scores are ALREADY normalized by the contract (divided by 10000)
    // The contract stores acceptance/rejection as 0-100, NOT 0-1000000
    let acceptScore = Number(sub.acceptance);
    let rejectScore = Number(sub.rejection);

    // For PendingVerdikta, read the round through the escrow's lens: its phase, and its result as
    // the contract judges it (item 12's Q-of-N rule — not the mean score against the threshold).
    let roundState = null;
    if (statusIndex === 1) {
      const zeroHash = '0x' + '0'.repeat(64);
      const aggId = sub.verdiktaAggId;
      if (aggId && aggId !== zeroHash) {
        try {
          roundState = await getContractService().getRoundState(onChainId, subId);
          if (!roundState.error) {
            if (roundState.hasResult) {
              chainStatus = roundState.outcome === 'pass' ? 'ACCEPTED_PENDING_CLAIM'
                : roundState.outcome === 'hard_fail' ? 'REJECTED_PENDING_FINALIZATION'
                : 'SOFT_FAIL_PENDING_FINALIZATION';
              if (roundState.scores) {
                acceptScore = roundState.scores.acceptance;
                rejectScore = roundState.scores.rejection;
              }
              logger.info('[refresh] Oracle evaluation complete, pending finalization', {
                jobId, submissionId: subId, chainStatus, outcome: roundState.outcome, passCount: roundState.passCount
              });
            } else if (roundState.outcome === 'no_result') {
              chainStatus = 'NO_RESULT_PENDING_CLOSE';
            }
          }
        } catch (err) {
          logger.debug('[refresh] Error reading the round', { error: err.message });
        }
      }
    }

    logger.info('[refresh] Status mapping', {
      rawStatus: sub.status?.toString?.() ?? sub.status,
      statusIndex,
      chainStatus
    });

    // Why a failed submission failed. The escrow emits NO_RESULT (a round with no result that
    // could not re-run) or RERUN_EXPIRED (a re-run not taken in its window) in place of
    // justification CIDs; those were recorded by the sync service from the event. Otherwise a
    // Failed submission had a result that failed (a hard fail, or a soft fail out of re-runs).
    let failureReason = null;
    if (statusIndex === 2) { // Failed/REJECTED
      const known = localSubmission?.failureReason;
      failureReason = known === 'NO_RESULT' || known === 'RERUN_EXPIRED' ? known : 'EVALUATION_FAILED';
    }
    // v2: an undrawn or open round on an expired bounty is NOT failed — it still resolves (a
    // result, closeFailedRound, or cancellation after a day), and the deadline only stops new
    // starts and re-runs. So no local "stuck → failed" override any more.

    logger.info('[refresh] Parsed submission from chain', {
      jobId,
      onChainId,
      submissionId: subId,
      statusIndex,
      chainStatus,
      acceptScore,
      rejectScore,
      failureReason
    });

    // Update local storage (reuse localSubmission from earlier check)
    if (localSubmission) {
      localSubmission.status = chainStatus;
      // Low-level chain enum name. Analytics keys off this to distinguish
      // PassedPaid vs PassedUnpaid; without it, paid winners are miscounted
      // as approvedUnpaid in /api/analytics.
      if (chainOnChainStatus) {
        localSubmission.onChainStatus = chainOnChainStatus;
      }
      localSubmission.score = acceptScore;
      localSubmission.acceptance = acceptScore;
      localSubmission.rejection = rejectScore;
      localSubmission.evaluationCid = sub.evaluationCid;
      localSubmission.hunterCid = sub.hunterCid;
      // BountyEscrow does not store justification CIDs (v0.5.0); the local value comes from
      // the SubmissionFinalized event / the aggregator via the sync service, so this only
      // ever overwrites with a non-empty value (never, from the escrow wrapper).
      if (sub.justificationCids) {
        localSubmission.justificationCids = sub.justificationCids;
      }
      localSubmission.finalizedAt = Number(sub.finalizedAt);
      localSubmission.verdiktaAggId = sub.verdiktaAggId;
      if (sub.funder && !/^0x0{40}$/i.test(sub.funder)) localSubmission.funder = sub.funder;
      localSubmission.failureReason = failureReason;
      localSubmission.paidWinner = paidWinner;
      localSubmission.passedUnpaid = passedUnpaid;
      localSubmission.creatorWindowEnd = Number(sub.creatorWindowEnd);

      jobStorage.updateJob(jobId, { submissions: job.submissions });
      
      logger.info('[refresh] Updated local submission', { 
        jobId, 
        submissionId: subId, 
        newStatus: chainStatus,
        score: acceptScore
      });
    } else {
      logger.warn('[refresh] Submission not found in local storage', {
        jobId,
        submissionId: subId,
        existingSubmissionIds: job.submissions?.map(s => s.submissionId) || []
      });
    }
    
    return res.json({
      success: true,
      submission: {
        submissionId: subId,
        status: chainStatus,
        onChainStatus: chainOnChainStatus,
        acceptance: acceptScore,
        rejection: rejectScore,
        evaluationCid: sub.evaluationCid,
        hunterCid: sub.hunterCid,
        justificationCids: sub.justificationCids,
        finalizedAt: Number(sub.finalizedAt),
        hunter: sub.hunter,
        verdiktaAggId: sub.verdiktaAggId,
        failureReason,  // null, 'EVALUATION_FAILED', 'NO_RESULT' or 'RERUN_EXPIRED'
        paidWinner,
        passedUnpaid,
        // v2: the round, as the escrow's lens reports it (PendingVerdikta only), and item 12's fields
        round: roundState && !roundState.error ? {
          phase: roundState.phaseName, outcome: roundState.outcome, passCount: roundState.passCount,
          deadline: roundState.deadline || null, nextAction: roundState.nextAction
        } : null,
        rounds: Number(sub.rounds ?? 0),
        rerunDeadline: Number(sub.rerunDeadline ?? 0) || null,
        bondHeldWei: (sub.bondHeld ?? 0n).toString()
      }
    });
    
  } catch (error) {
    logger.error('[refresh] Error reading submission from blockchain', { 
      jobId, 
      submissionId, 
      error: error.message,
      stack: error.stack,
      RPC_URL: config.rpcUrl ? 'set' : 'NOT SET',
      ESCROW_ADDR: config.bountyEscrowAddress
    });
    return res.status(500).json({
      error: 'Failed to refresh submission',
      details: error.message,
      hint: error.message.includes('bad bountyId') ? 'Bounty ID may not exist on this contract' :
            error.message.includes('bad submissionId') ? 'Submission ID may not exist for this bounty' :
            'Check server logs for details'
    });
  }
});


/* =======================
   TIMEOUT STUCK SUBMISSION
   ======================= */

/**
 * POST /api/jobs/:jobId/submissions/:submissionId/recover-refund
 * Calldata for BountyEscrow.recoverLeftoverEth(bountyId, submissionId): retry recovery of a
 * RESOLVED submission's unspent oracle prepay after the resolving tx emitted RefundDeferred.
 * Anyone may send it; the funder is paid. Gated on the contract's nextAction === "RECOVER_REFUND".
 */
router.post('/:jobId/submissions/:submissionId/recover-refund', async (req, res) => {
  const { jobId, submissionId } = req.params;
  try {
    const job = await jobStorage.getJob(jobId);
    if (rejectIfNotOnChain(res, job, jobId, { canRecover: false })) return;
    const onChainBountyId = Number(job.jobId);
    const onChainSubmissionId = Number(submissionId);
    const cs = getContractService();
    let action;
    try {
      action = await cs.contract.nextAction(onChainBountyId, onChainSubmissionId);
    } catch (e) {
      return res.status(503).json({ success: false, canRecover: false, error: 'Could not read the contract', details: e.message });
    }
    if (action !== 'RECOVER_REFUND') {
      return res.status(400).json({
        success: false,
        canRecover: false,
        nextAction: action,
        error: action === 'DONE' ? 'Nothing to recover' : 'Submission is not resolved yet',
        hint: action === 'DONE'
          ? 'The prepay for this submission has already been refunded.'
          : `The contract reports nextAction=${action}; recovery is only possible once the submission is Failed / PassedPaid / PassedUnpaid.`
      });
    }
    const iface = new ethers.Interface(['function recoverLeftoverEth(uint256 bountyId, uint256 submissionId)']);
    const data = iface.encodeFunctionData('recoverLeftoverEth', [onChainBountyId, onChainSubmissionId]);
    return res.json({
      success: true,
      canRecover: true,
      nextAction: action,
      transaction: { to: config.bountyEscrowAddress, data, value: '0', chainId: config.chainId, gasLimit: '300000' },
      contractCall: { method: 'recoverLeftoverEth', args: [onChainBountyId, onChainSubmissionId], abi: 'function recoverLeftoverEth(uint256 bountyId, uint256 submissionId)' },
      note: 'Anyone may broadcast this; the unspent prepay is paid to the address that funded the start.'
    });
  } catch (error) {
    logger.error('[recover-refund] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare recover-refund calldata', details: error.message });
  }
});

/**
 * GET /api/jobs/withdrawable/:address
 * Balance on the escrow's pull ledger for `address` (a payout / refund / close whose direct
 * delivery failed or exceeded PAYOUT_GAS_LIMIT — see PaymentDeferred), plus calldata for
 * BountyEscrow.withdraw(), which must be sent FROM that address.
 */
router.get('/withdrawable/:address', async (req, res) => {
  const { address } = req.params;
  if (!ethers.isAddress(address)) {
    return res.status(400).json({ success: false, error: 'Invalid address' });
  }
  try {
    const cs = getContractService();
    const wei = (await cs.contract.withdrawable(address)).toString();
    const iface = new ethers.Interface(['function withdraw()']);
    return res.json({
      success: true,
      address,
      withdrawableWei: wei,
      withdrawableEth: ethers.formatEther(wei),
      canWithdraw: wei !== '0',
      transaction: wei !== '0'
        ? { to: config.bountyEscrowAddress, data: iface.encodeFunctionData('withdraw', []), value: '0', chainId: config.chainId, gasLimit: '120000' }
        : null,
      contractCall: { method: 'withdraw', args: [], abi: 'function withdraw()' },
      note: 'withdraw() pays msg.sender, so the transaction must be sent from this address.'
    });
  } catch (error) {
    logger.error('[withdrawable] error', { address, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to read the pull ledger', details: error.message });
  }
});

/**
 * The calls that move a submission's v2 round, as ready-to-sign transactions. Anyone may send
 * each of them (the server's keeper usually does — utils/roundKeeper.js); every endpoint checks
 * the escrow lens's nextAction first, so it never hands out a transaction that would revert.
 *
 *   POST .../close-failed  closeFailedRound (escrow): a round with no result that can get none —
 *                          failed, cancelled, past its deadline, or undrawn for a day. The
 *                          submission then awaits a re-run, keeping its place and bond.
 *                          (.../timeout is the v1 name, kept as an alias.)
 *   POST .../draw          drawJury (escrow, through the submission's wallet, so the draw reward
 *                          is refunded to the round's funder): from two blocks after the start;
 *                          again after the beacon stage for a beacon bounty.
 *   POST .../round-step    whichever of draw / closeCommits / promote / closeFailedRound /
 *                          expireRerun moves the round on now (closeCommits and promote go to the
 *                          aggregator; the promote reward goes to whoever sends it).
 *   POST .../rerun         rerunSubmission (escrow, payable: requiredPrepay): the hunter or the
 *                          bond's funder, while the submission awaits a re-run (item 12).
 *   POST .../expire-rerun  expireRerun (escrow): a re-run not taken in its window; the bond goes back.
 */
const ROUND_STEP_CALLS = {
  DRAW: { target: 'escrow', method: 'drawJury', abi: 'function drawJury(uint256 bountyId, uint256 submissionId)' },
  CLOSE_COMMITS: { target: 'aggregator', method: 'closeCommits', abi: 'function closeCommits(bytes32 aggId)' },
  PROMOTE: { target: 'aggregator', method: 'promote', abi: 'function promote(bytes32 aggId)' },
  CLOSE_FAILED: { target: 'escrow', method: 'closeFailedRound', abi: 'function closeFailedRound(uint256 bountyId, uint256 submissionId)' },
  EXPIRE_RERUN: { target: 'escrow', method: 'expireRerun', abi: 'function expireRerun(uint256 bountyId, uint256 submissionId)' },
};

/** Load the job and the live round for a round endpoint; sends the error response and returns null on failure. */
async function loadRound(req, res, label) {
  const { jobId, submissionId } = req.params;
  const job = await jobStorage.getJob(jobId);
  if (rejectIfNotOnChain(res, job, jobId)) return null;
  const subId = parseInt(submissionId, 10);
  let cs;
  try {
    cs = getContractService();
  } catch (e) {
    res.status(503).json({ success: false, error: 'Blockchain service not available', details: e.message });
    return null;
  }
  let chainSub;
  try {
    chainSub = await cs.contract.getSubmission(job.jobId, subId);
  } catch (e) {
    res.status(404).json({ success: false, error: `Submission ${submissionId} not found on-chain for job ${jobId}`, details: e.message });
    return null;
  }
  const state = await cs.getRoundState(job.jobId, subId);
  if (state.error) {
    res.status(503).json({ success: false, error: 'Could not read the round state; retry shortly', details: state.error });
    return null;
  }
  logger.info(`[${label}] check`, { jobId, submissionId, nextAction: state.nextAction, phase: state.phaseName });
  return { job, cs, subId, chainSub, state, onChainBountyId: job.jobId, status: SUBMISSION_STATUSES[Number(chainSub.status)] };
}

/** The transaction for one round step; null data when it can't be encoded. */
async function roundStepTx(ctx, call, { value = '0' } = {}) {
  const iface = new ethers.Interface([call.abi]);
  let to = config.bountyEscrowAddress;
  let args = [ctx.onChainBountyId, ctx.subId];
  if (call.target === 'aggregator') {
    to = await ctx.cs.getAggregatorAddress();
    args = [ctx.chainSub.verdiktaAggId];
  }
  const data = iface.encodeFunctionData(call.method, args);
  // drawJury costs up to ~13.5M (50 jurors with beacons): its fallback is the per-tx cap.
  const gas = call.target === 'escrow'
    ? await resolveGasGuidance(data, undefined, call.method === 'drawJury' ? { fallbackLimit: DRAW_GAS_LIMIT_FALLBACK } : {})
    : null;
  return {
    transaction: { to, data, value, chainId: config.chainId, ...(gas ? { gasLimit: gas.gasLimit } : {}) },
    ...(gas ? { gas: { ...gas, note: RESOLVE_GAS_NOTE } } : {}),
    contractCall: { target: call.target, method: call.method, args: args.map(String), abi: call.abi }
  };
}

/** The reply when the asked-for step is not the one that will succeed now. */
function wrongStep(res, ctx, wanted, extra = {}) {
  const { jobId, submissionId } = { jobId: ctx.job.jobId, submissionId: ctx.subId };
  const next = ctx.state.nextAction;
  const pointers = {
    FINALIZE: `The round has a result: POST /api/jobs/${jobId}/submissions/${submissionId}/finalize.`,
    AWAIT_EARLIER: 'The round passes, but an earlier submission holds priority: see GET .../diagnose for blockedBy.',
    AWAIT_ORACLE: 'The round is in progress (beacons, commits or reveals): wait.',
    RERUN: `The submission awaits a re-run: POST /api/jobs/${jobId}/submissions/${submissionId}/rerun.`,
    AWAIT_EXPIRY: 'A re-run would revert (a lower-index round already passes); wait for the re-run window to close, then expire it.',
    START: 'The submission has not been started.',
    DONE: 'The submission is resolved.',
  };
  return res.status(400).json({
    success: false,
    error: `${wanted} is not the step that succeeds now`,
    nextAction: next,
    phase: ctx.state.phaseName,
    hint: pointers[next] || (ROUND_STEP_CALLS[next] ? `The step that succeeds now is ${next}: POST .../round-step.` : `nextAction is ${next}.`),
    ...extra
  });
}

async function closeFailedHandler(req, res) {
  const { jobId, submissionId } = req.params;
  try {
    const ctx = await loadRound(req, res, 'close-failed');
    if (!ctx) return;
    if (ctx.state.nextAction !== 'CLOSE_FAILED') {
      const gate = await ctx.cs.getCloseFailedEligibility(ctx.onChainBountyId, ctx.subId);
      return wrongStep(res, ctx, 'closeFailedRound', {
        canTimeout: false,
        canCloseFailed: false,
        canFinalize: gate.hasResult === true,
        onChainStatus: ctx.status,
        deadline: gate.deadline ?? null,
        remainingSeconds: gate.secondsUntilDeadline ?? null,
        closeFailed: gate
      });
    }
    const tx = await roundStepTx(ctx, ROUND_STEP_CALLS.CLOSE_FAILED);
    logger.info('[close-failed] conditions met', { jobId, submissionId, gasLimit: tx.transaction.gasLimit });
    return res.json({
      success: true,
      canTimeout: true,
      canCloseFailed: true,
      message: `The round has no result and can get none — closeFailedRound settles or cancels it, returns what is left of the prepay to the round's funder, and lets the submission re-run (it keeps its place and bond). Send it with transaction.gasLimit (${tx.transaction.gasLimit}): settling a round can need well over 1M gas, and a hand-picked lower limit fails with no revert reason.`,
      round: { phase: ctx.state.phaseName, deadline: ctx.state.deadline || null, rounds: ctx.state.rounds },
      ...tx,
      submission: { id: ctx.subId, hunter: ctx.chainSub.hunter, onChainStatus: ctx.status }
    });
  } catch (error) {
    logger.error('[close-failed] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({ success: false, canTimeout: false, error: 'Failed to prepare closeFailedRound', details: error.message });
  }
}
router.post('/:jobId/submissions/:submissionId/close-failed', closeFailedHandler);
router.post('/:jobId/submissions/:submissionId/timeout', closeFailedHandler);

router.post('/:jobId/submissions/:submissionId/draw', async (req, res) => {
  const { jobId, submissionId } = req.params;
  try {
    const ctx = await loadRound(req, res, 'draw');
    if (!ctx) return;
    if (ctx.state.nextAction !== 'DRAW') return wrongStep(res, ctx, 'drawJury');
    return res.json({
      success: true,
      message: ctx.state.phase === 2
        ? 'The beacon stage is over: this draws the jury (anyone may send it).'
        : 'This draws the jury as the submission\'s wallet, so the draw reward comes back to the round\'s funder (anyone may send it). For a beacon bounty the first draw starts the beacon stage; draw again when nextAction says DRAW.',
      ...(await roundStepTx(ctx, ROUND_STEP_CALLS.DRAW))
    });
  } catch (error) {
    logger.error('[draw] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare drawJury', details: error.message });
  }
});

router.post('/:jobId/submissions/:submissionId/round-step', async (req, res) => {
  const { jobId, submissionId } = req.params;
  try {
    const ctx = await loadRound(req, res, 'round-step');
    if (!ctx) return;
    const call = ROUND_STEP_CALLS[ctx.state.nextAction];
    if (!call) return wrongStep(res, ctx, 'A round step');
    return res.json({
      success: true,
      nextAction: ctx.state.nextAction,
      phase: ctx.state.phaseName,
      ...(await roundStepTx(ctx, call))
    });
  } catch (error) {
    logger.error('[round-step] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare the round step', details: error.message });
  }
});

router.post('/:jobId/submissions/:submissionId/rerun', async (req, res) => {
  const { jobId, submissionId } = req.params;
  try {
    const ctx = await loadRound(req, res, 'rerun');
    if (!ctx) return;
    if (ctx.state.nextAction !== 'RERUN') return wrongStep(res, ctx, 'rerunSubmission');
    const from = req.body?.hunter || req.body?.from;
    if (from && ethers.isAddress(from)) {
      const allowed = [ctx.chainSub.hunter, ctx.chainSub.bondFunder].map((a) => String(a).toLowerCase());
      if (!allowed.includes(String(from).toLowerCase())) {
        return res.status(403).json({ success: false, error: 'Only the hunter or the bond\'s funder may re-run (contract: "only hunter or funder")' });
      }
    }
    const prepay = (await ctx.cs.contract.requiredPrepay(ctx.onChainBountyId)).toString();
    const call = { target: 'escrow', method: 'rerunSubmission', abi: 'function rerunSubmission(uint256 bountyId, uint256 submissionId) payable' };
    return res.json({
      success: true,
      message: 'A new round with a fresh jury, from the same wallet: the submission keeps its index (payout priority) and its bond. Attach requiredPrepay as msg.value; the unspent part comes back to you. Draw it like the first round.',
      rerunDeadline: Number(ctx.chainSub.rerunDeadline),
      rounds: Number(ctx.chainSub.rounds),
      ...(await roundStepTx(ctx, call, { value: prepay }))
    });
  } catch (error) {
    logger.error('[rerun] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare rerunSubmission', details: error.message });
  }
});

router.post('/:jobId/submissions/:submissionId/expire-rerun', async (req, res) => {
  const { jobId, submissionId } = req.params;
  try {
    const ctx = await loadRound(req, res, 'expire-rerun');
    if (!ctx) return;
    if (ctx.state.nextAction !== 'EXPIRE_RERUN') return wrongStep(res, ctx, 'expireRerun');
    return res.json({
      success: true,
      message: 'The re-run window has closed (or the submission can no longer re-run): expireRerun fails it, returns the bond to its funder and frees its place in the payout queue. Anyone may send it.',
      ...(await roundStepTx(ctx, ROUND_STEP_CALLS.EXPIRE_RERUN))
    });
  } catch (error) {
    logger.error('[expire-rerun] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare expireRerun', details: error.message });
  }
});


/* =======================
   DIAGNOSE STUCK SUBMISSION
   ======================= */

// Probes a CID against the configured IPFS gateways using a tiny range GET
// (bytes=0-0) rather than HEAD, since some gateways are slow to populate HEAD
// metadata for newly-pinned large objects. Returns on the first gateway that
// answers with ok or a partial-content status; otherwise reports every attempt.
async function probeCidAccessibility(cid, perGatewayTimeoutMs = 10000) {
  const gateways = config.ipfsReadGateways;
  const attempts = [];
  for (const gateway of gateways) {
    const url = `${gateway}/ipfs/${cid}`;
    const startedAt = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(perGatewayTimeoutMs),
      });
      const elapsedMs = Date.now() - startedAt;
      const ok = resp.ok || resp.status === 206;
      attempts.push({ gateway, status: resp.status, elapsedMs, ok });
      if (ok) {
        try { await resp.body?.cancel?.(); } catch (_) { /* ignore */ }
        return { ok: true, gateway, attempts };
      }
    } catch (err) {
      attempts.push({
        gateway,
        status: null,
        elapsedMs: Date.now() - startedAt,
        ok: false,
        error: err.message,
      });
    }
  }
  return { ok: false, attempts };
}

/**
 * GET /api/jobs/:jobId/submissions/:submissionId/diagnose
 * Deep diagnostic for stuck submissions - checks on-chain state, CID accessibility, and Verdikta status.
 * Helps identify why a submission is stuck or why timeout is reverting.
 */
// Run bountyValidator for /diagnose. A fetch failure (bountyValidator's transient
// issue types) is reported as unverifiable rather than as a package fault, unless
// what did load already shows a deterministic package error. Returns null when
// no IPFS client is configured or the validator throws.
async function diagnosePackage(job, req) {
  const ipfsClient = req.app.locals.ipfsClient;
  if (!ipfsClient) return null;
  let classMap;
  try {
    classMap = require('@verdikta/common').classMap;
  } catch (e) {
    logger.warn('Could not load classMap for validation:', e.message);
  }
  try {
    const result = await validateBounty({ evaluationCid: job.evaluationCid, classId: job.classId, ipfsClient, classMap });
    const fetchFailure = result.issues.find(isTransientIssue);
    if (fetchFailure && !result.issues.some(isGatingIssue)) {
      return { ...result, unverifiable: true, unverifiableReason: fetchFailure.message };
    }
    return result;
  } catch (e) {
    logger.warn('[diagnose] validateBounty failed', { jobId: job.jobId, msg: e.message });
    return null;
  }
}

router.get('/:jobId/submissions/:submissionId/diagnose', async (req, res) => {
  const { jobId, submissionId } = req.params;

  const diagnosis = {
    jobId: parseInt(jobId),
    submissionId: parseInt(submissionId),
    checks: {},
    issues: [],
    recommendations: []
  };

  try {
    logger.info('[diagnose] start', { jobId, submissionId });

    // 1. Check local storage state
    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const localSub = job.submissions?.find(s => s.submissionId === subId);

    diagnosis.checks.localStorage = {
      found: !!localSub,
      status: localSub?.status || null,
      submittedAt: localSub?.submittedAt || null,
      hunterCid: localSub?.hunterCid || null,
      evalWallet: localSub?.evalWallet || null,
      verdiktaAggId: localSub?.verdiktaAggId || null
    };

    if (!localSub) {
      diagnosis.issues.push('Submission not found in local storage');
    }

    // 2. Check on-chain state
    const onChainBountyId = job.jobId;
    diagnosis.checks.onChainIds = {
      bountyId: onChainBountyId,
      submissionId: subId
    };

    if (!job.onChain && !job.syncedFromBlockchain) {
      diagnosis.issues.push('Job not linked to on-chain bounty');
      diagnosis.recommendations.push('Link job to on-chain bounty ID');
    } else {
      try {
        const cs = getContractService();
        const contract = cs.contract;

        const chainSub = await contract.getSubmission(onChainBountyId, subId);

        const chainStatus = SUBMISSION_STATUSES[Number(chainSub.status)] || `Unknown(${chainSub.status})`;

        const submittedAtChain = Number(chainSub.submittedAt);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const elapsedSeconds = nowSeconds - submittedAtChain;
        // v2: the round as the escrow's lens reports it — its phase, its result judged by item 12's
        // Q-of-N rule, and the call that moves it on now (nextAction). No timer anywhere: a dead
        // round is closed (closeFailedRound) once the aggregator says it can get no result.
        let round = null;
        if (Number(chainSub.status) === 1) round = await cs.getRoundState(onChainBountyId, subId);
        const closeFailedEligible = round?.nextAction === 'CLOSE_FAILED';

        diagnosis.checks.onChain = {
          found: true,
          hunter: chainSub.hunter,
          status: chainStatus,
          statusCode: Number(chainSub.status),
          evaluationCid: job.evaluationCid,
          hunterCid: chainSub.hunterCid,
          evalWallet: chainSub.evalWallet,
          verdiktaAggId: chainSub.verdiktaAggId,
          funder: chainSub.funder,
          bondFunder: chainSub.bondFunder,
          bondHeldWei: (chainSub.bondHeld ?? 0n).toString(),
          rounds: Number(chainSub.rounds ?? 0),
          passCount: Number(chainSub.passCount ?? 0),
          rerunDeadline: Number(chainSub.rerunDeadline ?? 0) || null,
          submittedAt: submittedAtChain,
          submittedAtISO: new Date(submittedAtChain * 1000).toISOString(),
          finalizedAt: Number(chainSub.finalizedAt),
          acceptance: Number(chainSub.acceptance),
          rejection: Number(chainSub.rejection),
          elapsedMinutes: Math.floor(elapsedSeconds / 60),
          elapsedSeconds,
          round: round && !round.error ? {
            phase: round.phaseName, phaseCode: round.phase, outcome: round.outcome, passCount: round.passCount,
            deadline: round.deadline || null, deadlineISO: round.deadline ? new Date(round.deadline * 1000).toISOString() : null,
            requestTime: round.requestTime || null, nextAction: round.nextAction
          } : (round?.error ? { error: round.error } : null),
          closeFailedEligible,
          // v1 name, kept
          timeoutEligible: closeFailedEligible,
          roundNote:
            'A v2 round is drawn (drawJury, from two blocks after the start), commits, is promoted, then revealed. Anyone may send each step (the server\'s keeper usually does): POST .../round-step returns the one that succeeds now. A round with no result that can get none is closed with closeFailedRound; the submission then awaits a re-run, keeping its place and bond.'
        };

        // Analyze on-chain state
        if (chainStatus === 'Prepared') {
          diagnosis.issues.push('Submission is still in Prepared state - startPreparedSubmission was never called');
          diagnosis.recommendations.push('Call startPreparedSubmission (payable — attach the live startValue(bountyId): the prepay plus the hunter bond; POST /start returns it as transaction.value) to begin evaluation');
        } else if (chainStatus === 'AwaitingRerun') {
          const rerunDeadline = Number(chainSub.rerunDeadline);
          const action = String(await contract.nextAction(onChainBountyId, subId));
          diagnosis.checks.onChain.nextAction = action;
          diagnosis.checks.rerun = {
            rerunDeadline, rerunDeadlineISO: new Date(rerunDeadline * 1000).toISOString(),
            secondsRemaining: Math.max(0, rerunDeadline - nowSeconds), rounds: Number(chainSub.rounds), maxRounds: 6
          };
          if (action === 'RERUN') {
            diagnosis.recommendations.push(`The last round soft-failed or had no result. Re-run it (the hunter or the bond's funder): POST /api/jobs/${jobId}/submissions/${subId}/rerun, before ${new Date(rerunDeadline * 1000).toISOString()}. It keeps its place and bond.`);
          } else if (action === 'EXPIRE_RERUN') {
            diagnosis.recommendations.push(`The re-run window has closed: anyone may expire it — POST /api/jobs/${jobId}/submissions/${subId}/expire-rerun (returns the bond, frees the place).`);
          } else if (action === 'AWAIT_EXPIRY') {
            diagnosis.recommendations.push('An earlier submission of this bounty already passes, so a re-run would revert; once the re-run window closes, anyone may expire this submission.');
          } else {
            diagnosis.recommendations.push(`nextAction is ${action}.`);
          }
        } else if (chainStatus === 'PendingVerdikta') {
          if (!chainSub.verdiktaAggId || chainSub.verdiktaAggId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            diagnosis.issues.push('PendingVerdikta but no verdiktaAggId - evaluation may not have started properly');
          } else if (!round || round.error) {
            diagnosis.checks.oracleResult = { complete: false, error: round?.error || 'unreadable' };
            diagnosis.recommendations.push('Could not read the round state. Retry /diagnose shortly.');
          } else {
            diagnosis.checks.verdiktaAggId = chainSub.verdiktaAggId;
            if (round.hasResult) {
              const d = jobDecisionSettings(job);
              diagnosis.checks.oracleResult = {
                complete: true,
                acceptance: round.scores ? round.scores.acceptance : 0,
                rejection: round.scores ? round.scores.rejection : 0,
                threshold: job.threshold || 0,
                outcome: round.outcome,
                passCount: round.passCount,
                quota: d.quota,
                forfeitLine: d.forfeitLine,
                passed: round.outcome === 'pass'
              };
              diagnosis.recommendations.push({
                pass: 'The round PASSED (Q of N at the threshold) — call finalizeSubmission to claim the bounty (and the bond back)',
                soft_fail: 'The round soft-failed (R..Q-1 at the threshold) — call finalizeSubmission; the submission then awaits a re-run, keeping its place and bond',
                hard_fail: 'The round hard-failed (fewer than R at the threshold) — finalizeSubmission fails the submission and the bond goes to the creator',
                no_result: 'The round\'s result is unusable — call finalizeSubmission; the submission then awaits a re-run, keeping its place and bond'
              }[round.outcome] || 'Call finalizeSubmission.');
            } else {
              diagnosis.checks.oracleResult = { complete: false, phase: round.phaseName };

              // A dead round in which no drawn juror committed often means the evaluation package
              // is unusable (mirrors example-arbiters' "likely malformed" rule). It can also be a
              // jury model the arbiters don't serve or no live operator for the class, so the
              // package is checked before blaming it. Only dead rounds are inspected.
              let aggHistory = null;
              if (closeFailedEligible && isVerdiktaServiceAvailable()) {
                try {
                  const aggregator = await cs.getAggregatorAddress();
                  aggHistory = await getVerdiktaService().getAggHistory(chainSub.verdiktaAggId, { aggregator });
                } catch (aggHistErr) {
                  logger.warn('[diagnose] getAggHistory failed', { jobId, submissionId, msg: aggHistErr.message });
                }
              }

              if (closeFailedEligible) {
                diagnosis.recommendations.push(
                  `The round has no result and can get none — call POST /api/jobs/${jobId}/submissions/${subId}/close-failed (or closeFailedRound on-chain; anyone). It settles or cancels the round, returns what is left of the prepay, and the submission may then re-run with its place and bond.`
                );
                if (aggHistory?.found && aggHistory.outcome === LIKELY_MALFORMED_OUTCOME) {
                  const totalSlots = aggHistory.analysis.totalSlots;
                  diagnosis.checks.aggHistory = {
                    outcome: aggHistory.outcome,
                    totalSlots,
                    committed: aggHistory.analysis.committed,
                    likelyMalformed: true
                  };
                  const packageCheck = await diagnosePackage(job, req);
                  diagnosis.checks.packageValidation = packageCheck;
                  const noCommits = `No arbiter committed (0 of ${totalSlots} drawn jurors).`;

                  if (packageCheck?.unverifiable) {
                    diagnosis.issues.push(
                      `${noCommits} This often means the evaluation package is malformed, but the package could not be fetched to check it (${packageCheck.unverifiableReason}).`
                    );
                    diagnosis.recommendations.push(`Check the evaluation package: GET /api/jobs/${jobId}/validate`);
                  } else if (packageCheck && !packageCheck.valid) {
                    diagnosis.issues.push(`${noCommits} The evaluation package fails validation, the likely cause:`);
                    for (const issue of packageCheck.issues.filter(i => i.severity === IssueSeverity.ERROR && !isTransientIssue(i))) {
                      diagnosis.issues.push(`Evaluation package: ${issue.message}`);
                    }
                    diagnosis.recommendations.push(
                      `Do not re-run or resubmit to this bounty until the package problem is resolved: every round will fail the same way. Details: GET /api/jobs/${jobId}/validate`
                    );
                  } else if (packageCheck) {
                    diagnosis.issues.push(
                      `${noCommits} The evaluation package passes validation, so the cause is more likely on the oracle side: a jury model the arbiters don't serve, or no live operator for class ${job.classId}.`
                    );
                  } else {
                    diagnosis.issues.push(`${noCommits} This often means the evaluation package is malformed.`);
                    diagnosis.recommendations.push(`Check the evaluation package: GET /api/jobs/${jobId}/validate`);
                  }
                }
              } else if (['DRAW', 'CLOSE_COMMITS', 'PROMOTE'].includes(round.nextAction)) {
                diagnosis.recommendations.push(
                  `The round (${round.phaseName} phase) needs its next step: ${round.nextAction}. Anyone may send it — POST /api/jobs/${jobId}/submissions/${subId}/round-step returns it (the server's keeper usually sends it within a sync cycle).`
                );
              } else {
                diagnosis.recommendations.push(
                  round.deadline
                    ? `The round is in progress (${round.phaseName} phase). If it has no result by its deadline (${new Date(round.deadline * 1000).toISOString()}, in ${Math.max(0, round.deadline - nowSeconds)}s), anyone may close it.`
                    : `The round is in progress (${round.phaseName} phase).`
                );
              }
            }
          }
        } else if (chainStatus === 'PendingCreatorApproval') {
          const windowEnd = Number(chainSub.creatorWindowEnd);
          const windowOpen = windowEnd > nowSeconds;

          diagnosis.checks.creatorApprovalWindow = {
            windowEnd,
            windowEndISO: new Date(windowEnd * 1000).toISOString(),
            windowOpen,
            secondsRemaining: windowOpen ? windowEnd - nowSeconds : 0
          };

          if (windowOpen) {
            diagnosis.recommendations.push(
              `Creator approval window is open until ${new Date(windowEnd * 1000).toISOString()} (${Math.ceil((windowEnd - nowSeconds) / 60)} min remaining). ` +
              `The bounty creator can approve via POST /api/jobs/${jobId}/submissions/${subId}/approve-as-creator, ` +
              `or wait for the window to expire and then call POST /api/jobs/${jobId}/submissions/${subId}/start.`
            );
          } else {
            diagnosis.recommendations.push(
              `Creator approval window has expired. Call POST /api/jobs/${jobId}/submissions/${subId}/start to begin oracle evaluation (attach the live requiredPrepay as msg.value — the /start transaction.value)`
            );
          }
        } else if (chainStatus === 'Failed' || chainStatus === 'PassedPaid' || chainStatus === 'PassedUnpaid') {
          diagnosis.issues.push(`Submission already finalized with status: ${chainStatus}`);
          diagnosis.recommendations.push('No action needed - submission is complete');
        }

      } catch (chainErr) {
        diagnosis.checks.onChain = { found: false, error: chainErr.message };
        diagnosis.issues.push(`Failed to read on-chain state: ${chainErr.message}`);
      }
    }

    // 3. Check CID accessibility (backend-side probe — see note below).
    // NOTE: These probes use OUR own backend HTTP fetch against the configured
    // IPFS gateways. A failure here means the bounty-program backend could not
    // reach the gateway within the timeout — it does NOT, on its own, prove the
    // Verdikta oracle failed to fetch the CID. Oracle-side fetch failures
    // happen in a separate service and surface through the evaluation result
    // or a 10-minute timeout window, not through this probe.
    const ipfsClient = req.app.locals.ipfsClient;
    if (ipfsClient && localSub?.hunterCid) {
      const probe = await probeCidAccessibility(localSub.hunterCid);
      diagnosis.checks.hunterCidAccessible = probe.ok;
      diagnosis.checks.hunterCidProbe = {
        note: 'Backend-side gateway probe — not an oracle-side check',
        servedBy: probe.gateway || null,
        attempts: probe.attempts,
      };
      if (!probe.ok) {
        diagnosis.issues.push(
          `Backend gateway probe for hunterCid did not succeed against any configured gateway ` +
          `(${probe.attempts.map(a => a.gateway).join(', ')}). This is a backend reachability check, ` +
          `not an oracle failure. The oracle may still have fetched the CID successfully.`
        );
        diagnosis.recommendations.push(
          'Verify hunterCid is pinned (GET via gateway.pinata.cloud directly). ' +
          'If the CID resolves externally, the backend probe likely hit a transient gateway slowdown and can be ignored.'
        );
      }
    }

    // 4. Check evaluation CID (backend-side probe — same caveat as hunterCid).
    if (job.evaluationCid) {
      const probe = await probeCidAccessibility(job.evaluationCid);
      diagnosis.checks.evaluationCidAccessible = probe.ok;
      diagnosis.checks.evaluationCidProbe = {
        note: 'Backend-side gateway probe — not an oracle-side check',
        servedBy: probe.gateway || null,
        attempts: probe.attempts,
      };
      if (!probe.ok) {
        diagnosis.issues.push(
          `Backend gateway probe for evaluationCid did not succeed against any configured gateway ` +
          `(${probe.attempts.map(a => a.gateway).join(', ')}). This is a backend reachability check, ` +
          `not an oracle failure.`
        );
        diagnosis.recommendations.push(
          'Verify evaluationCid (evaluation package) is pinned. ' +
          'If it resolves externally, the backend probe likely hit a transient gateway slowdown.'
        );
      }
    }

    // 5. Summary
    diagnosis.summary = {
      issueCount: diagnosis.issues.length,
      status: diagnosis.issues.length === 0 ? 'healthy' : 'issues_found',
      canTimeout: diagnosis.checks.onChain?.status === 'PendingVerdikta' &&
                  diagnosis.checks.onChain?.timeoutEligible === true
    };

    // The contract's own verdict on what to do next (see BountyEscrow.nextAction):
    // START | AWAIT_SLOT | AWAIT_CREATOR | DRAW | CLOSE_COMMITS | PROMOTE | AWAIT_ORACLE |
    // AWAIT_EARLIER | FINALIZE | CLOSE_FAILED | RERUN | AWAIT_EXPIRY | EXPIRE_RERUN |
    // RECOVER_REFUND | DONE | DEAD. For AWAIT_EARLIER, blockedBy lists the
    // earlier submissions holding payout priority and the calls that resolve them.
    try {
      if (job && job.onChain !== false && Number.isInteger(Number(job.jobId))) {
        diagnosis.nextAction = await getContractService().contract.nextAction(Number(job.jobId), Number(submissionId));
      }
    } catch (e) {
      diagnosis.nextAction = null;
    }
    if (diagnosis.nextAction === 'AWAIT_EARLIER') {
      const blockers = await finalizeBlockersFor(Number(job.jobId), Number(submissionId), diagnosis.checks?.onChain?.hunter);
      if (blockers) {
        diagnosis.blockedBy = blockers.blockedBy;
        if (blockers.hint) diagnosis.recommendations.push(blockers.hint);
      }
    }

    return res.json({ success: true, diagnosis });

  } catch (error) {
    logger.error('[diagnose] error', { jobId, submissionId, msg: error.message });
    return res.status(500).json({
      success: false,
      error: 'Diagnosis failed',
      details: error.message,
      partialDiagnosis: diagnosis
    });
  }
});


/* =======================
   GET EVALUATION REPORT (Agent-friendly endpoint)
   ======================= */

/**
 * GET /api/jobs/:jobId/submissions/:submissionId/evaluation
 * Returns the AI evaluation report for a submission.
 * Fetches justification content from IPFS so agents don't need direct IPFS access.
 *
 * Response includes:
 * - scores: acceptance/rejection scores and pass/fail status
 * - evaluation: The parsed AI evaluation report (criteria scores, feedback, etc.)
 * - meta: Submission and job context
 */
router.get('/:jobId/submissions/:submissionId/evaluation', async (req, res) => {
  const { jobId, submissionId } = req.params;

  try {
    logger.info('[evaluation] get', { jobId, submissionId });

    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const submission = job.submissions?.find(s => s.submissionId === subId);

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found',
        details: `No submission with ID ${submissionId} found for job ${jobId}`
      });
    }

    // Check if evaluation is complete (includes oracle-complete-but-not-finalized statuses)
    const hasEvaluation = submission.status === 'APPROVED' ||
                          submission.status === 'REJECTED' ||
                          submission.status === 'PassedPaid' ||
                          submission.status === 'PassedUnpaid' ||
                          submission.status === 'Failed' ||
                          submission.status === 'ACCEPTED_PENDING_CLAIM' ||
                          submission.status === 'REJECTED_PENDING_FINALIZATION';

    if (!hasEvaluation) {
      return res.status(400).json({
        success: false,
        error: 'Evaluation not complete',
        details: `Submission status is "${submission.status}". Evaluation results are only available after evaluation completes.`,
        status: submission.status,
        hint: 'Use POST /api/jobs/:jobId/submissions/:submissionId/refresh to check for updates'
      });
    }

    // Build scores response
    const scores = {
      acceptance: submission.acceptance ?? submission.score ?? null,
      rejection: submission.rejection ?? null,
      threshold: job.threshold,
      passed: (submission.acceptance ?? submission.score ?? 0) >= job.threshold,
      status: submission.status,
      failureReason: submission.failureReason || null
    };

    // Check if we have justification CIDs to fetch
    const justificationCids = submission.justificationCids;
    const evaluationCid = submission.evaluationCid;

    if (!justificationCids && !evaluationCid) {
      // No detailed evaluation available (e.g., oracle timeout)
      return res.json({
        success: true,
        scores,
        evaluation: null,
        evaluationAvailable: false,
        message: scores.failureReason === 'ORACLE_TIMEOUT'
          ? 'No evaluation report available - oracle timeout occurred'
          : 'No detailed evaluation report available',
        meta: {
          jobId: job.jobId,
          submissionId: subId,
          hunter: submission.hunter,
          submittedAt: submission.submittedAt,
          finalizedAt: submission.finalizedAt
        }
      });
    }

    // Fetch evaluation content from IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        success: false,
        error: 'IPFS client not available',
        scores, // Still return scores even if IPFS fails
        justificationCids,
        evaluationCid,
        hint: 'Scores are available but detailed report requires IPFS'
      });
    }

    let evaluationContent = null;
    let fetchedFrom = null;

    // Try justificationCids first (contains the detailed AI feedback)
    if (justificationCids) {
      // justificationCids might be a single CID or comma-separated list
      const cids = justificationCids.split(',').map(c => c.trim()).filter(Boolean);

      for (const cid of cids) {
        try {
          const rawContent = await withTimeout(
            ipfsClient.fetchFromIPFS(cid),
            PIN_TIMEOUT_MS,
            'IPFS evaluation fetch'
          );

          // Try to parse as JSON
          try {
            const parsed = JSON.parse(rawContent);
            if (!evaluationContent) {
              evaluationContent = parsed;
              fetchedFrom = cid;
            } else if (Array.isArray(evaluationContent)) {
              evaluationContent.push(parsed);
            } else {
              evaluationContent = [evaluationContent, parsed];
            }
          } catch {
            // Not JSON, store as raw text
            if (!evaluationContent) {
              evaluationContent = { raw: rawContent, cid };
              fetchedFrom = cid;
            }
          }
        } catch (ipfsErr) {
          logger.warn('[evaluation] Failed to fetch justification CID', { cid, msg: ipfsErr.message });
        }
      }
    }

    // Fallback to evaluationCid if no justification content
    if (!evaluationContent && evaluationCid) {
      try {
        const rawContent = await withTimeout(
          ipfsClient.fetchFromIPFS(evaluationCid),
          PIN_TIMEOUT_MS,
          'IPFS evaluation fetch'
        );
        try {
          evaluationContent = JSON.parse(rawContent);
          fetchedFrom = evaluationCid;
        } catch {
          evaluationContent = { raw: rawContent, cid: evaluationCid };
          fetchedFrom = evaluationCid;
        }
      } catch (ipfsErr) {
        logger.warn('[evaluation] Failed to fetch evaluation CID', { cid: evaluationCid, msg: ipfsErr.message });
      }
    }

    if (!evaluationContent) {
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch evaluation from IPFS',
        scores, // Still return scores
        justificationCids,
        evaluationCid,
        hint: 'You can try fetching directly from IPFS gateway using the CIDs above'
      });
    }

    // Surface any oracle warnings (esp. attachment_skipped — a file the models never
    // saw) at the top level so agents don't have to dig through the raw report.
    const oracleWarnings = extractEvaluationWarnings(evaluationContent);

    return res.json({
      success: true,
      untrustedContent: untrustedContent(['evaluation', 'warnings', 'meta.jobTitle']),
      scores,
      evaluation: evaluationContent,
      evaluationAvailable: true,
      warnings: oracleWarnings,
      ...(oracleWarnings.length > 0 ? {
        warningsNote: 'The oracle reported warnings for this submission. An "attachment_skipped" entry means a file was NOT seen by the models — a common cause of an unexpectedly low/zero score.'
      } : {}),
      fetchedFrom,
      meta: {
        jobId: job.jobId,
        jobTitle: job.title,
        submissionId: subId,
        hunter: submission.hunter,
        hunterCid: submission.hunterCid,
        submittedAt: submission.submittedAt,
        finalizedAt: submission.finalizedAt,
        justificationCids,
        evaluationCid
      }
    });

  } catch (error) {
    logger.error('[evaluation] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to get evaluation', details: error.message });
  }
});


/* =======================
   GET SUBMISSION CONTENT (Agent-friendly endpoint)
   ======================= */

/**
 * GET /api/jobs/:jobId/submissions/:submissionId/content
 * Returns the submission content (manifest, narrative, file list).
 * Fetches the hunter submission archive from IPFS and extracts metadata.
 *
 * Query params:
 * - includeFileContent=true: Include base64-encoded file content (for small text files only)
 * - file=<filename>: Return only a specific file's content
 *
 * Response includes:
 * - manifest: The submission manifest with file metadata
 * - narrative: The submission narrative (from primary_query.json)
 * - files: List of files with names, sizes, types
 * - meta: Submission and job context
 */
router.get('/:jobId/submissions/:submissionId/content', async (req, res) => {
  const { jobId, submissionId } = req.params;
  const { includeFileContent, file: requestedFile } = req.query;

  try {
    logger.info('[content] get', { jobId, submissionId, includeFileContent, requestedFile });

    const job = await jobStorage.getJob(jobId);
    const subId = parseInt(submissionId, 10);
    const submission = job.submissions?.find(s => s.submissionId === subId);

    if (!submission) {
      return res.status(404).json({
        success: false,
        error: 'Submission not found',
        details: `No submission with ID ${submissionId} found for job ${jobId}`
      });
    }

    const hunterCid = submission.hunterCid;
    if (!hunterCid) {
      return res.status(404).json({
        success: false,
        error: 'No submission content available',
        details: 'This submission does not have a hunterCid (no uploaded content)'
      });
    }

    // Fetch the submission archive from IPFS
    const ipfsClient = req.app.locals.ipfsClient;
    if (!ipfsClient) {
      return res.status(500).json({
        success: false,
        error: 'IPFS client not available',
        hunterCid,
        hint: 'You can fetch directly from IPFS gateway'
      });
    }

    let archiveBuffer;
    try {
      // fetchFromIPFS returns string, but we need buffer for ZIP
      // Try to get raw buffer if available, otherwise use gateway URL
      const gatewayUrl = `${process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'}/ipfs/${hunterCid}`;
      const response = await withTimeout(
        fetch(gatewayUrl),
        PIN_TIMEOUT_MS * 2, // Give more time for archive download
        'IPFS archive fetch'
      );

      if (!response.ok) {
        throw new Error(`Gateway returned ${response.status}`);
      }

      // capped: hunterCid is whatever the hunter put on chain; any archive the site accepts is readable
      archiveBuffer = await readBodyCapped(response, Math.max(archiveShapeValidator.MAX_ARCHIVE_BYTES, DEFAULT_CONTENT_READ_BYTES));
      logger.info('[content] Archive fetched', { jobId, submissionId, size: archiveBuffer.length });
    } catch (ipfsErr) {
      logger.error('[content] Failed to fetch archive', { hunterCid, msg: ipfsErr.message });
      return res.status(502).json({
        success: false,
        error: 'Failed to fetch submission archive from IPFS',
        details: ipfsErr.message,
        hunterCid,
        hint: 'You can try fetching directly from IPFS gateway'
      });
    }

    // Extract archive contents
    let zip;
    try {
      zip = new AdmZip(archiveBuffer);
    } catch (zipErr) {
      logger.error('[content] Failed to parse archive', { hunterCid, msg: zipErr.message });
      return res.status(500).json({
        success: false,
        error: 'Failed to parse submission archive',
        details: 'The archive may be corrupted or not a valid ZIP file',
        hunterCid
      });
    }

    const zipEntries = zip.getEntries();

    // Parse manifest.json
    let manifest = null;
    const manifestEntry = zipEntries.find(e => e.entryName === 'manifest.json');
    if (manifestEntry) {
      try {
        manifest = JSON.parse(readEntry(manifestEntry).toString('utf8'));
      } catch (e) {
        logger.warn('[content] Failed to parse manifest.json', { msg: e.message });
      }
    }

    // Parse primary_query.json (contains narrative)
    let narrative = null;
    const queryEntry = zipEntries.find(e => e.entryName === 'primary_query.json');
    if (queryEntry) {
      try {
        const queryData = JSON.parse(readEntry(queryEntry).toString('utf8'));
        narrative = queryData.query || null;
      } catch (e) {
        logger.warn('[content] Failed to parse primary_query.json', { msg: e.message });
      }
    }

    // List submission files
    const submissionFiles = zipEntries
      .filter(e => e.entryName.startsWith('submission/') && !e.isDirectory)
      .map(e => {
        const filename = e.entryName.replace('submission/', '');
        const fileInfo = manifest?.additional?.find(a => a.filename === e.entryName || a.filename === `submission/${filename}`);

        return {
          filename,
          path: e.entryName,
          size: e.header.size,
          compressedSize: e.header.compressedSize,
          type: fileInfo?.type || 'application/octet-stream',
          description: fileInfo?.description || null
        };
      });

    // If a specific file was requested, return just that file
    if (requestedFile) {
      const fileEntry = zipEntries.find(e =>
        e.entryName === `submission/${requestedFile}` ||
        e.entryName === requestedFile
      );

      if (!fileEntry) {
        return res.status(404).json({
          success: false,
          error: 'File not found in submission',
          details: 'No file with that name was found in the submission archive',
          availableFiles: submissionFiles.map(f => f.filename)
        });
      }

      const fileData = readEntry(fileEntry);
      const fileInfo = submissionFiles.find(f => f.filename === requestedFile || f.path === fileEntry.entryName);

      // For text files, return as string; for binary, return base64
      const isTextFile = /\.(txt|md|json|js|ts|py|sol|html|css|xml|yaml|yml|csv|log)$/i.test(requestedFile);

      return res.json({
        success: true,
        untrustedContent: untrustedContent(['file']),
        file: {
          ...fileInfo,
          content: isTextFile ? fileData.toString('utf8') : fileData.toString('base64'),
          encoding: isTextFile ? 'utf8' : 'base64'
        },
        meta: {
          jobId: job.jobId,
          submissionId: subId,
          hunterCid
        }
      });
    }

    // Build response with optional file content
    const filesWithContent = includeFileContent === 'true'
      ? submissionFiles.map(f => {
          const entry = zipEntries.find(e => e.entryName === f.path);
          if (!entry) return f;

          // Only include content for small text files (< 100KB)
          const isSmallTextFile = f.size < 100000 &&
            /\.(txt|md|json|js|ts|py|sol|html|css|xml|yaml|yml|csv)$/i.test(f.filename);

          if (isSmallTextFile) {
            return {
              ...f,
              content: readEntry(entry).toString('utf8'),
              encoding: 'utf8'
            };
          }

          return {
            ...f,
            content: null,
            contentNote: f.size >= 100000 ? 'File too large' : 'Binary file - use ?file=<filename> to fetch'
          };
        })
      : submissionFiles;

    return res.json({
      success: true,
      untrustedContent: untrustedContent(['manifest', 'narrative', 'files', 'meta.jobTitle']),
      manifest,
      narrative,
      files: filesWithContent,
      fileCount: submissionFiles.length,
      totalSize: submissionFiles.reduce((sum, f) => sum + f.size, 0),
      meta: {
        jobId: job.jobId,
        jobTitle: job.title,
        submissionId: subId,
        hunter: submission.hunter,
        hunterCid,
        submittedAt: submission.submittedAt,
        status: submission.status
      }
    });

  } catch (error) {
    logger.error('[content] error', { jobId, submissionId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to get submission content', details: error.message });
  }
});


/* =======================
   ESTIMATE SUBMISSION FEE (Agent-friendly endpoint)
   ======================= */

/**
 * GET /api/jobs/:jobId/estimate-fee
 * POST /api/jobs/estimate-fee (with custom jury config)
 *
 * Estimates the ETH cost for submitting to a bounty (the oracle prepay).
 * This helps agents budget before committing to a submission.
 *
 * The fee depends on:
 * - Number of AI models in the jury
 * - Number of runs per model
 * - Number of iterations
 * - Current max oracle fee from Verdikta aggregator
 *
 * Response includes:
 * - estimatedEthCost: Estimated ETH prepay needed (usually spent in full; any unspent part is refunded after the eval)
 * - breakdown: How the estimate was calculated
 * - parameters: Fee parameters to use in prepareSubmission
 */
router.get('/:jobId/estimate-fee', async (req, res) => {
  const { jobId } = req.params;

  try {
    logger.info('[estimate-fee] get', { jobId });

    const job = await jobStorage.getJob(jobId);

    // Get jury configuration from the job
    const juryNodes = job.juryNodes || [];
    const iterations = job.iterations || 1;

    // Calculate the fee estimate under the bounty's own oracle settings
    const oracleSettings = jobOracleSettings(job);
    const estimate = await calculateFeeEstimate(juryNodes, iterations, oracleSettings, jobDecisionSettings(job));

    return res.json({
      success: true,
      ...estimate,
      oracleSettings,
      meta: {
        jobId: job.jobId,
        title: job.title,
        classId: job.classId,
        juryNodes: juryNodes.length,
        iterations
      }
    });

  } catch (error) {
    logger.error('[estimate-fee] error', { jobId, msg: error.message });
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, error: 'Job not found', details: error.message });
    }
    return res.status(500).json({ success: false, error: 'Failed to estimate fee', details: error.message });
  }
});

/**
 * POST /api/jobs/estimate-fee
 * Estimate fee with custom jury configuration (without needing a job)
 *
 * Body:
 * - juryNodes: Array of {provider, model, runs, weight}
 * - iterations: Number of evaluation iterations (default: 1)
 */
router.post('/estimate-fee', async (req, res) => {
  try {
    const { juryNodes = [], iterations = 1 } = req.body;

    logger.info('[estimate-fee] post', { juryNodesCount: juryNodes.length, iterations });

    if (!Array.isArray(juryNodes) || juryNodes.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid jury configuration',
        details: 'juryNodes must be a non-empty array'
      });
    }

    const estimate = await calculateFeeEstimate(juryNodes, iterations);

    return res.json({
      success: true,
      ...estimate,
      meta: {
        juryNodes: juryNodes.length,
        iterations
      }
    });

  } catch (error) {
    logger.error('[estimate-fee] error', { msg: error.message });
    return res.status(500).json({ success: false, error: 'Failed to estimate fee', details: error.message });
  }
});

/**
 * Estimate one round's prepay (v2): the aggregator's own quote,
 *   maxTotalFee(maxFee, minFee, withBeacons, K, P) = juror x (K + B x P [+ beacon quorum]) + eff x (draw + promote rewards),
 * eff = min(maxFee, ceiling), juror = max(eff, minFee), for the bounty's jury. That is exactly what
 * a start escrows (startValue adds the hunter bond); the unspent part is refunded when the round
 * resolves. The jury models (juryNodes, iterations) run inside each arbiter and do not change it.
 *
 * @param juryNodes, iterations  reported back only (v1 multiplied the fee by them)
 * @param oracleSettings  the bounty's settings ({maxOracleFee, minOracleFee, withBeacons, ...} in wei);
 *   server defaults otherwise
 * @param decision  { jury: {K, M, N, P, timeout}, bond (wei string) }; the Small jury and no bond otherwise
 */
async function calculateFeeEstimate(juryNodes, iterations, oracleSettings = null, decision = null) {
  const maxFeeWei = BigInt(String(oracleSettings?.maxOracleFee ?? config.submissionDefaults.maxOracleFeeWei));
  const minFeeWei = BigInt(String(oracleSettings?.minOracleFee ?? '0'));
  const withBeacons = Boolean(oracleSettings?.withBeacons);
  const jury = decision?.jury && typeof decision.jury === 'object' && Number(decision.jury.K) > 0
    ? decision.jury
    : presetByKey('small').jury;
  const bondWei = BigInt(String(decision?.bond ?? '0'));

  // The live quote for the bounty's jury, when the aggregator can be read; v2 defaults otherwise
  // (bonus 3, rewards 2 + 1, a 2-value beacon quorum, a 0.0004 ETH ceiling).
  let shape = { bonusMultiplier: 3, maxOracleFee: '0.0004' };
  let quoteWei = null;
  let aggregatorConfigAvailable = false;
  if (isVerdiktaServiceAvailable()) {
    try {
      const vs = getVerdiktaService();
      shape = await vs.getAggregatorConfig();
      quoteWei = BigInt(await vs.aggregator.maxTotalFee(maxFeeWei, minFeeWei, withBeacons, jury.K, jury.P));
      aggregatorConfigAvailable = true;
    } catch (err) {
      logger.warn('[estimate-fee] Could not read the aggregator', { msg: err.message });
    }
  }
  const ceilingWei = ethers.parseEther(String(shape.maxOracleFee || '0.0004'));
  const effWei = maxFeeWei < ceilingWei ? maxFeeWei : ceilingWei;
  const jurorWei = minFeeWei > effWei ? minFeeWei : effWei;
  const slots = BigInt(jury.K) + BigInt(shape.bonusMultiplier) * BigInt(jury.P) + (withBeacons ? 2n : 0n);
  if (quoteWei == null) quoteWei = jurorWei * slots + effWei * 3n;
  // The least a finished round spends: the K base fees (+ 2 beacon values) — bonuses and rewards
  // only go to arbiters who earn them, and the rest comes back.
  const minAttemptWei = jurorWei * (BigInt(jury.K) + (withBeacons ? 2n : 0n));

  let totalCalls = 0;
  for (const node of juryNodes || []) totalCalls += node.runs || 1;
  totalCalls *= iterations || 1;

  const eth = (w) => Number(ethers.formatEther(w));
  return {
    estimatedEthCost: eth(quoteWei),
    estimatedEthCostWei: quoteWei.toString(),
    startValueWei: (quoteWei + bondWei).toString(),
    startValueEth: eth(quoteWei + bondWei),
    breakdown: {
      jury: { K: Number(jury.K), M: Number(jury.M), N: Number(jury.N), P: Number(jury.P), timeout: Number(jury.timeout) },
      K: Number(jury.K), M: Number(jury.M), N: Number(jury.N), P: Number(jury.P),
      bonusMultiplier: Number(shape.bonusMultiplier),
      feeCeilingEth: eth(effWei),
      feeFloorEth: eth(minFeeWei),
      perJurorEth: eth(jurorWei),
      withBeacons,
      prepayEth: eth(quoteWei),
      minAttemptCostEth: eth(minAttemptWei),
      bondEth: eth(bondWei),
      juryModelCalls: totalCalls
    },
    recommendedParams: {
      alpha: String(oracleSettings?.alpha ?? config.submissionDefaults.alpha),
      maxOracleFee: maxFeeWei.toString(),
      minOracleFee: minFeeWei.toString(),
      withBeacons,
      estimatedBaseCost: String(oracleSettings?.estimatedBaseCost ?? config.submissionDefaults.estimatedBaseCostWei),
      maxFeeBasedScaling: String(oracleSettings?.maxFeeBasedScaling ?? config.submissionDefaults.maxFeeBasedScaling),
      note: 'Creator-side createBounty oracle settings; not prepareSubmission arguments.'
    },
    aggregatorConfigAvailable,
    note: aggregatorConfigAvailable
      ? 'The prepay is the aggregator\'s own quote (maxTotalFee) for this bounty\'s jury and settings; a start attaches it plus the bond (startValue). The unspent part of the prepay is refunded when the round resolves; an attempt costs at least minAttemptCostEth.'
      : 'Estimated with v2 defaults (the aggregator could not be read).',
    warning: 'The quote moves with the aggregator\'s owner-set parameters; read requiredPrepay / startValue from the escrow (GET /api/jobs/:id/onchain-status) before starting.'
  };
}

// What routes/wagerRoutes.js reads bounties with (server.js passes it in), so the wager
// endpoints see a bounty exactly as GET /:id and /:id/onchain-status serve it.
router._wagerDeps = { readWagerRecords, linkedWagerJobs, resolveOracleSettings, resolveDecisionSettings };

// Exposed for unit tests only.
router._chainHelpers = { readWithLagRetry, readChainSubmissionWithRetry, ensureLocalSubmission, submissionRecordFromChain };
router._createAttemptLimiters = [createAttemptJobLimiter, createAttemptIpLimiter];

module.exports = router;

