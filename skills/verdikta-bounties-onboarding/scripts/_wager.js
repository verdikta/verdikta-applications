// Mutual wagers, pure logic: no wallet, network, files or environment (wager.js does the I/O).
// A wager is two directed bounties, one per bettor, each paying the other bettor only if that bettor's side wins
// and that bettor holds a live mirrored counter bounty (the website's Mutual Wager template, mutual-wager-v3).
// Terms are built and checked by the website's own code (_mutual-wager-terms.js, vendored byte for byte); this
// module adds the skill's structured input, its extra rules, the read-back of the opponent's bounty from the
// chain, the owner's approval line and the claim.
import { createHash } from 'node:crypto';
import { getAddress, parseEther, ZeroAddress } from 'ethers';
import * as site from './_mutual-wager-terms.js';
import template from './mutual-wager-template.json' with { type: 'json' };
export { site, template };

export const DEFAULT_MARKET = 'straight-up winner on the official final score, overtime included. No point spread.';
export const DEFAULT_NO_WINNER = 'a tie, or no official final score before the settlement deadline';
// The create page writes the Site line with client/src/config.js network names and the Jury line with the
// provider display names of client/src/services/modelProviderService.js; a site user can answer only terms
// spelled the same way.
export const SITE_CHAIN_NAMES = { base: 'Base Mainnet', 'base-sepolia': 'Base Sepolia Testnet' };
export const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Open-source (Ollama)', hyperbolic: 'Hyperbolic API', xai: 'xAI' };
// The template's class and threshold, the create page's oracle defaults (client config submissionDefaults) and the
// jury every wager so far has used. An operator file can replace the jury and oracle settings (wager.js --defaults).
export const WAGER_DEFAULTS = Object.freeze({
  classId: template.classId, threshold: template.threshold, iterations: 1,
  jury: [{ provider: 'OpenAI', model: 'gpt-5.6-terra', weight: 0.5, runs: 1 }, { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5, runs: 1 }],
  oracle: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 },
});
export const WORK_PRODUCT_TYPE = 'Wager settlement claim';
// No game is final this soon after its scheduled start. Jurors' web caches lag the final by up to about two hours.
export const CLAIM_OPENS_AFTER_START = 3 * 3600;
const MIN_SETTLE_AFTER_START = 12 * 3600, MAX_SETTLE_AFTER_START = 60 * 86400;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const WHOLE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;
export const unix = (iso) => (WHOLE_ISO.test(norm(iso)) && Number.isFinite(Date.parse(norm(iso))) ? Date.parse(norm(iso)) / 1000 : null);
export const isoOf = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');
export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sameAddress = (a, b) => { try { return getAddress(String(a)) === getAddress(String(b)); } catch { return false; } };
const wei = (eth) => { try { return parseEther(norm(eth)); } catch { return null; } };
const big = (v) => { try { return BigInt(v); } catch { return null; } };

/** The exact text a wager bounty carries; the owner's approval names the first 8 hex of its SHA-256. */
export const offerText = ({ title, description }) => `${title}\n\n${description}`;
export const termsHash = (offer) => createHash('sha256').update(offerText(offer), 'utf8').digest('hex');

export function siteContext({ network, origin, deployment }) {
  if (!SITE_CHAIN_NAMES[network] || !deployment) throw new Error(`No wager site for network ${network}`);
  return { network, site: origin, escrow: deployment.address, chain: `${SITE_CHAIN_NAMES[network]} (chain ID ${deployment.chainId})` };
}

/** The rubric the create page uploads for the template, minus threshold and classId (create_bounty.js sends those). */
export function wagerRubricJson() {
  return {
    version: template.version, title: template.title, description: template.description || '',
    criteria: template.criteria.map((c) => ({ id: c.id, label: c.label || c.id.replace(/_/g, ' '), must: !!c.must, weight: Number(c.weight ?? 0), description: c.instructions || c.label || c.description || '' })),
    forbiddenContent: template.forbiddenContent || [],
  };
}

/** What the create page passes to checkMutualWagerTerms for the bounty `me` would post (deadline = settlement). */
export function expectFor({ me, target, stake, classId, threshold, jury, iterations, oracle, settle, ctx, now }) {
  return {
    posterWallet: me, targetHunter: target, stake, threshold, classId, jury, iterations, oracle, approvalWindow: false,
    now, deadline: unix(settle), site: ctx.site, escrow: ctx.escrow, chain: ctx.chain,
    criteria: template.criteria, forbiddenContent: template.forbiddenContent, template,
  };
}

