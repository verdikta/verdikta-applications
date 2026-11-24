import './_v2-deployment.js'; // synthetic v2 escrow: deployments.json holds placeholders until the deploy
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, ZeroAddress, keccak256 } from 'ethers';
import { iface, aggregatorIface, targetFor, creationTerms, decisionTerms, decisionBody, bindCreation, verifyTransaction, verifyDeployment, verifyCreatedBounty, deployments, escrowDeployment, DOCUMENTED_FUNCTIONS } from '../_transaction-guards.js';
import { withPlaceholders } from './_v2-deployment.js';
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
  const create=iface.getFunction('createBounty').inputs[0].components;
  assert.deepEqual(create.map(c=>c.name),['evaluationCid','requestedClass','threshold','submissionDeadline','targetHunter','creatorDeterminationPayment','arbiterDeterminationPayment','creatorAssessmentWindowSize','oracle','jury','quota','forfeitLine','bond']);
  assert.deepEqual(create[8].components.map(c=>c.name),['maxOracleFee','alpha','estimatedBaseCost','maxFeeBasedScaling','minOracleFee','withBeacons']);
  assert.deepEqual(create[9].components.map(c=>c.name+':'+c.type),['K:uint8','M:uint8','N:uint8','P:uint8','timeout:uint40']);
  const bounty=iface.getFunction('getBounty').outputs[0].components.map(c=>c.name);
  assert.ok(['juryK','juryM','juryN','juryP','juryTimeout'].every(f=>bounty.includes(f)));assert.ok(!bounty.includes('jury'));
  for(const gone of ['aggregatorOf','aggregators','aggregatorCount']) assert.equal(iface.getFunction(gone),null);
  assert.ok(iface.getFunction('aggregator'));
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
  for(const field of ['evaluationCid','requestedClass','threshold','submissionDeadline','targetHunter','creatorDeterminationPayment','arbiterDeterminationPayment','creatorAssessmentWindowSize','jury','quota','forfeitLine','bond']) {
    if(field==='jury') continue;
    const params={...expected.args[0],[field]: field==='evaluationCid'?'Qm'+'b'.repeat(44):field==='targetHunter'?ZeroAddress:BigInt(expected.args[0][field])+1n};
    assert.throws(()=>verifyTransaction({...tx,data:iface.encodeFunctionData('createBounty',[params])},expected));
  }
  for(const f of ['K','M','N','P','timeout']) {
    const params={...expected.args[0],jury:{...expected.args[0].jury,[f]:BigInt(expected.args[0].jury[f])+1n}};
    assert.throws(()=>verifyTransaction({...tx,data:iface.encodeFunctionData('createBounty',[params])},expected));
  }
  for(const oracle of [{...expected.args[0].oracle,minOracleFee:1n},{...expected.args[0].oracle,withBeacons:true}]) assert.throws(()=>verifyTransaction({...tx,data:iface.encodeFunctionData('createBounty',[{...expected.args[0],oracle}])},expected));
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
test('decision settings: a size-class preset (Bondless Small by default), overrides, and USD only at a reviewed price',()=>{
  const d=decisionTerms(config);
  const small={K:6n,M:5n,N:4n,P:3n,timeout:300n};
  assert.deepEqual({...d},{bountyClass:'bondless-small',className:'Bondless Small',jury:small,quota:3n,forfeitLine:1n,bond:0n,minOracleFee:0n,withBeacons:false});
  const p=creationTerms(config).params;
  assert.deepEqual([p.jury,p.quota,p.forfeitLine,p.bond,p.oracle.minOracleFee,p.oracle.withBeacons],[small,3n,1n,0n,0n,false]);
  // A preset with a USD bond or fee floor needs the wei amount, or an owner-reviewed ethUsd to convert it.
  assert.throws(()=>decisionTerms({...config,bountyClass:'medium'}),/Medium preset's bond is \$50: give bond in wei, or an owner-reviewed ethUsd/);
  assert.throws(()=>decisionTerms({...config,bountyClass:'medium',bond:'1'}),/fee floor is \$0.25: give oracle.minOracleFee in wei/);
  const medium=decisionTerms({...config,bountyClass:'medium',ethUsd:2500});
  assert.deepEqual([medium.jury,medium.quota,medium.forfeitLine,medium.bond,medium.minOracleFee,medium.withBeacons],[{K:8n,M:5n,N:4n,P:3n,timeout:300n},3n,2n,20000000000000000n,100000000000000n,false]);
  const jumbo=decisionTerms({...config,bountyClass:'jumbo',bond:'5',oracle:{...config.oracle,minOracleFee:'7'}});
  assert.equal(jumbo.withBeacons,true);assert.deepEqual(jumbo.jury,{K:50n,M:38n,N:27n,P:17n,timeout:600n});
  // No class named: the smallest class offered for the reward at ethUsd (0.001 ETH x $2500 = $2.50: Bondless Small; 0.2 ETH = $500: Medium).
  assert.equal(decisionTerms({...config,ethUsd:2500}).bountyClass,'bondless-small');
  assert.equal(decisionTerms({...config,bountyAmount:'0.2',ethUsd:2500}).bountyClass,'medium');
  // The creator's jury: any of K, M, N, P, timeout over the preset's.
  const custom=decisionTerms({...config,bountyClass:'small',bond:'123',jury:{K:7,timeout:600},quota:2,forfeitLine:0,oracle:{...config.oracle,withBeacons:true}});
  assert.deepEqual([custom.jury,custom.quota,custom.forfeitLine,custom.bond,custom.withBeacons],[{K:7n,M:5n,N:4n,P:3n,timeout:600n},2n,0n,123n,true]);
  assert.throws(()=>decisionTerms({...config,jury:1}),/aggregator index is no longer used/);
  assert.throws(()=>decisionTerms({...config,jury:{M:7}}),/bad jury/);
  assert.throws(()=>decisionTerms({...config,jury:{N:2,P:1}}),/bad jury/);
  assert.throws(()=>decisionTerms({...config,jury:{N:41,M:41,K:41}}),/bad jury/);
  assert.throws(()=>decisionTerms({...config,quota:5}),/exceeds the jury's N \(4\)/);
  assert.throws(()=>decisionTerms({...config,jury:{Q:3}}),/unknown field/);
  for(const bad of [{bountyClass:'huge'},{quota:0},{quota:2,forfeitLine:3},{jury:{K:256}},{jury:{timeout:0}},{bond:'-1'},{bond:(1n<<96n).toString()},{oracle:{...config.oracle,withBeacons:'yes'}}]) assert.throws(()=>decisionTerms({...config,...bad}));
  // Every setting goes to the API explicitly, so the server picks no class and converts no price.
  assert.deepEqual(decisionBody(medium),{bountyClass:'medium',jury:{K:8,M:5,N:4,P:3,timeout:300},quota:3,forfeitLine:2,bond:'20000000000000000',oracleMinOracleFee:'100000000000000',oracleWithBeacons:false});
});
test('the created bounty is read back field by field, the v2 settings included',()=>{
  const {params}=bindCreation(config,response),creator='0x3333333333333333333333333333333333333333';
  // getBounty carries the jury flat (juryK..juryTimeout)
  const {jury,...rest}=params;
  const bounty={...rest,creator,oracle:{...params.oracle},juryK:jury.K,juryM:jury.M,juryN:jury.N,juryP:jury.P,juryTimeout:jury.timeout};
  verifyCreatedBounty(bounty,params,creator);
  for(const change of [{quota:2n},{forfeitLine:0n},{bond:1n},{juryK:7n},{juryN:3n},{juryTimeout:600n},{oracle:{...params.oracle,withBeacons:true}},{oracle:{...params.oracle,minOracleFee:1n}}]) assert.throws(()=>verifyCreatedBounty({...bounty,...change},params,creator),/mismatch/);
});
test('closeCommits and promote go only to the aggregator the escrow names, with no value',()=>{
  const aggregator='0x4444444444444444444444444444444444444444',aggId='0x'+'ab'.repeat(32);
  const tx={to:aggregator,chainId:8453,value:'0',data:aggregatorIface.encodeFunctionData('promote',[aggId])};
  const expected={network:'base',method:'promote',args:[aggId],maxValueWei:0n,aggregator};
  assert.equal(verifyTransaction(tx,expected).to,aggregator);
  assert.throws(()=>verifyTransaction(tx,{...expected,aggregator:null}),/escrow\.aggregator\(\)/);
  assert.throws(()=>verifyTransaction({...tx,to:deployments.base.address},expected),/destination/);
  assert.throws(()=>verifyTransaction({...tx,data:aggregatorIface.encodeFunctionData('closeCommits',[aggId])},expected),/drift/);
  assert.throws(()=>verifyTransaction({...tx,data:aggregatorIface.encodeFunctionData('promote',['0x'+'cd'.repeat(32)])},expected),/drift/);
  assert.throws(()=>verifyTransaction({...tx,value:'1'},{...expected,value:1n,maxValueWei:1n}),/value/);
  // An escrow call is never accepted at the aggregator address.
  assert.throws(()=>verifyTransaction({...tx,data:iface.encodeFunctionData('finalizeSubmission',[1,2])},{network:'base',method:'finalizeSubmission',args:[1,2],maxValueWei:0n,aggregator}),/destination/);
});
test('until the v2 deployment is recorded, every escrow transaction stops with a clear message',async()=>{
  const {tx,expected}=fixture();
  await withPlaceholders(async()=>{
    assert.equal(deployments.base.status,'NOT_DEPLOYED');assert.equal(deployments.base.address,null);assert.equal(deployments['base-sepolia'].codeHash,null);
    for(const network of ['base','base-sepolia']) assert.throws(()=>escrowDeployment(network),new RegExp(`BountyEscrow v2 is not deployed on ${network} yet: scripts/deployments.json holds a placeholder.*never uses the v1 escrow`));
    assert.throws(()=>verifyTransaction(tx,expected),/not deployed on base yet/);
    await assert.rejects(verifyDeployment('base',{getNetwork:async()=>({chainId:8453n}),getCode:async()=>'0x1234'},{contract:{address:ZeroAddress,chainId:8453}}),/not deployed on base yet/);
  });
  // The placeholder file itself: no address, no code hash, and the v1 escrows named only in the note.
  const file=JSON.parse(readFileSync(new URL('../deployments.json',import.meta.url),'utf8'));
  for(const d of Object.values(file)) {assert.equal(d.status,'NOT_DEPLOYED');assert.equal(d.address,null);assert.equal(d.codeHash,null);assert.equal(d.escrowVersion,2);}
});
test('start uses exact live prepay value and owner cap',()=>{
  const tx={to:deployments.base.address,chainId:8453,value:'200',data:iface.encodeFunctionData('startPreparedSubmission',[1,2])};
  const expected={network:'base',method:'startPreparedSubmission',args:[1,2],value:200n,maxValueWei:300n};
  verifyTransaction(tx,expected);assert.throws(()=>verifyTransaction({...tx,value:'100'},expected));assert.throws(()=>verifyTransaction(tx,{...expected,maxValueWei:199n}));
});
test('deployment chain, destination, code and selectors verified without fallback',async()=>{
  const d=deployments.base, old=d.codeHash;d.codeHash=keccak256('0x1234');
  const docs={contract:{address:d.address,chainId:8453,functions:Object.fromEntries(DOCUMENTED_FUNCTIONS.map(n=>[n,{signature:iface.getFunction(n).format('full').replace(/^function /,'')}]))}};
  const provider={getNetwork:async()=>({chainId:8453n}),getCode:async()=> '0x1234'};
  try {
    assert.equal(await verifyDeployment('base',provider,docs),d.address);
    await assert.rejects(verifyDeployment('base',{...provider,getNetwork:async()=>({chainId:84532n})},docs));
    await assert.rejects(verifyDeployment('base',{...provider,getCode:async()=> '0xabcd'},docs));
    await assert.rejects(verifyDeployment('base',provider,{contract:{...docs.contract,address:ZeroAddress}}));
    // A site still documenting the v1 escrow: its createBounty struct has a different selector, and it has no startValue.
    const v1Create='createBounty((string evaluationCid, uint64 requestedClass, uint8 threshold, uint64 submissionDeadline, address targetHunter, uint256 creatorDeterminationPayment, uint256 arbiterDeterminationPayment, uint64 creatorAssessmentWindowSize, (uint256 maxOracleFee, uint256 alpha, uint256 estimatedBaseCost, uint256 maxFeeBasedScaling) oracle) p) payable returns (uint256 bountyId)';
    await assert.rejects(verifyDeployment('base',provider,{contract:{...docs.contract,functions:{...docs.contract.functions,createBounty:{signature:v1Create}}}}),/selector drift/);
    const {startValue,...v1Functions}=docs.contract.functions;
    await assert.rejects(verifyDeployment('base',provider,{contract:{...docs.contract,functions:v1Functions}}),/selector drift/);
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
