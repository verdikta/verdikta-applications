// Mutual wagers, pure logic: no wallet, network, files or environment (wager.js does the I/O).
// A wager is two directed bounties, one per bettor, each paying the other bettor only if that bettor's side wins
// and that bettor holds a live mirrored counter bounty. Two templates, told apart by the rubric the terms name: game
// wagers (Mutual Wager, mutual-wager-v3: a game settled on its official final score) and question wagers (Question
// Wager, mutual-wager-v5: YES or NO on a published value or fact, settled on the answer the Resolution sources give;
// mutual-wager-v4 bounties already posted are still answered and claimed as v4).
// Bodies, checks and claims come from the website's shared module (_mutual-wager.cjs, vendored byte for byte):
// the same code the create page, the bounty server's /api/wagers and its /jobs/create check run. This module adds
// the skill's layers: an escrow read of the opponent's bounty, the standard no-winner rule, the owner's approval
// lines and the create_bounty.js config.
import { createHash } from 'node:crypto';
import { getAddress, parseEther, ZeroAddress } from 'ethers';
import shared from './_mutual-wager.cjs';
export { shared };

export const template = shared.MUTUAL_WAGER_TEMPLATE;
export const questionTemplate = shared.QUESTION_WAGER_TEMPLATE;
export const DEFAULT_MARKET = shared.DEFAULT_WAGER_MARKET;
export const DEFAULT_NO_WINNER = shared.DEFAULT_NO_WINNER;
// Provider display names of client/src/services/modelProviderService.js: the create page's Jury line spells
// providers this way, and an operator's wager-defaults.json may use the lower-case API names.
export const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Open-source (Ollama)', hyperbolic: 'Hyperbolic API', xai: 'xAI' };
// The template's class and threshold (the same for both templates), the shared default jury and the create page's
// oracle defaults (client config submissionDefaults). An operator file can replace the jury, oracle settings and class
// (wager.js --defaults).
export const WAGER_DEFAULTS = Object.freeze({
  classId: template.classId, threshold: template.threshold, iterations: 1,
  jury: shared.DEFAULT_WAGER_JURY.map((n) => ({ ...n })),
  oracle: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 },
});
// No game is final this soon after its scheduled start: claim refuses before it (shared timing adds ~2 h after the final).
export const CLAIM_OPENS_AFTER_START = 3 * 3600;
const MIN_SETTLE_AFTER_START = 12 * 3600, MAX_SETTLE_AFTER_START = 60 * 86400;
// The structured proposal fields; wager.js adds creator, and the jury, oracle and class come from operator defaults.
// No shortEvent: a wager's title is derived from its terms (the jury reads it), and the shared builder refuses one.
// A question wager takes the bounty server's POST /api/wagers/propose names, the same as the native runtime's.
export const PROPOSAL_FIELDS = ['wagerId', 'event', 'start', 'settle', 'stake', 'opponent', 'sides', 'market', 'noWinner'];
export const QUESTION_PROPOSAL_FIELDS = ['kind', 'wagerId', 'question', 'betsClose', 'resolvesAt', 'claimsOpen', 'yes', 'no', 'noWinner', 'sources', 'side', 'stake', 'settle', 'opponent'];
const GAME_ONLY_FIELDS = ['event', 'start', 'market', 'sides', 'shortEvent'];
/** 'game' (mutual-wager-v3) or 'question' (mutual-wager-v5, or v4) for parsed terms. */
export const kindOf = (terms) => (terms?.kind === 'question' ? 'question' : 'game');
/** The templates wager.js builds, answers, checks and claims (the native runtime's SUPPORTED_WAGER_RUBRICS). */
export const SUPPORTED_WAGER_RUBRICS = Object.freeze([shared.MUTUAL_WAGER_RUBRIC, ...shared.QUESTION_WAGER_RUBRICS]);
/**
 * Any other rubric is refused by name before anything is built: the shared module reads an unknown rubric as a game,
 * and an answer this wallet cannot claim pays only the other side.
 */
