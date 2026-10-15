import {request,Agent} from 'node:http';

export function normalizeLoopbackURL(value='http://127.0.0.1:11434',defaultPort=11434){
  let url;try{url=new URL(value);}catch{throw new Error('Adresse du moteur local non valide.');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Le moteur local doit utiliser une adresse de cet ordinateur.');
  if(url.hostname==='localhost')url.hostname='127.0.0.1';
  if(!url.port)url.port=String(defaultPort);
  return url.href;
}

/** A direct local socket deliberately bypasses HTTP_PROXY and browser cookies. */
export function createLocalTransport(send=request){const agent=new Agent({proxyEnv:{},keepAlive:false});return function localRequest(input,{method='GET',body,headers={},signal,timeoutMs=300000}={}){
  const url=new URL(input);
  if(url.username||url.password)throw new Error('Le moteur local ne doit pas utiliser d’identifiants dans son adresse.');
  const canonical=new URL(normalizeLoopbackURL(url.origin,80));
  url.hostname=canonical.hostname;
  if(signal?.aborted)return Promise.reject(new DOMException('Demande locale annulée.','AbortError'));
  const payload=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  const outgoing={Accept:'application/json',...headers};
  if(payload){outgoing['Content-Length']=payload.length;if(!outgoing['Content-Type'])outgoing['Content-Type']='application/json';}
  return new Promise((resolve,reject)=>{
    const req=send(url,{method,headers:outgoing,signal,agent},response=>{
      if(response.statusCode<200||response.statusCode>=300){response.resume();reject(new Error('Le moteur local a refusé la demande. Vérifiez le modèle et sa configuration.'));return;}
      resolve(response);
    });
    req.setTimeout(timeoutMs,()=>req.destroy(new Error('Le moteur local a dépassé le délai de réponse.')));
    req.once('error',error=>reject(error.name==='AbortError'?error:new Error('Le service local ne répond pas. Ouvrez le moteur local, puis réessayez.')));
    req.end(payload);
  });
};}
export const localRequest=createLocalTransport();

export async function readLocalJSON(response,maxBytes=2*1024*1024){
  if(response.statusCode!==undefined&&(response.statusCode<200||response.statusCode>=300))throw new Error('Le moteur local a refusé la demande.');
  let size=0;const chunks=[];
  for await(const chunk of response){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxBytes){response.destroy?.();throw new Error('La réponse du moteur local est trop volumineuse.');}chunks.push(bytes);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('La réponse du moteur local est non valide.');}
}
