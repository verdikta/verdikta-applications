import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { Wallet, Transaction } from 'ethers';
import { tmpdir } from 'node:os';
import { runCreate } from '../create_bounty.js';
import { runSubmit } from '../submit_to_bounty.js';
import { runClaim } from '../claim_bounty.js';
import { iface, deployments, bindCreation, verifyTransaction } from '../_transaction-guards.js';
const testWallet=new Wallet('0x'+'11'.repeat(32)); // Synthetic offline key, never funded.
const creator=testWallet.address,target='0x2222222222222222222222222222222222222222';
const cid='Qm'+'a'.repeat(44),hunterCid='Qm'+'b'.repeat(44),hash='0x'+'1'.repeat(64),d=deployments.base;
const policy={maxValueWei:'2000000000000000',maxTotalWei:'5000000000000000',maxGasLimit:'500000',maxFeePerGasWei:'2',maxPriorityFeePerGasWei:'1'};
const config={title:'test',description:'test only',procurementMode:'OPEN',classId:128,threshold:85,bountyAmount:'0.001',submissionWindowHours:24,oracle:{maxOracleFee:'100',alpha:500,estimatedBaseCost:'0',maxFeeBasedScaling:1},rubricJson:{criteria:[{id:'x',description:'x',weight:1,must:false}]},juryNodes:[{provider:'test',model:'test',weight:1,runs:1}]};
const json=x=>new Response(JSON.stringify(x),{headers:{'content-type':'application/json'}});
function log(name,args) {return {address:d.address,...iface.encodeEventLog(iface.getEvent(name),args)};}
function harness(args) {
 const sent=[],reviews=[];
 const provider={destroy(){},getTransaction:async()=>null,getTransactionReceipt:async()=>null};
 const wallet={address:creator,connect(){return {...this,provider};}};
 const lib={arg:n=>args[n]??null,argAll:n=>args[n]||[],getNetwork:()=> 'base',providerFor:()=>provider,loadWallet:async()=>wallet,loadApiKey:async()=> 'mock',preflightDeployment:async()=>d.address,loadSpendPolicy:async()=>policy,isDryRun:()=>false,confirmSpendOrExit:async r=>reviews.push(r),getSupportedModelsForClass:async()=>[],validateAndNormalizeJuryNodes:({juryNodes})=>juryNodes,
 sendTx:async(signer,method,tx,opts)=> {verifyTransaction(tx,{network:'base',method,args:opts.args,value:opts.exactValueWei??0n,maxValueWei:policy.maxValueWei});reviews.push(opts.review);await opts.onSigned?.({hash});sent.push(method);await opts.onBroadcast?.(hash);return {status:1,hash,blockNumber:1,logs:[]};}};
 return {lib,provider,wallet,sent,reviews};
}
async function creationFixture(t,changes={}) {
 const dir=await mkdtemp(`${tmpdir()}/verdikta-create-test-`);t.after(()=>rm(dir,{recursive:true,force:true}));
 const cfg={...config,...changes},file=`${dir}/config.json`;await writeFile(file,JSON.stringify(cfg));
 const args={config:file},h=harness(args),now=Math.floor(Date.now()/1000);
 const response={success:true,job:{jobId:7,evaluationCid:cid,threshold:85,submissionOpenTime:now,submissionCloseTime:now+86400},onChain:{transaction:{}}};
 const bound=bindCreation(cfg,response);
 response.onChain.transaction={to:d.address,chainId:d.chainId,value:bound.value.toString(),data:iface.encodeFunctionData('createBounty',[bound.params])};
 const bounty={creator,...bound.params};let creates=0,links=0;
 const env={baseUrl:'https://mock.invalid',contract:()=>({verdikta:async()=>target,maxOracleFee:async()=>1000n,getBounty:async()=>bounty}),fetchApi:async(url)=>{if(url.endsWith('/jobs/create')){creates++;return json(response);}links++;return json({success:true,job:{jobId:7}});}};
 const send=h.lib.sendTx;
 h.lib.sendTx=async(...params)=>{const r=await send(...params);r.logs=[log('BountyCreated',[7,creator,cid,128,85,1000000000000000n,now+86400])];return r;};
 return {...h,cfg,args,file,response,bounty,env,counts:()=>({creates,links})};
}
for(const mode of ['OPEN','TARGETED']) test(`create ${mode} checks exact tx and reads back bounty before link`,async t=>{
 const f=await creationFixture(t,{procurementMode:mode,...(mode==='TARGETED'?{targetHunter:target}:{})});
 await runCreate(f.lib,f.env);assert.deepEqual(f.sent,['createBounty']);assert.deepEqual(f.counts(),{creates:1,links:1});
 assert.ok(f.reviews.flat().some(x=>x?.includes('Submission deadline:')));
 f.args.resume=`${f.file}.state.json`;
 f.provider.getTransaction=async()=>({...f.response.onChain.transaction,from:creator});
 f.provider.getTransactionReceipt=async()=>({status:1,hash,blockNumber:1,logs:[log('BountyCreated',[7,creator,cid,128,85,1000000000000000n,f.response.job.submissionCloseTime])]});
 await runCreate(f.lib,f.env);assert.equal(f.sent.length,1);assert.deepEqual(f.counts(),{creates:1,links:2});
 f.provider.getTransaction=async()=>({...f.response.onChain.transaction,from:target});
 await assert.rejects(runCreate(f.lib,f.env),/wrong creator/);
});
test('API_CREATED resumes once, but ambiguous broadcast and changed config stop',async t=>{
 const f=await creationFixture(t),send=f.lib.sendTx;
 f.lib.sendTx=async()=>{throw Error('review rejected before broadcast');};
 await assert.rejects(runCreate(f.lib,f.env),/review rejected/);
 f.args.resume=`${f.file}.state.json`;const state=JSON.parse(await readFile(f.args.resume));assert.equal(state.status,'API_CREATED');
 f.lib.sendTx=send;
 const clock=Date.now;Date.now=()=>clock()+3600000;
 try {await runCreate(f.lib,f.env);} finally {Date.now=clock;}
 assert.deepEqual(f.counts(),{creates:1,links:1});assert.ok(f.reviews.flat().some(x=>x?.includes('Remaining submission time:')));
 await writeFile(f.args.resume,JSON.stringify({...state,status:'BROADCAST_PENDING'}));
 await assert.rejects(runCreate(f.lib,f.env),/No safe pre-broadcast/);
 await writeFile(f.args.resume,JSON.stringify({...state,network:'base-sepolia'}));
 await assert.rejects(runCreate(f.lib,f.env),/matching config/);
});
test('read-back mismatch blocks linking and fractional windows fail before API',async t=>{
 const f=await creationFixture(t);f.bounty.targetHunter=target;
 await assert.rejects(runCreate(f.lib,f.env),/target mismatch/);assert.equal(f.counts().links,0);
 const g=await creationFixture(t);await writeFile(g.file,JSON.stringify({...g.cfg,creatorAssessmentWindowSeconds:3900}));
 await assert.rejects(runCreate(g.lib,g.env),/whole hours/);assert.equal(g.counts().creates,0);
});
test('an exact deadline goes to the API as submissionDeadline and is bound to the second',async t=>{
 const clock=Date.now,fixed=clock(),deadline=Math.floor(fixed/1000)+86400;let f,g;
 Date.now=()=>fixed; // the fixture's server response closes exactly 24 h after its creation second
 try {f=await creationFixture(t,{submissionWindowHours:null,submissionDeadline:deadline});g=await creationFixture(t,{submissionWindowHours:null,submissionDeadline:deadline});} finally {Date.now=clock;}
 const bodies=[],fetchApi=f.env.fetchApi;
 f.env.fetchApi=async(url,init)=>{bodies.push(JSON.parse(init.body));return fetchApi(url,init);};
 await runCreate(f.lib,f.env);
 assert.equal(bodies[0].submissionDeadline,deadline);assert.ok(!('submissionWindowHours' in bodies[0]));
 assert.ok(f.reviews.flat().some(x=>x?.includes('exact deadline')));
 await writeFile(g.file,JSON.stringify({...g.cfg,submissionDeadline:deadline+60}));
 await assert.rejects(runCreate(g.lib,g.env),/exact submissionDeadline/);assert.equal(g.sent.length,0);
});
test('submit retries lagging confirmation; resume confirms without preparing again',async t=>{
 const dir=await mkdtemp(`${tmpdir()}/verdikta-submit-test-`);t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=`${dir}/result.txt`;await writeFile(file,'test');
 const args={jobId:'7',file:[file],state:`${dir}/state.json`},f=harness(args);let confirms=0,uploads=0,prepares=0;const pauses=[];let action='AWAIT_CREATOR';
 const bounty={evaluationCid:cid,targetHunter:creator};
 const transaction={to:d.address,chainId:d.chainId,value:'0',data:iface.encodeFunctionData('prepareSubmission',[7,cid,hunterCid])};
 const env={baseUrl:'https://mock.invalid',pause:async ms=>pauses.push(ms),contract:()=>({getBounty:async()=>bounty,isAcceptingSubmissions:async()=>true,getSubmission:async()=>({hunter:creator,hunterCid}),nextAction:async()=> action,requiredPrepay:async()=>123n}),fetchApi:async(url)=>{
   if(url.endsWith('/7'))return json({job:{jobId:7,onChain:true,evaluationCid:cid}});
   if(url.endsWith('/validate'))return json({valid:true});
   if(url.endsWith('/submit')){uploads++;return json({submission:{hunterCid}});}
   if(url.endsWith('/prepare')){prepares++;return json({transaction});}
   if(url.endsWith('/start'))return json({transaction:{to:d.address,chainId:d.chainId,value:'123',data:iface.encodeFunctionData('startPreparedSubmission',[7,0])}});
   if(url.endsWith('/confirm')){confirms++;return confirms===1?new Response('<html>gateway failure</html>',{status:502}):confirms===2?new Response(JSON.stringify({code:'SUBMISSION_BAD_ID'}),{status:400}):json({success:true});}
   throw Error(url);
 }};
 const send=f.lib.sendTx;f.lib.sendTx=async(...p)=>{const r=await send(...p);r.logs=[log('SubmissionPrepared',[7,0,creator,target,100n,cid])];return r;};
 await runSubmit(f.lib,env);assert.deepEqual(pauses,[1000,2000]);assert.equal(confirms,3);
 const state=JSON.parse(await readFile(args.state));assert.equal(state.confirmed,true);state.confirmed=false;await writeFile(args.state,JSON.stringify(state));
 delete state.submissionId;await writeFile(args.state,JSON.stringify(state));
 f.provider.getTransaction=async()=>({...transaction,from:creator});
 f.provider.getTransactionReceipt=async()=>({status:1,hash,logs:[log('SubmissionPrepared',[7,0,creator,target,100n,cid])]});
 args.resume='0';await runSubmit(f.lib,env);assert.equal(confirms,4);assert.equal(uploads,1);assert.equal(prepares,1);assert.deepEqual(f.sent,['prepareSubmission']);
 action='START';await runSubmit(f.lib,env);assert.equal(f.sent.at(-1),'startPreparedSubmission');assert.equal(prepares,1);
 state.hunter=target;await writeFile(args.state,JSON.stringify(state));await assert.rejects(runSubmit(f.lib,env),/recovery state/);
});
test('submit retries a lagging getSubmission after prepare and never prepares again',async t=>{
 const dir=await mkdtemp(`${tmpdir()}/verdikta-submit-lag-`);t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=`${dir}/result.txt`;await writeFile(file,'test');
 const bounty={evaluationCid:cid,targetHunter:creator};
 const transaction={to:d.address,chainId:d.chainId,value:'0',data:iface.encodeFunctionData('prepareSubmission',[7,cid,hunterCid])};
 const badId=()=>Object.assign(Error('execution reverted: "bad submissionId"'),{reason:'bad submissionId'});
 async function run(lagReads){
  const args={jobId:'7',file:[file],state:`${dir}/state-${lagReads}.json`},f=harness(args);let reads=0,prepares=0;const pauses=[];
  const env={baseUrl:'https://mock.invalid',pause:async ms=>pauses.push(ms),contract:()=>({getBounty:async()=>bounty,isAcceptingSubmissions:async()=>true,
    getSubmission:async()=>{if(++reads<=lagReads)throw badId();return {hunter:creator,hunterCid};},nextAction:async()=> 'AWAIT_CREATOR',requiredPrepay:async()=>123n}),fetchApi:async(url)=>{
    if(url.endsWith('/7'))return json({job:{jobId:7,onChain:true,evaluationCid:cid}});
    if(url.endsWith('/validate'))return json({valid:true});
    if(url.endsWith('/submit'))return json({submission:{hunterCid}});
    if(url.endsWith('/prepare')){prepares++;return json({transaction});}
    if(url.endsWith('/confirm'))return json({success:true});
    throw Error(url);
  }};
  const send=f.lib.sendTx;f.lib.sendTx=async(...p)=>{const r=await send(...p);r.logs=[log('SubmissionPrepared',[7,0,creator,target,100n,cid])];return r;};
  return {f,env,args,pauses,counts:()=>({reads,prepares})};
 }
 const ok=await run(2);await runSubmit(ok.f.lib,ok.env);
 assert.deepEqual(ok.pauses,[1000,2000]);assert.deepEqual(ok.counts(),{reads:3,prepares:1});assert.deepEqual(ok.f.sent,['prepareSubmission']);
 const stuck=await run(99);await assert.rejects(runSubmit(stuck.f.lib,stuck.env),/Submission 0 is prepared and saved.*--resume 0 --state/);
 assert.deepEqual(stuck.pauses,[1000,2000,4000,8000]);assert.deepEqual(stuck.counts(),{reads:5,prepares:1});
 assert.equal(JSON.parse(await readFile(stuck.args.state)).submissionId,'0');
});
test('claim shows creator payout, hunter and work CID and handles nextAction',async()=>{
 const args={jobId:'7',submissionId:'0'},f=harness(args);
 const env={baseUrl:'https://mock.invalid',contract:()=>({nextAction:async()=> 'AWAIT_CREATOR',getBounty:async()=>({creator,creatorDeterminationPayment:123n}),getSubmission:async()=>({hunter:target,hunterCid})})};
 process.argv.push('--approve-as-creator');
 try {await runClaim(f.lib,env);} finally {process.argv.pop();}
 assert.deepEqual(f.sent,['creatorApproveSubmission']);assert.ok(f.reviews.flat().some(x=>x.includes('123 wei')));assert.ok(f.reviews.flat().some(x=>x.includes(target)));assert.ok(f.reviews.flat().some(x=>x.includes(hunterCid)));
 await runClaim(f.lib,{...env,contract:()=>({nextAction:async()=> 'FINALIZE'})});assert.equal(f.sent.at(-1),'finalizeSubmission');
});

