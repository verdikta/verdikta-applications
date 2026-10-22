import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, Wallet, Transaction } from 'ethers';
import { deployments, iface } from '../_transaction-guards.js';
import { execute, preflightDeployment } from '../_executor.js';
const d=deployments.base;
const docs={contract:{address:d.address,chainId:8453,functions:Object.fromEntries(['createBounty','prepareSubmission','requiredPrepay'].map(n=>[n,{signature:iface.getFunction(n).format('full').replace(/^function /,'')}]))}};
const policy={maxValueWei:'1000',maxTotalWei:'1000000',maxGasLimit:'200',maxFeePerGasWei:'2',maxPriorityFeePerGasWei:'1'};
function setup() {
  let sent=0, confirmed=0;
  const provider={getNetwork:async()=>({chainId:8453n}),getCode:async()=> '0x1234'};
  const wallet=new Wallet('0x'+'11'.repeat(32)); // Synthetic offline test key; never funded.
  provider.broadcastTransaction=async raw=>{sent++;return {hash:Transaction.from(raw).hash,wait:async()=>({status:1,logs:[]})};};
  const signer={provider,estimateGas:async()=>100n,populateTransaction:async tx=>({...tx,nonce:0}),signTransaction:tx=>wallet.signTransaction(tx),getAddress:async()=>wallet.address};
  const tx={to:d.address,chainId:8453,value:'0',data:iface.encodeFunctionData('finalizeSubmission',[1,2])};
  return {provider,signer,tx,opts:{network:'base',args:[1,2],policy,confirm:async()=>{confirmed++;}},counts:()=>({sent,confirmed})};
}
test('executor validates dry-run and blocks drift/caps before signing',async()=>{
  const oldHash=d.codeHash,oldFetch=globalThis.fetch;d.codeHash=keccak256('0x1234');
  globalThis.fetch=async()=>new Response(JSON.stringify(docs),{headers:{'content-type':'application/json'}});
  try {
    const f=setup();await preflightDeployment('base',f.provider,d.docsUrl.replace('/api/docs',''));
    await execute(f.signer,'finalizeSubmission',f.tx,{...f.opts,dryRun:true});assert.deepEqual(f.counts(),{sent:0,confirmed:0});
    for(const [tx,opts] of [[{...f.tx,to:'0x'+'0'.repeat(40)},f.opts],[{...f.tx,chainId:84532},f.opts],[{...f.tx,data:iface.encodeFunctionData('closeExpiredBounty',[1])},f.opts],[f.tx,{...f.opts,policy:{...policy,maxGasLimit:'100'}}],[f.tx,{...f.opts,policy:{...policy,maxTotalWei:'200'}}]]) {
      await assert.rejects(execute(f.signer,'finalizeSubmission',tx,opts));
    }
    assert.deepEqual(f.counts(),{sent:0,confirmed:0});
    let saved=false;await execute(f.signer,'finalizeSubmission',f.tx,{...f.opts,onBroadcast:async()=>{saved=true;}});
    assert.equal(saved,true);assert.deepEqual(f.counts(),{sent:1,confirmed:1});
  } finally {d.codeHash=oldHash;globalThis.fetch=oldFetch;}
});
test('unavailable/malformed docs fail closed without alternate destination',async()=>{
  const old=globalThis.fetch;
  try {
    for(const response of [new Response('',{status:401}),new Response('<html>',{headers:{'content-type':'text/html'}}),new Response('{}',{headers:{'content-type':'application/json'}})]) {
      globalThis.fetch=async()=>response;
      await assert.rejects(preflightDeployment('base',setup().provider,d.docsUrl.replace('/api/docs','')));
    }
    await assert.rejects(preflightDeployment('base',setup().provider,'https://untrusted.invalid'));
  } finally {globalThis.fetch=old;}
});

