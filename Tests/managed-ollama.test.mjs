import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync,zstdCompressSync} from 'node:zlib';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createManagedOllama,managedOllamaRelease,downloadVerifiedArchive,extractManagedArchive,MANAGED_OLLAMA_VERSION} from '../desktop/managed-ollama.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const binary=Buffer.from('synthetic-ollama-executable\n'),runner=Buffer.from('synthetic-worker\n');
function makeTar(entries){
  const chunks=[];
  for(const {name,data=Buffer.alloc(0),type='0',link='',mode=0o755} of entries){
    const header=Buffer.alloc(512),octal=(offset,length,value)=>header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
    header.write(name,0,100);octal(100,8,mode);octal(108,8,0);octal(116,8,0);octal(124,12,data.length);octal(136,12,0);
    header.fill(32,148,156);header.write(type,156,1);header.write(link,157,100);header.write('ustar\0',257,6);header.write('00',263,2);
    const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
  }
  return Buffer.concat([...chunks,Buffer.alloc(1024)]);
}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function makeZip(entries){
  const files=[],central=[];let offset=0;
  for(const {name,data=binary,mode=0o100755} of entries){
    const filename=Buffer.from(name),local=Buffer.alloc(30),directory=Buffer.alloc(46),checksum=crc32(data);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);
    directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE((3<<8)|20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE((mode<<16)>>>0,38);directory.writeUInt32LE(offset,42);
    files.push(local,filename,data);central.push(directory,filename);offset+=local.length+filename.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...files,directory,end]);
}
async function temporary(t){const path=await fs.mkdtemp(join(tmpdir(),'atelier-managed-ollama-'));t.after(()=>fs.rm(path,{recursive:true,force:true}));return path;}
function releaseFor(bytes,{platform='darwin',format='tgz',executable='ollama',maxExtractedBytes=65536}={}){
  return {...managedOllamaRelease(platform,'x64'),bytes:bytes.length,sha256:sha(bytes),format,executable,maxExtractedBytes,requiredDiskBytes:100000};
}
async function fixture(t,options={}){
  const directory=await temporary(t),platform=options.platform??'darwin';
  const bytes=options.bytes??gzipSync(makeTar([{name:'./ollama',data:binary},{name:'./llama-server',data:runner},{name:'THIRD_PARTY_LICENSE',data:Buffer.from('fixture licence'),mode:0o644}]));
  const release=releaseFor(bytes,{platform,...options}),calls={downloads:0,spawns:[],terminated:[],progress:[]};
  const dependencies={release,freeDisk:async()=>1000000,download:async(definition,path)=>{calls.downloads++;await fs.writeFile(path,bytes);},
    spawn:(path,args,configuration)=>{const child=new EventEmitter();child.pid=43210;child.exitCode=null;child.signalCode=null;calls.spawns.push({path,args,configuration,child});return child;},
    reservePort:async()=>42321,ownsPort:async()=>true,probe:async()=>MANAGED_OLLAMA_VERSION,
    terminate:async child=>{calls.terminated.push(child.pid);child.exitCode=0;child.emit('exit',0,null);},startupTimeoutMs:50,pollMs:2,
    ...options.dependencies};
  const manager=createManagedOllama({userDataDirectory:join(directory,'App Data'),platform,arch:'x64',environment:{PATH:'/safe-bin',HOME:'/real-user',USERPROFILE:'C:\\real-user',OPENAI_API_KEY:'never-inherit',HTTP_PROXY:'http://proxy.invalid',OLLAMA_HOST:'http://cloud.invalid',OLLAMA_MODELS:'/user-models'},onProgress:event=>calls.progress.push(event),dependencies});
  return {manager,directory,calls,release,bytes};
}
function fakeHTTPS(steps){
  const calls=[];
  const request=(url,options,callback)=>{
    calls.push(String(url));const req=new EventEmitter();let response;
    req.setTimeout=()=>req;req.destroy=error=>{response?.destroy(error);queueMicrotask(()=>req.emit('error',error));};
    const cancel=()=>req.destroy(new DOMException('cancelled','AbortError'));
    options.signal?.addEventListener('abort',cancel,{once:true});
    queueMicrotask(()=>{
      if(options.signal?.aborted)return;
      const next=steps.shift();if(!next){req.emit('error',new Error('unexpected request'));return;}
      response=Readable.from(next.chunks??[]);response.statusCode=next.status??200;response.headers=next.headers??{};
      response.once('close',()=>options.signal?.removeEventListener('abort',cancel));callback(response);
    });return req;
  };
  return {request,calls};
}