// ---- Reading terms lines back (the opponent's bounty is the only source of an answer's terms) ----

/** "OpenAI gpt-5.6-terra weight 0.5, 1 run + ...; 1 iteration." -> { jury, iterations }, or null unless it round-trips. */
export function parseJuryLine(line) {
  const text = norm(line);
  const m = /^(.*); (\d+) iterations?\.$/.exec(text);
  if (!m) return null;
  const nodes = m[1].split(' + ').map((part) => /^(.+) (\S+) weight (\d+(?:\.\d+)?), (\d+) runs?$/.exec(part));
  if (!nodes.length || nodes.some((n) => !n)) return null;
  const jury = nodes.map((n) => ({ provider: n[1], model: n[2], weight: Number(n[3]), runs: Number(n[4]) }));
  const iterations = Number(m[2]);
  return `${site.formatJury(jury, iterations)}.` === text ? { jury, iterations } : null;
}

/** "maxOracleFeeEth 0.00002, estimatedBaseCostEth 0.00001, maxFeeBasedScaling 3, alpha 500." -> settings, or null. */
export function parseOracleLine(line) {
  const text = norm(line);
  const m = /^maxOracleFeeEth (\S+), estimatedBaseCostEth (\S+), maxFeeBasedScaling (\d+), alpha (\d+)\.$/.exec(text);
  if (!m || wei(m[1]) == null || wei(m[2]) == null) return null;
  const oracle = { maxOracleFeeEth: m[1], estimatedBaseCostEth: m[2], maxFeeBasedScaling: Number(m[3]), alpha: Number(m[4]) };
  return `${site.formatOracle(oracle)}.` === text ? oracle : null;
}

export function parseBothLine(line) {
  const m = /^rubric (\S+) \(must-pass criteria ([^)]*)\), threshold (\d+), class (\d+), approval window 0\.$/.exec(norm(line));
  return m ? { rubric: m[1], criteria: m[2].split(', '), threshold: Number(m[3]), classId: Number(m[4]) } : null;
}

/** The values a bounty must have to match a parsed terms block. */
export function termsValues(t) {
  const f = t.fields || {}, problems = [];
  const juryLine = parseJuryLine(f.jury), oracle = parseOracleLine(f.oracle), both = parseBothLine(f.both);
  const stake = /^(\S+) ETH per side\.?$/.exec(norm(f.stake))?.[1];
  if (!juryLine) problems.push('The Jury line cannot be read back ("<Provider> <model> weight <w>, <n> run(s) + ...; <n> iteration(s).").');
  if (!oracle) problems.push('The Oracle settings line cannot be read back.');
  if (!both) problems.push('The "Both bounties" line cannot be read back.');
  if (!(wei(stake) > 0n)) problems.push('The Stake line cannot be read back.');
  if (unix(f.start) == null || unix(f.settle) == null) problems.push('The scheduled start and the settlement deadline must be ISO UTC times to the second, such as 2026-10-21T19:00:00Z.');
  return { problems, jury: juryLine?.jury, iterations: juryLine?.iterations, oracle, classId: both?.classId, threshold: both?.threshold, stake, start: norm(f.start), settle: norm(f.settle) };
}

/**
 * Rules the skill adds to the site's checks. The standard market comes with the standard no-winner clause: testnet
 * #21/#24 add "a game decided in overtime" to it, which contradicts "overtime included" and pays one side only.
 */
export function skillTermsProblems(t) {
  const f = t.fields || {}, problems = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/.test(norm(f.wagerId))) problems.push('The Wager ID must be 4-64 letters, digits, dots, dashes or underscores.');
  if (norm(f.market) === DEFAULT_MARKET && norm(f.noWinner).replace(/\.$/, '') !== DEFAULT_NO_WINNER) {
    problems.push(`The "No winner" line must be the standard clause for the standard market ("${DEFAULT_NO_WINNER}"); it says "${norm(f.noWinner)}".`);
  }
  return problems;
}

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
 * ?includeRubric=true) and its escrow read (rpc). Without `mine`, the terms are the bounty this wallet would post to
 * answer it (mirrored from #number, naming it). With mine = { description, number, status } (this wallet already
 * posted its side), the terms are this wallet's own posted lines, naming #number, so every shared line is compared
 * with what the owner approved. Returns { problems, terms, values, expect, answer (only without mine) }.
 */
