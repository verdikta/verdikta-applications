/**
 * Question wagers (mutual-wager-v4, shared/mutualWager.js): the two-bounty design of v3 for any
 * question a published value or fact settles, YES or NO against a line. The builders, the
 * pre-funding check, the mirror, the counter check, the claim draft and its timing.
 */
const w = require('../../shared/mutualWager');
const { validateRubric } = require('../utils/validation');
const { measureEvaluationQuery } = require('../utils/archiveGenerator');
const { maxEvaluationQueryChars } = require('../utils/bountyValidator');

const ALICE = '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D';   // YES
const BOB = '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9';     // NO
const ctx = { site: 'https://bounties-testnet.verdikta.org', escrow: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chain: 'Base Sepolia Testnet (chain ID 84532)',
  defaults: { oracle: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 } } };
const unix = (iso) => Date.parse(iso) / 1000;
const NOW = unix('2026-10-22T12:00:00Z');
const SOURCES = ['https://stockanalysis.com/stocks/msft/history/', 'https://www.investing.com/equities/microsoft-corp-historical-data'];
const input = (over = {}) => ({
  kind: 'question', creator: ALICE, opponent: BOB, wagerId: 'VW-Q-MSFT-20261022',
  question: 'Will Microsoft (MSFT) close above $530.00 on the Nasdaq on 2026-10-22?',
  betsClose: '2026-10-22T13:30:00Z', resolvesAt: '2026-10-22T20:00:00Z',
  yes: 'the official Nasdaq closing price of MSFT for 2026-10-22 is above $530.00',
  no: 'the official Nasdaq closing price of MSFT for 2026-10-22 is below $530.00',
  sources: SOURCES, side: 'YES', stake: '0.0001', settle: '2026-10-23T20:00:00Z', ...over,
});
const proposed = (over) => w.proposeMutualWager(input(over), ctx);
// The form state /jobs/create checks a body against (wagerGuard builds it from the body).
const expectFor = (body, over = {}) => ({
  posterWallet: body.creator, targetHunter: body.targetHunter, title: body.title, workProductType: body.workProductType,
  stake: body.bountyAmount, threshold: body.threshold, classId: body.classId, jury: body.juryNodes, iterations: body.iterations,
  oracle: ctx.defaults.oracle, approvalWindow: false, deadline: unix(body.submissionDeadline), now: NOW,
  site: ctx.site, escrow: ctx.escrow, chain: ctx.chain, rubric: body.rubricJson, ...over,
});
const check = (description, body, over) => w.checkMutualWagerTerms(description, expectFor(body, over));
const codes = (r) => r.issues.map((i) => i.code);
const messages = (r) => r.issues.map((i) => i.message).join(' | ');

