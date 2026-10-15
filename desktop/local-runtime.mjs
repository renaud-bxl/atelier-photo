import {homedir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import fs from 'node:fs/promises';
import {inspectHardware,assessLocalModel} from './hardware-profile.mjs';
import {normalizeLoopbackURL} from './loopback-http.mjs';
import {LOCAL_VISION_MODELS} from './local-ai.mjs';

export const DEFAULT_LOCAL_AI=Object.freeze({ollamaURL:'http://127.0.0.1:11434/',model:'',comfyURL:'http://127.0.0.1:8188/',modelsDirectory:'',comfyModels:{diffusion:'',textEncoder:'',vae:''}});
const fail=message=>{throw new Error(message);};
export function normalizeLocalConfig(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Réglages IA locale non valides.');
  const model=input.model??'';
  if(typeof model!=='string'||model.length>160||(model&&!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*$/.test(model)))fail('Nom de modèle local non valide.');
  const modelsDirectory=input.modelsDirectory??'';
  if(typeof modelsDirectory!=='string'||modelsDirectory.length>32768||modelsDirectory.includes('\0')||(modelsDirectory&&!isAbsolute(modelsDirectory)))fail('Choisissez un dossier absolu pour mesurer le stockage des modèles.');
  const comfyModels={};
  for(const key of ['diffusion','textEncoder','vae']){
    const name=input.comfyModels?.[key]??'';
    if(typeof name!=='string'||name.length>512||/[\u0000-\u001f\u007f]/.test(name))fail('Nom de modèle ComfyUI non valide.');
    comfyModels[key]=name;
  }
  return {ollamaURL:normalizeLoopbackURL(input.ollamaURL??DEFAULT_LOCAL_AI.ollamaURL),model,
    comfyURL:normalizeLoopbackURL(input.comfyURL??DEFAULT_LOCAL_AI.comfyURL,8188),modelsDirectory,comfyModels};
}

export function engineAssessment(hardware,assessment){
  const reasons=[...assessment.reasons];let unsupported=false;
  const version=typeof hardware.osVersion==='string'?/^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+])/.exec(hardware.osVersion):null;
  let unverified=!version;
  if(!['darwin','win32','linux'].includes(hardware.platform)||!['arm64','x64'].includes(hardware.arch)){unsupported=true;reasons.push('engine_platform_unsupported');}
  if(hardware.platform==='darwin'&&version&&Number(version[1])<14){unsupported=true;reasons.push('engine_os_too_old');}
  if(hardware.platform==='win32'&&version){
    const major=Number(version[1]),build=version[3]===undefined?NaN:Number(version[3]);
    if(!Number.isFinite(build))unverified=true;
    if(major<10||(major===10&&Number.isFinite(build)&&build<19045)){unsupported=true;reasons.push('engine_os_too_old');}
  }
  if(unverified)reasons.push('engine_os_unverified');
  return {...assessment,status:unsupported?'insufficient':unverified&&assessment.status!=='insufficient'?'unknown':assessment.status,reasons};
}

/** Conservative application budgets; they are not vendor-certified minima. */
export function assessLocalGeneration(hardware,{sourcePixels=0,outputPixels=0}={}){
  const GiB=1024**3,vram=hardware?.gpu?.vramBytes;
  const imageBytes=Math.ceil(Math.max(0,sourcePixels)*16+Math.max(0,outputPixels)*32)+GiB;
  const minimum=(hardware?.gpu?.kind==='discrete'&&Number.isFinite(vram)&&vram>=8*GiB?16:24)*GiB;
  const requiredMemoryBytes=Math.max(minimum,12*GiB+imageBytes);
  const total=hardware?.memory?.totalBytes;
  return {status:Number.isFinite(total)&&total<requiredMemoryBytes?'insufficient':'unknown',
    requiredMemoryBytes,reasons:['resource_estimates_only','gpu_backend_unverified',...(Number.isFinite(total)&&total<requiredMemoryBytes?['memory_below_minimum']:[])]};
}

/** Measures the chosen model volume, not the application installation volume. */
export function createLocalDiagnostics({inspect=inspectHardware,environment=process.env,userHome=homedir(),platform=process.platform,access=fs.access}={}){
  let pending=null,lastKey='',expires=0,inFlight=false;
  const accessible=async path=>{
    let timer;
    try{return await Promise.race([access(path),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Storage unavailable'),{code:'ETIMEDOUT'})),1800);})]);}
    finally{clearTimeout(timer);}
  };
  async function hardware(input={}){
    const config=normalizeLocalConfig(input);
    const envPath=environment.OLLAMA_MODELS;
    // The standard Linux service runs as the ollama user, not the desktop user.
    // A custom service can still use a different volume: only an explicit user
    // selection confirms which measured directory is relevant to the download.
    const inferred=platform==='linux'?'/usr/share/ollama/.ollama/models':join(userHome,'.ollama','models');
    const requested=config.modelsDirectory||(typeof envPath==='string'&&isAbsolute(envPath)?envPath:inferred);
    const configurationVerified=Boolean(config.modelsDirectory),key=JSON.stringify([requested,configurationVerified]);
    if(pending&&lastKey===key&&(inFlight||Date.now()<expires))return pending;
    lastKey=key;inFlight=true;
    pending=(async()=>{
      let existing=requested;
      // An inferred default can measure an existing parent before installation.
      // A configured or environment volume must never fall back to another disk.
      if(!config.modelsDirectory&&!(typeof envPath==='string'&&isAbsolute(envPath)))for(let depth=0;depth<64;depth++){
        try{await accessible(existing);break;}catch(error){if(error?.code!=='ENOENT')break;const parent=dirname(existing);if(parent===existing)break;existing=parent;}
      }
      const result=await inspect({storagePath:existing});
      return {...result,storage:{...result.storage,path:requested,measuredPath:existing,configurationVerified},
        warnings:[...new Set([...result.warnings,...(!config.modelsDirectory?['model_storage_configuration_unverified']:[])])]};
    })();
    const current=pending;
    try{return await current;}catch(error){if(pending===current)pending=null;throw error;}
    finally{if(pending===current){inFlight=false;expires=Date.now()+1500;}}
  }
  async function recommendations(input={}){
    const snapshot=await hardware(input);
    const capacity=confirmedCapacity(snapshot);
    return LOCAL_VISION_MODELS.map(model=>({...model,assessment:engineAssessment(snapshot,assessLocalModel(capacity,model))}));
  }
  async function checkModel(model,input={},forDownload=false){
    const definition=LOCAL_VISION_MODELS.find(item=>item.id===model);
    const snapshot=await hardware(input);
    if(!definition)return snapshot; // Existing vision models are verified by Ollama; their needs remain unmeasured.
    let assessment=assessLocalModel(confirmedCapacity(snapshot),definition);
    if(!forDownload)assessment=assessLocalModel({...snapshot,storage:{...snapshot.storage,freeBytes:Number.MAX_SAFE_INTEGER}},definition);
    assessment=engineAssessment(snapshot,assessment);
    if(assessment.status==='insufficient')fail('Les ressources mesurées de cet ordinateur sont insuffisantes pour ce modèle. Choisissez un modèle plus léger.');
    return snapshot;
  }
  return {hardware,recommendations,checkModel};
}

function confirmedCapacity(snapshot){
  return snapshot.storage?.configurationVerified===false?{...snapshot,storage:{...snapshot.storage,freeBytes:null}}:snapshot;
}