export function counterReport({ number, status, job, rpc, me, ctx, now, mine = null }) {
  const placeholder = { number: 0, createdAt: '1970-01-01T00:00:00.000Z', deadline: '1970-01-01T00:00:00.000Z' };
  const named = { number, createdAt: status?.createdAtIso, deadline: status?.submissionDeadlineIso };
  // Mirroring this wallet's description twice swaps the parties back and names #number, keeping its own shared lines.
  const base = mine
    ? site.mirrorMutualWagerTerms(site.mirrorMutualWagerTerms(mine.description, placeholder)?.description, named)
    : site.mirrorMutualWagerTerms(job?.description, named);
  if (!base) return { problems: [mine ? 'Your own bounty has no single, complete terms block.' : `Bounty #${number} has no single, complete MUTUAL WAGER TERMS block.`] };
  const terms = site.parseMutualWagerTerms(base.description);
  const values = termsValues(terms);
  const expect = expectFor({ me, target: terms.claimant.wallet, ...values, ctx, now });
  const problems = [...values.problems];
  if (values.problems.length) return { problems, terms, values, expect };
  if (!mine) problems.push(...site.checkMutualWagerTerms(base.description, expect).problems);
  problems.push(...site.checkCounterBounty({ terms, status, job, expect }));
  problems.push(...chainProblems(number, status, rpc, now));
  problems.push(...skillTermsProblems(terms));
  if (values.iterations !== 1) problems.push('The skill posts wagers with 1 iteration only.');
  if (mine) {
    // Their Counter line: REQUIRED, or this wallet's bounty by number with its real creation time and deadline.
    const theirs = site.parseMutualWagerTerms(job?.description);
    if (theirs.found && theirs.counter) {
      if (mine.number != null && theirs.counter.number !== Number(mine.number)) problems.push(`Bounty #${number}: its Counter bounty line names #${theirs.counter.number}, not your bounty #${mine.number}.`);
      else if (mine.status && (Date.parse(theirs.counter.createdAt) !== Number(mine.status.createdAt) * 1000 || Date.parse(theirs.counter.deadline) !== Number(mine.status.submissionDeadline) * 1000)) {
        problems.push(`Bounty #${number}: its Counter bounty line gives your bounty #${mine.number} a creation time or deadline it does not have.`);
      }
    }
  }
  const answer = mine ? null : { title: `Wager ${terms.fields.wagerId}: answers #${number}, pays if ${terms.claimant.side}`, description: base.description, claimant: base.claimant };
  return { problems, terms, values, expect, answer };
}

// ---- Proposals (the first bettor) ----

const TEXT_LIMITS = { wagerId: 64, event: 300, shortEvent: 60, label: 100, short: 40, market: 200, noWinner: 200 };
function textProblem(name, value, limit) {
  const s = String(value ?? '');
  if (!s.trim()) return `${name} is required.`;
  if (/[\r\n]/.test(s) || /[<>]/.test(s)) return `${name} must be one line without < or >.`;
  if (s.trim().length > limit) return `${name} must be at most ${limit} characters.`;
  return null;
}

/**
 * Structured proposal -> the site's terms object and parties.
 * input = { wagerId, event, shortEvent, start, settle, stake, mySide: { label, short }, opponent: { wallet, label, short },
 *           market?, noWinner? }; defaults = { classId, threshold, iterations, jury, oracle }.
 */
