import sharp from 'sharp';
import {StringDecoder} from 'node:string_decoder';
import {localRequest,normalizeLoopbackURL,readLocalJSON} from './loopback-http.mjs';
import {parseRecommendation,recommendationPrompt,recommendationSchema} from './ai-service.mjs';

const GiB=1024**3;
export const LOCAL_VISION_MODELS=Object.freeze([
  {id:'qwen3-vl:2b-instruct',name:'Qwen3-VL Instruct 2B',downloadBytes:1_900_000_000,downloadEstimated:true,estimatedWorkingBytes:4*GiB,minTotalMemoryBytes:8*GiB,recommendedMemoryBytes:16*GiB,maxDimension:768,license:'Apache-2.0'},
  {id:'qwen3-vl:4b-instruct',name:'Qwen3-VL Instruct 4B',downloadBytes:3_300_000_000,downloadEstimated:true,estimatedWorkingBytes:6*GiB,minTotalMemoryBytes:16*GiB,recommendedMemoryBytes:24*GiB,maxDimension:1024,license:'Apache-2.0'},
  {id:'qwen3-vl:8b-instruct',name:'Qwen3-VL Instruct 8B',downloadBytes:6_100_000_000,downloadEstimated:true,estimatedWorkingBytes:10*GiB,minTotalMemoryBytes:24*GiB,recommendedMemoryBytes:32*GiB,maxDimension:1024,license:'Apache-2.0'},
]);
const cloud=value=>Boolean(value?.remote_host||value?.remote_model||/(?:^|[-:/])cloud(?:$|[-:/])/i.test(value?.name||value?.model||''));
const fail=message=>{throw new Error(message);};
const preservedGeometry=Object.freeze({rotation:0,cropRatio:0,cropX:0.5,cropY:0.5,flipHorizontal:false});
function modelName(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,159}$/.test(value)||cloud({name:value}))fail('Choisissez un modèle vision installé sur cet ordinateur.');return value;}
function versionParts(value){return /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value))?.slice(1).map(Number);}
function atLeast(value,minimum){const a=versionParts(value),b=versionParts(minimum);if(!a||!b)return false;for(let i=0;i<3;i++){if(a[i]>b[i])return true;if(a[i]<b[i])return false;}return true;}

export function parseLocalRecommendation(content){
  let data;try{data=JSON.parse(content);}catch{fail('Le modèle local n’a pas renvoyé de réglages valides.');}
  const schema=recommendationSchema(),properties=schema.properties.adjustments.properties;
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==2||!data.adjustments||typeof data.adjustments!=='object'||Array.isArray(data.adjustments)
    ||Object.keys(data.adjustments).length!==Object.keys(properties).length||typeof data.explanation!=='string'||!data.explanation.trim()||data.explanation.length>4000)fail('Le modèle local n’a pas renvoyé de réglages valides.');
  for(const [key,spec] of Object.entries(properties)){
    const value=data.adjustments[key];
    if(spec.type==='boolean'?typeof value!=='boolean':typeof value!=='number'||!Number.isFinite(value)||value<spec.minimum||value>spec.maximum)fail('Le modèle local n’a pas renvoyé de réglages valides.');
  }
  return parseRecommendation(content);
}

