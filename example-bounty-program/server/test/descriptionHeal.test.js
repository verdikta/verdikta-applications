/**
 * scripts/healTruncatedDescriptions.js: restoring synced descriptions the old
 * sync regex cut at the first blank line or "===" (mainnet #299).
 *
 * Only a stored description that is a strict prefix of the package's changes,
 * only synced jobs on the current escrow are considered (job ids repeat across
 * escrows), and the write is compare-and-set against a fresh read.
 */
const {
  isDescriptionHealCandidate,
  healedDescription,
  planDescriptionHeals,
  applyDescriptionHeals,
} = require('../scripts/healTruncatedDescriptions');

const ESCROW = '0xa741eff41bcf14793e61cebb4179e05c9124d3f6';
const OLD_ESCROW = '0x0000000000000000000000000000000000000abc';
const FULL = 'Settles one side of a two-bounty wager.\n\n=== MUTUAL WAGER TERMS ===\nPays if Team A wins.\n=== END WAGER TERMS ===';
const CUT = 'Settles one side of a two-bounty wager.';
const CID_A = 'QmPackageA000000000000000000000000000000000000';
const CID_B = 'QmPackageB000000000000000000000000000000000000';

function job(overrides = {}) {
  return {
    jobId: 299,
    title: 'Wager',
    status: 'OPEN',
    contractAddress: '0xA741eFf41Bcf14793E61CEbB4179E05C9124D3f6',
    syncedFromBlockchain: true,
    evaluationCid: CID_A,
    description: CUT,
    ...overrides,
  };
}

describe('isDescriptionHealCandidate', () => {
  it('takes a synced job on the current escrow (address compared case-insensitively)', () => {
    expect(isDescriptionHealCandidate(job(), ESCROW)).toBe(true);
  });

  it.each([
    ['another escrow', { contractAddress: OLD_ESCROW }],
    ['an API-created job', { syncedFromBlockchain: false }],
    ['an orphan', { status: 'ORPHANED' }],
    ['a dev CID', { evaluationCid: 'dev-123' }],
    ['no CID', { evaluationCid: null }],
    ['the sync placeholder', { description: 'Fetched from blockchain' }],
    ['an empty description', { description: '  ' }],
  ])('skips %s', (_label, overrides) => {
    expect(isDescriptionHealCandidate(job(overrides), ESCROW)).toBe(false);
  });
});

describe('healedDescription', () => {
  it('returns the package text when the stored text is a strict prefix of it', () => {
    expect(healedDescription(CUT, FULL)).toBe(FULL);
    // The old regex also stopped at an inline "===".
    expect(healedDescription('Pays if A', 'Pays if A === B')).toBe('Pays if A === B');
  });

  it('leaves equal, edited, longer or missing descriptions alone', () => {
    expect(healedDescription(FULL, FULL)).toBeNull();
    expect(healedDescription('Settles one side (edited).', FULL)).toBeNull();
    expect(healedDescription(FULL, CUT)).toBeNull();
    expect(healedDescription(CUT, null)).toBeNull();
  });
});

describe('planDescriptionHeals', () => {
  it('plans truncated jobs only, fetching each package once', async () => {
    const jobs = [
      job({ jobId: 298, description: FULL }), // API-matched or already repaired: same package, full text
      job({ jobId: 299 }), // re-funded the same package: cut
      job({ jobId: 299, contractAddress: OLD_ESCROW, evaluationCid: CID_B }), // same id, old escrow
      job({ jobId: 300, evaluationCid: CID_B, description: 'Something else entirely.' }),
    ];
    const fetchDescription = jest.fn(async (cid) => (cid === CID_A ? FULL : 'A different package.'));

    const plan = await planDescriptionHeals(jobs, { escrow: ESCROW, fetchDescription });

    expect(plan.scanned).toBe(3);
    expect(plan.heals).toEqual([{ jobId: 299, title: 'Wager', evaluationCid: CID_A, before: CUT, after: FULL }]);
    expect(plan.unreadable).toEqual([]);
    expect(fetchDescription.mock.calls.map(([cid]) => cid)).toEqual([CID_A, CID_B]);
  });

  it('reports unreadable packages and honours --job filters', async () => {
    const jobs = [job({ jobId: 7, evaluationCid: CID_B }), job({ jobId: 299 })];
    const fetchDescription = jest.fn(async (cid) => {
      if (cid === CID_B) throw new Error('gateway 429');
      return FULL;
    });

    expect(await planDescriptionHeals(jobs, { escrow: ESCROW, fetchDescription }))
      .toMatchObject({ scanned: 2, unreadable: [7], heals: [{ jobId: 299 }] });
    expect(await planDescriptionHeals(jobs, { escrow: ESCROW, jobIds: [7], fetchDescription }))
      .toMatchObject({ scanned: 1, unreadable: [7], heals: [] });
  });

  it('treats a package without a description as nothing to restore', async () => {
    const plan = await planDescriptionHeals([job()], { escrow: ESCROW, fetchDescription: async () => null });
    expect(plan).toMatchObject({ scanned: 1, heals: [], unreadable: [] });
  });
});

describe('applyDescriptionHeals', () => {
  const heal = { jobId: 299, before: CUT, after: FULL };

  it('writes the planned description onto the current-escrow job only', () => {
    const storage = { jobs: [job({ contractAddress: OLD_ESCROW }), job()] };
    expect(applyDescriptionHeals(storage, [heal], ESCROW)).toEqual({ applied: [299], skipped: [] });
    expect(storage.jobs[0].description).toBe(CUT);
    expect(storage.jobs[1].description).toBe(FULL);
  });

  it('skips a job whose description changed since it was read', () => {
    const storage = { jobs: [job({ description: 'Hand-repaired.' })] };
    expect(applyDescriptionHeals(storage, [heal], ESCROW)).toEqual({ applied: [], skipped: [299] });
    expect(storage.jobs[0].description).toBe('Hand-repaired.');
  });

  it('skips an ambiguous id rather than guessing', () => {
    const storage = { jobs: [job(), job()] };
    expect(applyDescriptionHeals(storage, [heal], ESCROW)).toEqual({ applied: [], skipped: [299] });
  });
});
