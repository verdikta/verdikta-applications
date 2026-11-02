// The record page's view of GET /api/records/:hash (node P4b1's mirror of recordByHash): the
// design §4.1 fields, the labels, the lineage, the later findings and the flags, as facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recordView } from '../src/lib/record.js';

const H = (n) => `0x${n.repeat(64)}`;
const DAY = 86400;
const T0 = 1_800_000_000;

const history = (over = {}) => ({
  claims: '0', pending: '0', outcomes: ['0', '0', '0', '0', '0', '0'], released: '0', undisclosed: '0', unrevealed: '0',
  noVerdict: '0', disputes: '0', disputesHeld: '0', disputesOverturned: '0', disputesNoVerdict: '0', lateClaims: '0',
  lateOutcomes: ['0', '0', '0', '0', '0', '0'], lateExpired: '0', ...over,
});

const listing = (over = {}) => ({
  listingId: '3', maker: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', state: 'Open', lapsed: false, invited: false,
  artifactChainId: '0', artifactAddress: '0x0000000000000000000000000000000000000000', listedAt: String(T0 - 100),
  openedAt: String(T0), fundedUntil: String(T0 + 30 * DAY), rolledAt: '0', closedAt: '0',
  awards: ['0', '100000000000000000', '400000000000000000', '2000000000000000000'], lowestClassCounted: 'MEDIUM',
  bondWei: '20000000000000000', escrowWei: '2000000000000000000', owedWei: '0', valueAtRiskUsd: '0',
  predecessor: '0', predecessorHash: H('0'), successor: '0', successorHash: H('0'), history: history(), ...over,
});

function view({ listings = [listing()], findings = [], flags = [], hist = history(), labels = {}, events = null, timestamp = T0 + 40 * DAY } = {}) {
  return {
    artifactHash: H('a'),
    artifact: { kind: 'Repo', repo: 'https://github.com/acme/vault', baseCommit: 'c0ffee'.padEnd(40, '0'), chainId: '0', address: listings[0]?.artifactAddress ?? '0x0000000000000000000000000000000000000000' },
    block: { number: 120, hash: H('b'), timestamp },
    fresh: true,
    staleReason: null,
    record: {
      artifactHash: H('a'), kind: 'Repo', listingCount: String(listings.length),
      active: listings.filter((l) => l.state !== 'Closed').map((l) => l.listingId),
      listings, history: hist, findingCount: String(findings.length), findings, flagCount: String(flags.length), flags,
    },
    labels: {
      listings: Object.fromEntries(listings.map((l) => [l.listingId, { stake: 'staked', invited: l.invited, lapsed: l.lapsed, live: l.state === 'Open', topAwardWei: l.awards[3], valueAtRiskUsd: l.valueAtRiskUsd, stakeUsd: null, error: null, ...(labels[l.listingId] ?? {}) }])),
      price: null,
      priceError: 'ETH_USD_NOT_CONFIGURED',
      placeholders: ['SA_BADGE_FLOOR_WEI', 'SA_UNDER_STAKED_RATIO_BPS'],
    },
    badge: { state: 'live', message: 'no finding at or above MEDIUM while staked', listingId: '3', class: 'MEDIUM' },
    history: {
      events: events ?? listings.map((l) => ({ name: 'Listed', listingId: l.listingId, claimId: null, args: { listingId: l.listingId, maker: l.maker, artifactHash: H('a'), kind: 'Repo', repo: 'https://github.com/acme/vault', baseCommit: 'c0ffee'.padEnd(40, '0'), chainId: '0', artifactAddress: l.artifactAddress, listingCid: 'bafkrei...', disputeCid: 'bafkrei...' } })),
      publishedClaims: findings.map((f) => f.claimId),
      lastValidFindingAt: findings.length ? Math.max(...findings.map((f) => Number(f.settledAt))) : null,
      daysSinceLastValidFinding: findings.length ? 4 : null,
    },
  };
}

const finding = (over = {}) => ({
  claimId: '9', listingId: '3', hunter: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', outcome: 'HIGH', late: false,
  dispute: 'None', paidWei: '400000000000000000', owedWei: '0', revealedAt: String(T0 + 20 * DAY), settledAt: String(T0 + 36 * DAY), bcid: 'bafkreiexample', ...over,
});

test('the artifact: hash, kind, and the repository and commit from the Listed event', () => {
  const v = recordView(view());
  assert.equal(v.hash, H('a'));
  assert.equal(v.kind, 'Repo');
  assert.deepEqual(v.artifact, { repo: 'https://github.com/acme/vault', baseCommit: 'c0ffee'.padEnd(40, '0'), chainId: '0', address: '0x0000000000000000000000000000000000000000' });
  assert.equal(v.listingCount, '1');
  assert.deepEqual(v.active, ['3']);
});

