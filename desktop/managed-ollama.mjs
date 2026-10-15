import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {get as httpsGet} from 'node:https';
import {createServer} from 'node:net';
import {spawn as spawnProcess,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve,relative,dirname,isAbsolute,posix,sep,basename} from 'node:path';
import {Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGunzip,createZstdDecompress,constants as zlibConstants} from 'node:zlib';
import * as tar from 'tar';
import yauzl from 'yauzl';
import {localRequest,readLocalJSON} from './loopback-http.mjs';

// Only upstream release assets are accepted in production. Ollama is MIT;
// bundled library licences/notices remain alongside its extracted binaries.
export const MANAGED_OLLAMA_VERSION='0.40.4';
export const MANAGED_OLLAMA_LICENSE=Object.freeze({name:'MIT',url:'https://github.com/ollama/ollama/blob/v0.40.4/LICENSE',
  notice:'Ollama est distribué sous licence MIT. Les bibliothèques incluses conservent leurs licences et notices dans le dossier du moteur.'});
const OLLAMA_MIT=`MIT License

Copyright (c) Ollama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const GiB=1024**3,MiB=1024**2;
const asset=(name,bytes,sha256,format,executable,maxExtractedBytes)=>Object.freeze({name,bytes,sha256,format,executable,maxExtractedBytes,
  url:`https://github.com/ollama/ollama/releases/download/v${MANAGED_OLLAMA_VERSION}/${name}`,
  requiredDiskBytes:bytes+maxExtractedBytes+512*MiB});
const MAC=asset('ollama-darwin.tgz',167884528,'a4ceae4b2aaf18df37ebcbfb56ba3a37a87838631112d66c2be07268693c8d58','tgz','ollama',GiB);
const WINDOWS=asset('ollama-windows-amd64.zip',1469916992,'7485a1172f8527db4342a63521b9342fc466185ff0855da378cc864ecf6354cf','zip','ollama.exe',6*GiB);
const LINUX=asset('ollama-linux-amd64.tar.zst',1436408810,'15f31e9576d15a481e099b4145dba6e9f8c1f295927d6b8895300ae30ed3740a','tar.zst','bin/ollama',6*GiB);
export function managedOllamaRelease(platform=process.platform,arch=process.arch){
  if(platform==='darwin'&&['arm64','x64'].includes(arch))return MAC;
  if(platform==='win32'&&arch==='x64')return WINDOWS;
  if(platform==='linux'&&arch==='x64')return LINUX;
  return null;
}
const ERR=Object.freeze({unsupported:'Ce système ou cette architecture ne prend pas en charge le moteur local géré.',
  invalid:'L’installation du moteur local est incomplète ou a été modifiée. Son dossier a été conservé.',
  missing:'Installez d’abord le moteur local depuis les réglages IA.',
  disk:'L’espace disque disponible est insuffisant pour installer le moteur local.',
  diskUnknown:'Impossible de vérifier l’espace disque pour installer le moteur local.',
  busy:'Une installation du moteur local est déjà en cours.',
  install:'L’installation du moteur local a échoué. Vérifiez le dossier des données de l’application.',
  download:'Le téléchargement officiel du moteur local a échoué. Réessayez.',
  integrity:'La taille ou l’empreinte du téléchargement du moteur local ne correspond pas à la version attendue.',
  archive:'L’archive du moteur local contient une entrée non sûre ou dépasse les limites autorisées.',
  start:'Le moteur local n’a pas pu démarrer. Vérifiez les ressources et la compatibilité de cet ordinateur.',
  timeout:'Le moteur local n’a pas répondu dans le délai prévu.',
  version:'La version du moteur local ne correspond pas à la version installée.',
  stop:'Impossible de confirmer l’arrêt du moteur local géré.'});
