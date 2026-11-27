/**
 * Review 2026-11-26 #19 (accepted limitation, hunters check a bounty's terms): the server refuses
 * hunter work on a bounty whose jury the aggregator's live limits refuse (lens juryProblem),
 * with 409 JURY_NOT_RUNNABLE, at prepare, start and the upload entry points; a failed chain read
 * does not refuse. Fixtures as in bountyUnevaluable.test.js.
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
let mockJuryProblem = jest.fn();
jest.mock('../utils/contractService', () => ({
  getContractService: () => ({
    getBounty: (...args) => mockGetBounty(...args),
    getJuryProblem: (...args) => mockJuryProblem(...args),
  }),
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
process.env.VERDIKTA_TMP_DIR = path.join(os.tmpdir(), 'verdikta-jury-gate-test');
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

beforeEach(() => {
  mockStorageData = { jobs: [], nextId: 0 };
  mockGetBounty = jest.fn().mockResolvedValue({ status: 'OPEN' });
  mockJuryProblem = jest.fn().mockResolvedValue('');
  serveHunterArchive();
});
afterAll(() => { global.fetch = realFetch; });

const GOOD = () => fakeIpfs({ [EVAL_CID]: evaluationPackage(), [RUBRIC_CID]: GOOD_RUBRIC });

describe('a jury the aggregator refuses (409 JURY_NOT_RUNNABLE)', () => {
  it('refuses /submit/prepare with the reason, before any other work', async () => {
    setJob();
    mockJuryProblem = jest.fn().mockResolvedValue('timeout at or below tPlus');
    const ipfs = GOOD();
    const res = await prepare(buildApp(ipfs));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.JURY_NOT_RUNNABLE);
    expect(res.body.juryProblem).toBe('timeout at or below tPlus');
    expect(mockJuryProblem).toHaveBeenCalledWith(JOBID);
    expect(ipfs.fetchFromIPFS).not.toHaveBeenCalled();              // no package validation either
  });

  it('refuses the start calldata', async () => {
    setJob();
    mockJuryProblem = jest.fn().mockResolvedValue('K above maxJury');
    const res = await request(buildApp(GOOD())).post(`/jobs/${JOBID}/submissions/0/start`).send({ hunter: HUNTER });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.JURY_NOT_RUNNABLE);
  });

  it('refuses an upload (/submit) before pinning anything', async () => {
    setJob();
    mockJuryProblem = jest.fn().mockResolvedValue('K above maxJury');
    const res = await request(buildApp(GOOD())).post(`/jobs/${JOBID}/submit`)
      .field('hunter', HUNTER).attach('files', Buffer.from('work'), 'work.txt');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCodes.JURY_NOT_RUNNABLE);
  });

  it('a runnable jury, or a chain read that fails, does not refuse', async () => {
    setJob();
    let res = await prepare(buildApp(GOOD()));
    expect(res.body.code).not.toBe(ErrorCodes.JURY_NOT_RUNNABLE);
    mockJuryProblem = jest.fn().mockRejectedValue(new Error('RPC down'));
    res = await prepare(buildApp(GOOD()));
    expect(res.body.code).not.toBe(ErrorCodes.JURY_NOT_RUNNABLE);
  });

  it('GET /:jobId/validate names it as an ERROR issue', async () => {
    setJob();
    mockJuryProblem = jest.fn().mockResolvedValue('timeout above maxTimeout');
    const res = await request(buildApp(GOOD())).get(`/jobs/${JOBID}/validate`);
    const issue = (res.body.issues || res.body.validation?.issues || []).find((i) => i.type === 'JURY_NOT_RUNNABLE');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('error');
    expect(issue.message).toMatch(/timeout above maxTimeout/);
  });
});
