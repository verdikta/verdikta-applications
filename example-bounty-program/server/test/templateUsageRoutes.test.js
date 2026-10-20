/**
 * POST /jobs/create stores which template the rubric came from (job.rubricTemplate),
 * and GET /jobs/admin/template-usage reports how often each template is used.
 */
jest.mock('../config',()=>({config:{network:'base-sepolia',chainId:84532,bountyEscrowAddress:'0x'+'11'.repeat(20),submissionDefaults:{maxOracleFeeWei:'20000000000000',alpha:500,estimatedBaseCostWei:'10000000000000',maxFeeBasedScaling:3}}}));
jest.mock('../utils/verdiktaService',()=>({isVerdiktaServiceAvailable:()=>false}));
jest.mock('../utils/contractService',()=>({getContractService:()=>({provider:{},contract:{}})}));
jest.mock('../utils/jobStorage',()=>({
  readStorage:jest.fn(async()=>({jobs:[]})),
  createJob:jest.fn(async data=>({...data,jobId:0})),
  updateJob:jest.fn(async (_id,updates)=>updates),
  listJobs:jest.fn(async()=>[]),
}));
jest.mock('../utils/archiveGenerator',()=>({...jest.requireActual('../utils/archiveGenerator'),createPrimaryCIDArchive:jest.fn(async()=>({archivePath:'/tmp/verdikta-mocked-archive-does-not-exist.zip'}))}));
jest.mock('@verdikta/common',()=>({...jest.requireActual('@verdikta/common'),classMap:{getClass:()=>({status:'ACTIVE',models:[{provider:'openai',model:'test-model'}]})}}));

const express=require('express');
const request=require('supertest');
const storage=require('../utils/jobStorage');

const app=express();app.use(express.json());app.use('/jobs',require('../routes/jobRoutes'));
const cid='Qm'+'a'.repeat(44);
app.locals.ipfsClient={uploadToIPFS:async()=>cid,fetchFromIPFS:async()=>Buffer.from(JSON.stringify({criteria:rubric().criteria,forbiddenContent:rubric().forbiddenContent}))};

// general-v1 as the create page pins it.
function rubric(){return{title:'General Work Submission',criteria:[
  {id:'prohibited',label:'Prohibited Content',must:true,weight:0,description:'Reject if contains NSFW, hate speech, or copyright violations.'},
  {id:'requirements',label:'Meets Requirements',must:false,weight:0.35,description:'Fulfills all stated requirements and specifications.'},
  {id:'quality',label:'Overall Quality',must:false,weight:0.35,description:'Professional quality, attention to detail, well-executed.'},
  {id:'completeness',label:'Completeness',must:false,weight:0.3,description:'Complete submission, nothing missing, ready to use.'}],
  forbiddenContent:['NSFW content','Hate speech','Copyright violations']};}
const body={title:'test',description:'test',creator:'0x'+'11'.repeat(20),bountyAmount:0.001,threshold:80,rubricCid:cid,juryNodes:[{provider:'openai',model:'test-model',weight:1,runs:1}]};

beforeEach(()=>jest.clearAllMocks());

describe('POST /jobs/create records the rubric template', () => {
  test('a website create from a template', async () => {
    const res=await request(app).post('/jobs/create').send({...body,rubricSource:{source:'template',templateKey:'general'}});
    expect(res.status).toBe(200);
    expect(storage.createJob.mock.calls[0][0].rubricTemplate).toEqual({key:'general',version:'general-v1',match:'exact',
      fingerprint:expect.stringMatching(/^[0-9a-f]{16}$/),source:'template',inferred:false});
  });

  test('an API create with no hint is still classified from its rubric', async () => {
    const res=await request(app).post('/jobs/create').send(body);
    expect(res.status).toBe(200);
    expect(storage.createJob.mock.calls[0][0].rubricTemplate).toMatchObject({key:'general',match:'exact',source:'api'});
  });

});

describe('GET /jobs/admin/template-usage', () => {
  test('reports usage, inferring jobs created before tracking', async () => {
    storage.readStorage.mockResolvedValueOnce({jobs:[
      {jobId:1,createdAt:1000,status:'AWARDED',onChain:true,rubricContent:rubric()},
      {jobId:2,createdAt:2000,status:'OPEN',onChain:true,rubricTemplate:{key:'mutualWager',version:'mutual-wager-v3',match:'exact',source:'template',inferred:false}},
    ]});
    const res=await request(app).get('/jobs/admin/template-usage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({success:true,network:'base-sepolia',since:null,totals:{created:2,onChain:2,awarded:1}});
    expect(res.body.templates.find(t=>t.key==='general')).toMatchObject({created:1,awarded:1,inferred:1});
    expect(res.body.templates.find(t=>t.key==='mutualWager')).toMatchObject({created:1,versions:{'mutual-wager-v3':1},sources:{template:1}});
  });

  test('takes since as unix seconds or ISO-8601 and refuses anything else', async () => {
    storage.readStorage.mockResolvedValue({jobs:[{jobId:1,createdAt:1000,rubricContent:rubric()},{jobId:2,createdAt:1792627200,rubricContent:rubric()}]});
    expect((await request(app).get('/jobs/admin/template-usage?since=1792627200')).body.totals.created).toBe(1);
    const iso=await request(app).get('/jobs/admin/template-usage?since=2026-10-22T00:00:00Z');
    expect(iso.body).toMatchObject({since:'2026-10-22T00:00:00.000Z',totals:{created:1}});
    const bad=await request(app).get('/jobs/admin/template-usage?since=last-week');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Invalid since');
    storage.readStorage.mockReset();
    storage.readStorage.mockImplementation(async()=>({jobs:[]}));
  });
});