const abortError=()=>new DOMException('Installation ou démarrage du moteur local annulé.','AbortError');
function checkAbort(signal){if(signal?.aborted)throw abortError();}
function inside(root,path){const name=relative(root,path);return name===''||(!name.startsWith('..'+sep)&&name!=='..'&&!isAbsolute(name));}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hashFile(path,signal){const digest=createHash('sha256');for await(const data of createReadStream(path)){checkAbort(signal);digest.update(data);}return digest.digest('hex');}
function notify(callback,event){try{callback?.({kind:'local-runtime',...event});}catch{/* A display callback cannot change installation integrity. */}}
function byteLimit(limit,onChunk){let size=0;return new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>limit){callback(new Error(ERR.archive));return;}onChunk?.(chunk,size);callback(null,chunk);}});}
const exec=promisify(execFile);

function allowedDownloadURL(value,initial){
  let url;try{url=new URL(value);}catch{throw new Error(ERR.download);}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hash)throw new Error(ERR.download);
  if(url.hostname==='github.com'){
    if(url.pathname!==new URL(initial).pathname||url.search)throw new Error(ERR.download);
  }else if(!['release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(url.hostname))throw new Error(ERR.download);
  return url;
}

/** Streams the exact pinned archive; signed redirect URLs and response bodies never enter errors. */
export async function downloadVerifiedArchive(release,destination,{signal,onProgress,request=httpsGet,idleTimeoutMs=30000,totalTimeoutMs=3600000}={}){
  checkAbort(signal);
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(),totalTimeoutMs);timer.unref?.();
  try{
    let response;
    let next=release.url;
    for(let redirects=0;redirects<=5;redirects++){
      const url=allowedDownloadURL(next,release.url);
      response=await new Promise((resolveResponse,reject)=>{
        const req=request(url,{signal:combined,headers:{Accept:'application/octet-stream','User-Agent':'AtelierPhoto-managed-Ollama'}},resolveResponse);
        req.setTimeout(idleTimeoutMs,()=>req.destroy(new Error(ERR.download)));
        req.once('error',reject);
      });
      if([301,302,303,307,308].includes(response.statusCode)){
        response.resume();
        if(redirects===5||typeof response.headers.location!=='string')throw new Error(ERR.download);
        next=new URL(response.headers.location,url).href;continue;
      }
      if(response.statusCode!==200){response.resume();throw new Error(ERR.download);}
      break;
    }
    const length=response.headers['content-length'];
    if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)!==release.bytes)){response.destroy();throw new Error(ERR.integrity);}
    const digest=createHash('sha256');let size=0,last=0;
    notify(onProgress,{phase:'download',status:'Téléchargement du moteur local…',completedBytes:0,totalBytes:release.bytes});
    const meter=new Transform({transform(chunk,encoding,callback){
      size+=chunk.length;
      if(size>release.bytes){callback(new Error(ERR.integrity));return;}
      digest.update(chunk);
      if(Date.now()-last>200){last=Date.now();notify(onProgress,{phase:'download',status:'Téléchargement du moteur local…',completedBytes:size,totalBytes:release.bytes});}
      callback(null,chunk);
    }});
    await pipeline(response,meter,createWriteStream(destination,{flags:'wx',mode:0o600}),{signal:combined});
    notify(onProgress,{phase:'verify',status:'Vérification du moteur local…',completedBytes:size,totalBytes:release.bytes});
    if(size!==release.bytes||digest.digest('hex')!==release.sha256)throw new Error(ERR.integrity);
  }catch(error){
    if(signal?.aborted)throw abortError();
    if(error.message===ERR.integrity)throw error;
    throw new Error(ERR.download);
  }finally{clearTimeout(timer);}
}

function archiveName(input,{target=false}={}){
  if(typeof input!=='string'||input.length>4096||/[\0-\x1f\\:]/.test(input)||input.startsWith('/'))throw new Error(ERR.archive);
  let name=input;while(name.startsWith('./'))name=name.slice(2);
  if(!target&&name.split('/').includes('..'))throw new Error(ERR.archive);
  name=posix.normalize(name).replace(/\/$/,'');
  if(name==='.')return '';
  if(name==='..'||name.startsWith('../')||posix.isAbsolute(name))throw new Error(ERR.archive);
  // Windows device names/ADS can escape the ordinary-file model on extraction.
  if(name.split('/').some(part=>/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))throw new Error(ERR.archive);
  return name;
}
async function ensureDirectory(path){await fs.mkdir(path,{recursive:true,mode:0o700});const info=await fs.lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error(ERR.archive);}