test('onboarding worker performs only a read-only open-job listing',async()=>{
 const {listOpenJobs}=await import('../bounty_worker_min.js');
 const calls=[];
 const jobs=await listOpenJobs({baseUrl:'https://mock.invalid',apiKey:'mock',fetchApi:async(url,options)=>{calls.push({url:String(url),options});return json({jobs:[{jobId:7,title:'Example'}]});}});
 assert.equal(jobs.length,1);assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');assert.ok(calls[0].url.endsWith('/api/jobs?status=OPEN&minHoursLeft=2'));
});

test('resume rebroadcasts the same signed bytes and rejects tampered hashes',async t=>{
 const f=await creationFixture(t);let signed;
 f.lib.sendTx=async(signer,method,tx,opts)=>{
   const rawTransaction=await testWallet.signTransaction({...tx,nonce:3,gasLimit:400000n,type:2,maxFeePerGas:2n,maxPriorityFeePerGas:1n});
   signed={rawTransaction,hash:Transaction.from(rawTransaction).hash};
   await opts.onSigned(signed);throw Error('transport lost');
 };
 await assert.rejects(runCreate(f.lib,f.env),/transport lost/);
 f.args.resume=`${f.file}.state.json`;
 const state=JSON.parse(await readFile(f.args.resume));assert.equal(state.status,'BROADCAST_PENDING');assert.equal(state.txHash,signed.hash);
 let broadcasts=0;
 f.provider.broadcastTransaction=async raw=>{broadcasts++;assert.equal(raw,signed.rawTransaction);return {hash:signed.hash,wait:async()=>({status:1,hash:signed.hash,blockNumber:5,logs:[log('BountyCreated',[7,creator,cid,128,85,1000000000000000n,f.response.job.submissionCloseTime])]})};};
 await runCreate(f.lib,f.env);assert.equal(broadcasts,1);assert.deepEqual(f.counts(),{creates:1,links:1});
 await writeFile(f.args.resume,JSON.stringify({...state,txHash:hash}));
 await assert.rejects(runCreate(f.lib,f.env),/hash mismatch/);assert.equal(broadcasts,1);
});
test('creation readback pins the receipt block, retries lag, and reports funded recovery',async t=>{
 const f=await creationFixture(t),pauses=[];let reads=0;
 const original=f.env.contract;
 f.env.pause=async ms=>pauses.push(ms);
 f.env.contract=(...args)=>({...original(...args),getBounty:async(id,overrides)=>{reads++;assert.equal(overrides.blockTag,1);if(reads<3)throw Error('header not found');return f.bounty;}});
 await runCreate(f.lib,f.env);assert.deepEqual(pauses,[1000,2000]);assert.equal(f.counts().links,1);
 const g=await creationFixture(t);g.env.pause=async()=>{};const other=g.env.contract;
 g.env.contract=(...args)=>({...other(...args),getBounty:async()=>{throw Error('RPC lag');}});
 await assert.rejects(runCreate(g.lib,g.env),/bounty is funded.*--resume/);assert.equal(g.counts().links,0);
});

test('delayed prepared-state dry-run validates without creating or altering recovery state',async t=>{
 const f=await creationFixture(t);f.lib.sendTx=async()=>{throw Error('review stopped');};
 await assert.rejects(runCreate(f.lib,f.env),/review stopped/);
 f.args.prepared=`${f.file}.state.json`;const before=await readFile(f.args.prepared,'utf8');
 f.lib.isDryRun=()=>true;let reviewed=0;
 f.lib.sendTx=async(signer,method,tx,opts)=>{verifyTransaction(tx,{network:'base',method,args:opts.args,value:opts.exactValueWei,maxValueWei:policy.maxValueWei});reviewed++;return null;};
 const clock=Date.now;Date.now=()=>clock()+3600000;
 try {await runCreate(f.lib,f.env);} finally {Date.now=clock;}
 assert.equal(reviewed,1);assert.deepEqual(f.counts(),{creates:1,links:0});assert.equal(await readFile(f.args.prepared,'utf8'),before);
});