test('live prepay drift and cumulative caps block a second transaction',async()=>{
  const {execute,preflightDeployment}=await import('../_executor.js?isolated-budget-test');
  const oldHash=d.codeHash,oldFetch=globalThis.fetch;d.codeHash=keccak256('0x1234');
  globalThis.fetch=async()=>new Response(JSON.stringify(docs),{headers:{'content-type':'application/json'}});
  try {
    const f=setup();f.provider.call=async()=>iface.encodeFunctionResult('requiredPrepay',[201n]);
    await preflightDeployment('base',f.provider,d.docsUrl.replace('/api/docs',''));
    const start={...f.tx,value:'200',data:iface.encodeFunctionData('startPreparedSubmission',[1,2])};
    await assert.rejects(execute(f.signer,'startPreparedSubmission',start,{...f.opts,exactValueWei:200n}),/Prepay changed/);
    assert.equal(f.counts().sent,0);
    // One transaction reserves 250 wei; a second would exceed this run cap.
    const opts={...f.opts,policy:{...policy,maxTotalWei:'400'}};
    await execute(f.signer,'finalizeSubmission',f.tx,opts);
    await assert.rejects(execute(f.signer,'finalizeSubmission',f.tx,opts),/Run total/);
    assert.equal(f.counts().sent,1);
  } finally {d.codeHash=oldHash;globalThis.fetch=oldFetch;}
});

test('signed bytes persist before transport failure; persistence failure prevents broadcast',async()=>{
  const oldHash=d.codeHash,oldFetch=globalThis.fetch;d.codeHash=keccak256('0x1234');
  globalThis.fetch=async()=>new Response(JSON.stringify(docs),{headers:{'content-type':'application/json'}});
  try {
    const f=setup();await preflightDeployment('base',f.provider,d.docsUrl.replace('/api/docs',''));
    let saved,attempts=0;
    f.provider.broadcastTransaction=async raw=>{attempts++;assert.equal(raw,saved.rawTransaction);assert.equal(Transaction.from(raw).hash,saved.hash);throw Error('insufficient gas funds');};
    await assert.rejects(execute(f.signer,'finalizeSubmission',f.tx,{...f.opts,onSigned:async s=>{saved=s;}}),/Broadcast uncertain/);
    assert.equal(attempts,1);assert.ok(saved.hash);
    await assert.rejects(execute(f.signer,'finalizeSubmission',f.tx,{...f.opts,onSigned:async()=>{throw Error('disk full');}}),/disk full/);
    assert.equal(attempts,1);
  } finally {d.codeHash=oldHash;globalThis.fetch=oldFetch;}
});

test('a cap refusal names the limit the call needs and the policy file',async()=>{
  const {execute,preflightDeployment}=await import('../_executor.js?cap-message-test');
  const oldHash=d.codeHash,oldFetch=globalThis.fetch,oldPolicy=process.env.VERDIKTA_SPEND_POLICY;d.codeHash=keccak256('0x1234');
  globalThis.fetch=async()=>new Response(JSON.stringify(docs),{headers:{'content-type':'application/json'}});
  process.env.VERDIKTA_SPEND_POLICY='/owner/spend-policy.json';
  try {
    const f=setup();await preflightDeployment('base',f.provider,d.docsUrl.replace('/api/docs',''));
    // estimateGas 100 -> gas limit 125 (+25%)
    await assert.rejects(execute(f.signer,'finalizeSubmission',f.tx,{...f.opts,policy:{...policy,maxGasLimit:'100'}}),
      /^Error: Gas limit exceeds owner cap: finalizeSubmission needs a gas limit of 125, and maxGasLimit is 100 in the spend policy \/owner\/spend-policy\.json\. Nothing was signed\. Ask the owner to raise maxGasLimit to at least 125/);
    await assert.rejects(execute(f.signer,'finalizeSubmission',f.tx,{...f.opts,policy:{...policy,maxTotalWei:'200'}}),
      /^Error: Run total exceeds owner cap: finalizeSubmission reserves 250 wei \(value \+ gas limit 125 x maxFeePerGasWei 2\), 0 wei are already reserved in this run, and maxTotalWei is 200 in the spend policy \/owner\/spend-policy\.json\. Nothing was signed\. Ask the owner to raise maxTotalWei to at least 250/);
    assert.deepEqual(f.counts(),{sent:0,confirmed:0});
  } finally {d.codeHash=oldHash;globalThis.fetch=oldFetch;if(oldPolicy===undefined)delete process.env.VERDIKTA_SPEND_POLICY;else process.env.VERDIKTA_SPEND_POLICY=oldPolicy;}
});
