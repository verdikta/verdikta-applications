/**
 * POST /jobs/create accepts an exact submissionDeadline (unix seconds or ISO-8601 with a
 * zone) as an alternative to submissionWindowHours. Mainnet #302 (2026-10-19): an agent
 * needed the deadline to match a date in its wager terms, worked the unix time out by
 * hand, and the bounty closed 22 hours early.
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
const {Interface}=require('ethers');
const storage=require('../utils/jobStorage');
const abi=require('../../../skills/verdikta-bounties-onboarding/scripts/bounty-escrow.abi.json');

const app=express();app.use(express.json());app.use('/jobs',require('../routes/jobRoutes'));
const cid='Qm'+'a'.repeat(44);
const upload=jest.fn(async()=>cid);
app.locals.ipfsClient={uploadToIPFS:upload,fetchFromIPFS:async()=>Buffer.from('{}')};
const body={title:'test',description:'test',creator:'0x'+'11'.repeat(20),bountyAmount:0.001,threshold:85,rubricCid:cid,juryNodes:[{provider:'openai',model:'test-model',weight:1,runs:1}]};

// Two days out, on the hour, so the ISO forms below name the same second.
const DEADLINE=Math.ceil(Date.now()/3600000)*3600+2*86400;
const DEADLINE_ISO=new Date(DEADLINE*1000).toISOString().replace('.000Z','Z');
const encodedDeadline=res=>new Interface(abi).decodeFunctionData('createBounty',res.body.onChain.transaction.data)[0].submissionDeadline;

beforeEach(()=>jest.clearAllMocks());

describe('POST /jobs/create with submissionDeadline', () => {
  test.each([
    ['unix seconds', DEADLINE],
    ['a digit string', String(DEADLINE)],
    ['ISO with Z', DEADLINE_ISO],
    ['ISO with an offset', new Date((DEADLINE+2*3600)*1000).toISOString().slice(0,19)+'+02:00'],
    ['ISO with zero milliseconds', new Date(DEADLINE*1000).toISOString()],
  ])('%s is stored, returned and encoded to the second', async (_label, submissionDeadline) => {
    const res=await request(app).post('/jobs/create').send({...body,submissionDeadline});
    expect(res.status).toBe(200);
    expect(res.body.job.submissionCloseTime).toBe(DEADLINE);
    expect(res.body.job.submissionCloseTimeIso).toBe(new Date(DEADLINE*1000).toISOString());
    expect(res.body.onChain.params.submissionDeadline).toBe(String(DEADLINE));
    expect(encodedDeadline(res)).toBe(BigInt(DEADLINE));
    const stored=storage.createJob.mock.calls[0][0];
    expect(stored).toMatchObject({submissionCloseTime:DEADLINE,plannedSubmissionCloseTime:DEADLINE,submissionDeadlineExact:true});
    expect(stored.submissionWindowSeconds).toBe(DEADLINE-stored.submissionOpenTime);
    expect(stored).not.toHaveProperty('submissionDeadline');
  });

  test('a window still works and records the planned deadline without the exact flag', async () => {
    const res=await request(app).post('/jobs/create').send({...body,submissionWindowHours:51});
    expect(res.status).toBe(200);
    const stored=storage.createJob.mock.calls[0][0];
    expect(stored.plannedSubmissionCloseTime).toBe(stored.submissionCloseTime);
    expect(stored.submissionCloseTime-stored.submissionOpenTime).toBe(51*3600);
    expect(stored).not.toHaveProperty('submissionDeadlineExact');
    expect(stored).not.toHaveProperty('submissionDeadline');
  });

  test.each([
    ['both fields', {submissionDeadline:DEADLINE,submissionWindowHours:24}, /not both/],
    ['a past deadline', {submissionDeadline:Math.floor(Date.now()/1000)-60}, /not in the future/],
    ['milliseconds', {submissionDeadline:DEADLINE*1000}, /looks like milliseconds/],
    ['a fractional second', {submissionDeadline:DEADLINE+0.5}, /whole unix seconds/],
    ['an ISO time with no zone', {submissionDeadline:DEADLINE_ISO.slice(0,19)}, /with a timezone/],
    ['an ISO time off a whole second', {submissionDeadline:new Date(DEADLINE*1000+250).toISOString()}, /whole second/],
    ['a date only', {submissionDeadline:DEADLINE_ISO.slice(0,10)}, /with a timezone/],
    ['an impossible date', {submissionDeadline:'2026-13-45T00:00:00Z'}, /with a timezone/],
    ['a non-date', {submissionDeadline:'next friday'}, /with a timezone/],
    ['a deadline inside the approval window', {submissionDeadline:Math.floor(Date.now()/1000)+3000,creatorDeterminationPayment:0.001,arbiterDeterminationPayment:0.001,creatorAssessmentWindowHours:1}, /approval window|assessment window/],
  ])('rejects %s before pinning or storage', async (_label, extra, detail) => {
    const res=await request(app).post('/jobs/create').send({...body,...extra});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid bounty window');
    expect(res.body.details).toMatch(detail);
    expect(upload).not.toHaveBeenCalled();
    expect(storage.createJob).not.toHaveBeenCalled();
  });

  test('a retry that reuses the unlinked job gets the deadline it asked for', async () => {
    storage.readStorage.mockResolvedValueOnce({jobs:[{...body,jobId:7,status:'OPEN',evaluationCid:cid,classId:128,bountyAmountWei:'1000000000000000',submissionOpenTime:1000,submissionCloseTime:87400,plannedSubmissionCloseTime:87400}]});
    const res=await request(app).post('/jobs/create').send({...body,submissionDeadline:DEADLINE_ISO});
    expect(res.status).toBe(200);
    expect(storage.createJob).not.toHaveBeenCalled();
    expect(storage.updateJob).toHaveBeenCalledWith(7,expect.objectContaining({submissionCloseTime:DEADLINE,plannedSubmissionCloseTime:DEADLINE,submissionDeadlineExact:true}));
    expect(res.body.job.submissionCloseTime).toBe(DEADLINE);
    expect(encodedDeadline(res)).toBe(BigInt(DEADLINE));
  });

  test('a window retry keeps the reused job as it was', async () => {
    storage.readStorage.mockResolvedValueOnce({jobs:[{...body,jobId:7,status:'OPEN',evaluationCid:cid,classId:128,bountyAmountWei:'1000000000000000',submissionOpenTime:1000,submissionCloseTime:87400}]});
    const res=await request(app).post('/jobs/create').send({...body,submissionWindowHours:24});
    expect(res.status).toBe(200);
    expect(storage.updateJob).not.toHaveBeenCalled();
    expect(res.body.job.submissionCloseTime).toBe(87400);
  });
});
