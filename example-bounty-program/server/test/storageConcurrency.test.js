/**
 * Regression tests for the jobs.json "orphan race" (lost update).
 *
 * jobs.json is a whole-file store: every mutation is read -> modify -> write,
 * with await points in between. The sync worker and API route handlers run in
 * the SAME process, so two cycles can interleave and the second writeStorage()
 * overwrites the first's changes (e.g. sync wiping a just-created API job).
 *
 * jobStorage.withStorage() serializes the whole read-modify-write critical
 * section behind a promise-chain lock to close that window. These tests:
 *   1. Prove the harness actually exercises the race (raw pattern loses data).
 *   2. Prove withStorage prevents the lost update.
 *   3. Prove a createJob() concurrent with a sync-style write survives.
 */

let mockStorageData = { jobs: [], nextId: 0 };

// Force a real interleave window: readFile/writeFile yield to the event loop,
// and each readFile returns an isolated snapshot (parse of the current state),
// exactly like reading the file from disk.
const tick = () => new Promise((resolve) => setImmediate(resolve));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockImplementation(async () => {
        await tick();
        return JSON.stringify(mockStorageData);
      }),
      writeFile: jest.fn().mockImplementation(async (_path, data) => {
        await tick();
        // Commit on write (the tmp-file write); rename is a no-op below.
        mockStorageData = JSON.parse(data);
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

const jobStorage = require('../utils/jobStorage');

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
});

describe('jobs.json concurrency / orphan-race', () => {
  // Control: demonstrates the bug. Two raw read-modify-write cycles race and one
  // append is lost. If this ever stops losing data, the test below is no longer
  // exercising a real race and should be re-examined.
  it('CONTROL: raw read-modify-write loses a concurrent append', async () => {
    const rawAppend = async () => {
      const s = await jobStorage.readStorage();
      await tick(); // simulate work between read and write
      s.jobs.push({ jobId: s.jobs.length });
      await jobStorage.writeStorage(s);
    };

    await Promise.all([rawAppend(), rawAppend()]);

    const result = await jobStorage.readStorage();
    // Lost update: both read length 0, both wrote a single-job file.
    expect(result.jobs).toHaveLength(1);
  });

  it('withStorage serializes concurrent appends (no lost update)', async () => {
    const lockedAppend = async () => {
      await jobStorage.withStorage(async (s) => {
        await tick(); // work inside the critical section
        s.jobs.push({ jobId: s.jobs.length });
      });
    };

    await Promise.all([lockedAppend(), lockedAppend(), lockedAppend()]);

    const result = await jobStorage.readStorage();
    expect(result.jobs).toHaveLength(3);
    // Serialized, so each saw the prior commit and got a distinct id.
    expect(result.jobs.map(j => j.jobId).sort()).toEqual([0, 1, 2]);
  });

  it('a createJob concurrent with a sync-style write is not wiped', async () => {
    // Seed one existing synced job (what the "sync worker" knows about).
    mockStorageData = {
      jobs: [{ jobId: 0, title: 'existing', submissions: [] }],
      nextId: 1,
    };

    // Sync-style persist: reads storage, does async work WITHOUT knowing about
    // the new job, then writes — all under the lock.
    const syncWrite = jobStorage.withStorage(async (s) => {
      await tick();
      await tick();
      // Touch only the jobs it knows about.
      for (const j of s.jobs) j.lastSyncedAt = 12345;
    });

    // Concurrently, the API creates a brand-new job.
    const createWrite = jobStorage.createJob({
      title: 'brand new',
      creator: '0xcreator',
      bountyAmount: 0.01,
    });

    await Promise.all([syncWrite, createWrite]);

    const result = await jobStorage.readStorage();
    const titles = result.jobs.map(j => j.title).sort();
    // Both the synced job and the newly-created one survive.
    expect(titles).toEqual(['brand new', 'existing']);
    expect(result.jobs.find(j => j.title === 'existing').lastSyncedAt).toBe(12345);
  });

  it('a bountyId relink+collision-splice is serialized with a concurrent create', async () => {
    // Mirrors the critical section of PATCH /:jobId/bountyId: a pending job
    // (id 50) is relinked to its on-chain id (3), splicing an unsynced phantom
    // that squats id 3. This must not lose — nor be lost to — a concurrent
    // createJob of an unrelated job.
    mockStorageData = {
      jobs: [
        { jobId: 50, evaluationCid: 'QmReal', submissions: [], syncedFromBlockchain: false, onChain: false },
        { jobId: 3, evaluationCid: 'QmPhantom', submissions: [], syncedFromBlockchain: false, onChain: false },
      ],
      nextId: 51,
    };

    const relink = jobStorage.withStorage(async (store, ctx) => {
      await tick();
      const job = store.jobs.find(j => j.jobId === 50);
      const collisionIdx = store.jobs.findIndex(j => j !== job && j.jobId === 3);
      const colliding = store.jobs[collisionIdx];
      // phantom (not synced, different CID) → removable
      const realDistinct = (colliding.syncedFromBlockchain || colliding.onChain) &&
        colliding.evaluationCid !== job.evaluationCid;
      expect(realDistinct).toBe(false);
      store.jobs.splice(collisionIdx, 1);
      job.jobId = 3;
      job.onChain = true;
      ctx; // (skipWrite stays false)
    });

    const create = jobStorage.createJob({ title: 'unrelated new', creator: '0xc', bountyAmount: 1 });

    await Promise.all([relink, create]);

    const result = await jobStorage.readStorage();
    const byTitle = result.jobs.map(j => j.title || `id:${j.jobId}`).sort();
    // Phantom gone; relinked job present as id 3; new job survived.
    expect(result.jobs.some(j => j.jobId === 3 && j.evaluationCid === 'QmReal')).toBe(true);
    expect(result.jobs.some(j => j.evaluationCid === 'QmPhantom')).toBe(false);
    expect(byTitle).toContain('unrelated new');
    expect(result.jobs).toHaveLength(2);
  });

  it('withStorage propagates mutator errors without breaking the lock', async () => {
    await expect(
      jobStorage.withStorage(async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    // The chain must still work after a rejected mutator.
    await jobStorage.withStorage((s) => { s.jobs.push({ jobId: 0 }); });
    const result = await jobStorage.readStorage();
    expect(result.jobs).toHaveLength(1);
  });
});
