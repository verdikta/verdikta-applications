// Mutual wagers, pure logic: no wallet, network, files or environment (wager.js does the I/O).
// A wager is two directed bounties, one per bettor, each paying the other bettor only if that bettor's side wins
// and that bettor holds a live mirrored counter bounty (the website's Mutual Wager template, mutual-wager-v3).
// Bodies, checks and claims come from the website's shared module (_mutual-wager.cjs, vendored byte for byte):
// the same code the create page, the bounty server's /api/wagers and its /jobs/create check run. This module adds
// the skill's layers: an escrow read of the opponent's bounty, the standard no-winner rule, the owner's approval
// lines and the create_bounty.js config.
import { createHash } from 'node:crypto';
import { getAddress, parseEther, ZeroAddress } from 'ethers';
import shared from './_mutual-wager.cjs';
export { shared };

export const template = shared.MUTUAL_WAGER_TEMPLATE;
export const DEFAULT_MARKET = shared.DEFAULT_WAGER_MARKET;
export const DEFAULT_NO_WINNER = shared.DEFAULT_NO_WINNER;
// Provider display names of client/src/services/modelProviderService.js: the create page's Jury line spells
// providers this way, and an operator's wager-defaults.json may use the lower-case API names.
export const PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', ollama: 'Open-source (Ollama)', hyperbolic: 'Hyperbolic API', xai: 'xAI' };
// The template's class and threshold, the shared default jury and the create page's oracle defaults (client config
// submissionDefaults). An operator file can replace the jury, oracle settings and class (wager.js --defaults).
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
export const PROPOSAL_FIELDS = ['wagerId', 'event', 'start', 'settle', 'stake', 'opponent', 'sides', 'market', 'noWinner'];

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

/** The shared /jobs/create rubricJson minus threshold and classId, which create_bounty.js sends outside the rubric. */
export function wagerRubricJson() {
  const { threshold, classId, ...rubric } = shared.mutualWagerRubricJson();
  return rubric;
}

