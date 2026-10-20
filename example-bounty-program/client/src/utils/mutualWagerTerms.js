// Job Description for one bounty of a mutual wager (the "Mutual Wager" rubric template).
// A wager is two directed bounties: each bettor posts one that pays the other bettor only
// if that bettor's side wins and the bettor holds a live mirrored counter bounty. The jury
// reads the terms only from the description, so both bounties must carry the same block
// with Poster and Claimant swapped; building both from one config keeps them in step.
//
// terms = { wagerId, event, shortEvent, start (ISO UTC), market, noWinner?, stake (ETH),
//           settle (ISO UTC), classId, threshold, jury: [{ provider, model, weight, runs }],
//           iterations?, oracle: { maxOracleFeeEth, estimatedBaseCostEth, maxFeeBasedScaling, alpha },
//           site, escrow, chain, criteria?: [id] }
// poster / claimant = { wallet, label, short }; counter = { number, createdAt, deadline } or null.
//
// The create page runs checkMutualWagerTerms before funding, and checkCounterBounty when the
// terms name a counter bounty: the jury skips its own counter checks in that case, so the
// site checks the named bounty's live record instead.
import { ethers } from 'ethers';

export const MUTUAL_WAGER_RUBRIC = 'mutual-wager-v3';
export const MUTUAL_WAGER_CRITERIA = ['terms_match', 'event_final', 'result_sources', 'claimant_side_won',
  'counter_bounty_onchain', 'counter_bounty_terms', 'integrity'];
export const MUTUAL_WAGER_TERMS_HEADER = '=== MUTUAL WAGER TERMS';
const TERMS_END = '=== END WAGER TERMS ===';
const DEFAULT_NO_WINNER = 'a tie, or no official final score before the settlement deadline';
// The other side's jury requires each bounty to exist before the scheduled start; leave room
// for the wallet and the block.
export const MIN_START_LEAD_SECONDS = 10 * 60;

const LINES = [
  ['wagerId', 'Wager ID: '],
  ['event', 'Event: '],
  ['start', 'Scheduled start: '],
  ['market', 'Market: '],
  ['poster', 'Poster (creator): '],
  ['claimant', 'Claimant (target, the only wallet that can claim): '],
  ['pays', 'Pays the Claimant only if '],
  ['noWinner', 'No winner (this bounty must not pay): '],
  ['stake', 'Stake: '],
  ['settle', 'Settlement deadline: '],
  ['both', 'Both bounties: '],
  ['jury', 'Jury (both bounties): '],
  ['oracle', 'Oracle settings (both bounties): '],
  ['counter', 'Counter bounty: '],
  ['site', 'Site: '],
];
// Lines the two bounties of a pair may not share: the parties swap, and each names its own counter.
const MIRRORED = new Set(['poster', 'claimant', 'pays', 'counter']);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const same = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();
const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '')) && !/^0x0{40}$/.test(String(a));
const toWei = (v) => { try { return ethers.parseEther(norm(v)); } catch { return null; } };
const eth = (v) => { const w = toWei(v); return w == null ? norm(v) : ethers.formatEther(w); };
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const unixOf = (iso) => (ISO_UTC.test(norm(iso)) ? Math.floor(Date.parse(norm(iso)) / 1000) : null);

/** "OpenAI gpt-5.6-terra weight 0.5, 1 run + Anthropic claude-sonnet-5 weight 0.5, 1 run; 1 iteration" */
export function formatJury(jury, iterations = 1) {
  if (!Array.isArray(jury) || jury.length === 0) return '<jury, e.g. OpenAI gpt-5.6-terra weight 0.5, 1 run + Anthropic claude-sonnet-5 weight 0.5, 1 run; 1 iteration>';
  const runs = (n) => `${n} run${Number(n) === 1 ? '' : 's'}`;
  const nodes = jury.map((n) => (typeof n === 'string' ? n : `${n.provider} ${n.model} weight ${Number(n.weight)}, ${runs(n.runs ?? 1)}`));
  return `${nodes.join(' + ')}; ${iterations} iteration${Number(iterations) === 1 ? '' : 's'}`;
}