test('only the four application targets select immutable upstream v0.40.4 assets',()=>{
  for(const [platform,arch] of [['darwin','arm64'],['darwin','x64'],['win32','x64'],['linux','x64']]){
    const release=managedOllamaRelease(platform,arch);assert.ok(release);assert.match(release.url,/^https:\/\/github\.com\/ollama\/ollama\/releases\/download\/v0\.40\.4\//);assert.match(release.sha256,/^[a-f0-9]{64}$/);assert.ok(release.requiredDiskBytes>release.bytes+release.maxExtractedBytes);
  }
  assert.equal(managedOllamaRelease('linux','arm64'),null);assert.equal(managedOllamaRelease('win32','arm64'),null);
  assert.equal(managedOllamaRelease('darwin','ia32'),null);assert.equal(managedOllamaRelease('freebsd','x64'),null);
});

test('factory and missing/unsupported status perform no download or launch',async t=>{
  const f=await fixture(t);assert.equal(f.calls.downloads,0);assert.deepEqual(f.calls.spawns,[]);
  const status=await f.manager.status();assert.equal(status.installed,false);assert.equal(status.running,false);assert.equal(status.endpoint,'');assert.equal(status.license,'MIT');assert.equal(status.downloadBytes,f.bytes.length);assert.equal(status.requiredDiskBytes,100000);
  await assert.rejects(f.manager.start(),/Installez d’abord/);assert.equal(f.calls.downloads,0);
  const directory=join(f.directory,'unsupported');const unsupported=createManagedOllama({userDataDirectory:directory,platform:'linux',arch:'arm64'});
  assert.equal((await unsupported.status()).supported,false);await assert.rejects(unsupported.install(),/architecture/);await assert.rejects(fs.access(directory));
});

test('official redirect download streams exact bytes and verifies the pinned digest',async t=>{
  const directory=await temporary(t),bytes=Buffer.from('verified fixture archive'),release=releaseFor(bytes),events=[];
  const transport=fakeHTTPS([{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset?signature=private'}},{chunks:[bytes.subarray(0,7),bytes.subarray(7)],headers:{'content-length':String(bytes.length)}}]);
  const path=join(directory,'archive');await downloadVerifiedArchive(release,path,{request:transport.request,onProgress:e=>events.push(e)});
  assert.deepEqual(await fs.readFile(path),bytes);assert.equal(transport.calls.length,2);assert.ok(events.every(e=>e.kind==='local-runtime'));assert.equal(events.at(-1).phase,'verify');
});

test('download refuses redirects outside HTTPS official hosts and hides server error bodies',async t=>{
  const directory=await temporary(t),release=releaseFor(Buffer.from('fixture'));
  for(const location of ['http://127.0.0.1/private','https://attacker.invalid/file','https://github.com/other/repository','https://user:password@objects.githubusercontent.com/file']){
    const transport=fakeHTTPS([{status:302,headers:{location}}]);await assert.rejects(downloadVerifiedArchive(release,join(directory,'never'),{request:transport.request}),error=>!error.message.includes('password')&&/officiel/.test(error.message));assert.equal(transport.calls.length,1);
  }
  const transport=fakeHTTPS([{status:403,chunks:[Buffer.from('private-token-secret')]}]);
  await assert.rejects(downloadVerifiedArchive(release,join(directory,'error'),{request:transport.request}),error=>!error.message.includes('private-token-secret'));
});

test('download rejects wrong length, overflow, truncation and digest before extraction',async t=>{
  const directory=await temporary(t),bytes=Buffer.from('fixture'),release=releaseFor(bytes);
  const cases=[{headers:{'content-length':'1000'},chunks:[bytes]},{chunks:[Buffer.concat([bytes,bytes])]},{chunks:[bytes.subarray(0,3)]},{chunks:[Buffer.from('changed')]}];
  for(let i=0;i<cases.length;i++){
    const transport=fakeHTTPS([cases[i]]);await assert.rejects(downloadVerifiedArchive(release,join(directory,String(i)),{request:transport.request}),/taille ou l’empreinte/);
  }
});

test('tar installation commits atomically, keeps worker permissions and licences, and reuses verified files',async t=>{
  const f=await fixture(t);const [first,second]=await Promise.all([f.manager.install(),f.manager.install()]);
  assert.equal(first.installed,true);assert.equal(second.installed,true);assert.equal(f.calls.downloads,1);
  assert.deepEqual(await fs.readFile(join(first.runtimeDirectory,'ollama')),binary);assert.deepEqual(await fs.readFile(join(first.runtimeDirectory,'llama-server')),runner);
  if(process.platform!=='win32')assert.ok((await fs.stat(join(first.runtimeDirectory,'llama-server'))).mode&0o100,'runner must remain executable');
  assert.match(await fs.readFile(join(first.runtimeDirectory,'OLLAMA_LICENSE.txt'),'utf8'),/Copyright \(c\) Ollama/);
  assert.equal(await fs.readFile(join(first.runtimeDirectory,'THIRD_PARTY_LICENSE'),'utf8'),'fixture licence');
  assert.equal((await f.manager.install()).installed,true);assert.equal(f.calls.downloads,1);
  assert.deepEqual((await fs.readdir(dirname(first.runtimeDirectory))).filter(name=>name.startsWith('.install')),[]);
});

test('Windows ZIP and Linux zstd use their real distribution layouts without external commands',async t=>{
  for(const [platform,format,executable,bytes] of [
    ['win32','zip','ollama.exe',makeZip([{name:'ollama.exe'},{name:'lib/ollama/library.dll',data:runner}])],
    ['linux','tar.zst','bin/ollama',zstdCompressSync(makeTar([{name:'./bin/ollama',data:binary},{name:'./lib/ollama/library.so',data:runner}]))]
  ]){
    const f=await fixture(t,{platform,format,executable,bytes});const status=await f.manager.install();assert.equal(status.installed,true);assert.deepEqual(await fs.readFile(join(status.runtimeDirectory,...executable.split('/'))),binary);
  }
});

test('internal tar library links survive while escaping or writing-through links are refused',async t=>{
  if(process.platform==='win32'){t.skip('symlink fixture needs ordinary POSIX user permissions');return;}
  const directory=await temporary(t);
  const entries=[{name:'ollama',data:binary},{name:'lib/cuda/library.so',data:runner},{name:'lib/mlx/library.so',type:'2',link:'../cuda/library.so'}];
  const bytes=gzipSync(makeTar(entries)),archive=join(directory,'good.tgz'),output=join(directory,'good');await fs.writeFile(archive,bytes);
  await extractManagedArchive(releaseFor(bytes),archive,output);assert.deepEqual(await fs.readFile(join(output,'lib/mlx/library.so')),runner);
  for(const [index,unsafe] of [
    [{name:'../escape',data:binary}],
    [{name:'ollama',data:binary},{name:'link',type:'2',link:'../../escape'}],
    [{name:'ollama',data:binary},{name:'link',type:'2',link:'inside'},{name:'link/overwrite',data:runner}],
    [{name:'/absolute',data:binary}]
  ].entries()){
    const invalid=gzipSync(makeTar(unsafe)),path=join(directory,'invalid-'+index);await fs.writeFile(path,invalid);
    await assert.rejects(extractManagedArchive(releaseFor(invalid),path,join(directory,'out-'+index)),/archive/);
  }
  await assert.rejects(fs.access(join(directory,'escape')));
});

test('archive limits and ZIP traversal/special entries fail closed',async t=>{
  const directory=await temporary(t);
  const cases=[
    {bytes:gzipSync(makeTar([{name:'ollama',data:binary}])),format:'tgz',executable:'ollama',maxExtractedBytes:2},
    {bytes:makeZip([{name:'../ollama.exe'}]),format:'zip',executable:'ollama.exe'},
    {bytes:makeZip([{name:'ollama.exe',mode:0o120777}]),format:'zip',executable:'ollama.exe'},
    {bytes:makeZip([{name:'ollama.exe'},{name:'CON.txt'}]),format:'zip',executable:'ollama.exe'}
  ];
  for(const [i,item] of cases.entries()){const path=join(directory,'archive-'+i);await fs.writeFile(path,item.bytes);await assert.rejects(extractManagedArchive(releaseFor(item.bytes,item),path,join(directory,'out-'+i)),/archive/);}
});

test('a rejected tar header after asynchronous file writes becomes a controlled rejection',async t=>{
  const directory=await temporary(t),bytes=gzipSync(makeTar([{name:'ollama',data:binary},{name:'large-worker',data:Buffer.alloc(1024*1024,71)},{name:'../escape',data:runner}]));
  const archive=join(directory,'chunked.tgz');await fs.writeFile(archive,bytes);
  await assert.rejects(extractManagedArchive(releaseFor(bytes,{maxExtractedBytes:2*1024*1024}),archive,join(directory,'output')),/archive/);
  await assert.rejects(fs.access(join(directory,'escape')));
});

test('cancellation during streamed tar extraction closes the stage before cleanup',async t=>{
  const controller=new AbortController(),bytes=gzipSync(makeTar([{name:'ollama',data:binary},{name:'large-worker',data:Buffer.alloc(4*1024*1024,73)}]));
  const f=await fixture(t,{bytes,maxExtractedBytes:8*1024*1024,dependencies:{extract:async(...args)=>{setTimeout(()=>controller.abort(),2);await extractManagedArchive(...args);}}});
  await assert.rejects(f.manager.install({signal:controller.signal}),{name:'AbortError'});
  const status=await f.manager.status();assert.equal(status.installed,false);assert.deepEqual(await fs.readdir(dirname(status.runtimeDirectory)),[]);
});

test('insufficient or unknown storage blocks downloads and preserves existing models',async t=>{
  for(const freeDisk of [async()=>0,async()=>NaN,async()=>{throw new Error('private disk path');}]){
    const f=await fixture(t,{dependencies:{freeDisk}}),status=await f.manager.status();await fs.mkdir(status.modelsDirectory,{recursive:true});await fs.writeFile(join(status.modelsDirectory,'keep'),'my model');
    await assert.rejects(f.manager.install(),error=>/disque/.test(error.message)&&!error.message.includes('private disk path'));
    assert.equal(f.calls.downloads,0);assert.equal(await fs.readFile(join(status.modelsDirectory,'keep'),'utf8'),'my model');
  }
});

test('cancelled download cleans only its stage/lock, keeps user models, and can retry',async t=>{
  const controller=new AbortController();let entered;const begun=new Promise(ok=>{entered=ok;});
  const f=await fixture(t,{dependencies:{download:async(release,path,{signal})=>{await fs.writeFile(path,'partial');entered();await new Promise((ok,no)=>signal.addEventListener('abort',()=>no(new DOMException('cancel','AbortError')),{once:true}));}}});
  const status=await f.manager.status();await fs.mkdir(status.modelsDirectory,{recursive:true});await fs.writeFile(join(status.modelsDirectory,'keep'),'my model');
  const pending=f.manager.install({signal:controller.signal});await begun;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual((await fs.readdir(dirname(status.runtimeDirectory))).sort(),['models']);assert.equal(await fs.readFile(join(status.modelsDirectory,'keep'),'utf8'),'my model');
  assert.equal((await f.manager.status()).installed,false);
});

test('an identified dead installer can resume without deleting unrelated folders or models',async t=>{
  const f=await fixture(t,{dependencies:{processAlive:pid=>pid===process.pid}}),status=await f.manager.status(),root=dirname(status.runtimeDirectory);
  const stage='.install-v0.40.4-abandoned-fixture',abandoned=join(root,stage),unrelated=join(root,'.install-v0.40.4-user-stuff');
  const owner={kind:'atelier-managed-ollama-install',version:'0.40.4',pid:242424,token:'11111111-1111-4111-8111-111111111111',stage};
  await fs.mkdir(abandoned,{recursive:true});await fs.writeFile(join(abandoned,'.atelier-stage-owner.json'),JSON.stringify(owner));await fs.writeFile(join(abandoned,'partial-archive'),'partial');
  await fs.link(join(abandoned,'.atelier-stage-owner.json'),join(root,'.install-lock-v0.40.4'));await fs.mkdir(unrelated);await fs.writeFile(join(unrelated,'keep'),'user data');await fs.mkdir(status.modelsDirectory);await fs.writeFile(join(status.modelsDirectory,'keep'),'model');
  assert.equal((await f.manager.install()).installed,true);await assert.rejects(fs.access(abandoned));assert.equal(await fs.readFile(join(unrelated,'keep'),'utf8'),'user data');assert.equal(await fs.readFile(join(status.modelsDirectory,'keep'),'utf8'),'model');
});

test('a live or unidentifiable installer lock is refused and preserved',async t=>{
  for(const identify of [true,false]){
    const f=await fixture(t,{dependencies:{processAlive:()=>true}}),status=await f.manager.status(),root=dirname(status.runtimeDirectory);await fs.mkdir(root,{recursive:true});
    const path=join(root,'.install-lock-v0.40.4'),bytes=identify?JSON.stringify({kind:'atelier-managed-ollama-install',version:'0.40.4',pid:process.pid,token:'22222222-2222-4222-8222-222222222222',stage:'.install-v0.40.4-other'}):'unidentified user file';
    await fs.writeFile(path,bytes);await assert.rejects(f.manager.install(),/déjà en cours/);assert.equal(await fs.readFile(path,'utf8'),bytes);assert.equal(f.calls.downloads,0);
  }
});

test('a tampered executable or installation manifest is never reused, replaced or deleted',async t=>{
  for(const target of ['ollama','atelier-install.json']){
    const f=await fixture(t),status=await f.manager.install(),path=join(status.runtimeDirectory,target);await fs.appendFile(path,'tampered');
    assert.equal((await f.manager.status()).installed,false);await assert.rejects(f.manager.start(),/modifiée/);await assert.rejects(f.manager.install(),/modifiée/);
    assert.match(await fs.readFile(path,'utf8'),/tampered$/);assert.equal(f.calls.downloads,1);assert.equal(f.calls.spawns.length,0);
  }
});

test('private root symlinks cannot redirect installation into user directories',async t=>{
  if(process.platform==='win32'){t.skip('symlink fixture needs ordinary POSIX user permissions');return;}
  const f=await fixture(t),status=await f.manager.status(),outside=join(f.directory,'outside');await fs.mkdir(outside);await fs.mkdir(dirname(dirname(status.runtimeDirectory)),{recursive:true});await fs.symlink(outside,dirname(status.runtimeDirectory));
  await assert.rejects(f.manager.install());assert.deepEqual(await fs.readdir(outside),[]);assert.equal(f.calls.downloads,0);
});

test('managed launch isolates home/models/cloud/proxy/secrets and stops only its own process',async t=>{
  const f=await fixture(t);await f.manager.install();const [a,b]=await Promise.all([f.manager.start(),f.manager.start()]);assert.equal(a.running,true);assert.equal(b.endpoint,'http://127.0.0.1:42321/');assert.equal(f.calls.spawns.length,1);
  const {configuration,args}=f.calls.spawns[0],env=configuration.env;assert.deepEqual(args,['serve']);assert.equal(configuration.shell,false);assert.equal(configuration.detached,true);
  assert.equal(env.HOME,env.USERPROFILE);assert.equal(env.OLLAMA_MODELS,a.modelsDirectory);assert.ok(env.HOME.startsWith(f.directory));assert.equal(env.OLLAMA_HOST,a.endpoint);assert.equal(env.OLLAMA_NO_CLOUD,'1');assert.equal(env.OLLAMA_NUM_PARALLEL,'1');assert.equal(env.OLLAMA_MAX_LOADED_MODELS,'1');assert.equal(env.OLLAMA_CONTEXT_LENGTH,'4096');assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.HTTP_PROXY,undefined);
  assert.equal((await f.manager.status()).running,true);await f.manager.stop();assert.deepEqual(f.calls.terminated,[43210]);assert.equal((await f.manager.status()).running,false);await f.manager.stop();assert.equal(f.calls.terminated.length,1);
});

test('readiness refuses a colliding third-party service without probing it',async t=>{
  let probes=0;const f=await fixture(t,{dependencies:{ownsPort:async()=>false,probe:async()=>{probes++;return MANAGED_OLLAMA_VERSION;},startupTimeoutMs:15}});await f.manager.install();
  await assert.rejects(f.manager.start(),/délai/);assert.equal(probes,0);assert.deepEqual(f.calls.terminated,[43210]);assert.equal((await f.manager.status()).endpoint,'');
});

test('wrong version, child error/exit and startup cancellation never publish a ready endpoint',async t=>{
  const setups=[
    {probe:async()=>'0.1.0'},
    {probe:async()=>{throw new Error('private underlying response');},startupTimeoutMs:10},
    {spawn:()=>{const child=new EventEmitter();child.pid=43210;child.exitCode=null;queueMicrotask(()=>child.emit('error',new Error('private machine path')));return child;}},
    {spawn:()=>{const child=new EventEmitter();child.pid=43210;child.exitCode=null;queueMicrotask(()=>{child.exitCode=1;child.emit('exit',1,null);});return child;}}
  ];
  for(const dependencies of setups){const f=await fixture(t,{dependencies});await f.manager.install();await assert.rejects(f.manager.start(),error=>!error.message.includes('private'));assert.equal((await f.manager.status()).running,false);assert.equal(f.calls.terminated.length,1);}
  const controller=new AbortController(),f=await fixture(t,{dependencies:{ownsPort:async()=>false,startupTimeoutMs:1000}});await f.manager.install();
  const pending=f.manager.start({signal:controller.signal});setTimeout(()=>controller.abort(),10);await assert.rejects(pending,{name:'AbortError'});assert.equal(f.calls.terminated.length,1);assert.equal((await f.manager.status()).endpoint,'');
});

test('stop while starting cancels the start and terminates the owned child once',async t=>{
  let launched;const began=new Promise(ok=>{launched=ok;});const f=await fixture(t,{dependencies:{ownsPort:async()=>{launched();return false;},startupTimeoutMs:1000}});await f.manager.install();
  const starting=f.manager.start();await began;const rejected=assert.rejects(starting,{name:'AbortError'});await f.manager.stop();await rejected;assert.deepEqual(f.calls.terminated,[43210]);
});
