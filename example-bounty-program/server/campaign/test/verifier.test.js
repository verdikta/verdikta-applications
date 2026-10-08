'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const express = require('express'), request = require('supertest');
const { Store } = require('../store');
const { verify, router } = require('../service');
const { eligibility } = require('../predicates');
const { project, key } = require('../ledger');
const { validateConfig, QUESTS, DAY } = require('../config');
const A = n => `0x${String(n).padStart(40,'0')}`;
const creator=A(1), hunter=A(2), hunter2=A(3), other=A(4), contract=A(9);
const start=1800000000, now=start+10*DAY;
const config = () => ({ id:'pilot', communityId:'community', subdomain:'verdikta', startAt:start,endAt:start+21*DAY,claimEndAt:start+24*DAY,
  maxAgeSeconds:3600,minimumWei:'100',teamWallets:[],historyInventoryComplete:true,deployments:[{chainId:8453,address:contract,campaign:true}],quests:Object.fromEntries(QUESTS.map(q=>[q,q])) });
const bounty=(id, at=start, who=creator, winner=hunter) => ({ key:key(contract,id), chainId:8453,contract,id:String(id),creator:who,createdAt:at,
  originalWei:'100', deadline:at+3*DAY, open:true, refunded:false, workOrder:{ok:true,requestDigest:`request-${id}`,templateId:id===1?'source-check-v1':'review-v1'},
  review:{approved:true,independentHunters:[hunter,hunter2],distinctFrom:[key(contract,1)]},
  submissions:[{hunter:winner,id:'0',started:true,passed:true,packageValid:true,submittedAt:at+100,finalizedAt:at+200}],
  payment:{winner,amount:'100',at:at+200,tx:`paid-${id}`} });
