// v2-escrow wager fixtures (mutual-wager-v6 games, mutual-wager-v7 questions), derived at test time from the recorded
// ones so they never drift from the shared module. The recorded pairs are v3 (fixtures/wager-testnet, live testnet
// records) and v4 (fixtures/wager-question, synthesized): still read and claimed, but no longer answered or funded.
// Their onchain-status and escrow records already carry the v2 fields (decisionSettings, minOracleFee, withBeacons),
// so only the job records change here:
// - games: each recorded bounty's description is rewritten as v6 terms (the template's two new settings parts, nothing
//   else), its rubric as the v6 template with any recorded alteration kept, its title as the canonical one. Honest
//   #18 and #19 then equal what the shared builder proposes (wager.test.js checks it), and #20-#25 keep their faults.
// - questions: the shared builder builds #40 (alice's v7 offer, the v4 pair's inputs) and answers it as #41 (bob).
import { readFileSync } from 'node:fs';
import * as W from '../_wager.js';

// The recorded records name the jury by the pre-item-15 aggregator index (0, the small jury). Read now, they carry the
// bounty's own jury as the escrow and the site serve it: getBounty's flat juryK .. juryTimeout, and
// decisionSettings.jury { K, M, N, P, timeout } (the wager default, Bondless Small).
export const WAGER_JURY = Object.freeze({ ...W.WAGER_DECISION.jury });
function withJury(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  if (out.decisionSettings && typeof out.decisionSettings.jury !== 'object') out.decisionSettings = { ...out.decisionSettings, jury: { ...WAGER_JURY } };
  if ('jury' in out && 'quota' in out && typeof out.jury !== 'object') {
    delete out.jury;
    Object.assign(out, { juryK: String(WAGER_JURY.K), juryM: String(WAGER_JURY.M), juryN: String(WAGER_JURY.N), juryP: String(WAGER_JURY.P), juryTimeout: String(WAGER_JURY.timeout) });
  }
  return out;
}
const read = (rel) => withJury(JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), 'utf8')));
/** The recorded v3 game fixtures, unchanged: n 18-25, kind job | status | rpc. */
export const legacyGame = (n, kind) => read(`wager-testnet/${n}.${kind}.json`);
/** The recorded v4 question fixtures, unchanged: kind job | status | chain, n 40 | 41. */
export const legacyQuestion = (kind, n) => read(`wager-question/${kind}-${n}.json`);

export const alice = '0x7ACbdBC2bB6e4fF8b705d695F77144eA619C0e2D', bob = '0x75fAc210bF1Dcd0BA3FaC294de7c50C5763Da6d9';
export const ctx = W.siteContext({ network: 'base-sepolia', origin: 'https://bounties-testnet.verdikta.org', deployment: { address: '0x1B4F0e43256d435DfcD5C0883799F0Eb3943e08f', chainId: 84532 } });
/** The Decision settings line of every v6/v7 fixture: the wager default (Bondless Small), as the recorded escrow records carry it. */
export const DECISION_LINE = 'Decision settings (both bounties): jury (K 6, M 5, N 4, P 3, timeout 300), quota 3, forfeitLine 1, bondWei 0.';

/** A v3 game description as the same bounty's v6 terms: rubric name, full Oracle settings line, Decision settings line, counter wording. */
export function v6Description(description) {
  const out = description
    .replace(/\(mutual-wager-v3\)/g, '(mutual-wager-v6)')
    .replace(/^Both bounties: rubric mutual-wager-v3 /m, 'Both bounties: rubric mutual-wager-v6 ')
    .replace(/^(Oracle settings \(both bounties\): .*)\.$/m, `$1, minOracleFeeEth 0.0, withBeacons false.\n${DECISION_LINE}`)
    .replace('mirrored terms, same rubric, jury and oracle settings)', 'mirrored terms, same rubric, jury, oracle and decision settings)');
  if (out === description || !out.includes(DECISION_LINE)) throw new Error('not a v3 game description');
  return out;
}