export function unsupportedWagerProblem(terms, number) {
  if (!terms?.found || SUPPORTED_WAGER_RUBRICS.includes(terms.rubric)) return null;
  return `Bounty #${number} is a ${terms.rubric ?? 'unnamed-rubric'} wager. wager.js handles game wagers (${shared.MUTUAL_WAGER_RUBRIC}) and question wagers (${shared.QUESTION_WAGER_RUBRICS.join(', ')}) only, so it cannot be answered or claimed with it.`;
}
/** The site's rule: kind "question", or a question with no kind, is a question input. */
const isQuestionInput = (input) => input?.kind === 'question' || (input?.kind === undefined && input?.question !== undefined);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const WHOLE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;
export const unix = (iso) => (WHOLE_ISO.test(norm(iso)) && Number.isFinite(Date.parse(norm(iso))) ? Date.parse(norm(iso)) / 1000 : null);
export const isoOf = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sameAddress = (a, b) => { try { return getAddress(String(a)) === getAddress(String(b)); } catch { return false; } };
const wei = (eth) => { try { return parseEther(norm(eth)); } catch { return null; } };
const big = (v) => { try { return BigInt(v); } catch { return null; } };
const messages = (problems) => (problems || []).map((p) => (typeof p === 'string' ? p : p.message));

// Shared with the native runtime: the terms hash is the SHA-256 of the description exactly as sent to /jobs/create.
// Every money term is in it; the title, rubric, target, amount and deadline are derived from it.
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const termsHash = (offer) => sha256(offer.description);

export function siteContext({ network, origin, deployment }) {
  if (!deployment || !shared.WAGER_CHAIN_NAMES[deployment.chainId]) throw new Error(`No wager site for network ${network}`);
  return { network, site: origin, escrow: getAddress(deployment.address), chain: shared.wagerChainLabel(deployment.chainId), defaults: { oracle: WAGER_DEFAULTS.oracle, jury: WAGER_DEFAULTS.jury } };
}

/**
 * The shared /jobs/create rubricJson minus threshold and classId, which create_bounty.js sends outside the rubric.
 * rubric picks a version (a v4 bounty's terms name mutual-wager-v4); otherwise the kind's current template.
 */
export function wagerRubricJson(kind = 'game', rubric) {
  const { threshold, classId, ...json } = shared.mutualWagerRubricJson({ kind, rubric });
  return json;
}

/** What the create page (and the server) pass to checkMutualWagerTerms for the bounty `me` would post. */
export function expectFor({ me, target, stake, classId, threshold, jury, iterations, oracle, settle, ctx, now, kind = 'game', rubric }) {
  return {
    posterWallet: me, targetHunter: target, stake, threshold, classId, jury, iterations, oracle, approvalWindow: false,
    now, deadline: unix(settle), site: ctx.site, escrow: ctx.escrow, chain: ctx.chain, rubric: wagerRubricJson(kind, rubric),
  };
}

/** The values a bounty must have to match a parsed terms block (the shared line parsers). */
export function termsValues(t) {
  const f = t.fields || {}, problems = [];
  const juryLine = shared.parseJuryLine(f.jury), oracle = shared.parseOracleLine(f.oracle), both = shared.parseBothLine(f.both), stake = shared.parseStakeLine(f.stake);
  if (!juryLine) problems.push('The Jury line cannot be read back ("<Provider> <model> weight <w>, <n> run(s) + ...; <n> iteration(s).").');
  if (!oracle) problems.push('The Oracle settings line cannot be read back.');
  if (!both) problems.push('The "Both bounties" line cannot be read back.');
  if (!(wei(stake) > 0n)) problems.push('The Stake line cannot be read back.');
  if (unix(f.start) == null || unix(f.settle) == null) problems.push(`${t.kind === 'question' ? 'Bets close' : 'The scheduled start'} and the settlement deadline must be ISO UTC times to the second, such as 2026-10-21T19:00:00Z.`);
  return { problems, kind: kindOf(t), rubric: t.rubric, jury: juryLine?.jury, iterations: juryLine?.iterations, oracle, classId: both?.classId, threshold: both?.threshold, stake, start: norm(f.start), settle: norm(f.settle) };
}

/**
 * The skill's rules on top of the shared checks. The standard market comes with the standard no-winner clause:
 * testnet #21/#24 add "a game decided in overtime" to it, which contradicts "overtime included" and pays one side only.
 */
