import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rubricWeights } from '../../src/utils/rubricWeights.js';
const require=createRequire(import.meta.url);
const {validateRubric}=require('../../../server/utils/validation.js');
test('client weight feedback agrees with canonical server edge cases',()=>{
  for(const weights of [[0,0.5,0.5],[0,0.5,0.505],[0.1,0.5,0.5],[0,0,0],[0,NaN,1],[0,-0.1,1.1]]){
    const criteria=weights.map((weight,i)=>({id:String(i),description:'criterion',must:i===0,weight}));
    assert.equal(rubricWeights(criteria).valid,validateRubric({criteria}).valid);
  }
  // Only must-pass criteria: nothing to sum, valid on both sides.
  for(const n of [1,3]){
    const criteria=Array.from({length:n},(_,i)=>({id:String(i),description:'criterion',must:true,weight:0}));
    assert.equal(validateRubric({criteria}).valid,true);
    assert.equal(rubricWeights(criteria).valid,validateRubric({criteria}).valid);
  }
});
