/**
 * Mutual wagers for agents: the create page's wager protections as API calls, under /api/wagers.
 * A wager is two directed bounties, one per bettor (see shared/mutualWager.js).
 *
 *   GET  /template   the rubric template, exact JSON (public, no key); ?kind=question for mutual-wager-v5
 *   POST /propose    first bettor: structured terms -> title, description and the /jobs/create body
 *   POST /answer     second bettor: bounty #N -> its terms mirrored with the sides swapped
 *   POST /check      a /jobs/create body -> every wager problem /jobs/create would refuse
 *   POST /claim      the winner: claim.md in the fixed format, linted, and whether it is too early
 *   GET  /status     the pairs of a Wager ID or wallet, and the offers targeted at a wallet
 * The sixth verb, close, is the existing POST /api/jobs/:id/close after a bounty's deadline.
 *
 * Every endpoint is side-effect free: nothing is pinned, no job id is used, nothing is signed.
 * They are a bettor's own tools before funding and before claiming; the jury never reads them.
 */
const express = require('express');
const logger = require('../utils/logger');
const wager = require('../../shared/mutualWager');
const { wagerContext, checkWagerCreate, sameAddress } = require('../utils/wagerGuard');
const { wagerStatus, counterProblems } = require('../utils/wagerStatus');
const { normalizeBountyPayments, validateProcurement } = require('../utils/validation');
const { sendError, ErrorCodes } = require('../utils/apiErrors');
const { createRateLimiter, clientAddress } = require('../utils/rateLimiter');
const { expandRubricTemplate } = require('../utils/rubricTemplates');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WAGER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
// A status query reads each bounty live (chain + rubric); a wallet with more wager bounties gets its newest.
// Status pages through complete wagers (both bounties together); each page reads at most this many bounties live.
const STATUS_GROUPS = 10;
const STATUS_READS = 30;
// Bump when a response's shape changes incompatibly.
const SCHEMA_VERSION = 1;
// Keys are free, and status, answer, check and claim read the chain and IPFS live: one budget per caller.
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 30;

const isoOf = (sec) => new Date(sec * 1000).toISOString();
const asBountyNumber = (v) => (v === null || v === undefined || v === '' || !/^\d+$/.test(String(v)) ? null : Number(v));

function inputError(res, problems, message = 'Invalid wager input') {
  return sendError(res, 400, {
    code: problems[0].code || 'WAGER_INPUT',
    message,
    details: problems[0].message,
    fix: 'Correct the fields named in problems[] and call again. Nothing was created.',
    extra: { problems },
  });
}

/**
 * deps: what jobRoutes reads bounties with (jobRoutes._wagerDeps), so these endpoints see a bounty
 * exactly as GET /api/jobs/:id and /:id/onchain-status serve it.
 *   readWagerRecords(n, ipfsClient) -> { status, job }; linkedWagerJobs(filter) -> jobs;
 *   resolveOracleSettings(body) -> wei settings; clock() -> unix seconds (tests).
 */