/** What the create page (and the server) pass to checkMutualWagerTerms for the bounty `me` would post. */
export function expectFor({ me, target, stake, classId, threshold, jury, iterations, oracle, settle, ctx, now }) {
  return {
    posterWallet: me, targetHunter: target, stake, threshold, classId, jury, iterations, oracle, approvalWindow: false,
    now, deadline: unix(settle), site: ctx.site, escrow: ctx.escrow, chain: ctx.chain, rubric: wagerRubricJson(),
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
  if (unix(f.start) == null || unix(f.settle) == null) problems.push('The scheduled start and the settlement deadline must be ISO UTC times to the second, such as 2026-10-21T19:00:00Z.');
  return { problems, jury: juryLine?.jury, iterations: juryLine?.iterations, oracle, classId: both?.classId, threshold: both?.threshold, stake, start: norm(f.start), settle: norm(f.settle) };
}

/**
 * The skill's rules on top of the shared checks. The standard market comes with the standard no-winner clause:
 * testnet #21/#24 add "a game decided in overtime" to it, which contradicts "overtime included" and pays one side only.
 */
export function skillTermsProblems(t) {
  const f = t.fields || {}, problems = [];
  if (norm(f.market) === DEFAULT_MARKET && norm(f.noWinner).replace(/\.$/, '') !== DEFAULT_NO_WINNER) {
    problems.push(`The "No winner" line must be the standard clause for the standard market ("${DEFAULT_NO_WINNER}"); it says "${norm(f.noWinner)}".`);
  }
  // The settlement deadline is also both bounties' deadline: too soon and no claim fits after the final, too late and
  // the loser's stake stays locked.
  const start = unix(f.start), settle = unix(f.settle);
  if (start != null && settle != null && (settle - start < MIN_SETTLE_AFTER_START || settle - start > MAX_SETTLE_AFTER_START)) {
    problems.push('The settlement deadline must be between 12 hours and 60 days after the scheduled start.');
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
 * ?includeRubric=true) and its escrow read (rpc). Without `mine`, the terms are the answer this wallet would post
 * (shared answerMutualWager: mirrored from #number, naming it), checked as the create page and the server check it.
 * With mine = { description, number, status } (this wallet already posted its side), the terms are this wallet's own
 * posted lines, naming #number, so every shared line is compared with what the owner approved.
 * Returns { problems, terms, values, expect, answer: { title, description, createBody } (only without mine) }.
 */
export function counterReport({ number, status, job, rpc, me, ctx, now, mine = null }) {
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
  if (!mine) problems.push(...messages(answered.problems), ...shared.checkMutualWagerTerms(base, expect).problems);
  problems.push(...shared.checkCounterBounty({ terms, status, job, expect }));
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
  return { problems, terms, values, expect, answer };
}

/**
 * The first bettor's bounty (shared proposeMutualWager) with every check, before any approval or spend.
 * input = { wagerId, event, start, settle, stake, opponent, sides: { creator, opponent }, market?, noWinner? }.
 */
export function buildProposal(input, { me, ctx, defaults = WAGER_DEFAULTS, now }) {
  const unknown = Object.keys(input || {}).filter((k) => !PROPOSAL_FIELDS.includes(k) && k !== '_note');
  if (input && '_note' in input) input = Object.fromEntries(Object.entries(input).filter(([k]) => k !== '_note'));
  if (unknown.length) return { problems: [`Not proposal fields: ${unknown.join(', ')}. Use ${PROPOSAL_FIELDS.join(', ')} (see examples/wager-proposal.json).`] };
  const built = shared.proposeMutualWager({ ...input, creator: me, classId: defaults.classId, threshold: defaults.threshold, jury: defaults.jury, iterations: defaults.iterations ?? 1, oracle: defaults.oracle }, ctx);
  if (!built.createBody) return { problems: messages(built.problems) };
  const expect = expectFor({ me, target: built.claimant.wallet, stake: built.terms.stake, ...defaults, settle: built.terms.settle, ctx, now });
  const checked = shared.checkMutualWagerTerms(built.description, expect);
  const problems = [...checked.problems, ...skillTermsProblems(checked.terms)];
  const offer = { title: built.title, description: built.description };
  return { offer, createBody: built.createBody, terms: checked.terms, expect, termsSha256: termsHash(offer), problems };
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

// ---- The owner's approval lines (shared with the native runtime) ----

/** Approve wager <8+ hex of the terms SHA-256>, stake <X> ETH, vs <opponent: full address, 0x + 8+ hex, or 0x1234…abcd>, settle <ISO>. */
export const WAGER_APPROVAL_LINE = /\bapprove\s+wager\s+([0-9a-f]{8,64})\b[\s,;:]*stake\s*[:=]?\s*(\d+(?:\.\d+)?)\s*eth\b[\s,;:]*(?:vs\.?|versus|against)\s*(0x[0-9a-f]{40}|0x[0-9a-f]{4,}\s*(?:…|\.{2,3})\s*[0-9a-f]{4,}|0x[0-9a-f]{8,39})[\s,;:]*settle\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)/gi;

export function parseWagerApprovalLines(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(WAGER_APPROVAL_LINE)].map((m) => ({ hashPrefix: m[1].toLowerCase(), stake: m[2], opponent: m[3].replace(/\s+/g, ''), settle: m[4], line: m[0] }));
}

export const approvalLineFor = ({ termsSha256, stake, opponent, settle }) => `Approve wager ${termsSha256.slice(0, 8)}, stake ${stake} ETH, vs ${getAddress(opponent)}, settle ${settle}`;

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
  if (!lines.length) throw new Error('No wager approval line found. Expected: Approve wager <first 8 hex of the terms hash>, stake <X> ETH, vs <opponent address>, settle <ISO time>');
  const forTerms = lines.filter((l) => termsSha256.startsWith(l.hashPrefix));
  if (!forTerms.length) throw new Error(`The approval names terms ${lines.map((l) => l.hashPrefix).join(', ')}; these terms hash to ${termsSha256.slice(0, 16)}… They changed: show the owner the current terms and ask for a fresh approval`);
  const a = forTerms[0];
  if (wei(a.stake) !== wei(stake)) throw new Error(`The approval says stake ${a.stake} ETH; the terms say ${stake} ETH`);
  if (!opponentMatches(a.opponent, opponent)) throw new Error(`The approval names opponent ${a.opponent}; the terms name ${opponent}`);
  if (Date.parse(a.settle) !== Date.parse(settle)) throw new Error(`The approval says settle ${a.settle}; the terms say ${settle}`);
  return a;
}

/** Approve claim <8+ hex of the SHA-256 of claim.md>, bounty #<N>: the owner's approval to submit that exact claim. */
export const CLAIM_APPROVAL_LINE = /\bapprove\s+claim\s+([0-9a-f]{8,64})\b[\s,;:]*bounty\s*#?\s*(\d+)\b/gi;
export const claimLineFor = ({ claimSha256, bounty }) => `Approve claim ${claimSha256.slice(0, 8)}, bounty #${bounty}`;
export function bindClaimApproval({ approvalText, claimSha256, bounty }) {
  const lines = typeof approvalText === 'string' ? [...approvalText.matchAll(CLAIM_APPROVAL_LINE)].map((m) => ({ hashPrefix: m[1].toLowerCase(), bounty: Number(m[2]), line: m[0] })) : [];
  if (!lines.length) throw new Error('No claim approval line found. Expected: Approve claim <first 8 hex of the claim.md hash>, bounty #<N>');
  const hit = lines.find((l) => claimSha256.startsWith(l.hashPrefix) && l.bounty === Number(bounty));
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

/** --source "Name|https://url|verbatim quote from that page" -> shared sources. */
export function parseSources(list) {
  return (list || []).map((raw) => {
    const [name, url, ...rest] = String(raw).split('|');
    return { name: norm(name), url: norm(url), quote: norm(rest.join('|')) };
  });
}

/**
 * claim.md for bounty #claimed.number (the opponent's, paying this wallet; claimed.status its /onchain-status), citing
 * counter = { number, status, job }: this wallet's own bounty. The text is the shared buildWagerClaim's. Before it the
 * skill checks that the game can be final (3 h after the start), runs the shared timing, and, when the claimed
 * bounty's jury reads the counter itself (its Counter line is REQUIRED), runs the shared counter check on this
 * wallet's bounty as that jury will. Returns { claim, warnings, tooEarly, claimAfter }; throws with every problem.
 */
export function buildClaim({ claimed, counter, me, ctx, score, sources, finalAt, now }) {
  const t = claimed.terms;
  if (!t?.found || !t.closed || t.count !== 1) throw new Error(`Bounty #${claimed.number} has no single, complete terms block`);
  if (!sameAddress(t.claimant.wallet, me)) throw new Error(`Bounty #${claimed.number} pays ${t.claimant.wallet}, not this wallet`);
  const start = unix(t.fields.start);
  if (start == null) throw new Error('The claimed bounty\'s scheduled start cannot be read');
  if (now < start + CLAIM_OPENS_AFTER_START) throw new Error(`Too early: the game cannot be final yet. Claims open at ${isoOf(start + CLAIM_OPENS_AFTER_START)}; submit about 2 hours after the final, when the jurors' web pages show it`);
  if (/^(\S+);/.exec(norm(t.fields.site))?.[1] !== ctx.site) throw new Error(`Bounty #${claimed.number} is not on ${ctx.site}`);
  const problems = [];
  const timing = shared.wagerClaimTiming({ start: t.fields.start, settle: t.fields.settle, deadline: claimed.status?.submissionDeadline, finalAt, now });
  problems.push(...messages(timing.problems));
  if (!t.counter) {
    const values = termsValues(t);
    problems.push(...values.problems, ...shared.checkCounterBounty({ terms: t, status: counter.status, job: counter.job, expect: values, number: counter.number }));
  }
  const s = parseScore(score);
  const built = shared.buildWagerClaim({ terms: t, bounty: claimed.number, counter: counter.number, score: s.rows, result: s.result, sources: parseSources(sources), site: ctx.site });
  problems.push(...messages(built.problems));
  if (problems.length) throw new Error(`No claim:\n  - ${problems.join('\n  - ')}`);
  return { claim: built.claim, warnings: [...messages(timing.warnings), ...messages(built.warnings)], tooEarly: timing.tooEarly, claimAfter: timing.claimAfter };
}
