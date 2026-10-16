/**
 * Permissionless classes: a class outside the @verdikta/common registry is
 * allowed (with warnings); refusals are limited to a jury the registry rules out
 * for a listed class, and to a class no arbiter could serve (zero eligible
 * arbiters on-chain, which makes every evaluation start revert).
 */

jest.mock('../config', () => ({
  config: {
    network: 'base-sepolia',
    chainId: 84532,
    bountyEscrowAddress: '0x' + '11'.repeat(20),
    submissionDefaults: { maxOracleFeeWei: '20000000000000', alpha: 500, estimatedBaseCostWei: '10000000000000', maxFeeBasedScaling: 3 }
  }
}));

// Class 128 is listed and ACTIVE; 129 is listed but EMPTY; 132 is listed with real
// registry ids the model-id format heuristic would reject; everything else is unlisted.
jest.mock('@verdikta/common', () => ({
  ...jest.requireActual('@verdikta/common'),
  classMap: {
    getMapVersion: () => 'test-1',
    listClasses: () => [{ id: 128, status: 'ACTIVE', name: 'Core' }],
    getClass: (id) => {
      if (Number(id) === 128) return { id: 128, name: 'Core', status: 'ACTIVE', models: [{ provider: 'openai', model: 'gpt-5.2-2025-12-11' }] };
      if (Number(id) === 129) return { id: 129, name: 'Empty', status: 'EMPTY', models: [] };
      if (Number(id) === 132) return { id: 132, name: 'Mixed', status: 'ACTIVE', models: [
        { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' },
        { provider: 'hyperbolic', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' },
        { provider: 'ollama', model: 'qwen3.5:9b' }
      ] };
      return null;
    }
  }
}));

const mockEligibility = jest.fn();
let mockServiceAvailable = true;
jest.mock('../utils/verdiktaService', () => ({
  isVerdiktaServiceAvailable: () => mockServiceAvailable,
  getVerdiktaService: () => ({
    getClassOracleEligibility: mockEligibility,
    getAggregatorConfig: async () => ({ maxOracleFee: '0.0004' })
  })
}));
jest.mock('../utils/contractService', () => ({ getContractService: () => ({ provider: {}, contract: {} }) }));
jest.mock('../utils/jobStorage', () => ({
  readStorage: jest.fn(async () => ({ jobs: [] })),
  createJob: jest.fn(async data => ({ ...data, jobId: 0 })),
  listJobs: jest.fn(async () => []),
  getJob: jest.fn()
}));
jest.mock('../utils/archiveGenerator', () => ({
  ...jest.requireActual('../utils/archiveGenerator'),
  createPrimaryCIDArchive: jest.fn(async () => ({ archivePath: '/tmp/verdikta-mocked-archive-does-not-exist.zip' }))
}));

const express = require('express');
const request = require('supertest');
const storage = require('../utils/jobStorage');
const { checkJuryAgainstClass, checkClassCoverage } = require('../utils/classPolicy');
const { validateJuryNodes } = require('../utils/validation');

const app = express();
app.use(express.json());
app.use('/jobs', require('../routes/jobRoutes'));
app.use(require('../routes/classRoutes'));
const cid = 'Qm' + 'a'.repeat(44);
const upload = jest.fn(async () => cid);
app.locals.ipfsClient = { uploadToIPFS: upload, fetchFromIPFS: async () => Buffer.from('{}') };

const CREATOR = '0x' + '11'.repeat(20);
const OPERATOR_OWNER = '0x' + '22'.repeat(20);
const body = (extra = {}) => ({
  title: 't', description: 'd', creator: CREATOR, bountyAmount: 0.001, threshold: 80, rubricCid: cid,
  classId: 717,
  juryNodes: [{ provider: 'MyToolCo', model: 'Vision_Tool-V2', weight: 1, runs: 1 }],
  ...extra
});

// A getClassOracleEligibility result with `eligible` arbiters owned by `owners`.
const pool = ({ eligible = 10, total = eligible, active = total, pricedOut = 0, owners = [OPERATOR_OWNER], toPoll = 6 } = {}) => ({
  available: true,
  classId: 717,
  oracleSettings: { maxOracleFeeEth: '0.00002' },
  totalInClass: total,
  activeInClass: active,
  eligibleCount: eligible,
  pricedOutCount: pricedOut,
  distinctOwnersEligible: eligible ? new Set(owners).size : 0,
  dominantOwner: eligible ? owners[0] : null,
  dominantOwnerCount: eligible,
  oraclesToPoll: toPoll,
  eligibleArbiters: Array.from({ length: eligible }, (_, i) => ({ oracle: `0x${String(i).padStart(40, '0')}`, owner: owners[i % owners.length] })),
  warnings: [],
  checkedAt: '2026-10-06T00:00:00.000Z'
});

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceAvailable = true;
  mockEligibility.mockResolvedValue(pool());
});