export function skillTermsProblems(t) {
  const f = t.fields || {}, problems = [];
  const start = unix(f.start), settle = unix(f.settle);
  // A question's times are the shared check's (Claims open at least 30 minutes after Resolves at, settlement at least
  // 2 hours after Claims open), so a close settles the same evening. The skill only caps how long a stake stays locked.
  if (t.kind === 'question') {
    if (start != null && settle != null && settle - start > MAX_SETTLE_AFTER_START) problems.push('The settlement deadline must be at most 60 days after Bets close.');
    return problems;
  }
  if (norm(f.market) === DEFAULT_MARKET && norm(f.noWinner).replace(/\.$/, '') !== DEFAULT_NO_WINNER) {
    problems.push(`The "No winner" line must be the standard clause for the standard market ("${DEFAULT_NO_WINNER}"); it says "${norm(f.noWinner)}".`);
  }
  // The settlement deadline is also both bounties' deadline: too soon and no claim fits after the final, too late and
  // the loser's stake stays locked.
  if (start != null && settle != null && (settle - start < MIN_SETTLE_AFTER_START || settle - start > MAX_SETTLE_AFTER_START)) {
    problems.push('The settlement deadline must be between 12 hours and 60 days after the scheduled start.');
  }
  return problems;
}

/** What the terms' start is called: a game's scheduled start, a question's Bets close (both bounties exist before it). */
export const startLabel = (kind) => (kind === 'question' ? 'Bets close time' : 'scheduled start');

/**
 * Funding needs the start (a question's Bets close) at least 10 minutes away (the shared MIN_START_LEAD_SECONDS). The
 * other side's jury rejects a counter created after it, so a bounty funded later can lose but never win: a one-sided bet.
 */
export function startLeadProblem(start, now, kind = 'game') {
  const s = unix(start);
  if (s != null && s - now >= shared.MIN_START_LEAD_SECONDS) return null;
  return `The ${startLabel(kind)} ${norm(start)} is less than ${shared.MIN_START_LEAD_SECONDS / 60} minutes away or past: a bounty funded now could be created after it, the other side's jury would reject it as a counter, and the bet would be one-sided.`;
}

/** This wallet's approved description checked again at `now`, as /jobs/create checks it (timing included). */
export function ownTermsProblems({ description, me, ctx, now }) {
  const terms = shared.parseMutualWagerTerms(description);
  const values = termsValues(terms);
  if (values.problems.length) return values.problems;
  return [...shared.checkMutualWagerTerms(description, expectFor({ me, target: terms.claimant.wallet, ...values, ctx, now })).problems, ...skillTermsProblems(terms)];
}

// Escrow SubmissionStatus: a claim whose evaluation ended Failed may be replaced by a new one before the deadline.
export const SUBMISSION_STATUS = ['Prepared', 'PendingVerdikta', 'Failed', 'PassedPaid', 'PassedUnpaid', 'PendingCreatorApproval'];

/** The opponent's bounty read straight from the escrow must agree with the site's onchain-status for it. */
export function chainProblems(number, status, b, now) {
  const p = (msg) => `Bounty #${number} on chain: ${msg}`;
  if (!b) return [p('it could not be read from the escrow.')];
  if (!status) return [];
  const o = status.oracleSettings || {};
  const fields = [
    ['creator', sameAddress(b.creator, status.creator)],
    ['target', sameAddress(b.targetHunter, status.targetHunter || ZeroAddress)],
    ['evaluation package', b.evaluationCid === status.evaluationCid],
    ['creation time', big(b.createdAt) === big(status.createdAt)],
    ['deadline', big(b.submissionDeadline) === big(status.submissionDeadline)],
    ['class', big(b.requestedClass) === big(status.classId)],
    ['threshold', big(b.threshold) === big(status.threshold)],
    ['escrowed amount', big(b.payoutWei) === big(status.payoutWei)],
    ['arbiter payment', big(b.arbiterDeterminationPayment) === wei(status.arbiterDeterminationPaymentEth)],
    ['creator payment', big(b.creatorDeterminationPayment) === wei(status.creatorDeterminationPaymentEth)],
    ['approval window', big(b.creatorAssessmentWindowSize) === big(status.creatorAssessmentWindowSize)],
    ['oracle settings', ['maxOracleFee', 'alpha', 'estimatedBaseCost', 'maxFeeBasedScaling'].every((k) => big(b.oracle?.[k]) === big(o[k]))],
  ];
  const problems = fields.filter(([, ok]) => !ok).map(([name]) => p(`its ${name} differs from the site's record of it.`));
  if (Number(b.status) !== 0) problems.push(p(`it is no longer open (status ${b.status}).`));
  if (now != null && Number(b.submissionDeadline) <= now) problems.push(p('its deadline has passed.'));
  return problems;
}

