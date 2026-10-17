jest.mock('../config',()=>({config:{network:'base-sepolia',chainId:84532,bountyEscrowAddress:'0x'+'11'.repeat(20),submissionDefaults:{maxOracleFeeWei:'20000000000000',alpha:500,estimatedBaseCostWei:'10000000000000',maxFeeBasedScaling:3}}}));
jest.mock('../utils/verdiktaService',()=>({isVerdiktaServiceAvailable:()=>false}));
jest.mock('../utils/contractService',()=>({getContractService:()=>({provider:{},contract:{}})}));
jest.mock('../utils/jobStorage',()=>({readStorage:jest.fn(async()=>({jobs:[]})),createJob:jest.fn(async data=>({...data,jobId:0})),listJobs:jest.fn(async()=>[])}));
jest.mock('../utils/archiveGenerator',()=>({...jest.requireActual('../utils/archiveGenerator'),createPrimaryCIDArchive:jest.fn(async()=>({archivePath:'/tmp/verdikta-mocked-archive-does-not-exist.zip'}))}));
jest.mock('@verdikta/common',()=>({...jest.requireActual('@verdikta/common'),classMap:{getClass:()=>({status:'ACTIVE',models:[{provider:'openai',model:'test-model'}]})}}));
const express=require('express'),request=require('supertest');
const storage=require('../utils/jobStorage'),archive=require('../utils/archiveGenerator');
const {applyChainBountyFields}=require('../utils/syncService');
const app=express();app.use(express.json());app.use('/jobs',require('../routes/jobRoutes'));
const cid='Qm'+'a'.repeat(44),upload=jest.fn(async()=>cid);
app.locals.ipfsClient={uploadToIPFS:upload,fetchFromIPFS:async()=>Buffer.from('{}')};
const body={title:'test',description:'test',creator:'0x'+'11'.repeat(20),bountyAmount:0.001,threshold:85,rubricCid:cid,juryNodes:[{provider:'openai',model:'test-model',weight:1,runs:1}]};
beforeEach(()=>jest.clearAllMocks());
test('legacy numeric no-mode creation returns exact decimal amount and encoded tx',async()=>{
 const res=await request(app).post('/jobs/create').send(body);
 expect(res.status).toBe(200);expect(res.body.onChain.transaction.data).toMatch(/^0x/);
 expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({bountyAmount:0.001,bountyAmountWei:'1000000000000000',targetHunter:null}));
});
test.each(['0x10','0','-1','NaN','Infinity','1e99999','1e-99999','0.0000000000000000001',{},true])('invalid amount %p rejects before pinning/storage',async bountyAmount=>{
 const res=await request(app).post('/jobs/create').send({...body,bountyAmount});
 expect(res.status).toBe(400);expect(storage.createJob).not.toHaveBeenCalled();expect(archive.createPrimaryCIDArchive).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
});
test('trimmed amounts normalize, including split payments',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,bountyAmount:' 0.01 ',creatorDeterminationPayment:' 0.005 ',arbiterDeterminationPayment:' 0.01',creatorAssessmentWindowHours:1});
 expect(res.status).toBe(200);expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({bountyAmount:0.01,bountyAmountWei:'10000000000000000',creatorDeterminationPayment:'0.005',arbiterDeterminationPayment:'0.01'}));
});
test.each(['creatorDeterminationPayment','arbiterDeterminationPayment'])('invalid %s rejects before pinning',async field=>{
 const res=await request(app).post('/jobs/create').send({...body,[field]:'0x10'});
 expect(res.status).toBe(400);expect(storage.createJob).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
});
test('OPEN zero stores null; TARGETED missing/non-prefixed target is rejected',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,procurementMode:'OPEN',targetHunter:'0x'+'0'.repeat(40)});
 expect(res.status).toBe(200);expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({targetHunter:null}));
 jest.clearAllMocks();
 for(const targetHunter of [undefined,'1'.repeat(40),'XE7338O073KYGTWWZN0F2WZ0R8PX5ZPPZS']) {
  const bad=await request(app).post('/jobs/create').send({...body,procurementMode:'TARGETED',targetHunter});
  expect(bad.status).toBe(400);
 }
 expect(storage.createJob).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
});
test('chain field sync retains numeric display and exact wei, preferring authoritative wei',()=>{
 const job={};const amount='0.123456789012345678';
 applyChainBountyFields(job,{bountyAmount:amount});expect(job.bountyAmount).toBe(Number(amount));expect(job.bountyAmountWei).toBe('123456789012345678');
 applyChainBountyFields(job,{bountyAmount:0.12345678901234568,bountyAmountWei:'123456789012345678'});
 expect(job.bountyAmountWei).toBe('123456789012345678');
});

