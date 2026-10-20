import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, keccak256 } from 'ethers';
import { iface, targetFor, creationTerms, bindCreation, verifyTransaction, verifyDeployment, deployments } from '../_transaction-guards.js';
const config = { procurementMode:'TARGETED',targetHunter:'0x1111111111111111111111111111111111111111', classId:128,threshold:85,bountyAmount:'0.001',submissionWindowHours:24,oracle:{maxOracleFee:'100000000000000',alpha:500,estimatedBaseCost:'0',maxFeeBasedScaling:1} };
const opened=Math.floor(Date.now()/1000),cid='Qm'+'a'.repeat(44);
const response={success:true,job:{jobId:1,evaluationCid:cid,threshold:85,submissionOpenTime:opened,submissionCloseTime:opened+86400},onChain:{transaction:{}}};
function fixture(c=config) {
  const bound=bindCreation(c,response);
  const tx={to:deployments.base.address,chainId:8453,value:bound.value.toString(),data:iface.encodeFunctionData('createBounty',[bound.params])};
  return {tx,expected:{network:'base',method:'createBounty',args:[bound.params],value:bound.value,maxValueWei:bound.value}};
}
test('current generated create struct and three-argument prepare',()=>{
  assert.equal(iface.getFunction('createBounty').inputs.length,1);
  assert.equal(iface.getFunction('createBounty').inputs[0].components.length,9);
  assert.equal(iface.getFunction('prepareSubmission').inputs.length,3);
  const {tx,expected}=fixture();assert.equal(verifyTransaction(tx,expected).value,1000000000000000n);
  assert.equal(iface.decodeFunctionData('createBounty',tx.data)[0].targetHunter,config.targetHunter);
});
test('explicit open, targeted missing/invalid/zero fail closed',()=>{
  assert.equal(targetFor({procurementMode:'OPEN'}),ZeroAddress);
  const c={...config,procurementMode:'OPEN',targetHunter:ZeroAddress};const {tx,expected}=fixture(c);verifyTransaction(tx,expected);
  for(const targetHunter of [undefined,ZeroAddress,'bad']) assert.throws(()=>targetFor({...config,targetHunter}));
  assert.throws(()=>targetFor({}));assert.throws(()=>targetFor({...config,procurementMode:'OPEN'}));
});
test('deadline is exact server seconds; wrong units/window rejected',()=>{
  assert.equal(bindCreation(config,response).params.submissionDeadline,BigInt(opened+86400));
  for(const submissionCloseTime of [(opened+86400)*1000,opened+80000]) assert.throws(()=>bindCreation(config,{...response,job:{...response.job,submissionCloseTime}}));
});
test('all transaction fields and argument drift fail closed',()=>{
  const {tx,expected}=fixture();
  for(const mutate of [t=>t.to=ZeroAddress,t=>t.chainId=84532,t=>delete t.chainId,t=>t.value='1',t=>t.data='0x12345678',t=>t.data+='00']) {const bad={...tx};mutate(bad);assert.throws(()=>verifyTransaction(bad,expected));}
  for(const field of ['evaluationCid','requestedClass','threshold','submissionDeadline','targetHunter','creatorDeterminationPayment','arbiterDeterminationPayment','creatorAssessmentWindowSize']) {
    const params={...expected.args[0],[field]: field==='evaluationCid'?'Qm'+'b'.repeat(44):field==='targetHunter'?ZeroAddress:1n};
    assert.throws(()=>verifyTransaction({...tx,data:iface.encodeFunctionData('createBounty',[params])},expected));
  }
  assert.throws(()=>verifyTransaction(tx,{...expected,maxValueWei:1n}));
});
test('oracle bounds and split payment invariants',()=>{
  assert.throws(()=>creationTerms({...config,creatorDeterminationPayment:'0.0005'}));
  for(const oracle of [{...config.oracle,alpha:1001},{...config.oracle,maxFeeBasedScaling:0},{...config.oracle,estimatedBaseCost:config.oracle.maxOracleFee}]) assert.throws(()=>creationTerms({...config,oracle}));
  assert.equal(creationTerms({...config,creatorDeterminationPayment:'0.0005',creatorAssessmentWindowSeconds:3600}).params.creatorAssessmentWindowSize,3600n);
});
test('SubmissionPrepared budget precedes CID; finalization includes paid bool; tuples are current',()=>{
  const e=iface.getEvent('SubmissionPrepared');
  assert.deepEqual(e.inputs.map(x=>x.name),['bountyId','submissionId','hunter','evalWallet','ethMaxBudget','evaluationCid']);
  const encoded=iface.encodeEventLog(e,[1,2,config.targetHunter,config.targetHunter,987n,cid]);const decoded=iface.parseLog(encoded);
  assert.equal(decoded.args.ethMaxBudget,987n);assert.equal(decoded.args.evaluationCid,cid);
  assert.deepEqual(iface.getEvent('SubmissionFinalized').inputs.map(x=>x.name),['bountyId','submissionId','passed','paid','acceptance','rejection','justificationCids']);
  const fields=iface.getFunction('getSubmission').outputs[0].components.map(x=>x.name);
  assert.ok(fields.includes('funder'));assert.ok(!fields.includes('evaluationCid'));assert.ok(!fields.includes('addendum'));
});
test('start uses exact live prepay value and owner cap',()=>{
  const tx={to:deployments.base.address,chainId:8453,value:'200',data:iface.encodeFunctionData('startPreparedSubmission',[1,2])};
  const expected={network:'base',method:'startPreparedSubmission',args:[1,2],value:200n,maxValueWei:300n};
  verifyTransaction(tx,expected);assert.throws(()=>verifyTransaction({...tx,value:'100'},expected));assert.throws(()=>verifyTransaction(tx,{...expected,maxValueWei:199n}));
});
test('deployment chain, destination, code and selectors verified without fallback',async()=>{
  const d=deployments.base, old=d.codeHash;d.codeHash=keccak256('0x1234');
  const docs={contract:{address:d.address,chainId:8453,functions:Object.fromEntries(['createBounty','prepareSubmission','requiredPrepay'].map(n=>[n,{signature:iface.getFunction(n).format('full').replace(/^function /,'')}]))}};
  const provider={getNetwork:async()=>({chainId:8453n}),getCode:async()=> '0x1234'};
  try {
    assert.equal(await verifyDeployment('base',provider,docs),d.address);
    await assert.rejects(verifyDeployment('base',{...provider,getNetwork:async()=>({chainId:84532n})},docs));
    await assert.rejects(verifyDeployment('base',{...provider,getCode:async()=> '0xabcd'},docs));
    await assert.rejects(verifyDeployment('base',provider,{contract:{...docs.contract,address:ZeroAddress}}));
    docs.contract.functions.prepareSubmission.signature='prepareSubmission(uint256,string,string,string,uint256,uint256,uint256,uint256)';
    await assert.rejects(verifyDeployment('base',provider,docs));
  } finally {d.codeHash=old;}
});
test('bundled ABI matches freshly compiled source + lens signatures',()=>{
  // Relative path is resolved from this test directory back to repository root.
  const dir=new URL('../../../../example-bounty-program/onchain/artifacts/contracts/',import.meta.url);
  for(const name of ['BountyEscrow','BountyEscrowLens']) {
    const artifact=JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`,dir),'utf8'));
    for(const fragment of new Interface(artifact.abi).fragments.filter(f=>['function','event'].includes(f.type))) {
      if(fragment.name==='constructor')continue;
      assert.equal((fragment.type==='event'?iface.getEvent(fragment.name):iface.getFunction(fragment.name)).format('full'),fragment.format('full'));
    }
  }
});
test('packaged rubric implementation equals canonical server function',()=>{
  const server=readFileSync(new URL('../../../../example-bounty-program/server/utils/validation.js',import.meta.url),'utf8');
  const source=server.slice(server.indexOf('function validateRubric('),server.indexOf('\n/**',server.indexOf('function validateRubric('))).trim();
  const bundled=readFileSync(new URL('../rubric.cjs',import.meta.url),'utf8');
  assert.equal(bundled.split('\n').slice(1).join('\n').split('\nmodule.exports')[0].trim(),source);
});
test('API reuse stops new funding; saved recovery permits expired server deadline',()=>{
  assert.throws(()=>bindCreation(config,{...response,message:'Reusing existing job (same evaluation package).'}));
  const expired={...response,job:{...response.job,submissionOpenTime:1,submissionCloseTime:86401}};
  assert.throws(()=>bindCreation(config,expired));
  assert.equal(bindCreation(config,expired,{recovery:true}).params.submissionDeadline,86401n);
});

test('future clock drift and fractional windows stop creation before mutation',()=>{
  const shifted={...response,job:{...response.job,submissionOpenTime:opened+86400,submissionCloseTime:opened+172800}};
  assert.throws(()=>bindCreation(config,shifted),/local clock/);
  assert.throws(()=>creationTerms({...config,submissionWindowHours:1.5}),/whole hours/);
  assert.throws(()=>creationTerms({...config,creatorAssessmentWindowSeconds:3900}),/whole hours/);
});

test('saved local creation timestamp permits delayed review but enforces usable deadline',()=>{
 const old=Date.now;
 try {
  Date.now=()=> (opened+3600)*1000;
  assert.equal(bindCreation(config,response,{apiCreatedAt:opened}).params.submissionDeadline,BigInt(opened+86400));
  assert.throws(()=>bindCreation(config,response),/local clock/);
  assert.throws(()=>bindCreation(config,response,{apiCreatedAt:opened-901}),/local clock/);
  Date.now=()=> (opened+86400-302)*1000;
  assert.throws(()=>bindCreation(config,response,{apiCreatedAt:opened}),/five minutes/);
 } finally {Date.now=old;}
});

test('exact submissionDeadline: unix seconds or ISO UTC, bound to the server deadline to the second',()=>{
  const iso=new Date((opened+90000)*1000).toISOString().replace('.000Z','Z');
  const exact={...config,submissionWindowHours:undefined,submissionDeadline:iso};
  assert.equal(creationTerms(exact).submissionDeadline,BigInt(opened+90000));
  assert.equal(creationTerms({...exact,submissionDeadline:opened+90000}).submissionDeadline,BigInt(opened+90000));
  assert.equal(creationTerms(config).submissionDeadline,null);
  const at={...response,job:{...response.job,submissionCloseTime:opened+90000}};
  assert.equal(bindCreation(exact,at).params.submissionDeadline,BigInt(opened+90000));
  assert.throws(()=>bindCreation(exact,{...at,job:{...at.job,submissionCloseTime:opened+90001}}),/exact submissionDeadline/);
  assert.throws(()=>bindCreation(config,at),/window drift/);
  for(const submissionDeadline of [(opened+90000)*1000,'2026-10-22T00:00:00','2026-10-22T00:00:00+02:00','2026-10-22T00:00:00.500Z','tomorrow',1.5]) assert.throws(()=>creationTerms({...exact,submissionDeadline}),/submissionDeadline|exact integer|unsigned/);
  assert.throws(()=>creationTerms({...exact,submissionWindowHours:24}),/not both/);
  const soon={...response,job:{...response.job,submissionCloseTime:opened+200}};
  assert.throws(()=>bindCreation({...exact,submissionDeadline:opened+200},soon),/five minutes/);
});
