import test from 'node:test';
import assert from 'node:assert/strict';
import {depthDimensions,depthTensor,normalizeDepth} from '../src/depth-core.js';
test('depth model preprocessing preserves RGB order, CHW layout and ImageNet normalization',()=>{
  const data=depthTensor(Uint8ClampedArray.from([255,0,127,255,0,255,64,0]),2,1);
  const expected=[(1-.485)/.229,(0-.485)/.229,(0-.456)/.224,(1-.456)/.224,(127/255-.406)/.225,(64/255-.406)/.225];
  data.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-6));
  assert.throws(()=>depthTensor(new Uint8Array(5),1,1));
});
test('depth inference bounds dimensions to 518 and multiples of 14',()=>{
  for(const [width,height] of [[6000,4000],[800,1200],[10000,30]]){
    const size=depthDimensions(width,height);assert.equal(size.width%14,0);assert.equal(size.height%14,0);assert.ok(Math.max(size.width,size.height)<=518);
  }
  assert.throws(()=>depthDimensions(0,900));
});
test('relative depth normalization rejects NaN, clips outliers and keeps constant scenes flat',()=>{
  assert.deepEqual([...normalizeDepth(new Float32Array([3,3,3]))],[128,128,128]);
  const result=normalizeDepth(Float32Array.from({length:100},(_,i)=>i));assert.equal(result[0],0);assert.equal(result[99],255);assert.ok(result[50]>result[20]);
  assert.throws(()=>normalizeDepth(new Float32Array([NaN])));
});