const state=() => ({ chain:{error:null,checkedAt:now,historyComplete:true},conflicts:{},history:{creators:{},hunters:{}},bounties:[bounty(1),bounty(2,start+3*DAY+201,creator,hunter2)] });
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zealy-test-')); const store=new Store(dir,'policy');
  store.transact(s=>Object.assign(s,state())); t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return store;
}
const body=(q='Q3',wallet=creator,user='user',id='request')=>({userId:user,communityId:'community',subdomain:'verdikta',questId:q,requestId:id,accounts:{wallet}});
test('all creator core predicates have positive fixtures, independent of cash inventory',()=>{
  for (const q of ['Q3','Q4','Q5','Q6','Q14','Q15']) assert.equal(eligibility(config(),state(),q,creator,now).ok,true,q);
});
test('Q8 passing unpaid; Q9 actual payment; Q10 distinct creators and 72h returning hunter',()=>{
  const s=state();s.bounties[1]=bounty(2,start+3*DAY+201,other,hunter);
  for (const q of ['Q8','Q9','Q10']) assert.equal(eligibility(config(),s,q,hunter,now).ok,true,q);
  s.bounties[0].payment=null;s.bounties[1].payment=null;
  assert.equal(eligibility(config(),s,'Q8',hunter,now).ok,true);
  for (const q of ['Q9','Q10']) assert.equal(eligibility(config(),s,q,hunter,now).ok,false,q);
});
for (const [name,mutate,q='Q3',wallet=creator] of [
  ['old bounty',s=>s.bounties.forEach(b=>b.createdAt=start-1)],
  ['testnet',s=>s.bounties.forEach(b=>b.chainId=84532)],
  ['other contract',s=>s.bounties.forEach(b=>b.contract=A(8))],
  ['insufficient original funding',s=>s.bounties.forEach(b=>b.originalWei='99')],
  ['refund',s=>s.bounties.forEach(b=>b.refunded=true)],
  ['targeted',s=>s.bounties.forEach(b=>b.open=false)],
  ['duplicate scope',s=>s.bounties.forEach(b=>b.duplicate=true)],
  ['missing rubric',s=>s.bounties.forEach(b=>b.workOrder={ok:false})],
  ['scope not reviewed',s=>s.bounties.forEach(b=>b.review.approved=false)],
  ['prepared only',s=>s.bounties.forEach(b=>b.submissions.forEach(x=>x.started=false)),'Q8',hunter],
  ['invalid work package',s=>s.bounties.forEach(b=>b.submissions.forEach(x=>x.packageValid=false)),'Q8',hunter],
  ['failed evaluation',s=>s.bounties.forEach(b=>b.submissions.forEach(x=>x.passed=false)),'Q8',hunter],
  ['repeat less than 72h',s=>s.bounties[1].createdAt=start+3*DAY-1,'Q5'],
  ['repeat before payment',s=>s.bounties[0].payment.at=s.bounties[1].createdAt+1,'Q5'],
  ['different hash not independent scope',s=>s.bounties[1].review.distinctFrom=[],'Q5'],
  ['same paid hunter',s=>s.bounties[1].payment.winner=hunter,'Q6'],
  ['legacy history incomplete',s=>s.chain.historyComplete=false,'Q4'],
  ['existing creator',s=>s.history.creators[creator]=true,'Q4'],
  ['RPC outage',s=>s.chain.error='RPC_OUTAGE'],
  ['stale cache',s=>s.chain.checkedAt=now-3601],
  ['reorg',s=>s.chain.error='REORG_REBUILD_REQUIRED'],
  ['identity hold',s=>s.conflicts[creator]=true],
  ['payment during grace',s=>s.bounties.forEach(b=>b.payment.at=start+21*DAY),'Q4']
]) test(name,()=>{const s=state();mutate(s);assert.equal(eligibility(config(),s,q,wallet,now).ok,false);});
test('repeat hunter rejects prehistory, same creator, insufficient interval and team second creator',()=>{
  for (const modify of [(s,c)=>s.history.hunters[hunter]=true,(s)=>s.bounties[1].creator=creator,
    s=>s.bounties[1].submissions[0].submittedAt=start+101,(s,c)=>c.teamWallets=[other]]) {
    const s=state(),c=config();s.bounties[1]=bounty(2,start+3*DAY+201,other,hunter);modify(s,c);
    assert.equal(eligibility(c,s,'Q10',hunter,now).ok,false);
  }
});
test('UTC start, activity cutoff and correction grace boundaries',()=>{
  const c=config(),s=state();
  s.chain.checkedAt=start-1;assert.equal(eligibility(c,s,'Q3',creator,start-1).code,'CAMPAIGN_NOT_STARTED');
  s.chain.checkedAt=c.endAt;assert.equal(eligibility(c,s,'Q4',creator,c.endAt).ok,true);
  s.chain.checkedAt=c.claimEndAt-1;assert.equal(eligibility(c,s,'Q4',creator,c.claimEndAt-1).ok,true);
  assert.equal(eligibility(c,s,'Q4',creator,c.claimEndAt).code,'CLAIM_WINDOW_CLOSED');
  s.bounties.forEach(b=>b.createdAt=c.endAt);s.chain.checkedAt=c.endAt;
  assert.equal(eligibility(c,s,'Q3',creator,c.endAt).ok,false);
});
test('concurrent duplicate claims are idempotent, persist across restart, and never reserve a reward',async t=>{
  const store=setup(t),c=config();
  const outcomes=await Promise.all(Array.from({length:20},()=>Promise.resolve().then(()=>verify(c,store,body(),now))));
  assert.ok(outcomes.every(r=>r.ok));assert.equal(store.state.audit.length,1);assert.equal(Object.keys(store.state.identities).length,1);
  assert.equal(JSON.parse(fs.readFileSync(store.claimFile)).attempts[Object.keys(store.state.attempts)[0]].code,'VERIFIED');
  assert.throws(()=>new Store(path.dirname(store.file),'policy'),/EEXIST/);
  assert.equal(verify(c,store,body('Q4',creator,'user','request'),now).code,'REQUEST_ID_REUSED');
  store.transact(s=>s.chain.error='REORG');assert.equal(verify(c,store,body(),now).ok,false);
});
test('wallet swap, reverse duplicate and both owners remain held; zero/social/pasted wallet rejected',t=>{
  const store=setup(t),c=config();assert.equal(verify(c,store,body(),now).ok,true);
  assert.equal(verify(c,store,body('Q3',hunter,'user','swap'),now).code,'IDENTITY_REVIEW_REQUIRED');
  assert.equal(verify(c,store,body('Q3',creator,'second','duplicate'),now).code,'IDENTITY_REVIEW_REQUIRED');
  assert.equal(verify(c,store,body('Q3',creator,'user','retry'),now).ok,false);
  assert.equal(verify(c,store,body('Q3',A(0)),now).code,'AUTHENTICATED_WALLET_REQUIRED');
  const b=body();delete b.accounts.wallet;b.wallet=creator;assert.equal(verify(c,store,b,now).code,'AUTHENTICATED_WALLET_REQUIRED');
});
test('wrong wallet does not claim someone else activity, contract wallets use exact authenticated address',t=>{
  const store=setup(t),c=config();assert.equal(verify(c,store,body('Q3',A(50)),now).ok,false);
  assert.equal(verify(c,store,body('Q3',creator,'smart-wallet-user','smart'),now).ok,true);
});
test('HTTP authentication, community allowlist, useful reason and secret-free response',async t=>{
  const store=setup(t),c=config(),secret='x'.repeat(32),app=express();app.use(express.json());app.use(router(c,store,secret,()=>now));
  assert.equal((await request(app).post('/verify').send(body())).status,400);
  const good=await request(app).post('/verify').set('X-Api-Key',secret).send(body());assert.equal(good.status,200);assert.deepEqual(good.body,{message:'VERIFIED'});
  const bad=await request(app).post('/verify').set('X-Api-Key',secret).send({...body(),communityId:'other'});assert.equal(bad.status,400);
  assert.equal((await request(app).get('/health')).status,200);
});
test('deployment identity, original funding and deferred payment before/after withdrawal',()=>{
  const logs=[];let index=0;
  const emit=(name,args,tx='tx',at=start,c=contract)=>logs.push({name,args,tx,at,contract:c,index:index++});
  const created={bountyId:'1',creator,evaluationCid:'cid',threshold:'80',payoutWei:'100',submissionDeadline:String(start+3*DAY)};
  emit('BountyCreated',created);emit('BountyCreated',created,'other',start-1,A(8));
  emit('PayoutSent',{bountyId:'1',winner:hunter,amountWei:'100'});
  emit('PaymentDeferred',{to:hunter,amount:'100'});
  let view=project(logs,start);assert.equal(view.bounties.length,2);assert.equal(view.bounties[0].payment.at,null);assert.equal(view.bounties[0].originalWei,'100');
  emit('Withdrawn',{account:hunter,amount:'100'},'withdraw',start+500);
  view=project(logs,start);assert.equal(view.bounties[0].payment.at,start+500);assert.equal(view.bounties[0].payment.tx,'withdraw');
  assert.equal(view.history.creators[creator],true);
});
test('deferred refund is not confused with an immediate payout',()=>{
  const logs=[{name:'BountyCreated',args:{bountyId:'1',creator,payoutWei:'100'},contract,at:start},
    {name:'PayoutSent',args:{bountyId:'1',winner:hunter,amountWei:'90'},contract,tx:'t',at:start+1},
    {name:'CreatorRefunded',args:{bountyId:'1',creator,amountRefunded:'10'},contract,tx:'t',at:start+1},
    {name:'PaymentDeferred',args:{to:creator,amount:'10'},contract,tx:'t',at:start+1}];
  assert.equal(project(logs,start).bounties[0].payment.at,start+1);
});
test('incomplete production configuration refuses startup',()=>{
  assert.throws(()=>validateConfig({},'x'.repeat(32)),/configuration/);
});