test('the artifact is what the server states: null when it states none', () => {
  assert.equal(recordView({ ...view(), artifact: null }).artifact, null);
});

test('each stake: state, award table by class, bond, times, escrow, owed, value at risk', () => {
  const [l] = recordView(view()).listings;
  assert.equal(l.id, '3');
  assert.equal(l.state, 'Open');
  assert.deepEqual(l.awards, { LOW: '0', MEDIUM: '100000000000000000', HIGH: '400000000000000000', CRITICAL: '2000000000000000000' });
  assert.equal(l.lowest, 'MEDIUM');
  assert.equal(l.bondWei, '20000000000000000');
  assert.equal(l.escrowWei, '2000000000000000000');
  assert.equal(l.owedWei, '0');
  assert.equal(l.openedAt, T0);
  assert.equal(l.fundedUntil, T0 + 30 * DAY);
  assert.equal(l.rolledAt, null);
  assert.equal(l.closedAt, null);
  assert.equal(l.valueAtRiskUsd, null, 'not declared');
  assert.equal(l.daysOpen, 40);
});

test('days open run to the roll forward or the close, whichever came first', () => {
  const rolled = recordView(view({ listings: [listing({ state: 'Rolled', rolledAt: String(T0 + 10 * DAY) })] })).listings[0];
  assert.equal(rolled.daysOpen, 10);
  assert.equal(rolled.rolledAt, T0 + 10 * DAY);
  const closed = recordView(view({ listings: [listing({ state: 'Closed', rolledAt: String(T0 + 10 * DAY), closedAt: String(T0 + 12 * DAY) })] })).listings[0];
  assert.equal(closed.daysOpen, 10);
  assert.equal(closed.closedAt, T0 + 12 * DAY);
  const closedDirect = recordView(view({ listings: [listing({ state: 'Closed', closedAt: String(T0 + 3 * DAY) })] })).listings[0];
  assert.equal(closedDirect.daysOpen, 3);
});

test('labels: the stake label, then invited and lapsed; no price gives no stake label', () => {
  const base = recordView(view()).listings[0];
  assert.deepEqual(base.labels, ['staked']);
  const many = recordView(view({ listings: [listing({ invited: true, lapsed: true })], labels: { 3: { stake: 'under-staked' } } })).listings[0];
  assert.deepEqual(many.labels, ['under-staked', 'invited', 'lapsed']);
  const unpriced = recordView(view({ listings: [listing({ valueAtRiskUsd: '1250000' })], labels: { 3: { stake: null, error: 'ETH_USD_UNAVAILABLE' } } })).listings[0];
  assert.deepEqual(unpriced.labels, ['noPrice']);
  assert.equal(unpriced.valueAtRiskUsd, '1250000');
});

test('each stake carries its control fact as the server states it, and none reads as "no"', () => {
  const fact = { maker: listing().maker, subject: 'repository', proof: 'yes', statement: 'staker controls the repository: yes', reason: null, detail: null, repository: { path: '.verdikta/stake-control.json' }, deployment: null };
  const v = view();
  v.control = { 3: fact };
  assert.deepEqual(recordView(v).listings[0].control, fact);
  const none = recordView(view()).listings[0].control;
  assert.equal(none.proof, 'no');
  assert.equal(none.subject, 'repository');
  assert.equal(none.reason, 'NOT_CHECKED_YET');
});

test('the top award as a share of the declared value at risk, when the server priced it', () => {
  const l = recordView(view({ listings: [listing({ valueAtRiskUsd: '1250000' })], labels: { 3: { stake: 'under-staked', stakeUsd: '4840' } } })).listings[0];
  assert.equal(l.stakeUsd, '4840');
  assert.equal(l.sharePct, '0.38');
  const none = recordView(view()).listings[0];
  assert.equal(none.sharePct, null);
});

test('history: claims, claims judged (the settled outcomes), verdicts by outcome, duplicates, disputes and their outcomes', () => {
  const hist = history({
    claims: '12', pending: '2', outcomes: ['4', '2', '1', '0', '1', '0'], released: '1', undisclosed: '1', unrevealed: '1',
    noVerdict: '1', disputes: '2', disputesHeld: '1', disputesOverturned: '1', disputesNoVerdict: '0',
  });
  const v = recordView(view({ hist, findings: [finding()] }));
  assert.equal(v.history.claims, '12');
  assert.equal(v.history.judged, '8');
  assert.equal(v.history.pending, '2');
  assert.deepEqual(v.history.verdicts, [['INVALID', '4'], ['DUPLICATE', '2'], ['LOW', '1'], ['MEDIUM', '0'], ['HIGH', '1'], ['CRITICAL', '0']]);
  assert.equal(v.history.duplicates, '2');
  assert.equal(v.history.released, '1');
  assert.equal(v.history.undisclosed, '1');
  assert.equal(v.history.unrevealed, '1');
  assert.equal(v.history.noVerdict, '1');
  assert.deepEqual(v.history.disputes, { filed: '2', held: '1', overturned: '1', noVerdict: '0' });
  assert.equal(v.history.daysSinceLastValidFinding, 4);
});