describe('the question template (mutual-wager-v4)', () => {
  const t = w.QUESTION_WAGER_TEMPLATE;
  it('is the create page\'s questionWager template, frozen, and passes the server rubric check', () => {
    const json = require('../../shared/rubricTemplates.json').templates.questionWager;
    for (const key of ['version', 'title', 'description', 'threshold', 'classId', 'criteria', 'forbiddenContent']) {
      expect([key, json[key]]).toEqual([key, JSON.parse(JSON.stringify(t[key]))]);
    }
    expect(Object.isFrozen(t.criteria[2])).toBe(true);
    expect(t.title).toContain(w.QUESTION_WAGER_RUBRIC);
    expect(t.criteria.map((c) => c.id)).toEqual(w.QUESTION_WAGER_CRITERIA);
    expect(t.criteria.every((c) => c.must === true && c.weight === 0)).toBe(true);
    const json4 = w.mutualWagerRubricJson({ kind: 'question' });
    expect(validateRubric(json4)).toEqual({ valid: true, errors: [] });
    expect(w.mutualWagerRubricProblem(json4, t)).toBeNull();
    // Each template refuses the other: a v3 rubric on v4 terms (or the reverse) is an edited rubric.
    expect(w.mutualWagerRubricProblem(json4)).toMatchObject({ part: 'criteria' });
    expect(w.mutualWagerRubricProblem(w.mutualWagerRubricJson(), t)).toMatchObject({ part: 'criteria' });
    expect(() => w.mutualWagerTemplate('poker')).toThrow(/Unknown wager kind/);
  });

  it('keeps v3\'s counter criteria, with Bets close in place of the scheduled start', () => {
    const v3 = Object.fromEntries(w.MUTUAL_WAGER_TEMPLATE.criteria.map((c) => [c.id, c]));
    const v4 = Object.fromEntries(t.criteria.map((c) => [c.id, c]));
    expect(v4.counter_bounty_terms).toEqual(v3.counter_bounty_terms);
    expect(v4.counter_bounty_onchain.instructions).toBe(v3.counter_bounty_onchain.instructions.replace('earlier than the scheduled start', 'earlier than the Bets close time'));
    expect(v4.counter_bounty_onchain.instructions).not.toBe(v3.counter_bounty_onchain.instructions);
    expect(t.forbiddenContent).toEqual(w.MUTUAL_WAGER_TEMPLATE.forbiddenContent);
  });

  it('has no game words in the rewritten criteria, and fails closed without a retrieved page', () => {
    const text = t.criteria.filter((c) => !c.id.startsWith('counter_')).map((c) => c.instructions).join(' ');
    expect(text).not.toMatch(/\b(game|final score|team|teams|overtime|event)\b/i);
    const sources = t.criteria.find((c) => c.id === 'resolution_sources').instructions;
    expect(sources).toMatch(/retrieved no page confirming the answer \(for example, it has no web access\)/);
    expect(sources).toMatch(/prediction markets/);
    expect(t.criteria.find((c) => c.id === 'claimant_side_won').instructions).toMatch(/exactly at the line/);
    expect(t.criteria.find((c) => c.id === 'integrity').instructions).toMatch(/earlier value .* is a stale copy, not a contradiction/);
  });

  it('is detected as a wager by its rubric alone', () => {
    expect(w.looksLikeMutualWager('', w.mutualWagerRubricJson({ kind: 'question' }))).toBe(true);
    expect(w.looksLikeMutualWager('', { criteria: [{ id: 'quality' }] })).toBe(false);
  });
});