export function proposalTerms(input, { me, ctx, defaults = WAGER_DEFAULTS }) {
  const i = input || {}, problems = [];
  const check = (name, value, limit) => { const e = textProblem(name, value, limit); if (e) problems.push(e); };
  check('wagerId', i.wagerId, TEXT_LIMITS.wagerId); check('event', i.event, TEXT_LIMITS.event); check('shortEvent', i.shortEvent, TEXT_LIMITS.shortEvent);
  for (const side of ['mySide', 'opponent']) {
    check(`${side}.label`, i[side]?.label, TEXT_LIMITS.label); check(`${side}.short`, i[side]?.short, TEXT_LIMITS.short);
    if (/[.;]$/.test(norm(i[side]?.label))) problems.push(`${side}.label must not end with . or ;`);
  }
  if (i.market != null) check('market', i.market, TEXT_LIMITS.market);
  if (i.noWinner != null) check('noWinner', i.noWinner, TEXT_LIMITS.noWinner);
  if (norm(i.mySide?.label).toLowerCase() === norm(i.opponent?.label).toLowerCase()) problems.push('mySide.label and opponent.label must name different sides.');
  let opponent = null;
  try { opponent = getAddress(String(i.opponent?.wallet ?? '')); } catch { problems.push('opponent.wallet must be an address.'); }
  if (opponent === ZeroAddress) problems.push('opponent.wallet cannot be the zero address.');
  if (opponent && sameAddress(opponent, me)) problems.push('opponent.wallet is this wallet: a wager needs another bettor.');
  if (!/^\d+(\.\d{1,18})?$/.test(norm(i.stake)) || !(wei(i.stake) > 0n)) problems.push('stake must be a positive decimal ETH amount, such as "0.001".');
  const start = unix(i.start), settle = unix(i.settle);
  if (start == null) problems.push('start must be the scheduled start, ISO UTC to the second, such as 2026-10-20T19:00:00Z.');
  if (settle == null) problems.push('settle must be the settlement deadline, ISO UTC to the second, such as 2026-10-22T19:00:00Z.');
  if (start != null && settle != null && (settle - start < MIN_SETTLE_AFTER_START || settle - start > MAX_SETTLE_AFTER_START)) problems.push('settle must be between 12 hours and 60 days after start (it is also both bounties\' deadline).');
  const terms = {
    wagerId: norm(i.wagerId), event: norm(i.event), shortEvent: norm(i.shortEvent), start: norm(i.start), market: i.market == null ? DEFAULT_MARKET : norm(i.market),
    ...(i.noWinner == null ? {} : { noWinner: norm(i.noWinner).replace(/\.$/, '') }),
    stake: norm(i.stake), settle: norm(i.settle), classId: defaults.classId, threshold: defaults.threshold,
    jury: defaults.jury, iterations: defaults.iterations ?? 1, oracle: defaults.oracle, site: ctx.site, escrow: ctx.escrow, chain: ctx.chain,
  };
  const poster = { wallet: me, label: norm(i.mySide?.label), short: norm(i.mySide?.short) };
  const claimant = { wallet: opponent, label: norm(i.opponent?.label), short: norm(i.opponent?.short) };
  return { terms, poster, claimant, problems };
}

/** The first bettor's bounty: offer text, terms hash and every check, before any approval or spend. */
export function buildProposal(input, { me, ctx, defaults = WAGER_DEFAULTS, now }) {
  const { terms, poster, claimant, problems } = proposalTerms(input, { me, ctx, defaults });
  if (problems.length) return { problems };
  const offer = site.buildMutualWagerBounty(terms, poster, claimant, null);
  const expect = expectFor({ me, target: claimant.wallet, stake: terms.stake, ...defaults, settle: terms.settle, ctx, now });
  const checked = site.checkMutualWagerTerms(offer.description, expect);
  problems.push(...checked.problems, ...skillTermsProblems(checked.terms));
  if ((defaults.iterations ?? 1) !== 1) problems.push('The skill posts wagers with 1 iteration only.');
  return { offer, terms: checked.terms, expect, termsSha256: termsHash(offer), problems };
}

/** create_bounty.js config for an approved wager bounty: TARGETED, exact deadline = settlement deadline, no window. */
export function createConfig({ offer, expect, wager }) {
  const o = expect.oracle;
  return {
    title: offer.title, description: offer.description, workProductType: WORK_PRODUCT_TYPE,
    rubricJson: wagerRubricJson(), threshold: expect.threshold, classId: expect.classId,
    juryNodes: expect.jury.map(({ provider, model, weight, runs }) => ({ provider, model, weight, runs: runs ?? 1 })),
    procurementMode: 'TARGETED', targetHunter: getAddress(expect.targetHunter), bountyAmount: String(expect.stake),
    submissionDeadline: expect.deadline, creatorAssessmentWindowSeconds: 0,
    oracle: { maxOracleFee: parseEther(String(o.maxOracleFeeEth)).toString(), alpha: Number(o.alpha), estimatedBaseCost: parseEther(String(o.estimatedBaseCostEth)).toString(), maxFeeBasedScaling: Number(o.maxFeeBasedScaling) },
    wager,
  };
}

// ---- The owner's approval line ----

/** Approve wager <8+ hex of the terms SHA-256>, stake <X> ETH, vs <opponent address, full or 0x1234…abcd>, settle <ISO>. */
export const WAGER_APPROVAL_LINE = /\bapprove\s+wager\s+([0-9a-f]{8,64})\b[\s,;:]*stake\s*[:=]?\s*(\d+(?:\.\d+)?)\s*eth\b[\s,;:]*(?:vs\.?|versus|against)\s*(0x[0-9a-f]{40}|0x[0-9a-f]{4,}\s*(?:…|\.{2,3})\s*[0-9a-f]{4,})[\s,;:]*settle\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)/gi;

