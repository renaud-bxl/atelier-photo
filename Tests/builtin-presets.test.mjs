import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {builtinPresets} from '../src/builtin-presets.js';
import {normalizeAdjustments,renderImage} from '../desktop/image-engine.mjs';

test('all 48 original styles render actual pixels, with unique names and no missing LUT/profile dependency',async()=>{
  assert.equal(builtinPresets.length,48);
  assert.equal(new Set(builtinPresets.map(p=>p.id)).size,48);
  assert.equal(new Set(builtinPresets.map(p=>p.name)).size,48);
  const width=256,height=64,pixels=new Uint16Array(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*3;pixels[i]=8000+x*160;pixels[i+1]=3000+y*600+x*30;pixels[i+2]=50000-x*120+y*20;
  }
  const source=await sharp(pixels,{raw:{width,height,channels:3}}).pipelineColourspace('rgb16').toColourspace('rgb16').png().toBuffer();
  const baseline=await renderImage(source,{}, {format:'png',bitDepth:16});
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),neutral=hash(baseline);
  const outputs=new Set();
  for(const style of builtinPresets){
    const recipe=normalizeAdjustments(style.adjustments);
    assert.equal(recipe.lutId,undefined,style.name);
    const output=await renderImage(source,recipe,{format:'png',bitDepth:16});
    const metadata=await sharp(output).metadata();
    assert.equal(metadata.depth,'ushort',style.name);
    assert.notEqual(hash(output),neutral,`${style.name}: unexpected neutral preset`);
    outputs.add(hash(output));
  }
  assert.ok(outputs.size>=44,`${outputs.size} distinct rendered styles`);
});
