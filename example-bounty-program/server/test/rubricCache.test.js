/**
 * Tests for the persisted-rubric cache (Option B): the bounty-detail load
 * optimization that stores the authoritative rubric (+ jury) on the job so
 * future loads serve it locally with zero IPFS.
 *
 * The route logic lives in GET /api/jobs/:id?includeRubric=true, but its two
 * load-bearing pieces are exercised here against real jobStorage:
 *   1. The persist round-trips through jobStorage.updateJob (race-safe).
 *   2. The cache-validity predicate is keyed on the immutable evaluationCid, so
 *      it hits while the source CID matches and misses (forcing a re-fetch) when
 *      evaluationCid is re-pointed.
 */

let mockStorageData = { jobs: [], nextId: 0 };

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => Promise.resolve(JSON.stringify(mockStorageData))),
      writeFile: jest.fn().mockImplementation((_path, data) => {
        mockStorageData = JSON.parse(data);
        return Promise.resolve();
      }),
      rename: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../config', () => ({
  config: { network: 'base-sepolia', bountyEscrowAddress: '0xabc123' },
}));

const jobStorage = require('../utils/jobStorage');

// Mirrors the cacheHit predicate in the GET /:id?includeRubric=true handler.
const rubricCacheValid = (job) => {
  const rubricSource = job.evaluationCid || job.rubricCid || null;
  return !!(job.rubricContent && rubricSource && job.rubricSourceCid === rubricSource);
};

beforeEach(() => {
  mockStorageData = {
    jobs: [{
      jobId: 0,
      evaluationCid: 'QmEvalPackage',
      rubricCid: 'QmLooseRubric',
      juryNodes: [],
      submissions: [],
      contractAddress: '0xabc123',
    }],
    nextId: 1,
  };
});

describe('persisted-rubric cache (Option B)', () => {
  it('starts as a cache MISS when nothing is persisted', async () => {
    const job = await jobStorage.getJob(0);
    expect(rubricCacheValid(job)).toBe(false);
  });

  it('persists rubric + jury + source CID and then reports a HIT', async () => {
    const rubric = { description: 'r', criteria: [{ id: 'a', weight: 1 }] };
    const jury = [{ provider: 'OpenAI', model: 'gpt-5.2', runs: 1, weight: 1 }];

    await jobStorage.updateJob(0, {
      rubricContent: rubric,
      rubricSourceCid: 'QmEvalPackage', // = evaluationCid
      juryNodes: jury,
    });

    const job = await jobStorage.getJob(0);
    expect(rubricCacheValid(job)).toBe(true);
    expect(job.rubricContent).toEqual(rubric);
    expect(job.juryNodes).toEqual(jury);
  });

  it('MISSES after evaluationCid is re-pointed (forces a fresh fetch)', async () => {
    await jobStorage.updateJob(0, {
      rubricContent: { description: 'r', criteria: [] },
      rubricSourceCid: 'QmEvalPackage',
    });
    expect(rubricCacheValid(await jobStorage.getJob(0))).toBe(true);

    // Local heal re-points the evaluation package to a new CID.
    await jobStorage.updateJob(0, { evaluationCid: 'QmEvalPackageV2' });

    const job = await jobStorage.getJob(0);
    expect(rubricCacheValid(job)).toBe(false); // stale source CID -> re-fetch
  });
});