// tar's Minipass destination is not a Node Writable and has no destroy(). The
// adapter gives pipeline a real cancellation/error boundary and finishes pending
// file writes before the caller removes its private stage.
function tarDestination(reader,validationError){
  let finished=false;
  reader.once('finish',()=>{finished=true;});
  const destination=new Writable({
    write(chunk,encoding,callback){
      let called=false;const done=error=>{if(!called){called=true;callback(error);}};
      try{const flowing=reader.write(chunk);if(validationError())done(validationError());else if(flowing)done();else reader.once('drain',()=>done(validationError()));}catch(error){done(error);}
    },
    final(callback){if(finished){callback(validationError());return;}reader.once('finish',()=>callback(validationError()));try{reader.end();}catch(error){callback(error);}},
    destroy(error,callback){
      if(finished){callback(error);return;}
      let called=false;const done=()=>{if(!called){called=true;clearTimeout(timer);callback(error);}};
      const timer=setTimeout(done,2000);reader.once('finish',done);
      queueMicrotask(()=>{try{reader.end();}catch{done();}});
    }
  });
  reader.on('error',error=>destination.destroy(error));
  return destination;
}

/** Links are delayed until all ordinary files exist, preventing writes through an archive link. */
export async function extractManagedArchive(release,archive,directory,{signal}={}){
  checkAbort(signal);await ensureDirectory(directory);
  const canonicalRoot=await fs.realpath(directory);
  let declared=0,count=0;const seen=new Map(),links=[];
  function entry(name,size,type,linkpath=''){
    checkAbort(signal);name=archiveName(name);
    if(!name){if(type==='directory')return '';throw new Error(ERR.archive);}
    if(++count>50000||!Number.isSafeInteger(size)||size<0)throw new Error(ERR.archive);
    if(seen.has(name)&&!(type==='directory'&&seen.get(name)==='directory'))throw new Error(ERR.archive);
    seen.set(name,type);
    if(type==='file'){declared+=size;if(declared>release.maxExtractedBytes)throw new Error(ERR.archive);}
    if(type==='symlink'||type==='hardlink'){
      if(typeof linkpath!=='string'||linkpath.startsWith('/')||/[\0-\x1f\\:]/.test(linkpath))throw new Error(ERR.archive);
      const target=archiveName(type==='hardlink'?linkpath:posix.join(posix.dirname(name),linkpath),{target:true});
      if(!target)throw new Error(ERR.archive);
      links.push({name,target,type,linkpath});
    }
    return name;
  }
  try{
    if(release.format==='zip'){
      const zip=await new Promise((ok,no)=>yauzl.open(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true},(error,value)=>error?no(error):ok(value)));
      await new Promise((ok,no)=>{
        const cancel=()=>{zip.close();no(abortError());};signal?.addEventListener('abort',cancel,{once:true});
        const fail=error=>{zip.close();signal?.removeEventListener('abort',cancel);no(error);};
        zip.once('error',fail);zip.once('end',()=>{signal?.removeEventListener('abort',cancel);ok();});
        zip.on('entry',item=>{(async()=>{
          const mode=item.externalFileAttributes>>>16,type=mode&0o170000;
          if(type&&type!==0o100000&&type!==0o040000)throw new Error(ERR.archive);
          const directoryEntry=item.fileName.endsWith('/');
          const name=entry(item.fileName,item.uncompressedSize,directoryEntry?'directory':'file');
          if(name){const output=join(directory,...name.split('/'));
            if(directoryEntry)await ensureDirectory(output);
            else{
              await ensureDirectory(dirname(output));
              const source=await new Promise((yes,nope)=>zip.openReadStream(item,(error,stream)=>error?nope(error):yes(stream)));
              await pipeline(source,byteLimit(item.uncompressedSize),createWriteStream(output,{flags:'wx',mode:mode&0o111?0o700:0o600}),{signal});
            }
          }
          zip.readEntry();
        })().catch(fail);});zip.readEntry();
      });
    }else{
      let rejected;
      const reader=tar.x({cwd:directory,strict:true,preservePaths:false,noChmod:true,noMtime:true,
        filter:(path,item)=>{
          if(rejected)return false;
          try{
            const type={File:'file',OldFile:'file',Directory:'directory',SymbolicLink:'symlink',Link:'hardlink'}[item.type];
            if(!type)throw new Error(ERR.archive);
            entry(path,item.size,type,item.linkpath);item.mode&=0o755;
            return type==='file'||type==='directory';
          }catch(error){rejected=error;return false;}
        }});
      const decompressor=release.format==='tgz'?createGunzip():release.format==='tar.zst'?createZstdDecompress({params:{[zlibConstants.ZSTD_d_windowLogMax]:27}}):null;
      if(!decompressor)throw new Error(ERR.archive);
      await pipeline(createReadStream(archive),decompressor,byteLimit(release.maxExtractedBytes+64*MiB),tarDestination(reader,()=>rejected),{signal});
    }
    for(const link of links){
      checkAbort(signal);
      const path=join(directory,...link.name.split('/')),target=join(directory,...link.target.split('/'));
      await ensureDirectory(dirname(path));
      for(let parent=dirname(link.name);parent!=='.';parent=posix.dirname(parent))if(['symlink','hardlink'].includes(seen.get(parent)))throw new Error(ERR.archive);
      if(link.type==='symlink')await fs.symlink(link.linkpath,path);
      else{const actual=await fs.realpath(target);if(!inside(canonicalRoot,actual)||(await fs.stat(actual)).isDirectory())throw new Error(ERR.archive);await fs.link(actual,path);}
    }
    // Resolve every link after creation (also detects cycles and dangling targets).
    for(const link of links)if(!inside(canonicalRoot,await fs.realpath(join(directory,...link.name.split('/')))))throw new Error(ERR.archive);
    const executable=join(directory,...release.executable.split('/')),info=await fs.lstat(executable);
    if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw new Error(ERR.archive);
    await fs.chmod(executable,0o700);checkAbort(signal);
  }catch(error){if(signal?.aborted||error?.name==='AbortError')throw abortError();throw new Error(ERR.archive,{cause:error});}
}

