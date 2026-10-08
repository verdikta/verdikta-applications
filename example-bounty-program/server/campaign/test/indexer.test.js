'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const {ethers}=require('ethers');
const {Store}=require('../store'),{Indexer,iface}=require('../indexer');
const address='0x'+'1'.repeat(40), creator='0x'+'2'.repeat(40), hunter='0x'+'3'.repeat(40);
const now=1800000000;
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'campaign-indexer-')),store=new Store(dir,'policy');
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const c={startAt:now-100,endAt:now+1000,confirmations:2,maxAgeSeconds:3600,logChunkSize:5,approvedTemplates:[],historyInventoryComplete:true,
    deployments:[{chainId:8453,address,fromBlock:10,codeHash:ethers.keccak256('0x1234'),adapter:'v0.5',campaign:true}]};
  const log=(name,args,n=10)=>({...iface.encodeEventLog(iface.getEvent(name),args),address,blockNumber:n,blockHash:`hash-${n}`,index:0,transactionHash:`tx-${n}`});
  const logs=[log('BountyCreated',[0,creator,'cid',1,80,100,now+200000]),
    log('SubmissionPrepared(uint256,uint256,address,address,uint256,string)',[0,0,hunter,address,100,'cid'],11)];
  let calls=0;
  const provider={getNetwork:async()=>({chainId:8453n}),getBlock:async n=>{const number=n==='latest'?22:n==='finalized'?20:n;return {number,hash:`hash-${number}`,timestamp:now-10};},
    getCode:async(a,n)=>n<10?'0x':'0x1234',getLogs:async({fromBlock,toBlock})=>{calls++;return logs.filter(l=>l.blockNumber>=fromBlock&&l.blockNumber<=toBlock);}};
  const contract={bountyCount:async()=>1n,submissionCount:async()=>1n,getBounty:async()=>({targetHunter:ethers.ZeroAddress}),getSubmission:async()=>({hunterCid:'hunter'})};
  let evidenceCalls=0;
  const validators={templateDigests:async()=>[],workOrder:async()=>{evidenceCalls++;return {ok:true,requestDigest:'hash'};},submission:async()=>true};
  const indexer=new Indexer(c,store,provider,validators,()=>contract);
  return {store,c,provider,contract,logs,indexer,calls:()=>calls,evidenceCalls:()=>evidenceCalls};
}
test('chunked event sync, finality boundary, storage count and cached immutable evidence',async t=>{
  const f=fixture(t);await f.indexer.reconcile(now);assert.equal(f.store.state.chain.error,null);assert.equal(f.store.state.chain.finalizedBlock,20);
  assert.equal(f.store.state.bounties[0].originalWei,'100');assert.equal(f.store.state.bounties[0].submissions[0].hunter,hunter);
  assert.equal(f.calls(),3);await f.indexer.reconcile(now);assert.equal(f.calls(),3);assert.equal(f.evidenceCalls(),1);
});
test('RPC failure rejects fresh previously verified generation',async t=>{
  const f=fixture(t);await f.indexer.reconcile(now);f.provider.getBlock=async()=>{throw new Error('rpc url and secret must not be exposed');};
  await f.indexer.reconcile(now);assert.equal(f.store.state.chain.error,'RECONCILIATION_FAILED_RETRY');
});
test('reorg invalidates snapshot then rebuilds from deployment origin',async t=>{
  const f=fixture(t);await f.indexer.reconcile(now);const original=f.provider.getBlock;
  f.provider.getBlock=async n=>({...await original(n),hash:n===20?'replacement':(await original(n)).hash});
  await f.indexer.reconcile(now);assert.equal(f.store.state.chain.error,'REORG_REBUILD_REQUIRED');assert.equal(f.store.state.bounties.length,0);
  f.provider.getBlock=original;await f.indexer.reconcile(now);assert.equal(f.store.state.chain.error,null);assert.equal(f.calls(),6);
});
for (const [name,change,code] of [
  ['wrong chain',f=>f.provider.getNetwork=async()=>({chainId:84532n}),'WRONG_CHAIN'],
  ['code changed',f=>f.provider.getCode=async()=> '0x5678','CODE_HASH_MISMATCH'],
  ['late indexing',f=>{const old=f.provider.getBlock;f.provider.getBlock=async n=>({...await old(n),timestamp:now-4000});},'CHAIN_STALE'],
  ['missing legacy bounty events',f=>f.contract.bountyCount=async()=>2n,'HISTORY_COUNT_MISMATCH'],
  ['missing legacy submission events',f=>f.contract.submissionCount=async()=>2n,'HISTORY_COUNT_MISMATCH'],
  ['scan starts too late',f=>f.provider.getCode=async()=> '0x1234','HISTORY_START_NOT_CREATION'],
  ['removed log',f=>f.logs[0].removed=true,'REORG_RETRY']
])test(name,async t=>{const f=fixture(t);change(f);await f.indexer.reconcile(now);assert.equal(f.store.state.chain.error,code);});
test('concurrent reconciliations do not publish partial generations',async t=>{
  const f=fixture(t);await Promise.all([f.indexer.reconcile(now),f.indexer.reconcile(now)]);assert.equal(f.calls(),3);assert.equal(f.store.state.chain.error,null);
});
test('unknown logs cannot silently certify a missing bounty or submission',async t=>{
  const f=fixture(t);f.logs[1].topics=['0x'+'0'.repeat(64)];await f.indexer.reconcile(now);assert.equal(f.store.state.chain.error,'HISTORY_COUNT_MISMATCH');
});
