/**
 * Issue #39 — the shared gate that refuses new submissions to a bounty whose
 * evaluation package can never be evaluated (ensureFreshValidation /
 * rejectIfUnevaluable in routes/jobRoutes.js), exercised through the three
 * submission entry points.
 *
 * The REAL bountyValidator runs here. Evaluation packages are in-memory ZIPs served
 * by a fake IPFS client, so a package that cannot be fetched is a fake client that
 * throws (as the public gateways do when they answer HTTP 429), not a mocked
 * validator verdict.
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
  config: {
    network: 'base-sepolia',
    bountyEscrowAddress: '0xabc123',
    chainId: 84532,
    explorer: 'https://sepolia.basescan.org',
    submissionDefaults: { maxOracleFeeWei: '20000000000000', alpha: 500, estimatedBaseCostWei: '10000000000000', maxFeeBasedScaling: 3 },
  },
}));

let mockGetBounty = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({ getBounty: (...args) => mockGetBounty(...args) }),
}));

// Only the class REGISTRY is stubbed (so INVALID_CLASS can be produced; the installed
// registry has no inactive class). The validator itself is the real one.
let mockGetClass = (id) => jest.requireActual('@verdikta/common').classMap.getClass(id);
jest.mock('@verdikta/common', () => {
  const actual = jest.requireActual('@verdikta/common');
  return { ...actual, classMap: { ...actual.classMap, getClass: (id) => mockGetClass(id) } };
});

// multer writes uploads under this directory; the mocked fs does not create it.
const path = require('path');
const os = require('os');
process.env.VERDIKTA_TMP_DIR = path.join(os.tmpdir(), 'verdikta-unevaluable-gate-test');
jest.requireActual('fs').mkdirSync(process.env.VERDIKTA_TMP_DIR, { recursive: true });

const AdmZip = require('adm-zip');
const express = require('express');
const request = require('supertest');
const { ErrorCodes } = require('../utils/apiErrors');
const { CONFORMING_SHAPE_EXAMPLE } = require('../utils/archiveShapeValidator');
const jobRoutes = require('../routes/jobRoutes');

const JOBID = 100;
const EVAL_CID = 'QmEvaluationPackageCidForTheGateTests';
const RUBRIC_CID = 'QmGradingRubricCidForTheGateTests';
const HUNTER = '0x1234567890123456789012345678901234567890';
const HUNTER_CID = 'QmPPhtCMngdLhxiKwEbP2Vds9dTWD6rM82piDkxa94kkY5';
const NOW = () => Math.floor(Date.now() / 1000);

// ---- real evaluation packages, built in memory ------------------------------------

function zipOf(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, 'utf8'));
  return zip.toBuffer();
}

const GOOD_JURY = [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-5.6-sol', NO_COUNTS: 1, WEIGHT: 1 }];

function evaluationPackage({ query = 'Evaluate the submitted work against the rubric.', primaryRaw, jury = GOOD_JURY } = {}) {
  return zipOf({
    'manifest.json': JSON.stringify({
      version: '1.0',
      primary: { filename: 'primary_query.json' },
      juryParameters: { AI_NODES: jury },
      additional: [{ name: 'gradingRubric', hash: RUBRIC_CID }],
      bCIDs: { submission: 'QmSubmission' },
    }),
    'primary_query.json': primaryRaw ?? JSON.stringify({ query, references: ['gradingRubric'], outcomes: ['DONT_FUND', 'FUND'] }),
  });
}

const rubricOf = (criteria) => Buffer.from(JSON.stringify({ criteria }));
const GOOD_RUBRIC = rubricOf([
  { id: 'a', label: 'A', weight: 0.5, must: false },
  { id: 'b', label: 'B', weight: 0.5, must: false },
]);

/** Fake IPFS client: cid -> Buffer to serve, or Error to throw (a gateway failure). */
function fakeIpfs(files) {
  return { fetchFromIPFS: jest.fn(async (cid) => {
    const entry = files[cid];
    if (entry instanceof Error) throw entry;
    if (!entry) throw new Error(`not found: ${cid}`);
    return entry;
  }) };
}
const gateway429 = () => new Error('Failed to fetch CID from all gateways: gateway https://dweb.link -> HTTP 429');