/**
 * The full check of an opponent's bounty #number, from its site records (status = /onchain-status, job = the .job of
 * ?includeRubric=true) and its escrow read (rpc). Without `mine`, the terms are the answer this wallet would post
 * (shared answerMutualWager: mirrored from #number, naming it), checked as the create page and the server check it.
 * With mine = { description, number, status } (this wallet already posted its side), the terms are this wallet's own
 * posted lines, naming #number, so every shared line is compared with what the owner approved.
 * Returns { problems, terms, values, expect, answer: { title, description, createBody } (only without mine), notes }.
 * A question offer's notes tell the owner that its question, YES/NO lines and sources are the offer poster's words.
 */
export function counterReport({ number, status, job, rpc, me, ctx, now, mine = null }) {
  const unsupported = unsupportedWagerProblem(shared.parseMutualWagerTerms(job?.description), number);
  if (unsupported) return { problems: [unsupported], notes: [] };
  const named = { number, createdAt: status?.createdAtIso, deadline: status?.submissionDeadlineIso };
  const placeholder = { number: 0, createdAt: '1970-01-01T00:00:00.000Z', deadline: '1970-01-01T00:00:00.000Z' };
  // Mirroring this wallet's description twice swaps the parties back and names #number, keeping its own shared lines.
  const answered = mine ? null : shared.answerMutualWager({ number, status, job }, { creator: me });
  const base = mine ? shared.mirrorMutualWagerTerms(shared.mirrorMutualWagerTerms(mine.description, placeholder)?.description, named)?.description : answered.description;
  if (!base) return { problems: mine ? ['Your own bounty has no single, complete terms block.'] : messages(answered.problems) };
  const terms = shared.parseMutualWagerTerms(base);
  const values = termsValues(terms);
  const expect = expectFor({ me, target: terms.claimant.wallet, ...values, ctx, now });
  const problems = [...values.problems];
  if (values.problems.length) return { problems, terms, values, expect };
  if (!mine) problems.push(...messages(answered.problems), ...shared.checkMutualWagerTerms(base, expect).problems, ...shared.checkCounterBounty({ terms, status, job, expect }));
  // Against this wallet's posted bounty the counter is checked as the shared check sees an offer (Counter line
  // unset): its rule that a counter must be REQUIRED is for the bounty being answered, and a correct answer to a
  // REQUIRED proposal names the proposal. Their Counter line is checked against this wallet's bounty below.
  else problems.push(...shared.checkCounterBounty({ terms: { ...terms, counter: null }, status, job, expect, number }));
  problems.push(...chainProblems(number, status, rpc, now));
  problems.push(...skillTermsProblems(terms));
  if (mine) {
    // Their Counter line: REQUIRED, or this wallet's bounty by number with its real creation time and deadline.
    const theirs = shared.parseMutualWagerTerms(job?.description);
    if (theirs.found && theirs.counter) {
      if (mine.number != null && theirs.counter.number !== Number(mine.number)) problems.push(`Bounty #${number}: its Counter bounty line names #${theirs.counter.number}, not your bounty #${mine.number}.`);
      else if (mine.status && (Date.parse(theirs.counter.createdAt) !== Number(mine.status.createdAt) * 1000 || Date.parse(theirs.counter.deadline) !== Number(mine.status.submissionDeadline) * 1000)) {
        problems.push(`Bounty #${number}: its Counter bounty line gives your bounty #${mine.number} a creation time or deadline it does not have.`);
      }
    }
  }
  const answer = answered?.createBody ? { title: answered.title, description: answered.description, createBody: answered.createBody } : null;
  return { problems, terms, values, expect, answer, notes: mine ? [] : questionOfferNotes(terms, answered) };
}