describe('checkJuryAgainstClass()', () => {
  it('verifies a listed ACTIVE class against its model list', () => {
    const ok = checkJuryAgainstClass([{ provider: 'OpenAI', model: 'gpt-5.2-2025-12-11' }], 128);
    expect(ok).toMatchObject({ listed: true, juryModelsVerified: true, errors: [] });
    const bad = checkJuryAgainstClass([{ provider: 'openai', model: 'gpt-4o' }], 128);
    expect(bad.errors).toEqual(['Jury model openai/gpt-4o is not available in class 128']);
    expect(bad.allowedModels).toEqual(['openai/gpt-5.2-2025-12-11']);
  });

  it('keeps refusing a listed class that is not ACTIVE', () => {
    expect(checkJuryAgainstClass([{ provider: 'openai', model: 'x' }], 129).errors[0]).toMatch(/not ACTIVE/);
  });

  it('allows an unlisted class with a warning instead of an error', () => {
    const r = checkJuryAgainstClass([{ provider: 'MyToolCo', model: 'anything' }], 717);
    expect(r).toMatchObject({ listed: false, juryModelsVerified: false, errors: [] });
    expect(r.warnings[0]).toMatch(/Class 717 is not in the Verdikta class registry \(@verdikta\/common class map test-1\)\. That is allowed/);
  });

  it('fails open when the registry cannot be read', () => {
    const r = checkJuryAgainstClass([{ provider: 'openai', model: 'x' }], 128, null);
    expect(r).toMatchObject({ listed: null, errors: [] });
    expect(r.warnings[0]).toMatch(/Could not read the class registry/);
  });
});

describe('validateJuryNodes() model-format mode', () => {
  const nodes = [{ provider: 'MyToolCo', model: 'Vision_Tool', weight: 1, runs: 1 }];
  it('errors by default (registry classes)', () => {
    expect(validateJuryNodes(nodes)).toMatchObject({ valid: false, warnings: [] });
  });
  it('only warns for classes outside the registry', () => {
    const r = validateJuryNodes(nodes, { modelFormat: 'warn' });
    expect(r.valid).toBe(true);
    expect(r.warnings[0]).toMatch(/Vision_Tool/);
  });
  it('still enforces structure (runs, weights) in warn mode', () => {
    expect(validateJuryNodes([{ ...nodes[0], runs: 0 }], { modelFormat: 'warn' }).valid).toBe(false);
  });
});