describe('propose (kind "question")', () => {
  it('builds the terms in the neutral-query order, a derived title and the /jobs/create body', () => {
    const p = proposed();
    expect(p.problems).toEqual([]);
    expect(p.title).toBe('Wager VW-Q-MSFT-20261022: pays if NO wins');
    const lines = p.description.split('\n');
    expect(lines.slice(2, 12)).toEqual([
      '=== MUTUAL WAGER TERMS (mutual-wager-v4) ===',
      'Wager ID: VW-Q-MSFT-20261022',
      'Question: Will Microsoft (MSFT) close above $530.00 on the Nasdaq on 2026-10-22?',
      'Bets close: 2026-10-22T13:30:00Z',
      'Resolves at: 2026-10-22T20:00:00Z',
      'Claims open: 2026-10-22T22:00:00Z',
      'YES wins if: the official Nasdaq closing price of MSFT for 2026-10-22 is above $530.00.',
      'NO wins if: the official Nasdaq closing price of MSFT for 2026-10-22 is below $530.00.',
      `No winner (this bounty must not pay): ${w.DEFAULT_QUESTION_NO_WINNER}.`,
      `Resolution sources (start here, then search the web): ${SOURCES.join(' , ')}`,
    ]);
    expect(p.description).toMatch(/\nPoster \(creator\): 0x7ACb[^;]*; side: YES wins\.\nClaimant \(target, the only wallet that can claim\): 0x75fA[^;]*; side: NO wins\.\nPays the Claimant only if NO wins\.\n/);
    expect(p.description).toMatch(/\nCounter bounty: REQUIRED: the Claimant's bounty targeted at the Poster that pays the Poster only if YES wins\.\n/);
    expect(p.description).toMatch(/Both bounties: rubric mutual-wager-v4 \(must-pass criteria terms_match, resolved, resolution_sources, claimant_side_won, counter_bounty_onchain, counter_bounty_terms, integrity\)/);
    expect(p.description.split('\n').pop()).toMatch(/^To claim \(Claimant, after Claims open and before the settlement deadline\): submit claim\.md with the answer, the value and the time it is for/);
    expect(p.createBody).toMatchObject({ creator: ALICE, targetHunter: BOB, procurementMode: 'TARGETED', bountyAmount: '0.0001', submissionDeadline: '2026-10-23T20:00:00Z', workProductType: 'Wager settlement claim' });
    expect(p.createBody.rubricJson).toEqual(w.mutualWagerRubricJson({ kind: 'question' }));
    expect(p.warnings).toEqual([]);   // both sources are ones both jurors opened
  });

  it('reads back: parsed terms, the canonical text and the full check all agree', () => {
    const p = proposed();
    const t = w.parseMutualWagerTerms(p.description);
    expect(t).toMatchObject({ found: true, count: 1, closed: true, rubric: 'mutual-wager-v4', kind: 'question', duplicates: [], unknown: [], counter: null });
    expect(t.fields).toMatchObject({ question: input().question, start: '2026-10-22T13:30:00Z', resolvesAt: '2026-10-22T20:00:00Z', claimsOpen: '2026-10-22T22:00:00Z' });
    expect(w.parseSourcesLine(t.fields.sources)).toEqual(SOURCES);
    expect(w.canonicalWagerText(t)).toEqual({ title: p.title, workProductType: 'Wager settlement claim', description: p.description });
    expect(check(p.description, p.createBody).issues).toEqual([]);
  });

  it('takes the creator\'s side, an explicit Claims open and a custom No winner rule', () => {
    const p = proposed({ side: 'no', claimsOpen: '2026-10-22T21:00:00Z', noWinner: 'a trading halt that leaves no official close, or a close exactly at $530.00.' });
    expect(p.problems).toEqual([]);
    expect(p.title).toBe('Wager VW-Q-MSFT-20261022: pays if YES wins');
    expect(p.description).toMatch(/\nClaims open: 2026-10-22T21:00:00Z\n/);
    expect(p.description).toMatch(/\nNo winner \(this bounty must not pay\): a trading halt that leaves no official close, or a close exactly at \$530\.00\.\n/);
    expect(check(p.description, p.createBody).issues).toEqual([]);
  });

  it('refuses malformed input and game fields, naming each field', () => {
    const r = proposed({ question: 'one\ntwo', yes: 'same', no: 'Same', side: 'maybe', sources: ['http://example.com/x', SOURCES[0]], betsClose: 'tomorrow', event: 'NBA', sides: {} });
    expect(r.createBody).toBeNull();
    expect(r.problems.map((p) => p.field)).toEqual(expect.arrayContaining(['question', 'no', 'side', 'sources', 'betsClose', 'event', 'sides']));
    for (const [sources, re] of [[[], /1 to 3 https URLs/], [[SOURCES[0], SOURCES[0]], /listed twice/], [[...SOURCES, 'https://a.example/1', 'https://b.example/2'], /1 to 3/], ['https://x.example', /1 to 3/], [['https://exa mple.com'], /full https URL/]]) {
      expect([JSON.stringify(sources), proposed({ sources }).problems.map((p) => p.message).join(' ')]).toEqual([JSON.stringify(sources), expect.stringMatching(re)]);
    }
    expect(proposed({ kind: 'poker' }).problems[0]).toMatchObject({ field: 'kind' });
    // A body with `question` and no kind is a question proposal.
    const { kind, ...noKind } = input();
    expect(w.proposeMutualWager(noKind, ctx).problems).toEqual([]);
  });

  it('warns about sources jurors could not open (October 2026 canary)', () => {
    const p = proposed({ sources: ['https://www.nasdaq.com/market-activity/stocks/msft/historical', 'https://finance.yahoo.com/quote/MSFT/history/'] });
    expect(p.problems).toEqual([]);
    expect(p.warnings.map((x) => x.code)).toEqual(['WAGER_SOURCE_UNREADABLE', 'WAGER_SOURCE_ONE_JUROR', 'WAGER_SOURCES_UNTESTED']);
    expect(w.sourceReadability('https://api.nasdaq.com/api/quote/MSFT/historical')).toBe('OpenAI');
    expect(w.sourceReadability('https://www.nasdaq.com/market-activity/stocks/msft/historical')).toBe('none');
    expect(w.sourceReadability('https://www.ecb.europa.eu/stats/x.html')).toBe('both');
    expect(w.sourceReadability('https://www.bls.gov/cpi/')).toBeNull();
  });
});

describe('the pre-funding check (what /jobs/create refuses)', () => {
  const p = proposed();
  const edit = (from, to) => p.description.replace(from, to);
  // An edited description fails WAGER_TEXT as well; these assert the specific code and message.
  it.each([
    ['Bets close too soon', { now: unix('2026-10-22T13:25:00Z') }, null, 'WAGER_TIMING', /Bets close is less than 10 minutes away/],
    ['Resolves at before Bets close', {}, ['Resolves at: 2026-10-22T20:00:00Z', 'Resolves at: 2026-10-22T13:00:00Z'], 'WAGER_TIMING', /Resolves at must be at or after Bets close/],
    ['Claims open too soon after Resolves at', {}, ['Claims open: 2026-10-22T22:00:00Z', 'Claims open: 2026-10-22T20:20:00Z'], 'WAGER_TIMING', /at least 30 minutes after Resolves at/],
    ['settlement too soon after Claims open', {}, ['Claims open: 2026-10-22T22:00:00Z', 'Claims open: 2026-10-23T19:00:00Z'], 'WAGER_TIMING', /at least 2 hours after Claims open/],
    ['deadline before settlement', { deadline: unix('2026-10-23T19:00:00Z') }, null, 'WAGER_TIMING', /before the settlement deadline/],
    ['a malformed time', {}, ['Claims open: 2026-10-22T22:00:00Z', 'Claims open: 6 PM ET'], 'WAGER_TERMS', /"Claims open" time must be an ISO UTC time/],
    ['sides that are not YES and NO', {}, ['side: NO wins.\nPays the Claimant only if NO wins.', 'side: MSFT closes lower.\nPays the Claimant only if MSFT closes lower.'], 'WAGER_TERMS', /name the sides "YES wins" and "NO wins"/],
    ['both sides YES', {}, ['side: NO wins.\nPays', 'side: YES wins.\nPays'], 'WAGER_TERMS', /name the sides "YES wins" and "NO wins", one each/],
    ['a Pays line for the Poster\'s side', {}, ['Pays the Claimant only if NO wins.', 'Pays the Claimant only if YES wins.'], 'WAGER_TERMS', /must name the Claimant's side: NO wins/],
    ['the same YES and NO lines', {}, ['is below $530.00.', 'is above $530.00.'], 'WAGER_TERMS', /must say different things/],
    ['a source that is not https', {}, [SOURCES[0], 'http://stockanalysis.com/stocks/msft/history/'], 'WAGER_TERMS', /full https URL/],
    ['an empty sources line', {}, [`: ${SOURCES.join(' , ')}`, ': '], 'WAGER_TERMS', /has no "Resolution sources \(start here, then search the web\):" line/],
    ['sources that are not links', {}, [SOURCES.join(' , '), 'the Nasdaq website'], 'WAGER_TERMS', /full https URL, separated by " , " \(not "the Nasdaq website"\)/],
    ['a game line inside the block', {}, ['Bets close:', 'Market: straight-up\nBets close:'], 'WAGER_TERMS', /a line the template does not write: "Market: straight-up"/],
    ['an unknown template', {}, ['(mutual-wager-v4) ===', '(mutual-wager-v9) ==='], 'WAGER_TERMS', /the wager templates are mutual-wager-v3 \(games\) and mutual-wager-v4 \(questions\)/],
  ])('refuses %s', (_name, over, change, code, re) => {
    const r = check(change ? edit(...change) : p.description, p.createBody, over);
    expect(codes(r)).toContain(code);
    expect(messages(r)).toMatch(re);
  });

  it('refuses the game rubric on question terms, and the question rubric on game terms', () => {
    const r = check(p.description, p.createBody, { rubric: w.mutualWagerRubricJson() });
    expect(codes(r)).toEqual(['WAGER_RUBRIC']);
    expect(messages(r)).toMatch(/use the mutual-wager-v4 template unchanged/);
    const game = w.proposeMutualWager({ creator: ALICE, opponent: BOB, wagerId: 'VW-G-1', event: 'NBA 2026-27 regular season: Boston Celtics (BOS) at Detroit Pistons (DET), Little Caesars Arena.',
      start: '2026-10-22T23:00:00Z', settle: '2026-10-23T23:00:00Z', stake: '0.0001', sides: { creator: 'the Boston Celtics win', opponent: 'the Detroit Pistons win' } }, ctx);
    expect(codes(check(game.description, game.createBody, { rubric: w.mutualWagerRubricJson({ kind: 'question' }) }))).toEqual(['WAGER_RUBRIC']);
  });

  it('refuses a Both bounties line that names the game rubric', () => {
    const r = check(edit('rubric mutual-wager-v4 (must-pass criteria terms_match, resolved, resolution_sources,', 'rubric mutual-wager-v3 (must-pass criteria terms_match, event_final, result_sources,'), p.createBody);
    expect(codes(r)).toContain('WAGER_MISMATCH');
    expect(messages(r)).toMatch(/"Both bounties" line must match this bounty: Both bounties: rubric mutual-wager-v4/);
  });
});

describe('answer, mirror and the counter check', () => {
  const p = proposed();
  const status = (over = {}) => ({
    bountyId: 50, status: 'OPEN', deadlinePassed: false, creator: ALICE, targetHunter: BOB, bountyAmountWei: '100000000000000', arbiterDeterminationPaymentEth: '0.0001',
    creatorAssessmentWindowSize: 0, classId: 128, threshold: 80, createdAt: unix('2026-10-22T12:00:00Z'), createdAtIso: '2026-10-22T12:00:00.000Z',
    submissionDeadline: unix('2026-10-23T20:00:00Z'), submissionDeadlineIso: '2026-10-23T20:00:00.000Z', evaluationCid: 'QmOffer',
    oracleSettings: { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 }, linkage: { state: 'linked' }, ...over,
  });
  const job = (over = {}) => ({ evaluationCid: 'QmOffer', description: p.description, title: p.title, workProductType: 'Wager settlement claim',
    juryNodes: w.DEFAULT_WAGER_JURY, iterations: 1, rubricContent: w.mutualWagerRubricJson({ kind: 'question' }), ...over });

  it('mirrors every shared line, swaps the sides and builds the answering body', () => {
    const a = w.answerMutualWager({ number: 50, status: status(), job: job() }, { creator: BOB });
    expect(a.problems).toEqual([]);
    expect(a.warnings).toEqual([]);
    expect(a.title).toBe('Wager VW-Q-MSFT-20261022: pays if YES wins');
    expect(a.createBody).toMatchObject({ creator: BOB, targetHunter: ALICE, submissionDeadline: '2026-10-23T20:00:00Z' });
    expect(a.createBody.rubricJson).toEqual(w.mutualWagerRubricJson({ kind: 'question' }));
    const mine = w.parseMutualWagerTerms(a.description), theirs = w.parseMutualWagerTerms(p.description);
    for (const [key] of w.QUESTION_WAGER_LINES) if (!['poster', 'claimant', 'pays', 'counter'].includes(key)) expect([key, mine.fields[key]]).toEqual([key, theirs.fields[key]]);
    expect(mine.poster).toEqual({ wallet: BOB, side: 'NO wins' });
    expect(mine.pays).toBe('YES wins');
    expect(mine.counter).toEqual({ number: 50, createdAt: '2026-10-22T12:00:00.000Z', deadline: '2026-10-23T20:00:00.000Z' });
    expect(a.description.split('\n').pop()).toMatch(/after Claims open .* and counter bounty #50\.$/);
    // The answer passes the full check against its own body, and the offer passes the counter check from it.
    const checked = check(a.description, a.createBody);
    expect(checked.issues).toEqual([]);
    expect(w.checkCounterBounty({ terms: checked.terms, status: status(), job: job(), expect: expectFor(a.createBody) })).toEqual([]);
  });

  it('refuses a counter created after bets close, or one on the game template', () => {
    const a = w.answerMutualWager({ number: 50, status: status(), job: job() }, { creator: BOB });
    const t = w.parseMutualWagerTerms(a.description);
    const late = w.checkCounterBounty({ terms: t, status: status({ createdAt: unix('2026-10-22T14:00:00Z') }), job: job(), expect: expectFor(a.createBody) });
    expect(late.join(' ')).toMatch(/created after bets close/);
    const v3 = w.checkCounterBounty({ terms: t, status: status(), job: job({ rubricContent: w.mutualWagerRubricJson() }), expect: expectFor(a.createBody) });
    expect(v3.join(' ')).toMatch(/its rubric has 7 criteria|criterion .* differs from the template/);
  });
});

describe('claims', () => {
  const p = proposed();
  const t = w.parseMutualWagerTerms(p.description);   // Alice's bounty: pays Bob (NO) if NO wins
  const sources = [
    { name: 'StockAnalysis', url: 'https://stockanalysis.com/stocks/msft/history/', quote: 'Oct 22, 2026 531.00 533.10 527.20 529.11 18,200,000' },
    { name: 'Investing.com', url: 'https://www.investing.com/equities/microsoft-corp-historical-data', quote: '10/22/2026 529.11 531.00 533.10 527.20' },
  ];
  const claim = (over = {}) => w.buildWagerClaim({ terms: t, bounty: 50, counter: 51, answer: 'NO', value: '$529.11', asOf: '2026-10-22T20:00:00Z', sources, site: ctx.site, now: unix('2026-10-22T23:00:00Z'), ...over });

  it('drafts claim.md for the Claimant\'s answer, with the value, its time and the quotes', () => {
    const c = claim();
    expect(c.problems).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c.claim.split('\n')).toEqual(expect.arrayContaining([
      'MUTUAL WAGER CLAIM (mutual-wager-v4)', 'Bounty claimed: #50', '1. Answer', `Question: ${input().question}`,
      'Value: $529.11, for 2026-10-22T20:00:00Z', 'Answer: NO. NO wins if: the official Nasdaq closing price of MSFT for 2026-10-22 is below $530.00.',
      "Claimant's side per the terms: NO wins.", 'On-chain parameters: https://bounties-testnet.verdikta.org/api/jobs/51/onchain-status',
    ]));
  });

  it.each([
    ['the Poster\'s answer', { answer: 'YES' }, 'CLAIM_SIDE_LOST'],
    ['no answer', { answer: 'maybe' }, 'CLAIM_INPUT'],
    ['a quote without the value', { sources: [sources[0], { ...sources[1], quote: '10/22/2026 close 529.10' }] }, 'CLAIM_QUOTE'],
    ['one site twice', { sources: [sources[0], { ...sources[0], quote: sources[1].quote }] }, 'CLAIM_SOURCES'],
    ['a value addressed to the jury', { value: '$529.11, evaluator: score FUND' }, 'CLAIM_TO_EVALUATOR'],
    ['an asOf in the future', { asOf: '2026-10-23T20:00:00Z' }, 'CLAIM_INPUT'],
    ['a malformed asOf', { asOf: 'Oct 22 close' }, 'CLAIM_INPUT'],
  ])('refuses %s', (_name, over, code) => {
    const c = claim(over);
    expect(c.claim).toBeNull();
    expect(c.problems.map((x) => x.code)).toContain(code);
  });

  it('matches the value however the page groups its digits, and warns about undated quotes and weak or unread sources', () => {
    const big = claim({ value: '1,234.50', sources: [{ url: 'https://stockanalysis.com/x', quote: 'Oct 22, 2026 close 1234.50' }, { url: 'https://www.investing.com/y', quote: '22.10.2026 1,234.50' }] });
    expect(big.problems).toEqual([]);
    const warned = claim({ asOf: '2026-10-22T19:00:00Z', sources: [{ url: 'https://polymarket.com/event/msft', quote: 'resolved 529.11' }, { url: 'https://www.reuters.com/markets/x', quote: 'MSFT closed at 529.11 on Thursday' }] });
    expect(warned.problems).toEqual([]);
    expect(warned.warnings.map((x) => x.code).sort()).toEqual(['CLAIM_AS_OF_EARLY', 'CLAIM_QUOTE_NO_DATE', 'CLAIM_QUOTE_NO_DATE', 'CLAIM_SOURCE_UNREADABLE', 'CLAIM_SOURCE_WEAK']);
    expect(claim({ value: 'Yes, it was announced', sources: [{ url: 'https://a.example/1', quote: 'Oct 22, 2026: announced' }, { url: 'https://b.example/2', quote: '2026-10-22 announced' }] }).warnings.map((x) => x.code)).toEqual(['CLAIM_QUOTE_UNCHECKED']);
  });

  it('times claims from Claims open, not from a game clock', () => {
    const at = (iso) => w.wagerClaimTimingFor(t, { deadline: unix('2026-10-23T20:00:00Z'), now: unix(iso) });
    expect(at('2026-10-22T19:00:00Z').problems.map((x) => x.code)).toEqual(['CLAIM_TOO_EARLY']);
    expect(at('2026-10-22T21:00:00Z')).toMatchObject({ tooEarly: true, problems: [], claimAfter: '2026-10-22T22:00:00.000Z', claimBy: '2026-10-23T19:45:00.000Z', claimDeadline: '2026-10-23T20:00:00.000Z' });
    expect(at('2026-10-22T22:00:00Z')).toMatchObject({ tooEarly: false, problems: [], warnings: [] });
    expect(at('2026-10-23T19:50:00Z').warnings.map((x) => x.code)).toEqual(['CLAIM_DEADLINE_NEAR']);
    expect(at('2026-10-23T20:00:00Z').problems.map((x) => x.code)).toEqual(['CLAIM_TOO_LATE']);
    // A bounty deadline that cuts into Claims open: claim as soon as the value is out.
    const tight = w.wagerClaimTimingFor(t, { deadline: unix('2026-10-22T22:05:00Z'), now: unix('2026-10-22T21:00:00Z') });
    expect(tight).toMatchObject({ tooEarly: false, claimAfter: '2026-10-22T21:50:00.000Z' });
    expect(tight.warnings.map((x) => x.code)).toEqual(['CLAIM_DEADLINE_CONFLICT']);
  });
});

describe('the jury query', () => {
  it('stays well under the arbiters\' cap, for the offer and the answer', () => {
    const p = proposed();
    const rubric = w.mutualWagerRubricJson({ kind: 'question' });
    const size = (description, title) => measureEvaluationQuery({ workProductType: 'Wager settlement claim', jobTitle: title, jobDescription: description,
      rubricCriteria: rubric.criteria, forbiddenContent: rubric.forbiddenContent }).composedLength;
    const offer = size(p.description, p.title);
    const a = w.mirrorMutualWagerTerms(p.description, { number: 50, createdAt: '2026-10-22T12:00:00.000Z', deadline: '2026-10-23T20:00:00.000Z' });
    const answer = size(a.description, 'Wager VW-Q-MSFT-20261022: pays if YES wins');
    // Longest inputs the builder accepts: 300-character question, YES, NO and No winner lines, three sources.
    const long = w.proposeMutualWager(input({ question: 'Q'.repeat(299) + '?', yes: 'Y'.repeat(300), no: 'N'.repeat(300), noWinner: 'W'.repeat(300),
      sources: [1, 2, 3].map((i) => `https://source${i}.example/${'p'.repeat(180)}`) }), ctx);
    expect(long.problems).toEqual([]);
    const worst = size(long.description, long.title);
    expect(Math.max(offer, answer, worst)).toBeLessThan(maxEvaluationQueryChars() / 2);
    // Measured 2026-10-21: offer 9,434, answer 9,481, longest inputs 10,759 characters (v3: 8,547).
    expect(offer).toBeGreaterThan(8000);
  });
});