/** What the owner reads before answering a question offer (the native answerWager's notes, and the source warnings). */
function questionOfferNotes(terms, answered) {
  if (terms.kind !== 'question') return [];
  const f = terms.fields, notes = [
    `The question, its "YES wins if" / "NO wins if" lines and its Resolution sources are the offer's, written by ${terms.claimant.wallet}; the jury settles on them exactly as written. Read them before approving.`,
  ];
  if (![shared.DEFAULT_QUESTION_NO_WINNER, shared.V4_DEFAULT_QUESTION_NO_WINNER].includes(norm(f.noWinner).replace(/\.$/, ''))) notes.push(`The offer's no-winner clause is not the site default: "${norm(f.noWinner)}". Read it before approving.`);
  return [...notes, ...messages(answered?.warnings)];
}

/**
 * The first bettor's bounty (shared proposeMutualWager) with every check, before any approval or spend.
 * A game: input = { wagerId, event, start, settle, stake, opponent, sides: { creator, opponent }, market?, noWinner? }.
 * A question: input = { kind: "question", wagerId, question, betsClose, resolvesAt, claimsOpen?, yes, no, noWinner?,
 * sources: [https URL], side: "YES" | "NO", stake, settle, opponent }. Returns { offer, createBody, terms, expect,
 * termsSha256, problems, warnings } (warnings: the shared builder's notes on a question's sources).
 */
export function buildProposal(input, { me, ctx, defaults = WAGER_DEFAULTS, now }) {
  if (input && '_note' in input) input = Object.fromEntries(Object.entries(input).filter(([k]) => k !== '_note'));
  if (input?.kind !== undefined && !['game', 'question'].includes(input.kind)) return { problems: ['kind must be "game" (a game settled on its official final score; or leave it out) or "question" (YES or NO on a published value).'] };
  const question = isQuestionInput(input);
  const fields = question ? QUESTION_PROPOSAL_FIELDS : [...PROPOSAL_FIELDS, ...(input?.kind === 'game' ? ['kind'] : [])];
  const unknown = Object.keys(input || {}).filter((k) => !fields.includes(k));
  if (unknown.length && question) {
    const game = unknown.filter((k) => GAME_ONLY_FIELDS.includes(k));
    return { problems: [`Not question-wager fields: ${unknown.join(', ')}.${game.length ? ` ${game.join(', ')} belong${game.length === 1 ? 's' : ''} to a game wager.` : ''} A question wager takes ${QUESTION_PROPOSAL_FIELDS.join(', ')} (see examples/wager-question.json).`] };
  }
  if (unknown.length) return { problems: [`Not proposal fields: ${unknown.join(', ')}. Use ${PROPOSAL_FIELDS.join(', ')} (see examples/wager-proposal.json).`] };
  const built = shared.proposeMutualWager({ ...input, creator: me, classId: defaults.classId, threshold: defaults.threshold, jury: defaults.jury, iterations: defaults.iterations ?? 1, oracle: defaults.oracle }, ctx);
  if (!built.createBody) return { problems: messages(built.problems) };
  const expect = expectFor({ me, target: built.claimant.wallet, stake: built.terms.stake, ...defaults, settle: built.terms.settle, ctx, now, kind: question ? 'question' : 'game' });
  const checked = shared.checkMutualWagerTerms(built.description, expect);
  const problems = [...checked.problems, ...skillTermsProblems(checked.terms)];
  const offer = { title: built.title, description: built.description };
  return { offer, createBody: built.createBody, terms: checked.terms, expect, termsSha256: termsHash(offer), problems, warnings: messages(built.warnings) };
}