/** "maxOracleFeeEth 0.00002, estimatedBaseCostEth 0.00001, maxFeeBasedScaling 3, alpha 500": onchain-status names. */
export function formatOracle(o) {
  if (!o) return '<oracle settings>';
  return `maxOracleFeeEth ${eth(o.maxOracleFeeEth)}, estimatedBaseCostEth ${eth(o.estimatedBaseCostEth)}, maxFeeBasedScaling ${Number(o.maxFeeBasedScaling)}, alpha ${Number(o.alpha)}`;
}

const bothLine = (threshold, classId, ids = MUTUAL_WAGER_CRITERIA) => `rubric ${MUTUAL_WAGER_RUBRIC} (must-pass criteria ${ids.join(', ')}), threshold ${threshold}, class ${classId}, approval window 0.`;
const siteLine = (terms) => `${terms.site}; escrow ${terms.escrow} on ${terms.chain}; no cancel or edit.`;

/** Title and description of the bounty that `poster` creates; it pays `claimant` if the claimant's side wins. */
export function buildMutualWagerBounty(terms, poster, claimant, counter = null) {
  const counterLine = counter
    ? `Counter bounty: #${counter.number}, verified by the Poster before posting (created by the Claimant, targeted at the Poster, ${terms.stake} ETH, created ${counter.createdAt}, deadline ${counter.deadline}, mirrored terms, same rubric, jury and oracle settings). It pays the Poster only if ${poster.label}.`
    : `Counter bounty: REQUIRED: the Claimant's bounty targeted at the Poster that pays the Poster only if ${poster.label}.`;
  const claimSteps = counter
    ? `and counter bounty #${counter.number}.`
    : `and the counter bounty's ${terms.site}/api/jobs/N/onchain-status and ${terms.site}/api/jobs/N?includeRubric=true URLs.`;
  const description = [
    'Settles one side of a two-bounty wager.',
    '',
    `${MUTUAL_WAGER_TERMS_HEADER} (${MUTUAL_WAGER_RUBRIC}) ===`,
    `Wager ID: ${terms.wagerId}`,
    `Event: ${terms.event}`,
    `Scheduled start: ${terms.start}`,
    `Market: ${terms.market}`,
    `Poster (creator): ${poster.wallet}; side: ${poster.label}.`,
    `Claimant (target, the only wallet that can claim): ${claimant.wallet}; side: ${claimant.label}.`,
    `Pays the Claimant only if ${claimant.label}.`,
    `No winner (this bounty must not pay): ${terms.noWinner || DEFAULT_NO_WINNER}.`,
    `Stake: ${terms.stake} ETH per side.`,
    `Settlement deadline: ${terms.settle}`,
    `Both bounties: ${bothLine(terms.threshold, terms.classId, terms.criteria)}`,
    `Jury (both bounties): ${formatJury(terms.jury, terms.iterations ?? 1)}.`,
    `Oracle settings (both bounties): ${formatOracle(terms.oracle)}.`,
    counterLine,
    `Site: ${siteLine(terms)}`,
    TERMS_END,
    '',
    `To claim (Claimant, after the event and before the settlement deadline): submit claim.md with the final score, two sources (URL + quote) ${claimSteps}`,
  ].join('\n');
  const title = `Wager ${terms.wagerId}: ${terms.shortEvent}, pays if ${claimant.short} win`;
  return { title, description };
}

/**
 * The terms block with what the create form already knows filled in and <...> placeholders
 * for the rest. The first poster's version: the counter bounty does not exist yet.
 */