module.exports = function createWagerRouter({ readWagerRecords, linkedWagerJobs, resolveOracleSettings, clock = () => Math.floor(Date.now() / 1000) }) {
  const router = express.Router();
  const limiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: RATE_MAX });
  router.use((req, res, next) => {
    if (req.path === '/template') return next();
    const { allowed, remaining, retryAfterSeconds } = limiter.hit(req.clientId || clientAddress(req));
    res.set('X-RateLimit-Remaining', String(remaining));
    if (allowed) return next();
    res.set('Retry-After', String(retryAfterSeconds));
    return sendError(res, 429, { code: ErrorCodes.RATE_LIMIT, message: 'Too many wager requests', details: `The wager endpoints allow ${RATE_MAX} requests a minute per key. Retry in ${retryAfterSeconds}s.`, fix: 'Wait for the Retry-After interval.' });
  });
  router._limiter = limiter;

  // Everything /jobs/create checks about a wager body, derived the way /jobs/create derives it.
  async function checkBody(body, req, counter = null) {
    const input = [];
    // A rubric named by template key is filled in exactly as /jobs/create fills it in.
    if (body.rubricTemplate != null) {
      const expanded = expandRubricTemplate(body);
      if (expanded.error) return { wager: true, issues: [{ code: 'WAGER_INPUT', message: `${expanded.error.error}: ${expanded.error.details}` }] };
      body = expanded.body;
    }
    const procurement = validateProcurement(body.procurementMode, body.targetHunter);
    if (procurement) input.push({ code: 'WAGER_INPUT', message: procurement });
    if (!ADDRESS.test(String(body.creator || ''))) input.push({ code: 'WAGER_INPUT', message: 'creator must be the wallet that signs createBounty (0x + 40 hex digits).' });
    if (body.rubricJson != null && (typeof body.rubricJson !== 'object' || Array.isArray(body.rubricJson))) input.push({ code: 'WAGER_INPUT', message: 'rubricJson must be a JSON object, not a string: GET /api/wagers/template returns it as rubricJson.' });
    let payments, oracleSettings;
    try { payments = normalizeBountyPayments(body); } catch (err) { input.push({ code: 'WAGER_INPUT', message: err.message }); }
    try { oracleSettings = resolveOracleSettings(body); } catch (err) { input.push({ code: 'WAGER_INPUT', message: `Oracle settings: ${err.message}` }); }
    if (input.length) return { wager: true, issues: input };
    let rubric = body.rubricJson;
    if (!rubric && body.rubricCid) {
      try { rubric = JSON.parse((await req.app.locals.ipfsClient.fetchFromIPFS(body.rubricCid)).toString('utf8')); }
      catch (err) { return { wager: true, issues: [{ code: 'WAGER_RUBRIC_UNVERIFIED', message: `Could not read rubricCid ${body.rubricCid} (${err.message}). Try again, or pass rubricJson from GET /api/wagers/template.` }] }; }
    }
    return checkWagerCreate({
      body: { ...body, classId: Number(body.classId ?? 128) },
      payments,
      oracleSettings,
      rubric,
      now: clock(),
      readCounter: (n) => (counter && counter.number === n ? counter.records : readWagerRecords(n, req.app.locals.ipfsClient)),
      listCreatorJobs: (wallet) => linkedWagerJobs((j) => sameAddress(j.creator, wallet)),
    });
  }

  const summary = (t) => (t?.found ? {
    wagerId: t.fields.wagerId, kind: t.kind, event: t.fields.event ?? null, market: t.fields.market ?? null,
    ...(t.kind === 'question' ? { question: t.fields.question, resolvesAt: t.fields.resolvesAt, claimsOpen: t.fields.claimsOpen, sources: wager.parseSourcesLine(t.fields.sources) } : {}),
    start: t.fields.start, settle: t.fields.settle,
    stakeEth: wager.parseStakeLine(t.fields.stake), poster: t.poster, claimant: t.claimant, counter: t.counter,
  } : null);
  // "the start" of a game; "bets close" of a question: both bounties exist before it.
  const lockOf = (t) => (t?.kind === 'question' ? 'bets close' : 'the start');

  function builderResponse({ title, description, createBody, terms, warnings = [] }, check, next) {
    const ok = check.issues.length === 0;
    return {
      schemaVersion: SCHEMA_VERSION,
      success: true,
      ok,
      problems: check.issues,
      // Advice that does not block posting (for a question: Resolution sources a juror may not open).
      warnings,
      // The parsed terms (propose's builder terms are not parsed, so they would summarize as null).
      wager: summary(check.terms?.found ? check.terms : terms),
      title,
      description,
      // Only a body that passes is returned: post it to /jobs/create unchanged.
      createBody: ok ? createBody : null,
      next: ok ? next : ['Do not post this wager. Fix the problems (each has a code and a message); POST /api/wagers/check shows them again.'],
      actions: ok ? postingActions(createBody) : [],
    };
  }

  // Posting, and recovering a post whose outcome is unclear without starting over (the general
  // recovery flow in /agents.txt: persist the job id and transaction hash, look up the receipt, retry the link).
  const postingSteps = (createBody, extra = []) => [
    'POST /api/jobs/create with createBody exactly as returned (X-Bot-API-Key header). Save job.jobId and onChain.transaction from the response before sending anything.',
    `Send onChain.transaction from ${createBody.creator} with value = the stake (${createBody.bountyAmount} ETH), save the transaction hash, then PATCH /api/jobs/<jobId>/bountyId with { bountyId, txHash } to link it.`,
    'If the outcome is unclear (a timeout, a dropped connection, a failed link), do not start over: GET /api/jobs/lookup?txHash=<hash> (or ?evaluationCid=<job.evaluationCid>) finds the on-chain bounty, then retry the PATCH. Creating the bounty again posts a second stake.',
    ...extra,
  ];
  const postingActions = (createBody) => [
    { type: 'CREATE_JOB', actor: createBody.creator, method: 'POST', path: '/api/jobs/create', body: createBody, spendsFunds: false, retryable: true, note: 'Save job.jobId and onChain.transaction.' },
    { type: 'FUND', actor: createBody.creator, transaction: 'onChain.transaction from the CREATE_JOB response', valueEth: createBody.bountyAmount, spendsFunds: true, retryable: false, note: 'Send once; save the hash. On an unclear outcome use RECOVER, never FUND again.' },
    { type: 'LINK', actor: createBody.creator, method: 'PATCH', path: '/api/jobs/<jobId>/bountyId', body: { bountyId: '<on-chain id>', txHash: '<hash>' }, spendsFunds: false, retryable: true },
    { type: 'RECOVER', actor: createBody.creator, method: 'GET', path: '/api/jobs/lookup?txHash=<hash>', spendsFunds: false, retryable: true, note: 'Finds the bounty a FUND transaction created, so LINK can be retried.' },
  ];

  /* ---------- GET /api/wagers/template (public) ---------- */
  router.get('/template', (req, res) => {
    const ctx = wagerContext();
    const kind = req.query.kind === undefined ? 'game' : String(req.query.kind);
    if (!['game', 'question'].includes(kind)) return inputError(res, [{ code: 'WAGER_INPUT', field: 'kind', message: 'kind must be "game" (mutual-wager-v3, the default) or "question" (mutual-wager-v5).' }]);
    res.set('Cache-Control', 'public, max-age=300');
    if (kind === 'question') return res.json(questionTemplateResponse(ctx));
    return res.json({
      schemaVersion: SCHEMA_VERSION,
      success: true,
      kind: 'game',
      kinds: { game: wager.MUTUAL_WAGER_RUBRIC, question: wager.QUESTION_WAGER_RUBRIC },
      rubric: wager.MUTUAL_WAGER_RUBRIC,
      version: wager.MUTUAL_WAGER_TEMPLATE.version,
      threshold: wager.MUTUAL_WAGER_TEMPLATE.threshold,
      classId: wager.MUTUAL_WAGER_TEMPLATE.classId,
      criteria: wager.MUTUAL_WAGER_CRITERIA,
      // POST /api/jobs/create's rubricJson, exactly as the create page uploads it.
      rubricJson: wager.mutualWagerRubricJson(),
      // The create page's template (criterion text under `instructions`).
      template: wager.MUTUAL_WAGER_TEMPLATE,
      termsLines: wager.MUTUAL_WAGER_LINES.map(([key, prefix]) => ({ key, line: prefix.trim() })),
      // The jury reads the title, work product type and whole description: a wager's are fixed by its terms.
      text: { workProductType: wager.WAGER_WORK_PRODUCT_TYPE, title: 'derived from the terms (see POST /api/wagers/propose)', description: 'exactly the terms as built, nothing else' },
      defaults: {
        jury: wager.DEFAULT_WAGER_JURY,
        iterations: 1,
        market: wager.DEFAULT_WAGER_MARKET,
        noWinner: wager.DEFAULT_NO_WINNER,
        oracle: ctx.defaults.oracle,
        workProductType: wager.WAGER_WORK_PRODUCT_TYPE,
      },
      site: { url: ctx.site, escrow: ctx.escrow, chain: ctx.chain },
      rules: {
        minStartLeadSeconds: wager.MIN_START_LEAD_SECONDS,
        minSettleAfterStartSeconds: wager.MIN_SETTLE_AFTER_START_SECONDS,
        claimStartMarginSeconds: wager.CLAIM_START_MARGIN_SECONDS,
        claimDelaySeconds: wager.CLAIM_DELAY_SECONDS,
        claimAfterStartSeconds: wager.CLAIM_AFTER_START_SECONDS,
      },
      note: 'Both bounties of a wager use this rubric unchanged, the same terms with Poster and Claimant swapped, the other bettor as targetHunter and no approval window. Build them with POST /api/wagers/propose and /answer; never write terms or claims by hand.',
    });
  });

  // GET /template?kind=question: the same response for mutual-wager-v5.
  function questionTemplateResponse(ctx) {
    const t = wager.QUESTION_WAGER_TEMPLATE;
    return {
      schemaVersion: SCHEMA_VERSION,
      success: true,
      kind: 'question',
      kinds: { game: wager.MUTUAL_WAGER_RUBRIC, question: wager.QUESTION_WAGER_RUBRIC },
      rubric: wager.QUESTION_WAGER_RUBRIC,
      version: t.version,
      threshold: t.threshold,
      classId: t.classId,
      criteria: wager.QUESTION_WAGER_CRITERIA,
      rubricJson: wager.mutualWagerRubricJson({ kind: 'question' }),
      template: t,
      termsLines: wager.QUESTION_WAGER_LINES.map(([key, prefix]) => ({ key, line: prefix.trim() })),
      text: { workProductType: wager.WAGER_WORK_PRODUCT_TYPE, title: 'derived from the terms (see POST /api/wagers/propose)', description: 'exactly the terms as built, nothing else' },
      defaults: {
        jury: wager.DEFAULT_WAGER_JURY,
        iterations: 1,
        noWinner: wager.DEFAULT_QUESTION_NO_WINNER,
        sourceDelaySeconds: wager.DEFAULT_SOURCE_DELAY_SECONDS,
        oracle: ctx.defaults.oracle,
        workProductType: wager.WAGER_WORK_PRODUCT_TYPE,
      },
      site: { url: ctx.site, escrow: ctx.escrow, chain: ctx.chain },
      rules: {
        minStartLeadSeconds: wager.MIN_START_LEAD_SECONDS,
        minSourceDelaySeconds: wager.MIN_SOURCE_DELAY_SECONDS,
        minClaimWindowSeconds: wager.MIN_CLAIM_WINDOW_SECONDS,
        claimStartMarginSeconds: wager.CLAIM_START_MARGIN_SECONDS,
        maxResolutionSources: wager.MAX_RESOLUTION_SOURCES,
        recommendedResolutionSources: wager.RECOMMENDED_RESOLUTION_SOURCES,
        minClaimSources: wager.MIN_CLAIM_SOURCES,
      },
      sources: wager.RESOLUTION_SOURCE_GUIDE,
      claims: 'A claim cites two or more sources from different sites, at least one on a listed Resolution source\'s site, each with the value it shows and a quote of the row with that value and its date. Sources may differ slightly (a last trade against the official close): the jury pays on the answer, and finds no winner if sources put the value on different sides of the line.',
      settleable: 'A published value or fact for a stated date or time: an official closing price, a reference rate or statistic, an official result. Not minute-level intraday prices: jurors could not confirm them (October 2026 canary).',
      note: 'Both bounties of a question wager use this rubric unchanged, the same terms with Poster and Claimant swapped (sides "YES wins" and "NO wins"), the other bettor as targetHunter and no approval window. Build them with POST /api/wagers/propose { "kind": "question", ... } and /answer; never write terms or claims by hand.',
    };
  }

  /* ---------- POST /api/wagers/propose ---------- */
  router.post('/propose', async (req, res) => {
    try {
      const built = wager.proposeMutualWager(req.body || {}, wagerContext());
      if (built.problems.length) return inputError(res, built.problems);
      const check = await checkBody(built.createBody, req);
      const lock = built.terms.kind === 'question' ? 'bets close' : 'the start';
      return res.json(builderResponse(built, check, postingSteps(built.createBody, [
        `Give ${built.claimant.wallet} the new bounty number. They answer it with POST /api/wagers/answer { "counter": <number>, "creator": "${built.claimant.wallet}" } before ${isoOf(Date.parse(built.terms.start) / 1000 - wager.MIN_START_LEAD_SECONDS)}.`,
        `Before ${lock} (${built.terms.start}), GET /api/wagers/status?wagerId=${built.terms.wagerId} must say VERIFIED. Until their bounty matches yours, your stake backs nothing and stays locked until your deadline.`,
      ])));
    } catch (err) {
      logger.error('[wagers/propose] error', { msg: err.message });
      return sendError(res, 500, { code: ErrorCodes.INTERNAL_ERROR, message: 'Failed to build the wager', details: err.message });
    }
  });

  /* ---------- POST /api/wagers/answer ---------- */
  router.post('/answer', async (req, res) => {
    try {
      const { counter, creator, submissionDeadline, shortEvent, publicSubmissions } = req.body || {};
      const n = asBountyNumber(counter);
      const bad = [];
      if (n === null) bad.push({ code: 'WAGER_INPUT', field: 'counter', message: 'counter must be the number of the bounty you answer (the one targeted at your wallet).' });
      if (!ADDRESS.test(String(creator || ''))) bad.push({ code: 'WAGER_INPUT', field: 'creator', message: 'creator must be your wallet (the Claimant of that bounty), which signs createBounty.' });
      if (bad.length) return inputError(res, bad);
      let records;
      try { records = await readWagerRecords(n, req.app.locals.ipfsClient); }
      catch (err) {
        return sendError(res, 503, { code: 'WAGER_COUNTER_UNVERIFIED', message: `Could not read bounty #${n}`, details: err.message, fix: 'Try again shortly. Never answer a bounty you could not check.' });
      }
      if (!records.status || !records.job) {
        return sendError(res, 404, { code: 'WAGER_COUNTER', message: `No bounty #${n} to answer`, details: `This site's escrow has no linked bounty #${n}.`, fix: 'Check the number with the other bettor: GET /api/wagers/status?wallet=<your wallet> lists the offers targeted at you.' });
      }
      const built = wager.answerMutualWager({ number: n, status: records.status, job: records.job }, { creator, submissionDeadline, shortEvent, publicSubmissions });
      const inputProblems = built.problems.filter((p) => p.code === 'WAGER_INPUT');
      if (inputProblems.length) return inputError(res, inputProblems);
      if (built.problems.length) return res.json(builderResponse(built, { issues: built.problems }, []));
      const check = await checkBody(built.createBody, req, { number: n, records });
      return res.json(builderResponse(built, check, postingSteps(built.createBody, [
        `Your bounty names #${n} as its counter, so its jury will not re-check #${n}: this answer and /jobs/create checked it against its live record instead.`,
        `Then GET /api/wagers/status?wagerId=${built.terms.fields.wagerId} should say VERIFIED before ${lockOf(built.terms)} (${built.terms.fields.start}).`,
      ])));
    } catch (err) {
      logger.error('[wagers/answer] error', { msg: err.message });
      return sendError(res, 500, { code: ErrorCodes.INTERNAL_ERROR, message: 'Failed to build the answer', details: err.message });
    }
  });

  /* ---------- POST /api/wagers/check ---------- */
  router.post('/check', async (req, res) => {
    try {
      const body = req.body || {};
      if (!wager.looksLikeMutualWager(body.description, body.rubricJson)) {
        return res.json({ schemaVersion: SCHEMA_VERSION, success: true, ok: false, wager: false, problems: [{ code: 'WAGER_TERMS', message: 'The description has no MUTUAL WAGER TERMS block, so this is not a wager. Build one with POST /api/wagers/propose or /answer.' }], checkedAt: isoOf(clock()) });
      }
      const check = await checkBody(body, req);
      return res.json({ schemaVersion: SCHEMA_VERSION, success: true, ok: check.issues.length === 0, wager: true, problems: check.issues, terms: summary(check.terms), checkedAt: isoOf(clock()) });
    } catch (err) {
      logger.error('[wagers/check] error', { msg: err.message });
      return sendError(res, 500, { code: ErrorCodes.INTERNAL_ERROR, message: 'Failed to check the wager', details: err.message });
    }
  });

  /* ---------- POST /api/wagers/claim ---------- */
  router.post('/claim', async (req, res) => {
    try {
      const { bounty, counter, score, result, sources, finalAt, answer, value, asOf } = req.body || {};
      const n = asBountyNumber(bounty);
      if (n === null) return inputError(res, [{ code: 'CLAIM_INPUT', field: 'bounty', message: 'bounty must be the number of the bounty you claim: the one that pays you (you are its Claimant).' }], 'Invalid claim input');
      if (counter !== undefined && asBountyNumber(counter) === null) return inputError(res, [{ code: 'CLAIM_INPUT', field: 'counter', message: 'counter must be the number of your own bounty in the pair.' }], 'Invalid claim input');
      let records;
      try { records = await readWagerRecords(n, req.app.locals.ipfsClient); }
      catch (err) { return sendError(res, 503, { code: 'CLAIM_UNVERIFIED', message: `Could not read bounty #${n}`, details: err.message, fix: 'Try again shortly.' }); }
      if (!records.status || !records.job) return sendError(res, 404, { code: ErrorCodes.BOUNTY_NOT_FOUND, message: `No bounty #${n}`, details: `This site's escrow has no linked bounty #${n}.` });
      const terms = wager.parseMutualWagerTerms(records.job.description);
      if (!terms.found || terms.count !== 1 || !terms.closed || !terms.claimant.wallet) {
        return res.json({ success: true, ok: false, ready: false, claim: null, problems: [{ code: 'CLAIM_TERMS', message: `Bounty #${n} has no single, complete MUTUAL WAGER TERMS block, so it is not a wager this endpoint can draft a claim for.` }], warnings: [] });
      }
      const status = records.status;
      const now = clock();
      const problems = [], warnings = [];
      if (status.status === 'AWARDED') problems.push({ code: 'CLAIM_PAID', message: `Bounty #${n} has already paid ${status.winner}.` });
      else if (status.status === 'CLOSED') problems.push({ code: 'CLAIM_CLOSED', message: `Bounty #${n} is closed: its stake went back to its creator.` });
      if (!sameAddress(status.targetHunter, terms.claimant.wallet)) problems.push({ code: 'CLAIM_TARGET', message: `Bounty #${n} is targeted on chain at ${status.targetHunter}, not at the Claimant in its terms (${terms.claimant.wallet}).` });
      // A game claims from the start or finalAt; a question from its Claims open time.
      const timing = wager.wagerClaimTimingFor(terms, { deadline: status.submissionDeadline, finalAt, now });
      problems.push(...timing.problems);
      warnings.push(...timing.warnings);
      const site = /^(\S+);/.exec(terms.fields.site || '')?.[1] || wagerContext().site;
      // A game claim takes score and result; a question claim takes answer, value and asOf.
      const built = wager.buildWagerClaim({ terms, bounty: n, counter, score, result, answer, value, asOf, sources, site, now });
      problems.push(...built.problems);
      warnings.push(...built.warnings);

      // The Claimant's own bounty backs the claim. When the terms name it the jury takes it on
      // trust (so a problem here is a warning); when they say REQUIRED the jury checks exactly this.
      const counterNo = terms.counter?.number ?? asBountyNumber(counter);
      if (counterNo !== null && counterNo !== undefined) {
        try {
          const c = await readWagerRecords(counterNo, req.app.locals.ipfsClient);
          const found = c.status && c.job
            ? counterProblems({ bountyId: n, terms, status, job: records.job }, { bountyId: counterNo, status: c.status, job: c.job }, now)
            : [`Counter bounty #${counterNo}: the site has no on-chain record of it.`];
          for (const message of found) (terms.counter ? warnings : problems).push({ code: 'CLAIM_COUNTER', message });
        } catch (err) {
          // A REQUIRED counter is exactly what the jury checks, so an unread one keeps the claim from
          // being ready (retry); a counter the terms name is taken on trust, so it stays a warning.
          (terms.counter ? warnings : problems).push({ code: 'CLAIM_COUNTER_UNVERIFIED', retryable: true,
            message: `Could not read counter bounty #${counterNo} to check it (${err.message}).${terms.counter ? '' : ' The jury will check it: try again shortly before submitting.'}` });
        }
      }
      // The bounty you claim runs its own package: one that is not its terms as built can hold conditions the terms do not show.
      if (records.job.wagerPackage && !records.job.wagerPackage.ok) {
        warnings.push({ code: 'CLAIM_PACKAGE', message: `Bounty #${n}'s evaluation package ${records.job.wagerPackage.problems.join('; ')}: its jury may read conditions that are not in its terms.` });
      }
      const ok = problems.length === 0;
      const ready = ok && !timing.tooEarly;
      return res.json({
        schemaVersion: SCHEMA_VERSION,
        success: true,
        ok,
        ready,
        tooEarly: timing.tooEarly,
        claimAfter: timing.claimAfter,
        claimBy: timing.claimBy,
        claimDeadline: timing.claimDeadline,
        filename: 'claim.md',
        claim: ok ? built.claim : null,
        problems,
        warnings,
        actions: ok ? [
          // notAfter is the hard cutoff (the escrow refuses a start at or after it); recommendedBy leaves time to prepare and start.
          { type: 'SUBMIT_DRY_RUN', actor: terms.claimant.wallet, method: 'POST', path: `/api/jobs/${n}/submit/dry-run`, body: { files: 'claim.md', hunter: terms.claimant.wallet }, notBefore: ready ? null : timing.claimAfter, notAfter: timing.claimDeadline, recommendedBy: timing.claimBy, spendsFunds: false, retryable: true },
          { type: 'SUBMIT', actor: terms.claimant.wallet, method: 'POST', path: `/api/jobs/${n}/submit`, body: { files: 'claim.md', hunter: terms.claimant.wallet }, notBefore: ready ? null : timing.claimAfter, notAfter: timing.claimDeadline, recommendedBy: timing.claimBy, spendsFunds: true, retryable: true, note: 'Then prepare and start the evaluation before notAfter; starting it prepays the evaluation fee.' },
        ] : [],
        submit: ok ? {
          hunter: terms.claimant.wallet,
          steps: [
            timing.tooEarly ? `Wait until ${timing.claimAfter}.` : null,
            'Save claim as claim.md exactly as returned. Do not add text: anything addressed to the evaluator fails the integrity criterion.',
            `POST /api/jobs/${n}/submit/dry-run (multipart: files = claim.md, hunter = ${terms.claimant.wallet}): free check.`,
            `POST /api/jobs/${n}/submit with the same fields, then prepare and start the evaluation (you prepay its fee) as /agents.txt "Submit Work" describes, before ${terms.fields.settle}.`,
            `After it pays you, close your own bounty after its deadline: POST /api/jobs/${counterNo}/close.`,
          ].filter(Boolean),
        } : null,
      });
    } catch (err) {
      logger.error('[wagers/claim] error', { msg: err.message });
      return sendError(res, 500, { code: ErrorCodes.INTERNAL_ERROR, message: 'Failed to draft the claim', details: err.message });
    }
  });

  /* ---------- GET /api/wagers/status ---------- */
  // Complete wagers are grouped from the site's own records first (same Wager ID and wallets, or
  // one bounty naming the other), then paged newest first with a cursor, and only then read live.
  // A cut never splits a pair, and a member that cannot be read now makes its wager UNKNOWN.
  router.get('/status', async (req, res) => {
    try {
      const wagerId = req.query.wagerId ? String(req.query.wagerId) : null;
      const wallet = req.query.wallet ? String(req.query.wallet) : null;
      const before = req.query.before !== undefined ? asBountyNumber(req.query.before) : null;
      // pair=<a>,<b>: evaluate exactly these two bounties (e.g. the members of an INCOMPLETE group).
      const pairIds = req.query.pair !== undefined ? String(req.query.pair).split(',').map(asBountyNumber) : null;
      const bad = [];
      if (!wagerId && !wallet && !pairIds) bad.push({ code: 'WAGER_INPUT', message: 'Pass wagerId=<Wager ID>, wallet=<0x address> or pair=<bounty>,<bounty>.' });
      if (pairIds && (pairIds.length !== 2 || pairIds.includes(null) || pairIds[0] === pairIds[1])) bad.push({ code: 'WAGER_INPUT', field: 'pair', message: 'pair must be two different bounty numbers, e.g. pair=50,51.' });
      if (wagerId && !WAGER_ID.test(wagerId)) bad.push({ code: 'WAGER_INPUT', field: 'wagerId', message: 'wagerId must be 3-64 letters, digits, ".", "_" or "-".' });
      if (wallet && !ADDRESS.test(wallet)) bad.push({ code: 'WAGER_INPUT', field: 'wallet', message: 'wallet must be a 0x address.' });
      if (req.query.before !== undefined && before === null) bad.push({ code: 'WAGER_INPUT', field: 'before', message: 'before must be the nextCursor of a previous page.' });
      if (bad.length) return inputError(res, bad);

      const local = (await linkedWagerJobs()).map((j) => ({ id: Number(j.jobId), job: j, terms: wager.parseMutualWagerTerms(j.description) }));
      const byId = new Map(local.map((x) => [x.id, x]));
      const parent = new Map(local.map((x) => [x.id, x.id]));
      const find = (i) => { while (parent.get(i) !== i) i = parent.get(i); return i; };
      const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent.set(a, b); };
      const firstOfKey = new Map();
      for (const x of local) {
        const t = x.terms;
        // A bounty joins a wager under the wallets its terms name only if its creator is the Poster named there.
        const key = t.found && t.fields.wagerId && t.poster.wallet && t.claimant.wallet && sameAddress(x.job.creator, t.poster.wallet)
          ? [t.fields.wagerId, ...[t.poster.wallet.toLowerCase(), t.claimant.wallet.toLowerCase()].sort()].join('|') : null;
        if (key) { if (firstOfKey.has(key)) union(x.id, firstOfKey.get(key)); else firstOfKey.set(key, x.id); }
        // A Counter reference joins only a bounty created by this one's Claimant and targeted at its Poster,
        // from a bounty created by its own Poster: an unrelated bounty naming #N stays in its own group.
        const named = t.counter ? byId.get(t.counter.number) : null;
        if (named && t.poster.wallet && t.claimant.wallet && sameAddress(x.job.creator, t.poster.wallet)
          && sameAddress(named.job.creator, t.claimant.wallet) && sameAddress(named.job.targetHunter, t.poster.wallet)) union(x.id, named.id);
      }
      const relevant = (x) => (!wagerId || x.terms.fields?.wagerId === wagerId)
        && (!wallet || [x.job.creator, x.job.targetHunter, x.terms.poster?.wallet, x.terms.claimant?.wallet].some((a) => sameAddress(a, wallet)));
      const groups = new Map();
      for (const x of local) { const r = find(x.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(x); }
      if (pairIds) {
        // An explicit pair: both must be linked wager bounties; they are judged as one wager, whatever their group.
        const missing = pairIds.filter((id) => !byId.has(id));
        if (missing.length) return inputError(res, [{ code: 'WAGER_INPUT', field: 'pair', message: `Not a linked wager bounty: #${missing.join(', #')}.` }]);
        groups.clear();
        groups.set('pair', pairIds.map((id) => byId.get(id)));
      }
      const selected = [...groups.values()].filter((g) => pairIds || g.some(relevant))
        .map((g) => ({ members: g.sort((p, q) => q.id - p.id), top: Math.max(...g.map((x) => x.id)) }))
        .sort((p, q) => q.top - p.top)
        .filter((g) => before === null || g.top < before);
      const page = [];
      let reads = 0;
      for (const g of selected) {
        if (page.length >= STATUS_GROUPS) break;
        // A group larger than one read budget is not read at all: a partial view could hide the real pair
        // behind duplicates, so it is reported INCOMPLETE with its members, and pair= resolves it.
        const oversized = g.members.length > STATUS_READS;
        const cost = oversized ? 0 : g.members.length;
        if (page.length && reads + cost > STATUS_READS) break;
        page.push({ ...g, oversized });
        reads += cost;
      }
      const nextCursor = selected.length > page.length ? page[page.length - 1].top : null;

      const invalid = [];
      const bounties = (await Promise.all(page.filter((g) => !g.oversized).flatMap((g) => g.members.map(async (x) => {
        const base = { bountyId: x.id, group: String(g.top), terms: x.terms };
        let r;
        try { r = await readWagerRecords(x.id, req.app.locals.ipfsClient); }
        catch (err) { return { ...base, error: err.message }; }   // transient: the wager is UNKNOWN, not guessed
        const terms = r.job ? wager.parseMutualWagerTerms(r.job.description) : null;
        const why = !r.status || !r.job ? 'no on-chain record on this escrow'
          : !terms.found || terms.count !== 1 || !terms.closed || !terms.poster.wallet || !terms.claimant.wallet || !terms.fields.wagerId ? 'no single, complete terms block' : null;
        if (why) {
          const live = r.status && !['AWARDED', 'CLOSED'].includes(r.status.status);
          invalid.push({ bountyId: x.id, reason: why, status: r.status?.status ?? null, deadline: r.status?.submissionDeadlineIso ?? null,
            close: live && r.status.deadlinePassed ? { method: 'POST', path: `/api/jobs/${x.id}/close` } : null });
          return null;
        }
        return { ...base, terms, status: r.status, job: r.job };
      })))).filter(Boolean);

      const now = clock();
      const { pairs, offers } = wagerStatus(bounties, { now, site: wagerContext().site, wallet });
      for (const g of page.filter((x) => x.oversized)) {
        const ids = g.members.map((m) => m.id);
        const t = g.members.find((m) => m.terms.found)?.terms;
        pairs.push({
          wagerId: t?.fields?.wagerId ?? null, state: 'INCOMPLETE', event: t?.fields?.event ?? null, start: t?.fields?.start ?? null, settle: t?.fields?.settle ?? null,
          memberIds: ids, bounties: [], extra: [], problems: [], paid: [],
          next: [`This wager has ${ids.length} bounties, more than one status read covers (${STATUS_READS}), so no action is derived from a partial view. Ask about the pair you hold with GET /api/wagers/status?pair=<your bounty>,<theirs> (memberIds lists every member).`],
          actions: [{ type: 'INSPECT', actor: 'caller', method: 'GET', path: '/api/wagers/status?pair=<a>,<b>', spendsFunds: false, retryable: true, note: 'Pick the two bounties of your pair from memberIds.' }],
        });
      }
      pairs.sort((x, y) => Math.max(...(y.memberIds || y.bounties.map((b) => b.bountyId))) - Math.max(...(x.memberIds || x.bounties.map((b) => b.bountyId))));
      return res.json({
        schemaVersion: SCHEMA_VERSION,
        success: true,
        query: { wagerId, wallet, before, pair: pairIds },
        checkedAt: isoOf(now),
        pairs,
        offers,
        invalid,
        // Pass as before=<nextCursor> for the next page; null when this page holds the last wager.
        nextCursor,
        states: 'AWAITING_COUNTERPARTY | OFFER_EXPIRED | MISMATCHED | VERIFIED | EVENT_PENDING | READY_TO_CLAIM | CLAIM_PENDING | PAID | REFUNDABLE | CLOSED | UNKNOWN (a member could not be read now: retry) | INCOMPLETE (too many members to read: use pair=)',
      });
    } catch (err) {
      logger.error('[wagers/status] error', { msg: err.message });
      return sendError(res, 500, { code: ErrorCodes.INTERNAL_ERROR, message: 'Failed to read wager status', details: err.message });
    }
  });

  return router;
};