/** create_bounty.js config from a shared /jobs/create body: TARGETED, exact deadline, no window, public claims. */
export function createConfig({ createBody: b, wager }) {
  const { threshold, classId, ...rubricJson } = b.rubricJson;
  return {
    title: b.title, description: b.description, workProductType: b.workProductType,
    rubricJson, threshold: b.threshold, classId: b.classId, iterations: b.iterations,
    juryNodes: b.juryNodes.map(({ provider, model, weight, runs }) => ({ provider, model, weight, runs })),
    procurementMode: 'TARGETED', targetHunter: getAddress(b.targetHunter), bountyAmount: String(b.bountyAmount),
    submissionDeadline: b.submissionDeadline, creatorAssessmentWindowSeconds: 0, publicSubmissions: b.publicSubmissions,
    oracle: { maxOracleFee: parseEther(String(b.oracleMaxOracleFee)).toString(), alpha: Number(b.oracleAlpha), estimatedBaseCost: parseEther(String(b.oracleEstimatedBaseCost)).toString(), maxFeeBasedScaling: Number(b.oracleMaxFeeBasedScaling) },
    wager,
  };
}

// ---- The owner's approval lines (shared with the native runtime, verdikta-agents MIN_APPROVAL_HEX) ----

// A line names its terms or claim by at least 16 hex characters of the SHA-256. Shorter prefixes are still read, so
// the refusal can give the owner the 16-hex prefix to use.
export const MIN_APPROVAL_HEX = 16;
const tooShort = (what, line, sha) => new Error(`The approval names the ${what} by ${line.hashPrefix.length} hex characters; it needs at least ${MIN_APPROVAL_HEX} (${sha.slice(0, MIN_APPROVAL_HEX)}). Ask the owner to reply with the line exactly as printed`);

/** Approve wager <16+ hex of the terms SHA-256>, stake <X> ETH, vs <opponent: full address, 0x + 8+ hex, or 0x1234…abcd>, settle <ISO>. */
export const WAGER_APPROVAL_LINE = /\bapprove\s+wager\s+([0-9a-f]{8,64})\b[\s,;:]*stake\s*[:=]?\s*(\d+(?:\.\d+)?)\s*eth\b[\s,;:]*(?:vs\.?|versus|against)\s*(0x[0-9a-f]{40}|0x[0-9a-f]{4,}\s*(?:…|\.{2,3})\s*[0-9a-f]{4,}|0x[0-9a-f]{8,39})[\s,;:]*settle\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)/gi;

export function parseWagerApprovalLines(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(WAGER_APPROVAL_LINE)].map((m) => ({ hashPrefix: m[1].toLowerCase(), stake: m[2], opponent: m[3].replace(/\s+/g, ''), settle: m[4], line: m[0] }));
}

export const approvalLineFor = ({ termsSha256, stake, opponent, settle }) => `Approve wager ${termsSha256.slice(0, MIN_APPROVAL_HEX)}, stake ${stake} ETH, vs ${getAddress(opponent)}, settle ${settle}`;

function opponentMatches(written, wallet) {
  const w = written.toLowerCase(), full = String(wallet).toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(w)) return w === full;
  if (/^0x[0-9a-f]{8,39}$/.test(w)) return full.startsWith(w);
  const m = /^0x([0-9a-f]{4,})(?:…|\.{2,3})([0-9a-f]{4,})$/.exec(w);
  return Boolean(m) && full.slice(2).startsWith(m[1]) && full.endsWith(m[2]);
}

/** The approval line that names these exact terms; throws with the reason otherwise. */
export function bindWagerApproval({ approvalText, termsSha256, stake, opponent, settle }) {
  const lines = parseWagerApprovalLines(approvalText);
  if (!lines.length) throw new Error('No wager approval line found. Expected: Approve wager <first 16 hex of the terms hash>, stake <X> ETH, vs <opponent address>, settle <ISO time>');
  const forTerms = lines.filter((l) => termsSha256.startsWith(l.hashPrefix));
  if (!forTerms.length) throw new Error(`The approval names terms ${lines.map((l) => l.hashPrefix).join(', ')}; these terms hash to ${termsSha256.slice(0, 16)}… They changed: show the owner the current terms and ask for a fresh approval`);
  const a = forTerms.find((l) => l.hashPrefix.length >= MIN_APPROVAL_HEX);
  if (!a) throw tooShort('terms', forTerms[0], termsSha256);
  if (wei(a.stake) !== wei(stake)) throw new Error(`The approval says stake ${a.stake} ETH; the terms say ${stake} ETH`);
  if (!opponentMatches(a.opponent, opponent)) throw new Error(`The approval names opponent ${a.opponent}; the terms name ${opponent}`);
  if (Date.parse(a.settle) !== Date.parse(settle)) throw new Error(`The approval says settle ${a.settle}; the terms say ${settle}`);
  return a;
}