export function mutualWagerTermsSkeleton({ posterWallet, claimantWallet, stake, threshold, classId, jury, iterations, oracle, site, escrow, chain }) {
  const known = (v, hint) => (v === undefined || v === null || v === '' ? `<${hint}>` : v);
  const terms = {
    wagerId: '<Wager ID, new for every pair, e.g. VW-WSH-SF-20261019>',
    event: '<league, season and round: Away Team (ABBR) at Home Team (ABBR), venue>',
    start: '<scheduled start, ISO UTC, e.g. 2026-10-20T00:15:00Z>',
    market: 'straight-up winner on the official final score, overtime included. No point spread.',
    stake: known(stake, 'stake in ETH'),
    settle: '<settlement deadline, ISO UTC, at or before both bounty deadlines>',
    threshold: known(threshold, 'threshold'),
    classId: known(classId, 'class'),
    jury, iterations: iterations ?? 1, oracle,
    site: known(site, 'bounty site URL'),
    escrow: known(escrow, 'escrow address'),
    chain: known(chain, 'chain'),
  };
  const poster = { wallet: known(posterWallet, "Poster's wallet (yours)"), label: "<the Poster's side, e.g. the San Francisco 49ers win>" };
  const claimant = { wallet: known(claimantWallet, "Claimant's wallet (the Target Hunter)"), label: "<the Claimant's side, e.g. the Washington Commanders win>" };
  return buildMutualWagerBounty(terms, poster, claimant, null).description;
}

/** True when a description already carries a terms block. */
export function hasMutualWagerTerms(description) {
  return typeof description === 'string' && description.includes(MUTUAL_WAGER_TERMS_HEADER);
}

const party = (rest) => {
  const m = /^(\S+); side: (.+?)\.?$/.exec(norm(rest));
  return m ? { wallet: m[1], side: m[2] } : { wallet: null, side: null };
};

/** Reads the first terms block in a description into its lines. */
export function parseMutualWagerTerms(description) {
  const text = String(description || '');
  const count = text.split(MUTUAL_WAGER_TERMS_HEADER).length - 1;
  if (count === 0) return { found: false, count };
  const start = text.indexOf(MUTUAL_WAGER_TERMS_HEADER);
  const end = text.indexOf(TERMS_END, start);
  const block = text.slice(start, end < 0 ? undefined : end);
  const [header, ...rest] = block.split('\n');
  const fields = {};
  for (const raw of rest) {
    const line = norm(raw);
    const hit = LINES.find(([, prefix]) => line.startsWith(prefix));
    if (hit && fields[hit[0]] === undefined) fields[hit[0]] = line.slice(hit[1].length);
  }
  const counterNumber = /^#(\d+)\b/.exec(fields.counter || '')?.[1];
  const counterTimes = /created (\S+), deadline (\S+?),/.exec(fields.counter || '');
  return {
    found: true, count, closed: end >= 0, block,
    rubric: /\(([^()]+)\) ===/.exec(header)?.[1] || null,
    fields,
    poster: party(fields.poster), claimant: party(fields.claimant),
    pays: fields.pays === undefined ? null : norm(fields.pays).replace(/\.$/, ''),
    counter: counterNumber ? { number: Number(counterNumber), createdAt: counterTimes?.[1], deadline: counterTimes?.[2] } : null,
  };
}

const criteriaProblem = (have, want) => {
  const key = (c) => [c.id, c.must === true, Number(c.weight), norm(c.instructions ?? c.description)].join('|');
  if (!Array.isArray(have) || have.length !== want.length) return `has ${Array.isArray(have) ? have.length : 0} criteria, the template has ${want.length}`;
  const i = want.findIndex((c, k) => key(c) !== key(have[k]));
  return i < 0 ? null : `criterion ${want[i].id} differs from the template`;
};
const sameList = (a, b) => JSON.stringify((a || []).map(norm)) === JSON.stringify((b || []).map(norm));

/**
 * Checks a description's terms block against the bounty the form will create. Returns
 * { problems: [message], terms }; create the bounty only when problems is empty.
 * expect = { posterWallet, targetHunter, stake, threshold, classId, jury, iterations, oracle,
 *            approvalWindow, deadline (unix), now (unix), site, escrow, chain,
 *            criteria, forbiddenContent, template: { criteria, forbiddenContent } }
 */