const V3 = W.shared.mutualWagerRubricJson({ rubric: W.shared.MUTUAL_WAGER_V3_RUBRIC }), V6 = W.wagerRubricJson('game');
/**
 * A recorded rubric as the v6 one: each criterion the v3 template wrote becomes v6's; an altered one is kept, so the
 * check still finds it. counter_bounty_terms is always v6's: the live pair predates its final wording (cfbd088).
 */
export function v6Rubric(rubric) {
  return {
    ...rubric, title: V6.title,
    criteria: rubric.criteria.map((c) => {
      const v3 = V3.criteria.find((x) => x.id === c.id), v6 = V6.criteria.find((x) => x.id === c.id);
      return v6 && (c.id === 'counter_bounty_terms' || c.description === v3?.description) ? { ...c, description: v6.description } : c;
    }),
  };
}

export function v6Job(job) {
  const description = v6Description(job.description);
  return { ...job, description, title: W.shared.canonicalWagerText(W.shared.parseMutualWagerTerms(description)).title, rubricContent: v6Rubric(job.rubricContent) };
}

/**
 * The v6 game fixtures, same numbers, same shapes as the recorded ones (job is the GET /api/jobs/N?includeRubric=true
 * body { success, job, tips }): #18 alice->bob and #19 bob->alice honest offers; #20/#23 claimant_side_won altered;
 * #21/#24 no-winner clause adds overtime; #22/#25 a 1-wei fee ceiling on chain.
 */
export function gameFx(n, kind) {
  const recorded = legacyGame(n, kind);
  return kind === 'job' ? { ...recorded, job: v6Job(recorded.job) } : recorded;
}

// The v4 pair's inputs (verdikta-agents QUESTION_INPUT), with its Claims open, as a v7 offer.
export const QUESTION_INPUT = Object.freeze({
  kind: 'question', wagerId: 'VQ-TEST-AAPL-20261022', question: 'Will Apple (AAPL) close above $250.00 on 2026-10-22?',
  betsClose: '2026-10-22T13:00:00Z', resolvesAt: '2026-10-22T20:00:00Z', claimsOpen: '2026-10-22T22:00:00Z',
  yes: 'the official closing price of AAPL on 2026-10-22 is above $250.00', no: 'the official closing price of AAPL on 2026-10-22 is $250.00 or below',
  sources: ['https://stockanalysis.com/stocks/aapl/history/'], side: 'NO', stake: '0.0001', settle: '2026-10-23T22:00:00Z', opponent: bob,
});
const NOTE = 'SYNTHESIZED v7 pair: test/_wager-v2-fixtures.js builds it with the shared module from the v4 pair\'s inputs and records.';
let questions;
function questionPair() {
  if (questions) return questions;
  const s40 = legacyQuestion('status', 40);
  const offer = W.buildProposal(QUESTION_INPUT, { me: alice, ctx, now: s40.createdAt - 60 });
  if (offer.problems.length) throw new Error(offer.problems.join('\n'));
  const job40 = { ...legacyQuestion('job', 40), title: offer.offer.title, description: offer.offer.description, rubricContent: offer.createBody.rubricJson, _fixture: NOTE };
  const answer = W.shared.answerMutualWager({ number: 40, status: s40, job: job40 }, { creator: bob });
  if (!answer.createBody) throw new Error(answer.problems.map((p) => p.message).join('\n'));
  const job41 = { ...legacyQuestion('job', 41), title: answer.title, description: answer.description, rubricContent: answer.createBody.rubricJson, _fixture: NOTE };
  questions = { 40: job40, 41: job41 };
  return questions;
}
/** The v7 question fixtures, same shapes as the recorded v4 ones: kind job | status | chain, n 40 | 41. */
export function questionFx(kind, n) {
  return kind === 'job' ? structuredClone(questionPair()[n]) : legacyQuestion(kind, n);
}
