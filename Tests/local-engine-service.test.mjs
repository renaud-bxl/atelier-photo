import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalEngineService} from '../desktop/local-engine-service.mjs';
import {normalizeLocalConfig} from '../desktop/local-runtime.mjs';

const MODEL='qwen3-vl:2b-instruct';
function fixture(overrides={}){
  const calls=[],events=[];
  let installed=false,running=false;
  const state=()=>({supported:true,installed,running,version:'0.40.4',endpoint:running?'http://127.0.0.1:54321/':null,modelsDirectory:'/private/atelier/models'});
  const engine={
    status:async()=>{calls.push('status');return state();},
    install:async({signal,onProgress})=>{calls.push('install');signal.throwIfAborted();onProgress({phase:'download',completedBytes:12,totalBytes:24});installed=true;return state();},
    start:async({signal}={})=>{calls.push('start');signal?.throwIfAborted();if(!installed)throw new Error('Missing runtime');running=true;return state();},
    stop:async()=>{calls.push('stop');running=false;},...overrides.engine,
  };
  const diagnostics={
    hardware:async options=>{calls.push(['hardware',options]);return options;},
    recommendations:async options=>{calls.push(['recommendations',options]);return [options];},
    checkModel:async(model,options,download)=>{calls.push(['check',model,options,download]);},...overrides.diagnostics,
  };
  const service=createLocalEngineService({engine,diagnostics,onProgress:event=>events.push(event),
    makeDirectory:async(path)=>{calls.push(['mkdir',path]);},
    client:({endpoint})=>({pullModel:async(model,{signal,onProgress})=>{calls.push(['pull',endpoint,model]);signal.throwIfAborted();onProgress({status:'success',completedBytes:24,totalBytes:24});return {name:model,local:true,capabilities:['vision']};}}),...overrides.service});
  return {service,calls,events,engine};
}

test('managed mode is opt-in and survives normalized settings without a transient endpoint',()=>{
  assert.equal(normalizeLocalConfig({model:MODEL}).engineMode,'external');
  const normalized=normalizeLocalConfig({engineMode:'managed',model:MODEL});
  assert.equal(normalized.engineMode,'managed');
  assert.equal(normalized.ollamaURL,'http://127.0.0.1:11434/');
  for(const engineMode of ['cloud',null,{},true]){
    if(engineMode===null)continue;
    assert.throws(()=>normalizeLocalConfig({engineMode}));
  }
});

test('opening a managed snapshot only reads state and preserves the external configuration',async()=>{
  const {service,calls}=fixture();
  const snapshot=await service.status();
  assert.equal(snapshot.installed,false);assert.equal(snapshot.job,null);
  assert.deepEqual(calls,['status']);
  const external=normalizeLocalConfig({engineMode:'external',ollamaURL:'http://localhost:11435',modelsDirectory:'/external/models'});
  assert.deepEqual(await service.resolve(external,{start:true}),external);
  assert.deepEqual(calls,['status']);
});

test('managed diagnostics measure the real private model destination rather than a renderer path',async()=>{
  const {service,calls}=fixture();
  const options=await service.hardware({engineMode:'managed',modelsDirectory:'/wrong/volume'});
  assert.equal(options.modelsDirectory,'/private/atelier/models');
  assert.deepEqual(calls.slice(0,2),['status',['mkdir','/private/atelier/models']]);
  assert.ok(!calls.includes('start'));assert.ok(!calls.includes('install'));
});

test('confirmed resource failure prevents runtime installation and process startup',async()=>{
  const {service,calls}=fixture({diagnostics:{checkModel:async()=>{throw new Error('Insufficient RAM');}}});
  await assert.rejects(service.install(),/Insufficient RAM/);
  assert.ok(!calls.includes('install'));assert.ok(!calls.includes('start'));assert.equal(service.busy,false);
  assert.equal((await service.status()).lastResult.error,'Insufficient RAM');
});

test('runtime setup completes before start; models remain a separate explicit download',async()=>{
  const {service,calls,events}=fixture();
  await service.install();
  const check=calls.findIndex(call=>Array.isArray(call)&&call[0]==='check');
  assert.ok(check>=0&&check<calls.indexOf('install')&&calls.indexOf('install')<calls.indexOf('start'));
  assert.ok(!calls.some(call=>Array.isArray(call)&&call[0]==='pull'));
  assert.ok(events.some(event=>event?.kind==='local-runtime'&&event.completedBytes===12));
  assert.equal(events.at(-1),null);assert.equal(service.busy,false);
  const config=await service.resolve({engineMode:'managed',modelsDirectory:'/untrusted',ollamaURL:'http://localhost:11435'});
  assert.equal(config.modelsDirectory,'/private/atelier/models');assert.equal(config.ollamaURL,'http://127.0.0.1:54321/');
});

test('a managed model pull targets only our owned engine and reports completion independently of a view',async()=>{
  const {service,calls}=fixture();
  await service.install();
  const result=await service.pull({engineMode:'managed',model:MODEL,ollamaURL:'http://localhost:11435',modelsDirectory:'/untrusted'});
  assert.equal(result.name,MODEL);
  assert.deepEqual(calls.find(call=>Array.isArray(call)&&call[0]==='pull'),['pull','http://127.0.0.1:54321/',MODEL]);
  const snapshot=await service.status();
  assert.deepEqual(snapshot.lastResult,{kind:'model',model:MODEL,success:true});assert.equal(snapshot.job,null);
});

test('arbitrary model names cannot cause a runtime launch or a download',async()=>{
  const {service,calls}=fixture();
  await assert.rejects(service.pull({engineMode:'managed',model:'arbitrary-cloud'}),/recommandé/);
  assert.deepEqual(calls,[]);
});

test('a runtime job can be observed and cancelled after the original view has disappeared',async()=>{
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const {service,calls}=fixture({engine:{install:async({signal,onProgress})=>{
    onProgress({phase:'download',completedBytes:10,totalBytes:100});started();
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }}});
  const operation=service.install();await ready;
  const snapshot=await service.status();
  assert.equal(snapshot.job.kind,'runtime');assert.equal(snapshot.job.completedBytes,10);assert.equal(service.busy,true);
  await assert.rejects(service.install(),/déjà en cours/);
  service.cancel('model');assert.equal(service.busy,true);
  service.cancel('runtime');assert.deepEqual(await operation,{cancelled:true});
  assert.equal(service.busy,false);assert.ok(!calls.includes('start'));
  assert.equal((await service.status()).lastResult.cancelled,true);
});

test('shutdown aborts an in-flight task and stops only the supplied owned engine',async()=>{
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const {service,calls}=fixture({engine:{install:async({signal})=>{
    started();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }}});
  const operation=service.install();await ready;await service.shutdown();
  assert.deepEqual(await operation,{cancelled:true});assert.equal(service.busy,false);
  assert.ok(calls.filter(call=>call==='stop').length>=1);assert.ok(!calls.includes('start'));
});