export function parseWagerApprovalLines(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(WAGER_APPROVAL_LINE)].map((m) => ({ hashPrefix: m[1].toLowerCase(), stake: m[2], opponent: m[3].replace(/\s+/g, ''), settle: m[4], line: m[0] }));
}

export const approvalLineFor = ({ termsSha256, stake, opponent, settle }) => `Approve wager ${termsSha256.slice(0, 8)}, stake ${stake} ETH, vs ${shortAddress(opponent)}, settle ${settle}`;

function opponentMatches(written, wallet) {
  const w = written.toLowerCase(), full = String(wallet).toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(w)) return w === full;
  const m = /^0x([0-9a-f]{4,})(?:…|\.{2,3})([0-9a-f]{4,})$/.exec(w);
  return Boolean(m) && full.slice(2).startsWith(m[1]) && full.endsWith(m[2]);
}

/** The approval line that names these exact terms; throws with the reason otherwise. */
export function bindWagerApproval({ approvalText, termsSha256, stake, opponent, settle }) {
  const lines = parseWagerApprovalLines(approvalText);
  if (!lines.length) throw new Error('No wager approval line found. Expected: Approve wager <first 8 hex of the terms hash>, stake <X> ETH, vs <opponent address>, settle <ISO time>');
  const forTerms = lines.filter((l) => termsSha256.startsWith(l.hashPrefix));
  if (!forTerms.length) throw new Error(`The approval names terms ${lines.map((l) => l.hashPrefix).join(', ')}; these terms hash to ${termsSha256.slice(0, 16)}… They changed: show the owner the current terms and ask for a fresh approval`);
  const a = forTerms[0];
  if (wei(a.stake) !== wei(stake)) throw new Error(`The approval says stake ${a.stake} ETH; the terms say ${stake} ETH`);
  if (!opponentMatches(a.opponent, opponent)) throw new Error(`The approval names opponent ${a.opponent}; the terms name ${opponent}`);
  if (Date.parse(a.settle) !== Date.parse(settle)) throw new Error(`The approval says settle ${a.settle}; the terms say ${settle}`);
  return a;
}

// ---- The claim ----

const SCORE = /^(.+?) (\d{1,3}), (.+?) (\d{1,3}) \((Final(?:[/ ,-]+[0-9A-Za-z]+)*)\)$/;
const NOT_SOURCES = /(^|\.)(x\.com|twitter\.com|facebook\.com|instagram\.com|tiktok\.com|reddit\.com|youtube\.com|threads\.net|t\.me|discord\.com|discord\.gg|draftkings\.com|fanduel\.com|betmgm\.com|caesars\.com|bet365\.com|oddschecker\.com|covers\.com|actionnetwork\.com|polymarket\.com|kalshi\.com)$/i;
const ADDRESSES_EVALUATOR = /\b(evaluators?|jurors?|jury|ignore (?:all|any|the|previous)|disregard|you must|award (?:this|the)|score this)\b/i;

export function parseScore(score) {
  const m = SCORE.exec(norm(score));
  if (!m) throw new Error('--score must read "<Team> <points>, <Team> <points> (Final)", for example "Detroit Pistons 112, Boston Celtics 104 (Final)" or "(Final/OT)"');
  return { teams: [m[1], m[3]], points: [Number(m[2]), Number(m[4])], status: m[5] };
}

/** --source "Name|https://url|verbatim quote from that page". */
export function parseSources(list) {
  const sources = (list || []).map((raw) => {
    const [name, url, ...rest] = String(raw).split('|');
    const quote = norm(rest.join('|'));
    let host;
    try { const u = new URL(norm(url)); if (u.protocol !== 'https:') throw new Error(); host = u.hostname.replace(/^www\./, '').toLowerCase(); } catch { throw new Error(`Source "${norm(name)}": the URL must be a full https:// address`); }
    if (!norm(name) || norm(name).length > 80) throw new Error('Each source needs a name of at most 80 characters');
    if (quote.length < 10 || quote.length > 500) throw new Error(`Source ${host}: the quote must be 10-500 characters copied from the page`);
    if (NOT_SOURCES.test(host)) throw new Error(`Source ${host}: social media, video and betting sites are not reputable sources for the result`);
    if (ADDRESSES_EVALUATOR.test(quote) || ADDRESSES_EVALUATOR.test(norm(name))) throw new Error(`Source ${host}: the quote addresses the evaluator; copy only the page's own text`);
    return { name: norm(name), url: norm(url), quote, host };
  });
  if (sources.length < 2 || sources.length > 4) throw new Error('Give two to four --source entries from independent reputable sites');
  const base = (h) => h.split('.').slice(-2).join('.');
  if (new Set(sources.map((s) => base(s.host))).size !== sources.length) throw new Error('The sources must be on different sites');
  return sources;
}