async function reservePrivatePort(){return new Promise((ok,no)=>{const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?no(error):ok(port));});});}

/** A free-port reservation has a race; readiness additionally proves the listening PID. */
export async function ownsListeningPort(pid,port,platform=process.platform){
  if(!Number.isInteger(pid)||pid<=1||!Number.isInteger(port)||port<1024||port>65535)return false;
  try{
    if(platform==='linux'){
      const rows=(await fs.readFile('/proc/net/tcp','utf8')).trim().split('\n').slice(1);
      const inodes=new Set(rows.map(row=>row.trim().split(/\s+/)).filter(row=>row[1]===`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`&&row[3]==='0A').map(row=>row[9]));
      if(!inodes.size)return false;
      for(const fd of await fs.readdir(`/proc/${pid}/fd`)){try{const target=await fs.readlink(`/proc/${pid}/fd/${fd}`);if(inodes.has(/^socket:\[(\d+)\]$/.exec(target)?.[1]))return true;}catch{/* An fd can close during inspection. */}}
      return false;
    }
    if(platform==='darwin'){
      const {stdout}=await exec('/usr/sbin/lsof',['-nP','-a','-p',String(pid),`-iTCP:${port}`,'-sTCP:LISTEN','-Fp'],{timeout:2000,maxBuffer:65536});
      return stdout.split(/\r?\n/).includes(`p${pid}`);
    }
    if(platform==='win32'){
      const executable=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const command=`@(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess) | ConvertTo-Json -Compress`;
      const {stdout}=await exec(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:3000,maxBuffer:65536});
      const value=stdout.trim()?JSON.parse(stdout):[];return (Array.isArray(value)?value:[value]).includes(pid);
    }
  }catch{return false;}
  return false;
}
async function probeVersion(endpoint,signal){const response=await localRequest(new URL('api/version',endpoint),{signal,timeoutMs:1200});return (await readLocalJSON(response,16384)).version;}
async function delay(ms,signal){checkAbort(signal);await new Promise((ok,no)=>{const cancel=()=>{clearTimeout(timer);no(abortError());},timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);ok();},ms);signal?.addEventListener('abort',cancel,{once:true});});}
function privateEnvironment(base,home,models,endpoint){
  const env={};
  for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','LC_CTYPE','CUDA_VISIBLE_DEVICES','HIP_VISIBLE_DEVICES','ROCR_VISIBLE_DEVICES'])if(typeof base[key]==='string')env[key]=base[key];
  return {...env,HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData','Roaming'),LOCALAPPDATA:join(home,'AppData','Local'),
    TEMP:join(home,'tmp'),TMP:join(home,'tmp'),TMPDIR:join(home,'tmp'),
    OLLAMA_MODELS:models,OLLAMA_HOST:endpoint,OLLAMA_NO_CLOUD:'1',OLLAMA_NUM_PARALLEL:'1',OLLAMA_MAX_LOADED_MODELS:'1',OLLAMA_CONTEXT_LENGTH:'4096'};
}
async function terminateOwned(child,platform){
  if(!child||!Number.isInteger(child.pid)||child.pid<=1)return;
  if(platform==='win32'){
    const taskkill=join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe');
    try{await exec(taskkill,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000,maxBuffer:65536});}
    catch{if(child.exitCode==null&&child.signalCode==null)throw new Error(ERR.stop);}
    return;
  }
  try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw new Error(ERR.stop);}
  const deadline=Date.now()+1500;
  while(child.exitCode==null&&child.signalCode==null&&Date.now()<deadline)await delay(40);
  // The original process group also contains any runners surviving their parent.
  try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw new Error(ERR.stop);}
}

