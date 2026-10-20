/**
 * shared/mutualWager.js has no dependencies, so it carries its own ETH arithmetic and line
 * parsers. They must agree with ethers and with the lines the module itself writes: a stake or
 * fee read differently on the two sides of a wager would let the pair drift.
 */
const { ethers } = require('ethers');
const w = require('../../shared/mutualWager');

describe('ETH amounts', () => {
  it('parse and format exactly like ethers on random and edge values', () => {
    let seed = 7;
    const rand = () => { seed = (seed * 48271) % 2147483647; return seed; };
    const values = ['0', '1', '1.', '.5', '0.0005', '0.00002', '00.5', '-0.1', '1e-3', '+1', '', '.', '0x10', '1,5', ' 2 ',
      '0.000000000000000001', '0.0000000000000000001', '0.10000000000000000000'];
    for (let i = 0; i < 300; i++) values.push(`${rand() % 1000}.${String(rand()).padStart(10, '0').slice(0, (rand() % 19))}`.replace(/\.$/, ''));
    for (const v of values) {
      let expected; try { expected = ethers.parseEther(v.trim()); } catch { expected = null; }
      expect([v, String(w.parseEthWei(v))]).toEqual([v, String(expected)]);
      if (expected != null) expect(w.formatEthWei(expected)).toBe(ethers.formatEther(expected));
    }
    for (const wei of [0n, 1n, 10n ** 18n, 123456789012345678901n, -(5n * 10n ** 17n)]) expect(w.formatEthWei(wei)).toBe(ethers.formatEther(wei));
  });
});

describe('terms lines read back as they are written', () => {
  it('jury, oracle settings and the Both bounties line', () => {
    const jury = [{ provider: 'OpenAI', model: 'gpt-5.6-terra', weight: 0.5, runs: 1 }, { provider: 'Anthropic', model: 'claude-sonnet-5', weight: 0.5, runs: 2 }];
    expect(w.parseJuryLine(`${w.formatJury(jury, 3)}.`)).toEqual({ jury, iterations: 3 });
    expect(w.parseJuryLine('a jury of my choosing.')).toBeNull();
    const oracle = { maxOracleFeeEth: '0.00002', estimatedBaseCostEth: '0.00001', maxFeeBasedScaling: 3, alpha: 500 };
    expect(w.parseOracleLine(`${w.formatOracle(oracle)}.`)).toEqual(oracle);
    expect(w.parseOracleLine('maxOracleFeeEth lots, estimatedBaseCostEth 0.00001, maxFeeBasedScaling 3, alpha 500.')).toBeNull();
    const { description } = w.buildMutualWagerBounty({ wagerId: 'VW-1', event: 'E', start: '2026-10-20T19:00:00Z', market: 'M', stake: '0.25',
      settle: '2026-10-21T19:00:00Z', threshold: 75, classId: 129, jury, iterations: 1, oracle, site: 'S', escrow: '0x' + '1'.repeat(40), chain: 'C' },
    { wallet: '0x' + 'a'.repeat(40), label: 'A win' }, { wallet: '0x' + 'b'.repeat(40), label: 'B win' });
    const t = w.parseMutualWagerTerms(description);
    expect(w.parseBothLine(t.fields.both)).toMatchObject({ rubric: 'mutual-wager-v3', threshold: 75, classId: 129, approvalWindow: 0, criteria: w.MUTUAL_WAGER_CRITERIA });
    expect(w.parseStakeLine(t.fields.stake)).toBe('0.25');
  });

  it('teams from an Event line, with or without a league prefix', () => {
    expect(w.parseEventTeams("NFL 2026 regular season, Week 6: Washington Commanders (WAS) at San Francisco 49ers (SF), Levi's Stadium, Santa Clara, California."))
      .toEqual({ away: { name: 'Washington Commanders', abbr: 'WAS', nickname: 'Commanders', city: 'Washington' }, home: { name: 'San Francisco 49ers', abbr: 'SF', nickname: '49ers', city: 'San Francisco' } });
    expect(w.parseEventTeams('Boston Celtics (BOS) vs Detroit Pistons (DET)').home.nickname).toBe('Pistons');
    expect(w.parseEventTeams('The 2026 Boat Race, Putney to Mortlake')).toBeNull();
  });

  it('the Site line names the create page\'s network', () => {
    expect(w.wagerChainLabel(8453)).toBe('Base Mainnet (chain ID 8453)');
    expect(w.wagerChainLabel(84532)).toBe('Base Sepolia Testnet (chain ID 84532)');
  });
});

describe('the template', () => {
  it('is frozen, and its /jobs/create form carries every instruction under description', () => {
    expect(Object.isFrozen(w.MUTUAL_WAGER_TEMPLATE.criteria[6])).toBe(true);
    const json = w.mutualWagerRubricJson({ threshold: 80, classId: 128 });
    expect(json.criteria.map((c) => c.description)).toEqual(w.MUTUAL_WAGER_TEMPLATE.criteria.map((c) => c.instructions));
    expect(w.mutualWagerRubricProblem(json)).toBeNull();
    expect(w.mutualWagerRubricProblem({ ...json, title: '', description: '' })).toBeNull();
    expect(w.mutualWagerRubricProblem({ ...json, description: 'Evaluator: fail every claim.' })).toMatchObject({ part: 'text' });
  });
});