describe('registry model ids skip the format heuristic', () => {
  const registryIds = [
    ['openrouter', 'deepseek/deepseek-v4-pro-0813'],
    ['hyperbolic', 'Qwen/Qwen3-Coder-480B-A35B-Instruct'],
    ['ollama', 'qwen3.5:9b'],
  ];
  const jury = (provider, model) => [{ provider, model, weight: 1, runs: 1 }];

  it.each(registryIds)('/jobs/create accepts registry id %s/%s', async (provider, model) => {
    const res = await request(app).post('/jobs/create').send(body({ classId: 132, juryNodes: jury(provider, model) }));
    expect(res.status).toBe(200);
    expect(res.body.classPolicy).toMatchObject({ listed: true, juryModelsVerified: true, warnings: expect.not.arrayContaining([expect.stringMatching(/outside \[a-z0-9.-\]/)]) });
  });

  it.each(registryIds)('/rubric/validate accepts registry id %s/%s', async (provider, model) => {
    const rubricJson = { title: 'r', criteria: [{ id: 'quality', label: 'Quality', must: false, weight: 1, description: 'Overall quality' }] };
    const res = await request(app).post('/jobs/rubric/validate').send({ rubricJson, classId: 132, juryNodes: jury(provider, model) });
    expect(res.body).toMatchObject({ valid: true, errors: [] });
  });

  it('matches the provider case-insensitively, the model exactly', async () => {
    const ok = await request(app).post('/jobs/create').send(body({ classId: 132, juryNodes: jury('OpenRouter', 'deepseek/deepseek-v4-pro-0813') }));
    expect(ok.status).toBe(200);
    const wrongCase = await request(app).post('/jobs/create').send(body({ classId: 132, juryNodes: jury('ollama', 'Qwen3.5:9b') }));
    expect(wrongCase.status).toBe(400);
    expect(wrongCase.body.errors.join(' ')).toMatch(/Qwen3\.5:9b.*outside \[a-z0-9.-\]/);
  });

  it('does not exempt a registry id under the wrong provider', async () => {
    const res = await request(app).post('/jobs/create').send(body({ classId: 132, juryNodes: jury('openai', 'deepseek/deepseek-v4-pro-0813') }));
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/outside \[a-z0-9.-\]/);
  });
});

describe('checkClassCoverage()', () => {
  const settings = { maxOracleFee: '20000000000000', alpha: 500, estimatedBaseCost: '10000000000000', maxFeeBasedScaling: 3 };

  it('refuses when no arbiter is registered for the class', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 0 }));
    const r = await checkClassCoverage(9999, settings);
    expect(r.refusal).toMatch(/No arbiters are registered for class 9999/);
    expect(r.coverage).toMatchObject({ checked: true, eligibleCount: 0 });
  });

  it('refuses with a fee fix when every active arbiter is priced out', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 4, active: 4, pricedOut: 4 }));
    expect((await checkClassCoverage(717, settings)).refusal).toMatch(/charge more than this bounty's max oracle fee.*Raise oracleMaxOracleFee/);
  });

  it('refuses when registered arbiters are inactive or blocked', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 3, active: 0 }));
    expect((await checkClassCoverage(717, settings)).refusal).toMatch(/None of the 3 arbiter\(s\) registered for class 717 is currently active/);
  });

  it('warns on thin coverage, a single operator, and creator-operated arbiters', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 3, owners: [CREATOR] }));
    const r = await checkClassCoverage(717, settings, { creator: CREATOR.toUpperCase().replace('0X', '0x') });
    expect(r.refusal).toBeNull();
    expect(r.coverage).toMatchObject({ eligibleCount: 3, distinctOwnersEligible: 1, creatorOperatedCount: 3 });
    expect(r.warnings.join('\n')).toMatch(/Only 3 eligible arbiter/);
    expect(r.warnings.join('\n')).toMatch(/belong to one operator/);
    expect(r.warnings.join('\n')).toMatch(/creator's address operates 3 of the 3/);
  });

  it('has no coverage warnings for a healthy multi-operator class', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 8, owners: [OPERATOR_OWNER, '0x' + '33'.repeat(20)] }));
    expect((await checkClassCoverage(717, settings, { creator: CREATOR })).warnings).toEqual([]);
  });

  it('fails open when the chain cannot be read', async () => {
    mockEligibility.mockRejectedValue(new Error('rpc down'));
    const r = await checkClassCoverage(717, settings);
    expect(r).toMatchObject({ refusal: null, coverage: { checked: false, reason: 'rpc down' } });
    expect(r.warnings[0]).toMatch(/Could not check arbiter coverage for class 717 right now \(rpc down\)/);
  });

  it('reports unchecked (no refusal) when the Verdikta service is not configured', async () => {
    mockServiceAvailable = false;
    expect(await checkClassCoverage(717, settings)).toMatchObject({ refusal: null, coverage: { checked: false } });
  });
});