export function createOllamaClient({endpoint='http://127.0.0.1:11434',transport=localRequest}={}){
  const base=normalizeLoopbackURL(endpoint);
  const json=async(path,body,signal)=>readLocalJSON(await transport(new URL(path,base),{method:body===undefined?'GET':'POST',body,signal,timeoutMs:path==='/api/chat'?300000:8000}));
  async function version(signal){const data=await json('/api/version',undefined,signal);if(typeof data.version!=='string'||!versionParts(data.version))fail('La version du moteur local est non valide.');return data.version;}
  async function inspectModel(name,{signal,engineVersion}={}){
    modelName(name);const data=await json('/api/show',{model:name,verbose:false},signal);
    if(cloud(data))fail('Ce modèle utilise un service cloud. Choisissez un modèle entièrement local.');
    if(!Array.isArray(data.capabilities)||!data.capabilities.includes('vision'))fail('Ce modèle ne peut pas analyser les photos.');
    const minimum=typeof data.requires==='string'&&versionParts(data.requires)?data.requires:'0.12.7';
    const installedVersion=engineVersion||await version(signal);
    if(!atLeast(installedVersion,minimum))fail('Mettez Ollama à jour pour utiliser ce modèle vision.');
    return {name,capabilities:data.capabilities.filter(x=>typeof x==='string').slice(0,16),local:true,requires:minimum};
  }
  async function status(){
    const signal=AbortSignal.timeout(12000);
    const installedVersion=await version(signal),tags=await json('/api/tags',undefined,signal);
    if(!Array.isArray(tags.models)||tags.models.length>500)fail('La liste des modèles locaux est non valide.');
    const models=[];
    // Metadata only: no weights are loaded and no photograph is sent here.
    const candidates=tags.models.slice(0,64);let next=0;
    await Promise.all(Array.from({length:Math.min(4,candidates.length)},async()=>{
      while(next<candidates.length&&!signal.aborted){const item=candidates[next++];if(cloud(item))continue;
        try{const info=await inspectModel(item.name,{engineVersion:installedVersion,signal});models.push({...info,size:Number.isSafeInteger(item.size)&&item.size>=0?item.size:null});}catch{/* Text-only and remote models are not offered as photo models. */}
      }
    }));
    models.sort((a,b)=>a.name.localeCompare(b.name));
    return {available:true,version:installedVersion,models};
  }
  async function recommend({imageData,instruction,model,language='fr',signal}={}){
    modelName(model);signal?.throwIfAborted();
    if(typeof instruction!=='string'||!instruction.trim()||instruction.length>10000)fail('Ajoutez une consigne de retouche.');
    if(!Buffer.isBuffer(imageData)||!imageData.length||imageData.length>100*1024*1024)fail('La photo est illisible ou dépasse 100 Mo.');
    await inspectModel(model,{signal}); // Cloud flags are checked before image preparation/transmission.
    const definition=LOCAL_VISION_MODELS.find(item=>item.id===model),maxDimension=definition?.maxDimension||768;
    const image=await sharp(imageData,{limitInputPixels:120000000,failOn:'error'}).rotate().resize({width:maxDimension,height:maxDimension,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
    signal?.throwIfAborted();const start=performance.now();
    const response=await json('/api/chat',{model,stream:false,format:recommendationSchema(),keep_alive:0,options:{temperature:0,num_ctx:4096,num_predict:2048},messages:[{role:'system',content:recommendationPrompt(language)},{role:'user',content:instruction,images:[image.toString('base64')]}]},signal);
    signal?.throwIfAborted();if(cloud(response))fail('Le moteur a signalé un modèle distant. La réponse a été refusée.');
    if(response.error||response.done!==true||response.done_reason==='length')fail('Le modèle local a interrompu sa réponse. Réessayez avec une consigne plus courte.');
    const result=parseLocalRecommendation(response.message?.content);
    // Schema validity does not establish that the model followed the request.
    // Local analysis has no permission to compose an image. Apply this policy
    // only after strict raw validation; manual geometry is restored by main.
    Object.assign(result.adjustments,preservedGeometry);
    let acceleration='unknown';
    try{const running=await json('/api/ps'),entry=running.models?.find(item=>item.name===model||item.model===model);if(entry&&Number.isFinite(entry.size)&&Number.isFinite(entry.size_vram)){acceleration=entry.size_vram===0?'cpu':entry.size_vram>=entry.size*.95?'gpu':'hybrid';}}catch{}
    return {...result,local:true,constraints:{geometryPreserved:true},metrics:{elapsedMs:Math.round(performance.now()-start),acceleration,evalTokens:response.eval_count??null,evalDurationNs:response.eval_duration??null}};
  }
  async function pullModel(model,{signal,onProgress=()=>{}}={}){
    if(!LOCAL_VISION_MODELS.some(item=>item.id===model))fail('Choisissez un modèle recommandé pour le téléchargement.');
    signal?.throwIfAborted();if(!atLeast(await version(signal),'0.12.7'))fail('Mettez Ollama à jour pour utiliser ce modèle vision.');
    const stream=await transport(new URL('/api/pull',base),{method:'POST',body:{model,stream:true},signal,timeoutMs:30*60*1000});
    let pending='',received=0,success=false;const blobs=new Map(),decoder=new StringDecoder('utf8');
    const progress=line=>{
      let item;try{item=JSON.parse(line);}catch{fail('La progression du modèle local est non valide.');}
      if(item.error)fail('Le téléchargement du modèle a échoué. Vérifiez votre connexion et l’espace disponible.');
      if(typeof item.status!=='string')return;
      if(item.digest&&Number.isSafeInteger(item.total)&&item.total>=0&&Number.isSafeInteger(item.completed)&&item.completed>=0&&item.completed<=item.total){
        if(typeof item.digest!=='string'||!/^sha256:[a-f0-9]{64}$/i.test(item.digest)||(!blobs.has(item.digest)&&blobs.size>=128))fail('La progression du modèle local est non valide.');
        blobs.set(item.digest,{total:item.total,completed:item.completed});
      }
      const list=[...blobs.values()],completed=list.reduce((sum,b)=>sum+b.completed,0),total=list.reduce((sum,b)=>sum+b.total,0);
      if(!Number.isSafeInteger(completed)||!Number.isSafeInteger(total))fail('La progression du modèle local est non valide.');
      onProgress({kind:'local-model',status:item.status,completedBytes:list.length?completed:null,totalBytes:list.length?total:null});
      if(item.status==='success')success=true;
    };
    for await(const chunk of stream){signal?.throwIfAborted();received+=chunk.length;if(received>16*1024*1024){stream.destroy?.();fail('La progression du téléchargement est trop volumineuse.');}pending+=decoder.write(Buffer.from(chunk));let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index).trim();pending=pending.slice(index+1);if(line.length>65536)fail('La progression du modèle local est non valide.');if(line)progress(line);}if(pending.length>65536)fail('La progression du modèle local est non valide.');}
    pending+=decoder.end();
    if(pending.trim())progress(pending);signal?.throwIfAborted();if(!success)fail('Le téléchargement du modèle n’a pas été confirmé.');
    return inspectModel(model,{signal});
  }
  return {endpoint:base,status,inspectModel,recommend,pullModel};
}