// ---- app / job fixtures -----------------------------------------------------------

function buildApp(ipfsClient) {
  const app = express();
  app.use(express.json());
  if (ipfsClient) app.locals.ipfsClient = ipfsClient;
  app.use('/jobs', jobRoutes);
  return app;
}

function makeJob(overrides = {}) {
  return {
    jobId: JOBID,
    title: 'Mainnet Bounty 100',
    creator: '0xcreator',
    bountyAmount: 0.005,
    threshold: 90,
    evaluationCid: EVAL_CID,
    classId: 128,
    status: 'OPEN',
    submissionOpenTime: NOW() - 3600,
    submissionCloseTime: NOW() + 3600,
    createdAt: NOW() - 3600,
    submissionCount: 0,
    submissions: [],
    contractAddress: '0xabc123',
    onChain: true,
    syncedFromBlockchain: true,
    ...overrides,
  };
}
const setJob = (overrides) => { mockStorageData = { jobs: [makeJob(overrides)], nextId: 1 }; };
const storedValidation = () => mockStorageData.jobs.find((j) => j.jobId === JOBID).validationStatus;

const realFetch = global.fetch;
// The hunter-archive shape check (#34/#35) fetches the hunter CID with global.fetch.
const serveHunterArchive = () => {
  const archive = zipOf({
    'manifest.json': JSON.stringify(CONFORMING_SHAPE_EXAMPLE),
    'primary_query.json': JSON.stringify({ query: 'This is my submitted work, please review it.' }),
  });
  global.fetch = jest.fn(async () => new Response(archive));
};

const prepare = (app) => request(app).post(`/jobs/${JOBID}/submit/prepare`).send({ hunter: HUNTER, hunterCid: HUNTER_CID });

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
  mockGetBounty = jest.fn().mockResolvedValue({ status: 'OPEN' });
  mockGetClass = (id) => jest.requireActual('@verdikta/common').classMap.getClass(id);
  serveHunterArchive();
});
afterAll(() => { global.fetch = realFetch; });

// ---- deterministic package errors block -----------------------------------------

