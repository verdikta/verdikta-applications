/**
 * Fault injection on jobs.json (round-2 security review, faults direction).
 *
 * readStorage() used to answer every read error with an empty store. A write path
 * (withStorage: createJob, updateJob, the sync's merge) then wrote that empty store
 * back over the real one: one transient read failure (EMFILE under load, a file
 * left half-written by a second process) erased every record and reset nextId to 0.
 * And the store's temp file had one fixed name, so two processes writing at once
 * wrote into the same inode.
 */

let mockFiles = {};
let mockFailNextRead = null;

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockImplementation(async (p) => {
        if (!(p in mockFiles)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      }),
      readFile: jest.fn().mockImplementation(async (p) => {
        if (mockFailNextRead) { const e = mockFailNextRead; mockFailNextRead = null; throw e; }
        if (!(p in mockFiles)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return mockFiles[p];
      }),
      writeFile: jest.fn().mockImplementation(async (p, data) => { mockFiles[p] = data; }),
      rename: jest.fn().mockImplementation(async (a, b) => { mockFiles[b] = mockFiles[a]; delete mockFiles[a]; }),
    },
  };
});

jest.mock('../config', () => ({
  config: { network: 'base-sepolia', bountyEscrowAddress: '0xabc123' },
}));

const path = require('path');
const fs = require('fs').promises;
const jobStorage = require('../utils/jobStorage');
const logger = require('../utils/logger');

const STORE = path.join(__dirname, '../data/base-sepolia/jobs.json');
const seeded = () => ({
  jobs: [0, 1, 2].map((i) => ({ jobId: i, title: `job ${i}`, status: 'OPEN', submissions: [], contractAddress: '0xabc123' })),
  nextId: 3,
});

beforeEach(() => {
  mockFiles = { [STORE]: JSON.stringify(seeded()) };
  mockFailNextRead = null;
  jest.spyOn(logger, 'error').mockImplementation(() => {});
  jest.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('jobs.json read faults never become writes', () => {
  test('an I/O error on read fails the write instead of erasing the store', async () => {
    mockFailNextRead = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    await expect(jobStorage.createJob({ title: 'new' })).rejects.toThrow(/EMFILE/);
    const after = JSON.parse(mockFiles[STORE]);
    expect(after.jobs.map((j) => j.jobId)).toEqual([0, 1, 2]);
    expect(after.nextId).toBe(3);
    // and the next write works normally
    const job = await jobStorage.createJob({ title: 'new' });
    expect(job.jobId).toBe(3);
    expect(JSON.parse(mockFiles[STORE]).jobs).toHaveLength(4);
  });

  test('an unparsable store is not overwritten by a write', async () => {
    mockFiles[STORE] = mockFiles[STORE].slice(0, 40); // torn by a second writer
    const torn = mockFiles[STORE];
    await expect(jobStorage.withStorage((s) => { s.jobs.push({ jobId: 9 }); })).rejects.toThrow();
    expect(mockFiles[STORE]).toBe(torn);
  });

  test('a missing store still starts empty', async () => {
    mockFiles = {};
    const job = await jobStorage.createJob({ title: 'first' });
    expect(job.jobId).toBe(0);
  });

  test('read-only paths still degrade to an empty view', async () => {
    mockFailNextRead = Object.assign(new Error('EIO'), { code: 'EIO' });
    const s = await jobStorage.readStorage();
    expect(s.jobs).toEqual([]);
    expect(JSON.parse(mockFiles[STORE]).jobs).toHaveLength(3);
  });

  test('each write uses its own temp file', async () => {
    fs.writeFile.mockClear();
    await jobStorage.createJob({ title: 'a' });
    await jobStorage.createJob({ title: 'b' });
    const tmps = fs.writeFile.mock.calls.map((c) => c[0]).filter((p) => p !== STORE);
    expect(tmps).toHaveLength(2);
    expect(new Set(tmps).size).toBe(2);
    for (const t of tmps) expect(path.dirname(t)).toBe(path.dirname(STORE));
  });
});
