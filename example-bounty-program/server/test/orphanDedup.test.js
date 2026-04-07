/**
 * Regression tests for GitHub issue: Orphan/Duplicate Bounty Jobs
 *
 * Covers:
 * 1. Reconcile case where initial API id != canonical on-chain id
 * 2. Only canonical job appears in default OPEN/browse lists
 * 3. Orphan cannot appear actionable
 * 4. No duplicate cards for same evaluationCid after reconciliation
 */

// ---------------------------------------------------------------------------
// In-memory storage (must be prefixed with "mock" for jest.mock scope rules)
// ---------------------------------------------------------------------------

let mockStorageData = { jobs: [], nextId: 0 };

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(() => {
        return Promise.resolve(JSON.stringify(mockStorageData));
      }),
      writeFile: jest.fn().mockImplementation((_path, data) => {
        mockStorageData = JSON.parse(data);
        return Promise.resolve();
      }),
      rename: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../config', () => ({
  config: {
    network: 'base-sepolia',
    bountyEscrowAddress: '0xabc123',
  },
}));

// Import AFTER mocks
const jobStorage = require('../utils/jobStorage');

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const CURRENT_CONTRACT = '0xabc123';
const OLD_CONTRACT = '0xold999';
const NOW_SEC = Math.floor(Date.now() / 1000);

function makeJob(overrides = {}) {
  return {
    jobId: 0,
    title: 'Test Bounty',
    description: 'A test bounty',
    creator: '0xcreator',
    bountyAmount: 0.01,
    threshold: 70,
    evaluationCid: 'QmTestCid',
    status: 'OPEN',
    createdAt: NOW_SEC,
    submissionCount: 0,
    submissions: [],
    winner: null,
    contractAddress: CURRENT_CONTRACT,
    onChain: true,
    syncedFromBlockchain: true,
    ...overrides,
  };
}

function setStorage(data) {
  mockStorageData = JSON.parse(JSON.stringify(data));
}

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
});