/** No work starts on import or factory creation. Injections are main-process-only test seams. */
export function createManagedOllama({userDataDirectory,platform=process.platform,arch=process.arch,environment=process.env,onProgress,dependencies={}}={}){
  if(typeof userDataDirectory!=='string'||!isAbsolute(userDataDirectory)||userDataDirectory.includes('\0'))throw new Error('Le dossier des données de l’application doit être absolu.');
  const release=dependencies.release??managedOllamaRelease(platform,arch);
  const root=join(resolve(userDataDirectory),'local-ai','ollama'),runtimeDirectory=join(root,`v${MANAGED_OLLAMA_VERSION}`),modelsDirectory=join(root,'models'),home=join(root,'home');
  const download=dependencies.download??downloadVerifiedArchive,extract=dependencies.extract??extractManagedArchive,spawn=dependencies.spawn??spawnProcess;
  const reservePort=dependencies.reservePort??reservePrivatePort,ownsPort=dependencies.ownsPort??ownsListeningPort,probe=dependencies.probe??probeVersion,terminate=dependencies.terminate??terminateOwned;
  const freeDisk=dependencies.freeDisk??(async path=>{const stat=await fs.statfs(path);return Number(stat.bavail)*Number(stat.bsize);});
  const processAlive=dependencies.processAlive??(pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}});
  const startupTimeoutMs=dependencies.startupTimeoutMs??45000,pollMs=dependencies.pollMs??200;
  let installing=null,starting=null,owned=null,startController=null,stopping=null,phase='idle';
  const progress=(callback,event)=>{phase=event.phase;notify(onProgress,event);if(callback!==onProgress)notify(callback,event);};
  async function privateRoot(create=false){
    if(create)await fs.mkdir(userDataDirectory,{recursive:true,mode:0o700});
    for(const path of [join(userDataDirectory,'local-ai'),root]){
      if(create)await ensureDirectory(path);
      else{try{const info=await fs.lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error(ERR.invalid);}catch(error){if(error.code==='ENOENT')return false;throw error;}}
    }
    return true;
  }
  async function endOwned(current){
    if(!current.termination)current.termination=Promise.resolve().then(()=>terminate(current.child,platform)).then(()=>{if(owned===current){owned=null;phase='idle';}});
    return current.termination;
  }
  async function readOwner(directory,filename='owner.json'){
    try{
      const path=filename?join(directory,filename):directory,info=await fs.lstat(path);
      if(filename){const folder=await fs.lstat(directory);if(!folder.isDirectory()||folder.isSymbolicLink())return null;}
      if(!info.isFile()||info.isSymbolicLink()||info.size>4096)return null;
      const value=JSON.parse(await fs.readFile(path,'utf8'));
      if(value.kind!=='atelier-managed-ollama-install'||value.version!==MANAGED_OLLAMA_VERSION||!Number.isInteger(value.pid)||value.pid<=1||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||typeof value.stage!=='string'||!value.stage.startsWith(`.install-v${MANAGED_OLLAMA_VERSION}-`)||basename(value.stage)!==value.stage)return null;
      return value;
    }catch{return null;}
  }
  async function claimLock(lock,owner){
    for(let attempt=0;attempt<4;attempt++){
      try{
        // link() is an exclusive, atomic acquisition of an already complete
        // record, so a crash cannot leave an empty/unidentifiable lock.
        await fs.link(join(root,owner.stage,'.atelier-stage-owner.json'),lock);
        return;
      }catch(error){if(error.code!=='EEXIST')throw error;}
      const previous=await readOwner(lock,null);
      if(!previous||await processAlive(previous.pid))throw new Error(ERR.busy);
      const quarantine=join(root,`.orphan-lock-v${MANAGED_OLLAMA_VERSION}-${randomUUID()}`);
      try{await fs.rename(lock,quarantine);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const captured=await readOwner(quarantine,null);
      if(!captured||captured.token!==previous.token||await processAlive(captured.pid)){
        // A concurrent process may have changed the lock before rename. Restore
        // its token exclusively; never overwrite or delete a live owner's lock.
        if(captured){try{await fs.link(quarantine,lock);await fs.rm(quarantine,{force:true});}catch{/* Leave the captured marker for inspection rather than deleting it. */}}
        throw new Error(ERR.busy);
      }
      const abandoned=join(root,previous.stage),stageOwner=await readOwner(abandoned,'.atelier-stage-owner.json');
      if(stageOwner?.token===previous.token&&stageOwner.pid===previous.pid)await fs.rm(abandoned,{recursive:true,force:true});
      await fs.rm(quarantine,{force:true});
    }
    throw new Error(ERR.busy);
  }
  const describe=()=>({supported:Boolean(release),installed:false,running:false,version:MANAGED_OLLAMA_VERSION,endpoint:'',phase,
    downloadBytes:release?.bytes??0,requiredDiskBytes:release?.requiredDiskBytes??0,license:MANAGED_OLLAMA_LICENSE.name,
    licenseURL:MANAGED_OLLAMA_LICENSE.url,licenseNotice:MANAGED_OLLAMA_LICENSE.notice,runtimeDirectory,modelsDirectory});
  async function verified(){
    if(!release)throw new Error(ERR.unsupported);
    if(!await privateRoot())return null;
    let folder;
    try{folder=await fs.lstat(runtimeDirectory);}catch(error){if(error.code==='ENOENT')return null;throw new Error(ERR.invalid);}
    if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error(ERR.invalid);
    try{
      const manifestPath=join(runtimeDirectory,'atelier-install.json'),sealPath=join(runtimeDirectory,'atelier-install.sha256');
      for(const path of [manifestPath,sealPath]){const info=await fs.lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw new Error(ERR.invalid);}
      const bytes=await fs.readFile(manifestPath),seal=(await fs.readFile(sealPath,'utf8')).trim();
      if(!/^[a-f0-9]{64}$/.test(seal)||hash(bytes)!==seal)throw new Error(ERR.invalid);
      const manifest=JSON.parse(bytes);
      if(manifest.schema!==1||manifest.version!==MANAGED_OLLAMA_VERSION||manifest.platform!==platform||manifest.arch!==arch||manifest.assetSHA256!==release.sha256||manifest.assetBytes!==release.bytes||manifest.executable?.path!==release.executable||!/^[a-f0-9]{64}$/.test(manifest.executable?.sha256))throw new Error(ERR.invalid);
      const executable=join(runtimeDirectory,...release.executable.split('/')),info=await fs.lstat(executable);
      if(!info.isFile()||info.isSymbolicLink()||!inside(await fs.realpath(runtimeDirectory),await fs.realpath(executable))||info.size!==manifest.executable.bytes||await hashFile(executable)!==manifest.executable.sha256)throw new Error(ERR.invalid);
      return executable;
    }catch{throw new Error(ERR.invalid);}
  }
  async function status(){
    const result=describe();if(!release)return {...result,reason:ERR.unsupported};
    try{result.installed=Boolean(await verified());}catch{return {...result,reason:ERR.invalid};}
    const current=owned;
    if(result.installed&&current?.ready&&current.alive){
      try{if(await ownsPort(current.child.pid,current.port,platform)&&await probe(current.endpoint)===MANAGED_OLLAMA_VERSION&&current===owned&&current.alive){result.running=true;result.endpoint=current.endpoint;}}catch{/* A status probe never adopts a different server. */}
    }
    return result;
  }
  async function install({signal,onProgress:callback}={}){
    checkAbort(signal);if(!release)throw new Error(ERR.unsupported);
    if(installing)return installing;
    installing=(async()=>{
      if(await verified())return status();
      await privateRoot(true);
      const lock=join(root,`.install-lock-v${MANAGED_OLLAMA_VERSION}`);let stage,owner,locked=false;
      try{
        stage=await fs.mkdtemp(join(root,`.install-v${MANAGED_OLLAMA_VERSION}-`));
        owner={kind:'atelier-managed-ollama-install',version:MANAGED_OLLAMA_VERSION,pid:process.pid,token:randomUUID(),stage:basename(stage)};
        await fs.writeFile(join(stage,'.atelier-stage-owner.json'),JSON.stringify(owner),{flag:'wx',mode:0o600});
        await claimLock(lock,owner);locked=true;
        let available;try{available=await freeDisk(root);}catch{throw new Error(ERR.diskUnknown);}
        if(!Number.isFinite(available)||available<0)throw new Error(ERR.diskUnknown);
        if(available<release.requiredDiskBytes)throw new Error(ERR.disk);
        const archive=join(stage,release.name),payload=join(stage,'payload');
        await download(release,archive,{signal,onProgress:event=>progress(callback,event)});
        checkAbort(signal);progress(callback,{phase:'extract',status:'Préparation du moteur local…'});
        await extract(release,archive,payload,{signal});
        await fs.writeFile(join(payload,'OLLAMA_LICENSE.txt'),OLLAMA_MIT,{flag:'wx',mode:0o600});
        const executable=join(payload,...release.executable.split('/')),info=await fs.lstat(executable);
        if(!info.isFile()||info.isSymbolicLink()||info.size===0)throw new Error(ERR.archive);
        const manifest={schema:1,version:MANAGED_OLLAMA_VERSION,platform,arch,assetSHA256:release.sha256,assetBytes:release.bytes,
          executable:{path:release.executable,bytes:info.size,sha256:await hashFile(executable,signal)}};
        const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
        await fs.writeFile(join(payload,'atelier-install.json'),bytes,{flag:'wx',mode:0o600});
        await fs.writeFile(join(payload,'atelier-install.sha256'),hash(bytes)+'\n',{flag:'wx',mode:0o600});
        checkAbort(signal);
        if((await readOwner(lock,null))?.token!==owner.token)throw new Error(ERR.busy);
        try{await fs.lstat(runtimeDirectory);throw new Error(ERR.invalid);}catch(error){if(error.code!=='ENOENT')throw error;}
        await fs.rename(payload,runtimeDirectory);
        progress(callback,{phase:'installed',status:'Moteur local installé.'});
        return status();
      }catch(error){
        if(signal?.aborted||error.name==='AbortError')throw abortError();
        if(Object.values(ERR).includes(error.message))throw error;
        throw new Error(ERR.install,{cause:error});
      }finally{
        if(stage)await fs.rm(stage,{recursive:true,force:true});
        if(locked&&(await readOwner(lock,null))?.token===owner?.token)await fs.rm(lock,{force:true});
        if(phase!=='installed')phase='idle';
      }
    })();
    try{return await installing;}finally{installing=null;}
  }
  async function stop(){
    startController?.abort();
    if(stopping)return stopping;
    const current=owned;if(!current)return;
    current.ready=false;
    stopping=endOwned(current);
    try{await stopping;}finally{stopping=null;}
  }
  async function start({signal}={}){
    checkAbort(signal);if(!release)throw new Error(ERR.unsupported);
    if(starting)return starting;
    startController=new AbortController();const controller=startController,combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    starting=(async()=>{
      let current;
      try{
        if(stopping)await stopping;
        const ready=await status();checkAbort(combined);if(ready.running)return ready;
        if(owned)await endOwned(owned);
        const executable=await verified();if(!executable)throw new Error(ERR.missing);
        await ensureDirectory(home);await ensureDirectory(join(home,'tmp'));await ensureDirectory(modelsDirectory);checkAbort(combined);
        const port=await reservePort();if(!Number.isInteger(port)||port<1024||port>65535)throw new Error(ERR.start);
        checkAbort(combined);
        const endpoint=`http://127.0.0.1:${port}/`;
        const child=spawn(executable,['serve'],{cwd:runtimeDirectory,env:privateEnvironment(environment,home,modelsDirectory,endpoint),
          shell:false,windowsHide:true,detached:platform!=='win32',stdio:'ignore'});
        current={child,port,endpoint,alive:true,ready:false,error:false};owned=current;phase='starting';
        child.once('error',()=>{current.error=true;current.alive=false;current.ready=false;});
        child.once('exit',()=>{current.alive=false;current.ready=false;endOwned(current).catch(()=>{});});
        const deadline=Date.now()+startupTimeoutMs;
        while(Date.now()<deadline){
          checkAbort(combined);if(!current.alive||current.error)throw new Error(ERR.start);
          if(await ownsPort(child.pid,port,platform)){
            let version;try{version=await probe(endpoint,combined);}catch(error){if(combined.aborted)throw abortError();}
            checkAbort(combined);if(version!==undefined&&version!==MANAGED_OLLAMA_VERSION)throw new Error(ERR.version);
            if(version===MANAGED_OLLAMA_VERSION&&current.alive&&owned===current&&await ownsPort(child.pid,port,platform)){
              checkAbort(combined);
              current.ready=true;phase='ready';return {...describe(),installed:true,running:true,endpoint};
            }
          }
          await delay(pollMs,combined);
        }
        throw new Error(ERR.timeout);
      }catch(error){
        if(current)await endOwned(current);phase='idle';
        if(combined.aborted||error.name==='AbortError')throw abortError();
        if([ERR.missing,ERR.invalid,ERR.version,ERR.timeout].includes(error.message))throw error;
        throw new Error(ERR.start);
      }
    })();
    try{return await starting;}finally{starting=null;if(startController===controller)startController=null;}
  }
  return Object.freeze({status,install,start,stop});
}