/** Approve claim <16+ hex of the SHA-256 of claim.md>, bounty #<N>: the owner's approval to submit that exact claim. */
export const CLAIM_APPROVAL_LINE = /\bapprove\s+claim\s+([0-9a-f]{8,64})\b[\s,;:]*bounty\s*#?\s*(\d+)\b/gi;
export const claimLineFor = ({ claimSha256, bounty }) => `Approve claim ${claimSha256.slice(0, MIN_APPROVAL_HEX)}, bounty #${bounty}`;
export function bindClaimApproval({ approvalText, claimSha256, bounty }) {
  const lines = typeof approvalText === 'string' ? [...approvalText.matchAll(CLAIM_APPROVAL_LINE)].map((m) => ({ hashPrefix: m[1].toLowerCase(), bounty: Number(m[2]), line: m[0] })) : [];
  if (!lines.length) throw new Error('No claim approval line found. Expected: Approve claim <first 16 hex of the claim.md hash>, bounty #<N>');
  const named = lines.filter((l) => claimSha256.startsWith(l.hashPrefix) && l.bounty === Number(bounty));
  const hit = named.find((l) => l.hashPrefix.length >= MIN_APPROVAL_HEX);
  if (named.length && !hit) throw tooShort('claim', named[0], claimSha256);
  if (!hit) throw new Error(`The approval names claim ${lines.map((l) => `${l.hashPrefix} for #${l.bounty}`).join(', ')}; this claim.md hashes to ${claimSha256.slice(0, 16)}… for #${bounty}. Show the owner the current claim and ask again`);
  return hit;
}

// ---- The claim (shared buildWagerClaim and wagerClaimTiming) ----

/** --score "Detroit Pistons 112, Boston Celtics 104 (Final)" -> shared score rows and result. */
export function parseScore(score) {
  const m = /^(.+?) (\d{1,3}), (.+?) (\d{1,3}) \((Final(?:\/(?:OT|SO|\d*OT))?)\)$/i.exec(norm(score));
  if (!m) throw new Error('--score must read "<Team> <points>, <Team> <points> (Final)", for example "Detroit Pistons 112, Boston Celtics 104 (Final)" or "(Final/OT)"');
  return { rows: [{ team: m[1], points: Number(m[2]) }, { team: m[3], points: Number(m[4]) }], result: m[5] };
}

/**
 * --source "Name|https://url|verbatim quote from that page" -> shared sources. A question claim (mutual-wager-v5) may
 * end a source with "|value=<the value that page shows>" when it differs from --value (a last trade against the
 * official close): the quote must then show that value.
 */
export function parseSources(list) {
  return (list || []).map((raw) => {
    const [name, url, ...rest] = String(raw).split('|');
    const value = rest.length > 1 ? /^\s*value\s*[=:]\s*(.+)$/i.exec(rest[rest.length - 1])?.[1] : undefined;
    const quote = norm((value !== undefined ? rest.slice(0, -1) : rest).join('|'));
    return { name: norm(name), url: norm(url), quote, ...(value !== undefined ? { value: norm(value) } : {}) };
  });
}

/** The claim flags a kind takes, for the refusal of a claim given in the other kind's shape. */
export const CLAIM_SHAPE = {
  game: '--score "<Team> <points>, <Team> <points> (Final)" and two --source "Name|URL|quote" (--final-at <ISO> optional)',
  question: '--answer YES|NO --value "<the value as the sources show it>" --as-of <ISO UTC time the value is for> and two or more --source "Name|URL|quote" (at least one on a listed Resolution source\'s site; end a source with "|value=<its value>" when it shows a different one)',
};
const QUESTION_CLAIM_INPUTS = ['answer', 'value', 'asOf'];

/**
 * claim.md for bounty #claimed.number (the opponent's, paying this wallet; claimed.status its /onchain-status), citing
 * counter = { number, status, job }: this wallet's own bounty. The claimed bounty's rubric picks the kind, never the
 * input: a game takes score (and finalAt), a question answer, value and asOf; the other kind's inputs are refused with
 * the shape the claim needs. The text is the shared builder's (buildWagerClaim for a game, buildQuestionClaim for a
 * question). Before it the skill checks that a game can be final (3 h after the start) and that a question's Claims
 * open has passed (the shared timing only flags it, but the terms the jury reads say a claim comes after it), runs the
 * shared timing (wagerClaimTimingFor), and, when the claimed bounty's jury reads the counter itself (its Counter line
 * is REQUIRED), runs the shared counter check on this wallet's bounty as that jury will.
 * Returns { claim, warnings, tooEarly, claimAfter, claimBy }; throws with every problem.
 */
export function buildClaim({ claimed, counter, me, ctx, score, sources, finalAt, answer, value, asOf, now }) {
  const t = claimed.terms;
  if (!t?.found || !t.closed || t.count !== 1) throw new Error(`Bounty #${claimed.number} has no single, complete terms block`);
  const unsupported = unsupportedWagerProblem(t, claimed.number);
  if (unsupported) throw new Error(unsupported);
  if (!sameAddress(t.claimant.wallet, me)) throw new Error(`Bounty #${claimed.number} pays ${t.claimant.wallet}, not this wallet`);
  const question = t.kind === 'question', given = { answer, value, asOf };
  if (question && (score != null || finalAt != null)) throw new Error(`Bounty #${claimed.number} is a question wager (${t.rubric}): claim it with ${CLAIM_SHAPE.question}, not --score${finalAt != null ? ' or --final-at' : ''}`);
  if (!question && QUESTION_CLAIM_INPUTS.some((k) => given[k] != null)) throw new Error(`Bounty #${claimed.number} is a game wager (${t.rubric}): claim it with ${CLAIM_SHAPE.game}, not --answer, --value or --as-of`);
  if (question && QUESTION_CLAIM_INPUTS.some((k) => given[k] == null)) throw new Error(`A question claim needs ${CLAIM_SHAPE.question}`);
  const start = unix(t.fields.start);
  if (start == null) throw new Error(`The claimed bounty's ${startLabel(kindOf(t))} cannot be read`);
  if (!question && now < start + CLAIM_OPENS_AFTER_START) throw new Error(`Too early: the game cannot be final yet. Claims open at ${isoOf(start + CLAIM_OPENS_AFTER_START)}; submit about 2 hours after the final, when the jurors' web pages show it`);
  if (/^(\S+);/.exec(norm(t.fields.site))?.[1] !== ctx.site) throw new Error(`Bounty #${claimed.number} is not on ${ctx.site}`);
  const problems = [];
  const timing = shared.wagerClaimTimingFor(t, { deadline: claimed.status?.submissionDeadline, finalAt, now });
  problems.push(...messages(timing.problems));
  // Before Resolves at the shared timing has a problem; after it and before Claims open it only sets tooEarly. The native
  // runtime refuses both, and so does this.
  if (question && (timing.tooEarly || timing.problems.some((p) => p.code === 'CLAIM_TOO_EARLY'))) throw new Error(`Too early: claims open at ${t.fields.claimsOpen}. The terms the jury reads say a claim comes after it, and until then a source or a juror's web cache can still show an earlier value. Prepare the claim from ${t.fields.claimsOpen}`);
  if (!t.counter) {
    const values = termsValues(t);
    problems.push(...values.problems, ...shared.checkCounterBounty({ terms: t, status: counter.status, job: counter.job, expect: values, number: counter.number }));
  }
  let built;
  if (question) {
    built = shared.buildQuestionClaim({ terms: t, bounty: claimed.number, counter: counter.number, answer, value, asOf, sources: parseSources(sources), site: ctx.site, now });
  } else {
    const s = parseScore(score);
    built = shared.buildWagerClaim({ terms: t, bounty: claimed.number, counter: counter.number, score: s.rows, result: s.result, sources: parseSources(sources), site: ctx.site });
  }
  problems.push(...messages(built.problems));
  if (problems.length) throw new Error(`No claim:\n  - ${problems.join('\n  - ')}`);
  return { claim: built.claim, warnings: [...messages(timing.warnings), ...messages(built.warnings)], tooEarly: timing.tooEarly, claimAfter: timing.claimAfter, claimBy: timing.claimBy };
}