// ===========================================================================
describe('Orphan / Duplicate Bounty Regression Tests', () => {
  // =========================================================================
  describe('1. Reconcile: API id != on-chain id', () => {
    it('should reconcile jobId to match on-chain bountyId', async () => {
      setStorage({
        jobs: [makeJob({ jobId: 69, onChain: false, syncedFromBlockchain: false })],
        nextId: 70,
      });

      // Replicate PATCH /:jobId/bountyId logic
      const storage = await jobStorage.readStorage();
      const job = storage.jobs.find(j => j.jobId === 69);
      job.onChain = true;
      const onChainId = 65;

      if (job.jobId !== onChainId) {
        const collisionIdx = storage.jobs.findIndex(j => j !== job && j.jobId === onChainId);
        if (collisionIdx !== -1) {
          storage.jobs.splice(collisionIdx, 1);
        }
        job.jobId = onChainId;
      }

      await jobStorage.writeStorage(storage);

      const result = await jobStorage.readStorage();
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].jobId).toBe(65);
      expect(result.jobs[0].onChain).toBe(true);
    });

    it('should remove colliding job during reconciliation', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 65, title: 'Synced Duplicate', syncedFromBlockchain: true }),
          makeJob({ jobId: 69, title: 'API Original', onChain: false, syncedFromBlockchain: false }),
        ],
        nextId: 70,
      });

      const storage = await jobStorage.readStorage();
      const job = storage.jobs.find(j => j.jobId === 69);
      const onChainId = 65;

      job.onChain = true;
      if (job.jobId !== onChainId) {
        const collisionIdx = storage.jobs.findIndex(j => j !== job && j.jobId === onChainId);
        if (collisionIdx !== -1) {
          storage.jobs.splice(collisionIdx, 1);
        }
        job.jobId = onChainId;
      }

      await jobStorage.writeStorage(storage);

      const result = await jobStorage.readStorage();
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].jobId).toBe(65);
      expect(result.jobs[0].title).toBe('API Original');
    });
  });

  // =========================================================================
  describe('2. Only canonical appears in default OPEN/browse lists', () => {
    it('should exclude ORPHANED jobs from default listing', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, title: 'Active Bounty' }),
          makeJob({ jobId: 1, title: 'Orphaned Bounty', status: 'ORPHANED', contractAddress: OLD_CONTRACT }),
        ],
        nextId: 2,
      });

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
      expect(listed[0].title).toBe('Active Bounty');
    });

    it('should exclude jobs from old contracts', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, title: 'Current Contract', contractAddress: CURRENT_CONTRACT }),
          makeJob({ jobId: 1, title: 'Old Contract', contractAddress: OLD_CONTRACT }),
        ],
        nextId: 2,
      });

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
      expect(listed[0].title).toBe('Current Contract');
    });

    it('should hide ghost jobs when synced sibling exists', async () => {
      const cid = 'QmSharedCid';
      setStorage({
        jobs: [
          makeJob({ jobId: 0, title: 'Synced On-Chain', evaluationCid: cid, syncedFromBlockchain: true }),
          makeJob({ jobId: 1, title: 'API Ghost', evaluationCid: cid, onChain: false, syncedFromBlockchain: false }),
        ],
        nextId: 2,
      });

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
      expect(listed[0].title).toBe('Synced On-Chain');
    });

    it('should hide ghost jobs older than 1 hour', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, title: 'Old Ghost', onChain: false, syncedFromBlockchain: false, createdAt: NOW_SEC - 7200 }),
        ],
        nextId: 1,
      });

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(0);
    });

    it('should show recent API-created jobs (< 1 hour, no synced sibling)', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, title: 'Fresh API Job', onChain: false, syncedFromBlockchain: false, createdAt: NOW_SEC - 60 }),
        ],
        nextId: 1,
      });

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
      expect(listed[0].title).toBe('Fresh API Job');
    });

    it('should include orphans when includeOrphans filter is set', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, title: 'Active' }),
          makeJob({ jobId: 1, title: 'Orphaned', status: 'ORPHANED', contractAddress: OLD_CONTRACT }),
        ],
        nextId: 2,
      });

      const listed = await jobStorage.listJobs({ includeOrphans: true, currentContractOnly: false });
      expect(listed).toHaveLength(2);
    });
  });

  // =========================================================================
  describe('3. Orphan cannot appear actionable', () => {
    it('should mark old-contract jobs as orphaned via markOrphanedJobs', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, contractAddress: OLD_CONTRACT, status: 'OPEN' }),
          makeJob({ jobId: 1, contractAddress: CURRENT_CONTRACT, status: 'OPEN' }),
        ],
        nextId: 2,
      });

      const result = await jobStorage.markOrphanedJobs();
      expect(result.marked).toBe(1);

      const storage = await jobStorage.readStorage();
      const orphaned = storage.jobs.find(j => j.jobId === 0);
      expect(orphaned.status).toBe('ORPHANED');
      expect(orphaned.orphanedAt).toBeDefined();

      const active = storage.jobs.find(j => j.jobId === 1);
      expect(active.status).toBe('OPEN');
    });

    it('should identify orphaned jobs via findOrphanedJobs', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, contractAddress: OLD_CONTRACT }),
          makeJob({ jobId: 1, contractAddress: CURRENT_CONTRACT }),
          makeJob({ jobId: 2, contractAddress: '' }),  // legacy, not orphaned
        ],
        nextId: 3,
      });

      const orphans = await jobStorage.findOrphanedJobs();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].jobId).toBe(0);
    });

    it('should not list orphaned jobs as OPEN', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, contractAddress: OLD_CONTRACT, status: 'ORPHANED' }),
        ],
        nextId: 1,
      });

      const openJobs = await jobStorage.listJobs({ status: 'OPEN' });
      expect(openJobs).toHaveLength(0);
    });

    it('should not list old-contract OPEN jobs even before explicit orphan marking', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, contractAddress: OLD_CONTRACT, status: 'OPEN' }),
        ],
        nextId: 1,
      });

      const listed = await jobStorage.listJobs({ status: 'OPEN' });
      expect(listed).toHaveLength(0);
    });
  });

  // =========================================================================
  describe('4. No duplicate cards for same evaluationCid', () => {
    it('should hide API ghost when on-chain sibling with same CID exists', async () => {
      const cid = 'QmDuplicateCid';
      setStorage({
        jobs: [
          makeJob({ jobId: 65, evaluationCid: cid, syncedFromBlockchain: true }),
          makeJob({ jobId: 69, evaluationCid: cid, onChain: false, syncedFromBlockchain: false, createdAt: NOW_SEC - 60 }),
        ],
        nextId: 70,
      });

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
      expect(listed[0].jobId).toBe(65);
    });

    it('should produce single job after full reconciliation flow', async () => {
      const cid = 'QmReconcileCid';

      // Step 1: API creates job 69
      setStorage({
        jobs: [
          makeJob({ jobId: 69, evaluationCid: cid, onChain: false, syncedFromBlockchain: false, createdAt: NOW_SEC }),
        ],
        nextId: 70,
      });

      // Step 2: Sync service creates job 65 from blockchain
      let storage = await jobStorage.readStorage();
      storage.jobs.push(makeJob({
        jobId: 65,
        evaluationCid: cid,
        syncedFromBlockchain: true,
        onChain: true,
      }));
      await jobStorage.writeStorage(storage);

      // Step 3: PATCH reconciles job 69 -> 65, removing collision
      storage = await jobStorage.readStorage();
      const apiJob = storage.jobs.find(j => j.jobId === 69);
      apiJob.onChain = true;
      const onChainId = 65;

      const collisionIdx = storage.jobs.findIndex(j => j !== apiJob && j.jobId === onChainId);
      if (collisionIdx !== -1) {
        storage.jobs.splice(collisionIdx, 1);
      }
      apiJob.jobId = onChainId;
      await jobStorage.writeStorage(storage);

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
      expect(listed[0].jobId).toBe(65);
      expect(listed[0].onChain).toBe(true);
    });

    it('should not create duplicate when POST /create reuses existing evaluationCid', async () => {
      const cid = 'QmExistingCid';
      setStorage({
        jobs: [
          makeJob({ jobId: 5, evaluationCid: cid, onChain: false, syncedFromBlockchain: false, createdAt: NOW_SEC }),
        ],
        nextId: 6,
      });

      // Replicate the dedup check from POST /create
      const storage = await jobStorage.readStorage();
      const existing = storage.jobs.find(j =>
        j.evaluationCid === cid &&
        j.status !== 'ORPHANED' &&
        !j.syncedFromBlockchain &&
        !j.onChain
      );

      expect(existing).toBeDefined();
      expect(existing.jobId).toBe(5);

      const listed = await jobStorage.listJobs();
      expect(listed).toHaveLength(1);
    });

    it('should permanently remove orphans via deleteOrphanedJobs', async () => {
      setStorage({
        jobs: [
          makeJob({ jobId: 0, contractAddress: OLD_CONTRACT, status: 'ORPHANED' }),
          makeJob({ jobId: 1, contractAddress: CURRENT_CONTRACT }),
          makeJob({ jobId: 2, contractAddress: '' }),  // legacy, kept
        ],
        nextId: 3,
      });

      const result = await jobStorage.deleteOrphanedJobs();
      expect(result.deleted).toBe(1);
      expect(result.remaining).toBe(2);

      const storage = await jobStorage.readStorage();
      expect(storage.jobs.find(j => j.jobId === 0)).toBeUndefined();
      expect(storage.jobs.find(j => j.jobId === 1)).toBeDefined();
      expect(storage.jobs.find(j => j.jobId === 2)).toBeDefined();
    });
  });
});