test('UI approval-window payload funds the larger split payment',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,bountyAmount:0.001,creatorDeterminationPayment:0.002,arbiterDeterminationPayment:0.001,creatorAssessmentWindowHours:1,submissionWindowHours:24});
 expect(res.status).toBe(200);expect(res.body.onChain.transaction.value).toBe('2000000000000000');
 expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({bountyAmount:0.002,bountyAmountWei:'2000000000000000',creatorDeterminationPayment:'0.002',arbiterDeterminationPayment:'0.001',creatorAssessmentWindowSize:3600}));
});
test.each([1860,3900,7500])('exact integer-second assessment window %p survives API storage and encoding',async seconds=>{
 const res=await request(app).post('/jobs/create').send({...body,creatorDeterminationPayment:0.001,arbiterDeterminationPayment:0.001,creatorAssessmentWindowSeconds:seconds});
 expect(res.status).toBe(200);expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({creatorAssessmentWindowSize:seconds}));
 const {Interface}=require('ethers');
 const abi=require('../../../skills/verdikta-bounties-onboarding/scripts/bounty-escrow.abi.json');
 expect(new Interface(abi).decodeFunctionData('createBounty',res.body.onChain.transaction.data)[0].creatorAssessmentWindowSize).toBe(BigInt(seconds));
});
test('invalid window is labelled specifically before pinning',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,creatorDeterminationPayment:0.002,arbiterDeterminationPayment:0.001,creatorAssessmentWindowHours:1,submissionWindowHours:1});
 expect(res.status).toBe(400);expect(res.body.error).toBe('Invalid bounty window');expect(upload).not.toHaveBeenCalled();expect(storage.createJob).not.toHaveBeenCalled();
});
test('hours-only payload rejects incomplete approval-window terms before writes',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,creatorAssessmentWindowHours:1});
 expect(res.status).toBe(400);expect(storage.createJob).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
});

