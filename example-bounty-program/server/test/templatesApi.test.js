/**
 * Templates for agents: GET /api/templates (public), POST /jobs/create with
 * rubricTemplate, the templateMatch on POST /jobs/rubric/validate, and the creating
 * client recorded on the job (hidden from anonymous reads).
 */
jest.mock('../config',()=>({config:{network:'base-sepolia',chainId:84532,bountyEscrowAddress:'0x'+'11'.repeat(20),publicReadRateLimitWindowMs:60000,publicReadRateLimitMax:50,submissionDefaults:{maxOracleFeeWei:'20000000000000',alpha:500,estimatedBaseCostWei:'10000000000000',maxFeeBasedScaling:3}}}));
jest.mock('../utils/verdiktaService',()=>({isVerdiktaServiceAvailable:()=>false}));
jest.mock('../utils/contractService',()=>({getContractService:()=>({provider:{},contract:{}})}));
jest.mock('../utils/jobStorage',()=>({
  readStorage:jest.fn(async()=>({jobs:[]})),
  createJob:jest.fn(async data=>({...data,jobId:0})),
  getJob:jest.fn(),
  updateJob:jest.fn(async (_id,updates)=>updates),
  listJobs:jest.fn(async()=>[]),
}));
jest.mock('../utils/archiveGenerator',()=>({...jest.requireActual('../utils/archiveGenerator'),createPrimaryCIDArchive:jest.fn(async()=>({archivePath:'/tmp/verdikta-mocked-archive-does-not-exist.zip'}))}));
jest.mock('@verdikta/common',()=>({...jest.requireActual('@verdikta/common'),classMap:{getClass:()=>({status:'ACTIVE',models:[{provider:'openai',model:'test-model'}]})}}));

process.env.FRONTEND_CLIENT_KEY = 'frontend-test-key';
delete process.env.FRONTEND_ALLOWED_ORIGINS;
process.env.IPFS_PINNING_KEY = 'test-pinning-key';

const express=require('express');
const request=require('supertest');
const storage=require('../utils/jobStorage');
const archiveGenerator=require('../utils/archiveGenerator');
const clientIdentification=require('../middleware/clientIdentification');
const { getTemplate } = require('../utils/rubricTemplates');
const templateData=require('../../shared/rubricTemplates.json');

const cid='Qm'+'a'.repeat(44);
const app=express();app.use(express.json());app.use(clientIdentification);
app.use('/api/templates',require('../routes/templateRoutes'));
app.use('/api/jobs',require('../routes/jobRoutes'));
app.locals.ipfsClient={uploadToIPFS:async()=>cid,fetchFromIPFS:async()=>Buffer.from('{}')};

const FRONTEND={'X-Client-Key':'frontend-test-key'};
const body={title:'Write about consensus',description:'A 1,000-word post on multi-model consensus for developers.',creator:'0x'+'11'.repeat(20),bountyAmount:0.001,juryNodes:[{provider:'openai',model:'test-model',weight:1,runs:1}]};
// The create route pins the rubric JSON with Pinata; stub the network call.
let pinned;
global.fetch=jest.fn(async(_url,opts)=>{pinned=JSON.parse(opts.body).pinataContent;const out=JSON.stringify({IpfsHash:'Qm'+'p'.repeat(44)});return{ok:true,status:200,text:async()=>out,json:async()=>JSON.parse(out)};});

beforeEach(()=>{jest.clearAllMocks();pinned=undefined;});

describe('GET /api/templates', () => {
  test('is public and lists the create page templates and the work-order templates', async () => {
    const res=await request(app).get('/api/templates');
    expect(res.status).toBe(200);
    const keys=res.body.templates.map(t=>t.key);
    expect(keys).toEqual(expect.arrayContaining([...Object.keys(templateData.templates),'source-check-v1','review-v1']));
    expect(res.body.templates.find(t=>t.key==='mutualWager')).toMatchObject({kind:'rubric',version:'mutual-wager-v3',recommendedThreshold:80,mustPass:7,detail:'/api/templates/mutualWager'});
    expect(res.body.templates.find(t=>t.key==='source-check-v1')).toMatchObject({kind:'service',docs:expect.stringContaining('verdikta-discover')});
    expect(res.body.usage.byKey).toMatch(/rubricTemplate/);
  });

  test('returns one template with a rubricJson /jobs/create accepts', async () => {
    const res=await request(app).get('/api/templates/general');
    expect(res.status).toBe(200);
    const t=res.body.template;
    expect(t).toMatchObject({key:'general',version:'general-v1',fingerprint:expect.stringMatching(/^[0-9a-f]{16}$/)});
    expect(t.rubricJson.criteria[0]).toEqual({id:'prohibited',label:'Prohibited Content',must:true,weight:0,description:templateData.templates.general.criteria[0].instructions});
    const valid=await request(app).post('/api/jobs/rubric/validate').set(FRONTEND).send({rubricJson:t.rubricJson});
    expect(valid.body).toMatchObject({valid:true,templateMatch:{key:'general',version:'general-v1',match:'exact'}});
  });

  test('explains an unknown key and points work-order keys at the discover skill', async () => {
    expect((await request(app).get('/api/templates/nope')).status).toBe(404);
    const svc=await request(app).get('/api/templates/source-check-v1');
    expect(svc.status).toBe(404);
    expect(svc.body.details).toMatch(/verdikta-discover/);
  });
});

