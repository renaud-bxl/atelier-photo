/** Explicit network/native QA. Downloads only the official runtime, never weights. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createManagedOllama} from '../desktop/managed-ollama.mjs';

const directory=await mkdtemp(join(tmpdir(),'atelier-owned-runtime-qa-'));
const engine=createManagedOllama({userDataDirectory:directory});
const started=performance.now();
const signal=AbortSignal.timeout(10*60*1000);
let lastLog=0,lastPhase='',failure;
try{
  const before=await engine.status();
  assert.equal(before.supported,true);assert.equal(before.installed,false);assert.equal(before.running,false);
  await engine.install({signal,onProgress:event=>{
    const phase=event.phase||event.status||'preparing';
    if(phase!==lastPhase||performance.now()-lastLog>15000){
      lastLog=performance.now();lastPhase=phase;
      console.log('[managed-runtime-qa]',phase,Number.isFinite(event.totalBytes)&&event.totalBytes>0?`${Math.floor(100*(event.completedBytes||0)/event.totalBytes)}%`:'');
    }
  }});
  const installed=await engine.status();
  assert.equal(installed.installed,true);assert.equal(installed.running,false);
  const running=await engine.start({signal});
  assert.equal(running.running,true);
  const endpoint=new URL(running.endpoint);
  assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.protocol,'http:');
  const version=await (await fetch(new URL('/api/version',endpoint),{signal:AbortSignal.timeout(5000)})).json();
  assert.equal(version.version,running.version);
  const tags=await (await fetch(new URL('/api/tags',endpoint),{signal:AbortSignal.timeout(5000)})).json();
  assert.deepEqual(tags.models,[], 'the managed service must use its own empty model store');
  await engine.stop();
  assert.equal((await engine.status()).running,false);
  await assert.rejects(fetch(new URL('/api/version',endpoint),{signal:AbortSignal.timeout(3000)}));
  const reused=createManagedOllama({userDataDirectory:directory});
  assert.equal((await reused.status()).installed,true,'verified runtime can be reused after app restart');
  const proof={platform:process.platform,arch:process.arch,version:version.version,officialRuntimeInstalled:true,ownedServiceStarted:true,
    emptyPrivateModelStore:true,loopbackOnly:true,stopped:true,reused:true,elapsedMs:Math.round(performance.now()-started),modelWeightsDownloaded:false};
  await mkdir('test-artifacts',{recursive:true});
  await writeFile(join('test-artifacts',`managed-runtime-${process.platform}-${process.arch}.json`),JSON.stringify(proof,null,2)+'\n');
  console.log('ATELIER_MANAGED_RUNTIME_OK',JSON.stringify(proof));
}catch(error){failure=error;}
finally{
  try{await engine.stop();}catch(error){failure=failure?new AggregateError([failure,error],'Runtime QA cleanup failed'):error;}
  if(!failure)await rm(directory,{recursive:true,force:true});
  else console.error('Temporary runtime retained for diagnosis:',directory);
}
if(failure)throw failure;