export function checkMutualWagerTerms(description, expect) {
  const problems = [];
  const t = parseMutualWagerTerms(description);
  if (!t.found) return { problems: ['The Job Description has no MUTUAL WAGER TERMS block. Use "Add a terms block" on the rubric step.'], terms: t };
  if (t.count > 1) problems.push(`The Job Description has ${t.count} terms blocks. Keep exactly one.`);
  if (!t.closed) problems.push(`The terms block has no "${TERMS_END}" line.`);
  if (t.rubric !== MUTUAL_WAGER_RUBRIC) problems.push(`The terms name rubric ${t.rubric || '(none)'}; this template is ${MUTUAL_WAGER_RUBRIC}.`);
  const placeholder = /<[^<>\n]+>/.exec(t.block);
  if (placeholder) problems.push(`Replace every <...> placeholder in the terms block (first: ${placeholder[0]}).`);
  for (const [key, prefix] of LINES) if (t.fields[key] === undefined) problems.push(`The terms block has no "${norm(prefix)}" line.`);
  if (problems.length) return { problems, terms: t };

  const f = t.fields;
  // Who can claim: the escrow pays whoever submits unless the bounty is targeted.
  if (!isAddress(expect.targetHunter)) problems.push("Set Target Hunter to the other bettor's wallet. An untargeted wager can be claimed by any wallet.");
  else if (!same(t.claimant.wallet, expect.targetHunter)) problems.push(`The Claimant wallet in the terms (${t.claimant.wallet}) is not the Target Hunter (${expect.targetHunter}).`);
  if (!expect.posterWallet) problems.push('Connect the wallet named as Poster in the terms.');
  else if (!same(t.poster.wallet, expect.posterWallet)) problems.push(`The Poster wallet in the terms (${t.poster.wallet}) is not your connected wallet (${expect.posterWallet}).`);
  if (isAddress(expect.targetHunter) && same(expect.targetHunter, expect.posterWallet)) problems.push('The Target Hunter is your own wallet: target the other bettor.');
  if (!t.claimant.side || !t.poster.side || same(t.claimant.side, t.poster.side)) problems.push('The Poster and Claimant lines must each name a different side ("...; side: the X win.").');
  else if (!same(t.pays, t.claimant.side)) problems.push(`The "Pays the Claimant only if" line must name the Claimant's side: ${t.claimant.side}.`);

  const stake = /^(\S+) ETH per side\.?$/.exec(f.stake)?.[1];
  const stakeWei = toWei(stake), formWei = toWei(expect.stake);
  if (stakeWei == null || formWei == null || stakeWei !== formWei) problems.push(`The stake in the terms (${f.stake}) is not the payout amount (${expect.stake} ETH).`);
  const want = {
    both: bothLine(expect.threshold, expect.classId),
    jury: `${formatJury(expect.jury, expect.iterations ?? 1)}.`,
    oracle: `${formatOracle(expect.oracle)}.`,
    site: siteLine(expect),
  };
  const labels = { both: 'Both bounties', jury: 'Jury', oracle: 'Oracle settings', site: 'Site' };
  for (const key of Object.keys(want)) {
    if (norm(f[key]) !== norm(want[key])) problems.push(`The "${labels[key]}" line must match this bounty: ${norm(LINES.find(([k]) => k === key)[1])} ${want[key]}`);
  }
  if (expect.approvalWindow) problems.push("Turn off the creator approval window: a wager pays on the jury's verdict alone.");

  const start = unixOf(f.start), settle = unixOf(f.settle);
  if (start == null) problems.push('The scheduled start must be an ISO UTC time such as 2026-10-20T00:15:00Z.');
  else if (start - expect.now < MIN_START_LEAD_SECONDS) problems.push("The scheduled start is less than 10 minutes away or past. Each bounty must exist before the start, or the other side's jury rejects it.");
  if (settle == null) problems.push('The settlement deadline must be an ISO UTC time such as 2026-10-22T00:00:00Z.');
  else if (start != null && settle <= start) problems.push('The settlement deadline must be after the scheduled start.');
  else if (expect.deadline < settle) {
    const hours = Math.ceil((settle - expect.now) / 3600);
    problems.push(`This bounty's deadline (${new Date(expect.deadline * 1000).toISOString()}) is before the settlement deadline (${f.settle}). Set the submission window to at least ${hours} hours.`);
  }
  if (!/^(REQUIRED\b|#\d+\b)/.test(f.counter)) problems.push('The "Counter bounty" line must start with REQUIRED or #<bounty number>.');

  const tmpl = expect.template;
  const edited = criteriaProblem(expect.criteria, tmpl.criteria);
  if (edited) problems.push(`The rubric was edited (${edited}). Both bounties of a wager use the template unchanged.`);
  if (!sameList(expect.forbiddenContent, tmpl.forbiddenContent)) problems.push('The rubric\'s forbidden content was edited. Both bounties of a wager use the template unchanged.');
  return { problems, terms: t };
}

/**
 * Checks the counter bounty a terms block names (#N) against its live records:
 * status = GET /api/jobs/N/onchain-status, job = GET /api/jobs/N?includeRubric=true (its .job).
 * The jury trusts a named counter, so this runs before the second bounty is funded.
 * Returns a list of problems; empty means the pair matches.
 */
export function checkCounterBounty({ terms, status, job, expect }) {
  const n = terms.counter.number;
  const problems = [];
  const p = (msg) => problems.push(`Counter bounty #${n}: ${msg}`);
  if (!status || Number(status.bountyId) !== n) { p('the site has no on-chain record of it.'); return problems; }
  if (status.linkage?.state !== 'linked') p(`its site record is not linked to the chain (state ${status.linkage?.state || 'unknown'}).`);
  if (!job || job.evaluationCid !== status.evaluationCid) p('its site record does not match its on-chain evaluation package.');
  if (!same(status.creator, terms.claimant.wallet)) p(`it was created by ${status.creator}, not the Claimant.`);
  if (!same(status.targetHunter, terms.poster.wallet)) p('it is not targeted at you.');
  if (status.status !== 'OPEN' || status.deadlinePassed) p(`it is ${status.status || 'not open'}, so it can no longer back a wager.`);
  const stakeWei = toWei(/^(\S+) ETH/.exec(terms.fields.stake)?.[1]);
  const amount = (() => { try { return BigInt(status.bountyAmountWei); } catch { return null; } })();
  const arbiter = toWei(status.arbiterDeterminationPaymentEth);
  if (amount == null || arbiter == null || stakeWei == null || amount < stakeWei || arbiter < stakeWei) p('it escrows less than the stake.');
  if (Number(status.creatorAssessmentWindowSize) !== 0) p('it has a creator approval window.');
  if (Number(status.classId) !== Number(expect.classId)) p(`its class is ${status.classId}, not ${expect.classId}.`);
  if (Number(status.threshold) > Number(expect.threshold)) p(`its threshold ${status.threshold} is above ${expect.threshold}.`);
  const start = unixOf(terms.fields.start), settle = unixOf(terms.fields.settle);
  if (!(Number(status.createdAt) < start)) p('it was created after the scheduled start.');
  if (!(Number(status.submissionDeadline) >= settle)) p('its deadline is before the settlement deadline.');
  if (terms.counter.createdAt && Date.parse(terms.counter.createdAt) !== Number(status.createdAt) * 1000) p(`it was created ${status.createdAtIso}, not ${terms.counter.createdAt} as your terms say.`);
  if (terms.counter.deadline && Date.parse(terms.counter.deadline) !== Number(status.submissionDeadline) * 1000) p(`its deadline is ${status.submissionDeadlineIso}, not ${terms.counter.deadline} as your terms say.`);
  const o = status.oracleSettings || {};
  if (formatOracle(o) !== formatOracle(expect.oracle)) p(`its oracle settings (${formatOracle(o)}) differ from yours. A bounty with a lower fee ceiling may never be evaluated.`);

  const theirs = parseMutualWagerTerms(job?.description);
  if (!theirs.found || theirs.count !== 1 || !theirs.closed) p('its description has no single, complete terms block.');
  else {
    if (theirs.rubric !== terms.rubric) p(`its terms name rubric ${theirs.rubric}.`);
    for (const [key, prefix] of LINES) {
      if (!MIRRORED.has(key) && norm(theirs.fields[key]) !== norm(terms.fields[key])) p(`its "${norm(prefix)}" line differs from yours.`);
    }
    if (!same(theirs.poster.wallet, terms.claimant.wallet) || !same(theirs.poster.side, terms.claimant.side)) p('its Poster line is not your Claimant line.');
    if (!same(theirs.claimant.wallet, terms.poster.wallet) || !same(theirs.claimant.side, terms.poster.side)) p('its Claimant line is not your Poster line.');
    if (!same(theirs.pays, terms.poster.side)) p(`it does not pay you only if ${terms.poster.side}.`);
  }
  const rc = job?.rubricContent || {};
  const edited = criteriaProblem(rc.criteria, expect.template.criteria);
  if (edited) p(`its rubric ${edited}.`);
  if (!sameList(rc.forbiddenContent, expect.template.forbiddenContent)) p('its rubric has different forbidden content.');
  const juryKey = (nodes) => (nodes || []).map((x) => [String(x.provider).toLowerCase(), x.model, Number(x.weight), Number(x.runs ?? 1)].join(':')).sort().join(',');
  if (juryKey(job?.juryNodes) !== juryKey(expect.jury) || Number(job?.iterations ?? 1) !== Number(expect.iterations ?? 1)) p('its jury differs from yours.');
  return problems;
}

/** A still-live bounty in `jobs` (the poster's own) whose terms carry the same Wager ID, or null. */
export function findWagerTwin(jobs, wagerId) {
  return (jobs || []).find((j) => !['CLOSED', 'AWARDED', 'EXPIRED'].includes(j.status)
    && parseMutualWagerTerms(j.description).fields?.wagerId === norm(wagerId)) || null;
}

/**
 * The second bettor's description, mirrored line by line from the first bettor's bounty
 * (`counterDescription`, bounty #number created at `createdAt` with deadline `deadline`, ISO):
 * Poster and Claimant swap, the Pays line names the other side, the Counter bounty line names
 * #number, and every shared line is copied unchanged. Returns null without one complete block.
 */
export function mirrorMutualWagerTerms(counterDescription, { number, createdAt, deadline }) {
  const t = parseMutualWagerTerms(counterDescription);
  if (!t.found || t.count !== 1 || !t.closed || !t.poster.wallet || !t.claimant.wallet || !t.claimant.side || !t.poster.side) return null;
  const stake = /^(\S+) ETH/.exec(t.fields.stake || '')?.[1];
  const site = /^(\S+);/.exec(t.fields.site || '')?.[1];
  const lines = t.block.replace(/\n+$/, '').split('\n').map((raw) => {
    const line = norm(raw);
    const key = LINES.find(([, prefix]) => line.startsWith(prefix))?.[0];
    if (key === 'poster') return `Poster (creator): ${t.claimant.wallet}; side: ${t.claimant.side}.`;
    if (key === 'claimant') return `Claimant (target, the only wallet that can claim): ${t.poster.wallet}; side: ${t.poster.side}.`;
    if (key === 'pays') return `Pays the Claimant only if ${t.poster.side}.`;
    if (key === 'counter') return `Counter bounty: #${number}, verified by the Poster before posting (created by the Claimant, targeted at the Poster, ${stake} ETH, created ${createdAt}, deadline ${deadline}, mirrored terms, same rubric, jury and oracle settings). It pays the Poster only if ${t.claimant.side}.`;
    return raw;
  });
  return {
    claimant: t.poster.wallet,
    stake,
    site,
    description: [
      'Settles one side of a two-bounty wager.',
      '',
      ...lines,
      TERMS_END,
      '',
      `To claim (Claimant, after the event and before the settlement deadline): submit claim.md with the final score, two sources (URL + quote) and counter bounty #${number}.`,
    ].join('\n'),
  };
}