// Expected legacy values are explicit; no floating-point ETH conversion in expectations.
test.each([
 ['1e-3','1000000000000000'], ['5e-05','50000000000000'], ['+1','1000000000000000000'],
 ['1E-18','1'], ['1.23456789012345678e-1','123456789012345678'], ['0.123456789012345678','123456789012345678'],
 [1e-7,'100000000000'], [0.30000000000000004,'300000000000000040'], ['.001','1000000000000000'], ['1.','1000000000000000000']
])('amount %p retains numeric response and exact calldata',async (bountyAmount,wei)=>{
 const res=await request(app).post('/jobs/create').send({...body,bountyAmount});
 expect(res.status).toBe(200);expect(typeof res.body.job.bountyAmount).toBe('number');expect(res.body.job.bountyAmount).toBe(Number(bountyAmount));
 expect(res.body.job.bountyAmountWei).toBe(wei);expect(res.body.onChain.transaction.value).toBe(wei);
 const {Interface}=require('ethers'),abi=require('../../../skills/verdikta-bounties-onboarding/scripts/bounty-escrow.abi.json');
 const terms=new Interface(abi).decodeFunctionData('createBounty',res.body.onChain.transaction.data)[0];
 expect(terms.creatorDeterminationPayment).toBe(BigInt(wei));expect(terms.arbiterDeterminationPayment).toBe(BigInt(wei));
 expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({bountyAmount:Number(bountyAmount),bountyAmountWei:wei}));
});
test('scientific notation also preserves exact split payments',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,bountyAmount:'1e-3',creatorDeterminationPayment:'5e-5',arbiterDeterminationPayment:'1e-3',creatorAssessmentWindowHours:1});
 expect(res.status).toBe(200);expect(res.body.onChain.params.creatorDeterminationPayment).toBe('50000000000000');expect(res.body.onChain.transaction.value).toBe('1000000000000000');
});
test.each([1.1,2.2,4.1])('fractional submission hours %p use one rounded duration throughout',async hours=>{
 const res=await request(app).post('/jobs/create').send({...body,submissionWindowHours:hours});
 expect(res.status).toBe(200);expect(res.body.job.submissionCloseTime-res.body.job.submissionOpenTime).toBe(Math.round(hours*3600));
 expect(res.body.onChain.params.submissionDeadline).toBe(String(res.body.job.submissionCloseTime));
 expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({submissionWindowSeconds:Math.round(hours*3600),submissionCloseTime:res.body.job.submissionCloseTime}));
});
test.each([1860/3600,1.1,2.2,4.1])('fractional assessment hours %p round to the intended seconds',async hours=>{
 const res=await request(app).post('/jobs/create').send({...body,creatorDeterminationPayment:0.001,arbiterDeterminationPayment:0.001,creatorAssessmentWindowHours:hours});
 expect(res.status).toBe(200);expect(res.body.onChain.params.creatorAssessmentWindowSize).toBe(String(Math.round(hours*3600)));
 expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({creatorAssessmentWindowSize:Math.round(hours*3600)}));
});
test.each([
 {creatorDeterminationPayment:0.001}, {arbiterDeterminationPayment:0.001},
 {creatorDeterminationPayment:0.001,creatorAssessmentWindowHours:1},
 {arbiterDeterminationPayment:0.001,creatorAssessmentWindowSeconds:3600},
 {creatorAssessmentWindowSeconds:3600}, {creatorAssessmentWindowHours:1,creatorAssessmentWindowSeconds:0}
])('partial split/window settings %p fail before upload or storage',async settings=>{
 const res=await request(app).post('/jobs/create').send({...body,...settings});
 expect(res.status).toBe(400);expect(res.body.error).toBe('Invalid bounty window');expect(storage.createJob).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();expect(archive.createPrimaryCIDArchive).not.toHaveBeenCalled();
});
test('no-window payment mismatch deliberately fails instead of ignoring requested terms',async()=>{
 const res=await request(app).post('/jobs/create').send({...body,creatorDeterminationPayment:0.002,arbiterDeterminationPayment:0.002});
 expect(res.status).toBe(400);expect(res.body.error).toBe('Invalid bounty payment');expect(storage.createJob).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();
});
test('legacy invalid-input labels remain stable; explicit procurement has its own label',async()=>{
 for(const amount of [0,'0x10','bad']) {
  const res=await request(app).post('/jobs/create').send({...body,bountyAmount:amount});expect(res.body.error).toBe('Invalid bountyAmount');
 }
 const legacy=await request(app).post('/jobs/create').send({...body,targetHunter:'bad'});expect(legacy.body.error).toBe('Invalid targetHunter address');
 const explicit=await request(app).post('/jobs/create').send({...body,procurementMode:'TARGETED',targetHunter:'bad'});expect(explicit.body.error).toBe('Invalid procurement intent');
 expect(upload).not.toHaveBeenCalled();
});

test('list responses retain numeric amounts and expose exact wei for created jobs',async()=>{
 const created=await request(app).post('/jobs/create').send({...body,bountyAmount:'0.123456789012345678'});
 expect(created.status).toBe(200);
 storage.listJobs.mockResolvedValueOnce([{...storage.createJob.mock.calls[0][0],jobId:0,status:'OPEN'}]);
 const listed=await request(app).get('/jobs');expect(listed.status).toBe(200);
 expect(typeof listed.body.jobs[0].bountyAmount).toBe('number');expect(listed.body.jobs[0].bountyAmountWei).toBe('123456789012345678');
});
test('reusing a saved exact amount never encodes the rounded display number',async()=>{
 storage.readStorage.mockResolvedValueOnce({jobs:[{...body,jobId:7,status:'OPEN',evaluationCid:cid,classId:128,bountyAmount:0.12345678901234568,bountyAmountWei:'123456789012345678',submissionOpenTime:1000,submissionCloseTime:87400}]});
 const res=await request(app).post('/jobs/create').send(body);
 expect(res.status).toBe(200);expect(res.body.job.bountyAmountWei).toBe('123456789012345678');expect(res.body.onChain.transaction.value).toBe('123456789012345678');expect(storage.createJob).not.toHaveBeenCalled();
});
test.each([[0.24484899999999998,0.24],['12.345',12.35],[0,0],[-5,0],['abc',0],[undefined,0]])('bountyAmountUSD %p is stored as whole cents (%p)',async (bountyAmountUSD,stored)=>{
 const res=await request(app).post('/jobs/create').send({...body,bountyAmountUSD});
 expect(res.status).toBe(200);expect(storage.createJob).toHaveBeenCalledWith(expect.objectContaining({bountyAmountUSD:stored}));
});