describe('POST /jobs/create with rubricTemplate', () => {
  test('fills in the exact rubric, threshold and class, and records reference and the client', async () => {
    const res=await request(app).post('/api/jobs/create').set(FRONTEND).send({...body,rubricTemplate:'general'});
    expect(res.status).toBe(200);
    expect(pinned.criteria).toEqual(getTemplate('general').rubricJson.criteria);
    const stored=storage.createJob.mock.calls[0][0];
    expect(stored).toMatchObject({threshold:80,classId:128,createdByClientType:'frontend',createdByClientId:'official-frontend',
      rubricTemplate:{key:'general',version:'general-v1',match:'exact',source:'reference'}});
    expect(res.body.job.rubricTemplate).toEqual({key:'general',version:'general-v1',match:'exact',source:'reference'});
    expect(archiveGenerator.createPrimaryCIDArchive.mock.calls[0][0].rubricCriteria).toEqual(getTemplate('general').rubricJson.criteria);
  });

  test('keeps a threshold the caller sent', async () => {
    const res=await request(app).post('/api/jobs/create').set(FRONTEND).send({...body,rubricTemplate:'general',threshold:90});
    expect(res.status).toBe(200);
    expect(storage.createJob.mock.calls[0][0].threshold).toBe(90);
  });

  test.each([
    ['an unknown key', {rubricTemplate:'nope'}, 'UNKNOWN_TEMPLATE', /one of: blogPost/],
    ['a work-order template', {rubricTemplate:'review-v1'}, 'UNKNOWN_TEMPLATE', /verdikta-discover/],
    ['a key with a rubric too', {rubricTemplate:'general',rubricCid:cid}, 'RUBRIC_TEMPLATE_CONFLICT', /not more than one/],
    ['an old version', {rubricTemplate:'mutualWager',rubricTemplateVersion:'mutual-wager-v1'}, 'TEMPLATE_VERSION_CHANGED', /now mutual-wager-v3/],
  ])('refuses %s before anything is pinned', async (_label, extra, code, details) => {
    const res=await request(app).post('/api/jobs/create').set(FRONTEND).send({...body,...extra});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({code,details:expect.stringMatching(details)});
    expect(global.fetch).not.toHaveBeenCalled();
    expect(storage.createJob).not.toHaveBeenCalled();
  });

  test('accepts the current version when asked for it', async () => {
    const res=await request(app).post('/api/jobs/create').set(FRONTEND).send({...body,rubricTemplate:'general',rubricTemplateVersion:'general-v1'});
    expect(res.status).toBe(200);
  });
});

describe('POST /jobs/rubric/validate', () => {
  test('points a one-criterion rubric at the templates', async () => {
    const res=await request(app).post('/api/jobs/rubric/validate').set(FRONTEND)
      .send({rubricJson:{criteria:[{id:'quality',label:'Quality',must:false,weight:1,description:'Good work.'}]}});
    expect(res.body).toMatchObject({valid:true,templateMatch:{key:null,match:null}});
    expect(res.body.tips.join(' ')).toMatch(/GET \/api\/templates/);
  });
});

describe('GET /jobs/:id', () => {
  test('hides which client created a bounty from anonymous readers only', async () => {
    const job={jobId:5,title:'t',status:'OPEN',onChain:true,rubricCid:null,submissions:[],createdByClientType:'bot',createdByClientId:'bot-123'};
    storage.getJob.mockResolvedValue(job);
    const anon=await request(app).get('/api/jobs/5');
    expect(anon.status).toBe(200);
    expect(anon.body.job).not.toHaveProperty('createdByClientType');
    expect(anon.body.job).not.toHaveProperty('createdByClientId');
    const keyed=await request(app).get('/api/jobs/5').set(FRONTEND);
    expect(keyed.body.job).toMatchObject({createdByClientType:'bot',createdByClientId:'bot-123'});
  });
});
