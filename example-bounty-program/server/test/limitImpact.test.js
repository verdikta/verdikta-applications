// scripts/limitImpact.js (owner runbook, review 2026-11-26 #19): which live bounties and listings a
// proposed limit change would strand. The pure part; the chain reads are ethers calls on the
// committed ABIs.
const { juryProblemUnder, impactOf, parseArgs } = require('../scripts/limitImpact');

const CURRENT = { maxJury: 50, maxTimeout: 3600, tPlus: 155, shortlist: 60 };
const SMALL = { K: 6, timeout: 300 };
const JUMBO = { K: 50, timeout: 600 };

describe('limitImpact', () => {
  it('names the same reasons, in the same order, as the lenses\' juryProblem', () => {
    expect(juryProblemUnder(CURRENT, SMALL)).toBe('');
    expect(juryProblemUnder(CURRENT, { K: 6, timeout: 155 })).toBe('timeout at or below tPlus');
    expect(juryProblemUnder(CURRENT, { K: 6, timeout: 0 })).toBe('timeout at or below tPlus');
    expect(juryProblemUnder(CURRENT, { K: 6, timeout: 3601 })).toBe('timeout above maxTimeout');
    expect(juryProblemUnder({ ...CURRENT, maxTimeout: 200000 }, { K: 6, timeout: 90000 })).toBe('timeout above one day');
    expect(juryProblemUnder(CURRENT, { K: 51, timeout: 300 })).toBe('K above maxJury');
    expect(juryProblemUnder({ ...CURRENT, maxJury: 100 }, { K: 61, timeout: 300 })).toBe("K above the keeper's shortlist");
  });

  it('raising T+ to 300 strands the 300 s juries only; one already refused is reported apart', () => {
    const items = [
      { kind: 'bounty', id: 1, jury: SMALL },
      { kind: 'listing', id: 2, jury: JUMBO },
      { kind: 'bounty', id: 3, jury: { K: 6, timeout: 100 } },
    ];
    const r = impactOf(CURRENT, { ...CURRENT, tPlus: 300 }, items);
    expect(r.stranded.map((x) => [x.kind, x.id, x.reason])).toEqual([['bounty', 1, 'timeout at or below tPlus']]);
    expect(r.alreadyFailing.map((x) => x.id)).toEqual([3]);
  });

  it('a lower shortlist strands the big juries; an unchanged set of limits strands nothing', () => {
    const items = [{ kind: 'bounty', id: 1, jury: SMALL }, { kind: 'listing', id: 2, jury: JUMBO }];
    expect(impactOf(CURRENT, { ...CURRENT, shortlist: 40 }, items).stranded.map((x) => x.id)).toEqual([2]);
    expect(impactOf(CURRENT, CURRENT, items).stranded).toEqual([]);
  });

  it('parses repeated contract flags', () => {
    const a = parseArgs(['--rpc', 'u', '--aggregator', '0xa', '--escrow', '0x1', '--escrow', '0x2', '--attestation', '0x3', '--t-plus', '200']);
    expect(a).toEqual({ rpc: 'u', aggregator: '0xa', escrow: ['0x1', '0x2'], attestation: ['0x3'], 't-plus': '200' });
  });
});