describe('POST /jobs/create', () => {
  it('creates a bounty for an unlisted class with arbiters, returning warnings and coverage', async () => {
    const res = await request(app).post('/jobs/create').send(body());
    expect(res.status).toBe(200);
    expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({ classId: 717 }));
    const { classPolicy } = res.body;
    expect(classPolicy).toMatchObject({ classId: 717, listed: false, juryModelsVerified: false, coverage: { checked: true, eligibleCount: 10 } });
    const warnings = classPolicy.warnings.join('\n');
    expect(warnings).toMatch(/Vision_Tool-V2/);                       // format heuristic only warns
    expect(warnings).toMatch(/not in the Verdikta class registry/);
    expect(warnings).toMatch(/belong to one operator/);
    // the encoded createBounty carries the unlisted class
    const { Interface } = require('ethers');
    const abi = require('../../../skills/verdikta-bounties-onboarding/scripts/bounty-escrow.abi.json');
    expect(new Interface(abi).decodeFunctionData('createBounty', res.body.onChain.transaction.data)[0].requestedClass).toBe(717n);
  });

  it('refuses a class no arbiter can serve, before pinning or storing anything', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 0 }));
    const res = await request(app).post('/jobs/create').send(body({ classId: 4242 }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'CLASS_UNSERVABLE', classId: 4242, coverage: { eligibleCount: 0 } });
    expect(storage.createJob).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('applies the same chain rule to listed classes', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 0 }));
    const res = await request(app).post('/jobs/create').send(body({ classId: 128, juryNodes: [{ provider: 'openai', model: 'gpt-5.2-2025-12-11', weight: 1, runs: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLASS_UNSERVABLE');
  });

  it('still refuses a model the registry rules out for a listed class', async () => {
    const res = await request(app).post('/jobs/create').send(body({ classId: 128, juryNodes: [{ provider: 'openai', model: 'gpt-4o', weight: 1, runs: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid jury configuration', invalidNodes: [{ provider: 'openai', model: 'gpt-4o' }] });
    expect(mockEligibility).not.toHaveBeenCalled();
  });

  it('still applies the model-format rule as an error for listed classes', async () => {
    const res = await request(app).post('/jobs/create').send(body({ classId: 128, juryNodes: [{ provider: 'openai', model: 'GPT_5', weight: 1, runs: 1 }] }));
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/GPT_5/);
  });

  it('proceeds with a warning when coverage cannot be read', async () => {
    mockEligibility.mockRejectedValue(new Error('rpc down'));
    const res = await request(app).post('/jobs/create').send(body());
    expect(res.status).toBe(200);
    expect(res.body.classPolicy.coverage).toMatchObject({ checked: false });
    expect(res.body.classPolicy.warnings.join('\n')).toMatch(/Could not check arbiter coverage/);
  });

  it.each(['abc', -1, 1.5])('rejects classId %p', async classId => {
    const res = await request(app).post('/jobs/create').send(body({ classId }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid classId');
  });
});

describe('POST /jobs/rubric/validate', () => {
  const rubricJson = { title: 'r', criteria: [{ id: 'quality', label: 'Quality', must: false, weight: 1, description: 'Overall quality' }] };

  it('passes an unlisted class with arbiters, with warnings and coverage', async () => {
    const res = await request(app).post('/jobs/rubric/validate').send({ rubricJson, classId: 717, juryNodes: body().juryNodes });
    expect(res.body.valid).toBe(true);
    expect(res.body.classListed).toBe(false);
    expect(res.body.coverage).toMatchObject({ checked: true, eligibleCount: 10 });
    expect(res.body.warnings.join('\n')).toMatch(/not in the Verdikta class registry/);
  });

  it('reports a class no arbiter can serve as an error, matching create', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 0 }));
    const res = await request(app).post('/jobs/rubric/validate').send({ rubricJson, classId: 4242, juryNodes: body().juryNodes });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join('\n')).toMatch(/No arbiters are registered for class 4242/);
  });

  it('blames the caller only for oracle fields they sent', async () => {
    const res = await request(app).post('/jobs/rubric/validate').send({ rubricJson, classId: 717, juryNodes: body().juryNodes, oracleMaxOracleFee: 'lots' });
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.join('\n')).toMatch(/Invalid oracle settings/);
  });
});

describe('class endpoints', () => {
  it('answers an unlisted class with status UNLISTED, not 404', async () => {
    const info = await request(app).get('/api/classes/717');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ success: true, listed: false, class: { id: 717, status: 'UNLISTED', models: [] } });
    const models = await request(app).get('/api/classes/717/models');
    expect(models.status).toBe(200);
    expect(models.body).toMatchObject({ success: true, listed: false, status: 'UNLISTED', models: [], modelsByProvider: {} });
  });

  it('marks registry classes as listed', async () => {
    expect((await request(app).get('/api/classes/128')).body.listed).toBe(true);
    expect((await request(app).get('/api/classes/128/models')).body).toMatchObject({ listed: true, status: 'ACTIVE' });
  });

  it('reports live coverage for any class', async () => {
    const res = await request(app).get('/api/classes/717/coverage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ classId: 717, listed: false, className: 'Custom class 717', servable: true, coverage: { eligibleCount: 10 } });
    expect(mockEligibility).toHaveBeenCalledWith(717, expect.objectContaining({ maxOracleFee: '20000000000000' }));
  });

  it('honours ?maxOracleFee and reports an unservable class', async () => {
    mockEligibility.mockResolvedValue(pool({ eligible: 0, total: 0 }));
    const res = await request(app).get('/api/classes/4242/coverage?maxOracleFee=0.0001');
    expect(res.body).toMatchObject({ servable: false });
    expect(res.body.refusal).toMatch(/No arbiters are registered/);
    expect(mockEligibility).toHaveBeenCalledWith(4242, expect.objectContaining({ maxOracleFee: '100000000000000' }));
  });

  it('returns servable:null when coverage cannot be checked', async () => {
    mockServiceAvailable = false;
    expect((await request(app).get('/api/classes/717/coverage')).body.servable).toBeNull();
  });

  it('validates its inputs', async () => {
    expect((await request(app).get('/api/classes/-1/coverage')).status).toBe(400);
    expect((await request(app).get('/api/classes/717/coverage?maxOracleFee=abc')).status).toBe(400);
    expect((await request(app).get('/api/classes/717/coverage?maxOracleFee=0')).status).toBe(400);
  });
});

