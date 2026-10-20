// Job Description for one bounty of a mutual wager (the "Mutual Wager" rubric template).
// A wager is two directed bounties: each bettor posts one that pays the other bettor only
// if that bettor's side wins and the bettor holds a live mirrored counter bounty. The jury
// reads the terms only from the description, so both bounties must carry the same block
// with Poster and Claimant swapped; building both from one config keeps them in step.
//
// terms = { wagerId, event, shortEvent, start (ISO UTC), market, noWinner?, stake (ETH),
//           settle (ISO UTC), classId, threshold, jury: [model], site, escrow, chain, criteria?: [id] }
// poster / claimant = { wallet, label, short }; counter = { number, createdAt, deadline } or null.
export const MUTUAL_WAGER_RUBRIC = 'mutual-wager-v2';
export const MUTUAL_WAGER_CRITERIA = ['terms_match', 'event_final', 'result_sources', 'claimant_side_won',
  'counter_bounty_onchain', 'counter_bounty_terms', 'integrity'];
export const MUTUAL_WAGER_TERMS_HEADER = '=== MUTUAL WAGER TERMS';

const DEFAULT_NO_WINNER = 'a tie, or no official final score before the settlement deadline';

/** Title and description of the bounty that `poster` creates; it pays `claimant` if the claimant's side wins. */
export function buildMutualWagerBounty(terms, poster, claimant, counter = null) {
  const criteria = (terms.criteria || MUTUAL_WAGER_CRITERIA).join(', ');
  const counterLine = counter
    ? `Counter bounty: #${counter.number}, verified by the Poster before posting (created by the Claimant, targeted at the Poster, ${terms.stake} ETH, created ${counter.createdAt}, deadline ${counter.deadline}, mirrored terms, same rubric and jury). It pays the Poster only if ${poster.label}.`
    : `Counter bounty: REQUIRED: the Claimant's bounty targeted at the Poster that pays the Poster only if ${poster.label}.`;
  const claimSteps = counter
    ? `and counter bounty #${counter.number}.`
    : `and the counter bounty's ${terms.site}/api/jobs/N/onchain-status and ${terms.site}/api/jobs/N?includeRubric=true URLs with the values copied from them.`;
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
    `Both bounties: rubric ${MUTUAL_WAGER_RUBRIC} (must-pass criteria ${criteria}), threshold ${terms.threshold}, class ${terms.classId}, jury ${terms.jury.join(' + ')}, approval window 0.`,
    counterLine,
    `Site: ${terms.site}; escrow ${terms.escrow} on ${terms.chain}; no cancel or edit.`,
    '=== END WAGER TERMS ===',
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
export function mutualWagerTermsSkeleton({ posterWallet, claimantWallet, stake, threshold, classId, jury, site, escrow, chain }) {
  const known = (v, hint) => (v === undefined || v === null || v === '' ? `<${hint}>` : v);
  const terms = {
    wagerId: '<Wager ID, the same on both bounties, e.g. VW-WSH-SF-20261019>',
    event: '<league, season and round: Away Team (ABBR) at Home Team (ABBR), venue>',
    start: '<scheduled start, ISO UTC, e.g. 2026-10-20T00:15:00Z>',
    market: 'straight-up winner on the official final score, overtime included. No point spread.',
    stake: known(stake, 'stake in ETH'),
    settle: '<settlement deadline, ISO UTC, at or before both bounty deadlines>',
    threshold: known(threshold, 'threshold'),
    classId: known(classId, 'class'),
    jury: jury && jury.length ? jury : ['<jury models, e.g. gpt-5.6-terra + claude-sonnet-5>'],
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
