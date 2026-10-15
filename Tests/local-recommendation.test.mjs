import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {protectLocalRecommendation,LOCAL_PORTRAIT_CONTROLS} from '../desktop/local-recommendation.mjs';
import {renderImage} from '../desktop/image-engine.mjs';

// Reproduction of the controls observed during the real 2B trial. This is not
// presented as a byte-for-byte capture of the original model response.
const observed={local:true,adjustments:{exposure:.2,cropRatio:1,rotation:0,flipHorizontal:false,
  ...Object.fromEntries(LOCAL_PORTRAIT_CONTROLS.map(key=>[key,.1])),
  ...Object.fromEntries(['vibrance','highlights','shadows','sharpness','clarity','denoise','vignette'].map(key=>[key,.1]))},explanation:'Lumière légèrement relevée.'};

test('a schema-valid contradictory local recipe cannot change existing crop, rotation, perspective or mirror',()=>{
  const current={rotation:13,cropRatio:1.61803398875,cropX:.3,cropY:.6,flipHorizontal:true,perspectiveHorizontal:.1,perspectiveVertical:-.2};
  const before=structuredClone(observed),result=protectLocalRecommendation(observed,{currentAdjustments:current});
  for(const [key,value] of Object.entries(current))assert.equal(result.adjustments[key],value);
  assert.equal(result.adjustments.exposure,.2);assert.equal(result.constraints.geometryPreserved,true);
  assert.deepEqual(observed,before,'Safeguards must not mutate the model response or source settings');
});

test('all portrait controls are neutral without a detected face and retained only when a face was detected',()=>{
  const noFace=protectLocalRecommendation(observed),withFace=protectLocalRecommendation(observed,{facesDetected:true});
  for(const key of LOCAL_PORTRAIT_CONTROLS){assert.equal(noFace.adjustments[key],0);assert.equal(withFace.adjustments[key],.1);}
  assert.equal(noFace.constraints.portraitDisabled,true);assert.equal(withFace.constraints.portraitDisabled,false);
});

test('the observed unwanted square crop is prevented in a real 16-bit engine export',async()=>{
  const width=1024,height=512,samples=new Uint16Array(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)samples[(y*width+x)*3+c]=8000+x*24+y*4+c*900;
  const source=await sharp(samples,{raw:{width,height,channels:3}}).pipelineColourspace('rgb16').toColourspace('rgb16').png().toBuffer();
  const result=protectLocalRecommendation(observed);
  const output=await renderImage(source,result.adjustments,{format:'png',bitDepth:16}),metadata=await sharp(output).metadata();
  assert.equal(metadata.width,width);assert.equal(metadata.height,height);assert.equal(metadata.bitsPerSample,16);
  const raw=await sharp(output).toColourspace('rgb16').raw({depth:'ushort'}).toBuffer();
  const values=new Uint16Array(raw.buffer,raw.byteOffset,raw.byteLength/2);
  assert.ok(new Set(Array.from({length:width},(_,x)=>values[(Math.floor(height/2)*width+x)*3])).size>256);
});