describe('deterministic package errors refuse the submission (409 BOUNTY_UNEVALUABLE)', () => {
  const blocked = async (files, expectInReason) => {
    setJob();
    const res = await prepare(buildApp(fakeIpfs(files)));
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(ErrorCodes.BOUNTY_UNEVALUABLE);
    if (expectInReason) expect(res.body.reason).toMatch(expectInReason);
    return res;
  };

  it('a primary query over the arbiters\' cap (bounty 100 / issue #36)', async () => {
    const res = await blocked(
      { [EVAL_CID]: evaluationPackage({ query: 'x'.repeat(12017) }), [RUBRIC_CID]: GOOD_RUBRIC },
      /12017 characters/,
    );
    expect(res.body.issues.map((i) => i.type)).toEqual(['QUERY_TOO_LONG']);
    expect(storedValidation().valid).toBe(false);
  });

  it('a primary_query.json in the wrong {title, description} format', async () => {
    await blocked(
      { [EVAL_CID]: evaluationPackage({ primaryRaw: JSON.stringify({ title: 't', description: 'd', outcomes: ['A', 'B'] }) }), [RUBRIC_CID]: GOOD_RUBRIC },
      /wrong format/,
    );
  });

  it('a primary_query.json that is not JSON', async () => {
    await blocked({ [EVAL_CID]: evaluationPackage({ primaryRaw: 'not json at all' }), [RUBRIC_CID]: GOOD_RUBRIC }, /Failed to parse primary_query\.json/);
  });

  it('a plain-JSON package (not a ZIP)', async () => {
    await blocked({ [EVAL_CID]: Buffer.from('{"query":"x"}') }, /plain JSON/);
  });

  it('a ZIP with neither manifest.json nor rubric.json', async () => {
    await blocked({ [EVAL_CID]: zipOf({ 'readme.txt': 'hello' }) }, /manifest\.json or rubric\.json/);
  });

  it('a must-pass criterion with non-zero weight', async () => {
    await blocked(
      { [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: rubricOf([{ id: 'a', label: 'A', weight: 0.4, must: true }, { id: 'b', label: 'B', weight: 1, must: false }]) },
      /Must-pass criteria must have weight 0/,
    );
  });

  it('scored weights that do not sum to 1.0', async () => {
    await blocked(
      { [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: rubricOf([{ id: 'a', label: 'A', weight: 0.3, must: false }, { id: 'b', label: 'B', weight: 0.3, must: false }]) },
      /must sum to 1\.0/,
    );
  });

  it('a rubric that fetched fine but is not valid JSON (an unparseable rubric is not a fetch failure)', async () => {
    const res = await blocked({ [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: Buffer.from('this is not json') }, /Failed to parse grading rubric/);
    expect(res.body.issues.map((i) => i.type)).toEqual(['INVALID_RUBRIC']);
  });

  it('is also enforced on /submit/bundle and on the /submit file upload', async () => {
    const app = () => buildApp(fakeIpfs({ [EVAL_CID]: evaluationPackage({ query: 'x'.repeat(10001) }), [RUBRIC_CID]: GOOD_RUBRIC }));

    setJob();
    const bundle = await request(app()).post(`/jobs/${JOBID}/submit/bundle`).send({ hunterAddress: HUNTER, hunterCid: HUNTER_CID });
    expect(bundle.status).toBe(409);
    expect(bundle.body.code).toBe(ErrorCodes.BOUNTY_UNEVALUABLE);

    setJob();
    const upload = await request(app()).post(`/jobs/${JOBID}/submit`).field('hunter', HUNTER).attach('files', Buffer.from('some work'), 'solution.txt');
    expect(upload.status).toBe(409);
    expect(upload.body.code).toBe(ErrorCodes.BOUNTY_UNEVALUABLE);
  });
});

// ---- a package that is fine goes through ----------------------------------------

describe('a sound package', () => {
  it('passes the gate at exactly the query cap and records a clean verdict', async () => {
    setJob();
    const res = await prepare(buildApp(fakeIpfs({ [EVAL_CID]: evaluationPackage({ query: 'x'.repeat(10000) }), [RUBRIC_CID]: GOOD_RUBRIC })));
    expect(res.status).toBe(200);
    expect(res.headers['x-verdikta-validation']).toBeUndefined();
    expect(storedValidation().valid).toBe(true);
    expect(storedValidation().checkedAt).toBeTruthy();
  });
});

// ---- fetch failures are not verdicts --------------------------------------------

describe('an IPFS fetch failure is never a verdict on the package', () => {
  it('lets the submission through, flags it unchecked, and does not persist anything (package fetch, HTTP 429)', async () => {
    setJob();
    const res = await prepare(buildApp(fakeIpfs({ [EVAL_CID]: gateway429() })));
    expect(res.status).toBe(200);
    expect(res.headers['x-verdikta-validation']).toBe('unchecked');
    expect(storedValidation()).toBeUndefined();
  });

  it('does the same when only the grading-rubric fetch fails (bounty 80)', async () => {
    setJob();
    const res = await prepare(buildApp(fakeIpfs({ [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: gateway429() })));
    expect(res.status).toBe(200);
    expect(res.headers['x-verdikta-validation']).toBe('unchecked');
    expect(storedValidation()).toBeUndefined();
  });

  it('still refuses a deterministic error found alongside a rubric fetch failure, and keeps the fetch failure out of the stored verdict', async () => {
    setJob();
    const res = await prepare(buildApp(fakeIpfs({ [EVAL_CID]: evaluationPackage({ query: 'x'.repeat(10001) }), [RUBRIC_CID]: gateway429() })));
    expect(res.status).toBe(409);
    expect(res.body.issues.map((i) => i.type)).toEqual(['QUERY_TOO_LONG']);
    expect(storedValidation().issues.map((i) => i.type)).toEqual(['QUERY_TOO_LONG']);
  });

  it('keeps the last real verdict when a later re-check can only fail to fetch', async () => {
    setJob({
      validationStatus: {
        valid: false,
        issues: [{ type: 'QUERY_TOO_LONG', severity: 'error', message: 'cached: query too long' }],
        checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      },
    });
    const ipfs = fakeIpfs({ [EVAL_CID]: gateway429() });
    const res = await prepare(buildApp(ipfs));
    expect(ipfs.fetchFromIPFS).toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body.reason).toContain('cached: query too long');
  });

  it('GET /validate reports the fetch failure to the caller but does not persist it', async () => {
    setJob();
    const res = await request(buildApp(fakeIpfs({ [EVAL_CID]: gateway429() }))).get(`/jobs/${JOBID}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.issues.map((i) => i.type)).toContain('CID_INACCESSIBLE');
    expect(storedValidation()).toBeUndefined();
  });
});

// ---- class-registry errors stay informational -----------------------------------

describe('class-registry errors do not gate submissions', () => {
  it('MODEL_UNAVAILABLE (a jury model the registry does not list for the class)', async () => {
    setJob();
    const jury = [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'a-model-dropped-from-the-class', NO_COUNTS: 1, WEIGHT: 1 }];
    const res = await prepare(buildApp(fakeIpfs({ [EVAL_CID]: evaluationPackage({ jury }), [RUBRIC_CID]: GOOD_RUBRIC })));
    expect(res.status).toBe(200);
    expect(storedValidation().issues.some((i) => i.type === 'MODEL_UNAVAILABLE' && i.severity === 'error')).toBe(true);
  });

  it('INVALID_CLASS (a class the registry lists as not ACTIVE)', async () => {
    setJob();
    mockGetClass = () => ({ status: 'DEPRECATED', models: [] });
    const res = await prepare(buildApp(fakeIpfs({ [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: GOOD_RUBRIC })));
    expect(res.status).toBe(200);
    expect(storedValidation().issues.some((i) => i.type === 'INVALID_CLASS' && i.severity === 'error')).toBe(true);
  });
});

// ---- caching and fail-open ------------------------------------------------------

describe('caching and fail-open', () => {
  it('reuses a fresh cached verdict instead of fetching again', async () => {
    setJob({
      validationStatus: {
        valid: false,
        issues: [{ type: 'INVALID_PRIMARY_QUERY', severity: 'error', message: 'cached error' }],
        checkedAt: new Date().toISOString(),
      },
    });
    const ipfs = fakeIpfs({});
    const res = await prepare(buildApp(ipfs));
    expect(res.status).toBe(409);
    expect(res.body.reason).toContain('cached error');
    expect(ipfs.fetchFromIPFS).not.toHaveBeenCalled();
  });

  it('ignores a cached verdict that only holds informational errors', async () => {
    setJob({
      validationStatus: {
        valid: false,
        issues: [{ type: 'MODEL_UNAVAILABLE', severity: 'error', message: 'registry says no' }],
        checkedAt: new Date().toISOString(),
      },
    });
    const res = await prepare(buildApp(fakeIpfs({})));
    expect(res.status).toBe(200);
  });

  it('does not block when no IPFS client is configured', async () => {
    setJob();
    const res = await prepare(buildApp(null));
    expect(res.status).toBe(200);
    expect(res.headers['x-verdikta-validation']).toBe('unchecked');
  });
});