test('valid findings exclude late ones, which are listed under later with the late counts', () => {
  const hist = history({ lateClaims: '2', lateOutcomes: ['1', '0', '1', '0', '0', '0'], lateExpired: '0' });
  const v = recordView(view({ hist, findings: [finding(), finding({ claimId: '11', outcome: 'LOW', late: true, paidWei: '0' })] }));
  assert.deepEqual(v.findings.map((f) => f.claimId), ['9']);
  assert.deepEqual(v.later.findings.map((f) => f.claimId), ['11']);
  assert.equal(v.later.claims, '2');
  assert.deepEqual(v.later.verdicts, [['INVALID', '1'], ['DUPLICATE', '0'], ['LOW', '1'], ['MEDIUM', '0'], ['HIGH', '0'], ['CRITICAL', '0']]);
  assert.equal(v.later.expired, '0');
  const f = v.findings[0];
  assert.equal(f.outcome, 'HIGH');
  assert.equal(f.paidWei, '400000000000000000');
  assert.equal(f.revealedAt, T0 + 20 * DAY);
  assert.equal(f.settledAt, T0 + 36 * DAY);
  assert.equal(f.dispute, 'None');
});

test('lineage: the predecessor this version fixed and the successor that fixed it, by listing and hash', () => {
  const l = listing({ state: 'Rolled', rolledAt: String(T0 + DAY), predecessor: '1', predecessorHash: H('c'), successor: '7', successorHash: H('d') });
  const [v] = recordView(view({ listings: [l] })).listings;
  assert.deepEqual(v.predecessor, { id: '1', hash: H('c') });
  assert.deepEqual(v.successor, { id: '7', hash: H('d') });
  const [none] = recordView(view()).listings;
  assert.equal(none.predecessor, null);
  assert.equal(none.successor, null);
});

test('flags: each with its claim\'s state and, once judged, the verdict and when', () => {
  const flags = [
    { claimId: '5', listingId: '3', late: false, state: 'Settled', outcome: 'INVALID', disclosedAt: String(T0 + DAY), revealedAt: String(T0 + 2 * DAY), judgedAt: String(T0 + 2 * DAY + 300) },
    { claimId: '6', listingId: '3', late: false, state: 'Committed', outcome: 'INVALID', disclosedAt: String(T0 + 3 * DAY), revealedAt: '0', judgedAt: '0' },
  ];
  const v = recordView(view({ flags }));
  assert.deepEqual(v.flags.map((f) => [f.claimId, f.state, f.verdict]), [
    ['5', 'Settled', { outcome: 'INVALID', at: T0 + 2 * DAY + 300 }],
    ['6', 'Committed', null],
  ]);
  assert.equal(v.flags[0].disclosedAt, T0 + DAY);
});

test('freshness and the placeholders ride along', () => {
  const v = recordView({ ...view(), fresh: false, staleReason: 'INDEXER_STALE' });
  assert.equal(v.fresh, false);
  assert.equal(v.staleReason, 'INDEXER_STALE');
  assert.deepEqual(v.block, { number: 120, hash: H('b'), timestamp: T0 + 40 * DAY });
  assert.deepEqual(v.placeholders, ['SA_BADGE_FLOOR_WEI', 'SA_UNDER_STAKED_RATIO_BPS']);
});

test('a listing that does not count is apart: with why, and no amount of it', () => {
  const v = recordView({ ...view(), notCounted: { listings: [{ listingId: '9', maker: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', state: 'Open', lapsed: false, reason: 'NOT_SIGNED_BY_BUILDER', detail: 'why', escrowWei: '5' }], findings: [{ claimId: '1' }], flags: [], events: [] } });
  const { control, ...row } = v.notCounted.listings[0];
  assert.deepEqual(row, { id: '9', maker: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', state: 'Open', reason: 'NOT_SIGNED_BY_BUILDER', detail: 'why' });
  assert.equal(control.proof, 'no', 'its fact comes along, for the signature form');
  assert.equal(v.notCounted.findings, 1);
  assert.equal(JSON.stringify(row).includes('escrow'), false);
  assert.deepEqual(recordView(view()).notCounted, { listings: [], findings: 0 });
});

test('the fork label is the server\'s, and none is not a guess', () => {
  assert.deepEqual(recordView({ ...view(), fork: { status: 'fork', parent: 'https://github.com/acme/vault' } }).fork, { status: 'fork', parent: 'https://github.com/acme/vault' });
  assert.equal(recordView(view()).fork, null);
});