test('restart preserves reverse identity binding and rejects policy changes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-restart-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let store=new Store(dir,'policy');store.transact(s=>Object.assign(s,state()));verify(config(),store,body(),now);store.close();
  store=new Store(dir,'policy');assert.equal(verify(config(),store,body('Q3',creator,'other','new'),now).code,'IDENTITY_REVIEW_REQUIRED');store.close();
  assert.throws(()=>new Store(dir,'different-policy'),/mismatch/i);
});
test('malformed and oversized JSON return sanitized 400 without binding a wallet',async t=>{
  const store=setup(t),secret='x'.repeat(32),app=express();app.use(router(config(),store,secret,()=>now));
  for(const text of ['{',JSON.stringify({huge:'x'.repeat(9000)})]) {
    const r=await request(app).post('/verify').set('X-Api-Key',secret).set('Content-Type','application/json').send(text);
    assert.equal(r.status,400);assert.deepEqual(r.body,{message:'INVALID_REQUEST'});
  }
  assert.equal(Object.keys(store.state.identities).length,0);
});
test('disk failure refuses success and poisons subsequent verification until repaired',t=>{
  const store=setup(t);store.writeAtomic=()=>{throw new Error('disk full');};
  assert.throws(()=>verify(config(),store,body(),now));assert.equal(store.failed,true);
  assert.equal(verify(config(),store,body(),now).code,'VERIFICATION_UNAVAILABLE_RETRY');
});
test('valid sample policy, unset opt-in, and required production fields',()=>{
  const {loadConfig}=require('../config');assert.equal(loadConfig({}),null);
  const sample=require('../config.example.json');assert.throws(()=>validateConfig(sample,'x'.repeat(32)));
  const good={...sample,communityId:'community',subdomain:'verdikta',start:'2026-10-01T00:00:00Z',minimumWei:'100',teamWalletsReviewed:true,
    historyInventoryComplete:false,deployments:[sample.deployments.at(-1)],quests:Object.fromEntries(QUESTS.map((q,i)=>[q,`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`]))};
  assert.equal(validateConfig(good,'x'.repeat(32)).endAt-Date.parse(good.start)/1000,21*DAY);
  for(const change of [{minimumWei:'0'},{start:null},{teamWalletsReviewed:false},{historyInventoryComplete:true},{quests:{}},{confirmations:0}])assert.throws(()=>validateConfig({...good,...change},'x'.repeat(32)));
});
