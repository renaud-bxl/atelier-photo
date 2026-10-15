import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeSpatialBase64} from '../desktop/media-input.mjs';
test('large legitimate spatial screenshots do not overflow the validation stack',()=>{
  for(const bytes of [4,12,18]){
    const source=Buffer.alloc(bytes*1024*1024,173);
    assert.deepEqual(decodeSpatialBase64(source.toString('base64')),source);
  }
});
test('spatial screenshot boundary rejects over-limit, malformed alphabet and padding',()=>{
  for(const value of ['',null,'abc','AAA=AAAA','AAAA===','AA\nA','!!!!','A'.repeat(24*1024*1024+4)])assert.throws(()=>decodeSpatialBase64(value));
});