/**
 * claim.md for bounty #claimed.number (the opponent's, paying this wallet), citing counterNumber (this wallet's own
 * bounty). Refuses before the game can be final, after the settlement deadline, on a tie, when the score's winner is
 * not this wallet's side (standard market), and on quotes that do not show the score.
 */
export function buildClaim({ claimed, counterNumber, me, ctx, score, sources, now }) {
  const t = claimed.terms;
  if (!t?.found || !t.closed || t.count !== 1) throw new Error(`Bounty #${claimed.number} has no single, complete terms block`);
  if (!sameAddress(t.claimant.wallet, me)) throw new Error(`Bounty #${claimed.number} pays ${t.claimant.wallet}, not this wallet`);
  const start = unix(t.fields.start), settle = unix(t.fields.settle);
  if (start == null || settle == null) throw new Error('The claimed bounty\'s start or settlement deadline cannot be read');
  if (now < start + CLAIM_OPENS_AFTER_START) throw new Error(`Too early: the game cannot be final yet. Claims open at ${isoOf(start + CLAIM_OPENS_AFTER_START)}; submit about 2 hours after the final, when the jurors' web pages show it`);
  if (now >= settle) throw new Error(`Too late: the settlement deadline ${t.fields.settle} has passed`);
  const siteUrl = /^(\S+);/.exec(norm(t.fields.site))?.[1];
  if (siteUrl !== ctx.site) throw new Error(`Bounty #${claimed.number} is on ${siteUrl}, not ${ctx.site}`);
  if (!Number.isSafeInteger(Number(counterNumber)) || Number(counterNumber) < 0) throw new Error('The counter bounty number is unknown');
  const s = parseScore(score);
  if (s.points[0] === s.points[1]) throw new Error('A tie: under the terms nobody wins, so do not claim');
  const event = norm(t.fields.event).toLowerCase();
  for (const team of s.teams) if (!event.includes(team.toLowerCase())) throw new Error(`"${team}" is not in the event line (${t.fields.event}); use the team names as written there`);
  const winner = s.points[0] > s.points[1] ? s.teams[0] : s.teams[1], loser = winner === s.teams[0] ? s.teams[1] : s.teams[0];
  const side = norm(t.claimant.side).toLowerCase();
  if (norm(t.fields.market) === DEFAULT_MARKET && (!side.includes(winner.toLowerCase()) || side.includes(loser.toLowerCase()))) {
    throw new Error(`By this score ${winner} won, and your side is "${t.claimant.side}": do not claim`);
  }
  const list = parseSources(sources);
  for (const src of list) {
    for (const n of s.points) if (!new RegExp(`(^|\\D)${n}(\\D|$)`).test(src.quote)) throw new Error(`Source ${src.host}: the quote must show the final score (${s.points.join('-')}); copy the scoreboard or recap text`);
  }
  const marketHead = norm(t.fields.market).split('.')[0];
  return [
    `MUTUAL WAGER CLAIM (${t.rubric})`,
    `Wager ID: ${t.fields.wagerId}`,
    `Bounty claimed: #${claimed.number}`,
    `Claimant: ${t.claimant.wallet}   Poster: ${t.poster.wallet}`,
    '',
    '1. Result',
    `Event: ${t.fields.event}`,
    `Final score: ${norm(score)}`,
    `Claimant's side per the terms: ${t.claimant.side}. Outcome under the market (${marketHead}): ${t.claimant.side}.`,
    '',
    '2. Sources',
    ...list.flatMap((src, k) => [`${'abcd'[k]}) ${src.name}: ${src.url}`, `   Quote: "${src.quote}"`]),
    '',
    '3. Counter bounty',
    `Bounty #${counterNumber}`,
    `On-chain parameters: ${ctx.site}/api/jobs/${counterNumber}/onchain-status`,
    `Terms, rubric and jury: ${ctx.site}/api/jobs/${counterNumber}?includeRubric=true`,
    '',
  ].join('\n');
}