describe('evaluation-package validation (Validate button, POST /jobs/validate)', () => {
  const AdmZip = require('adm-zip');
  const { validateBounty, IssueType, IssueSeverity } = require('../utils/bountyValidator');
  const { classMap } = require('@verdikta/common');
  const packageWith = (nodes) => {
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ version: '1.0', primary: { filename: 'primary_query.json' }, juryParameters: { AI_NODES: nodes } })));
    zip.addFile('primary_query.json', Buffer.from(JSON.stringify({ query: 'q', references: [], outcomes: ['DONT_FUND', 'FUND'] })));
    return zip.toBuffer();
  };
  const run = (classId, nodes) => validateBounty({
    evaluationCid: cid, classId, classMap,
    ipfsClient: { fetchFromIPFS: async () => packageWith(nodes) }
  });
  const classIssues = (r) => r.issues.filter(i => [IssueType.UNLISTED_CLASS, IssueType.INVALID_CLASS, IssueType.MODEL_UNAVAILABLE].includes(i.type));

  it('flags an unlisted class as a warning, not an error', async () => {
    const r = await run(717, [{ AI_PROVIDER: 'MyToolCo', AI_MODEL: 'vision-tool', WEIGHT: 1, NO_COUNTS: 1 }]);
    expect(classIssues(r)).toEqual([expect.objectContaining({ type: IssueType.UNLISTED_CLASS, severity: IssueSeverity.WARNING })]);
  });

  it('still errors on a model the registry rules out for a listed class', async () => {
    const r = await run(128, [{ AI_PROVIDER: 'OpenAI', AI_MODEL: 'gpt-4o', WEIGHT: 1, NO_COUNTS: 1 }]);
    expect(classIssues(r)).toEqual([expect.objectContaining({ type: IssueType.MODEL_UNAVAILABLE, severity: IssueSeverity.ERROR })]);
  });
});
