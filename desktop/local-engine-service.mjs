import {mkdir} from 'node:fs/promises';
import {createOllamaClient,LOCAL_VISION_MODELS} from './local-ai.mjs';
import {normalizeLocalConfig} from './local-runtime.mjs';

/** Owns download jobs independently of the settings window. No work at import. */
export function createLocalEngineService({engine,diagnostics,onProgress=()=>{},client=createOllamaClient,makeDirectory=mkdir}){
  let task=null,controller=null,pending=null,lastResult=null;
  const fail=message=>{throw new Error(message);};
  async function status(){return {...await engine.status(),job:task?{...task}:null,lastResult:lastResult?{...lastResult}:null};}
  async function diagnosticOptions(input={}){
    const config=normalizeLocalConfig(input);
    if(config.engineMode!=='managed')return config;
    const state=await engine.status();
    // This explicit diagnostic measures the volume actually used by our child.
    // Creating the private empty directory does not install a runtime or weights.
    await makeDirectory(state.modelsDirectory,{recursive:true,mode:0o700});
    return {...config,modelsDirectory:state.modelsDirectory};
  }
  async function resolve(input={}, {start=false,signal}={}){
    const config=normalizeLocalConfig(input);
    if(config.engineMode!=='managed')return config;
    signal?.throwIfAborted();
    const state=start?await engine.start({signal}):await engine.status();
    signal?.throwIfAborted();
    if(!state.running||!state.endpoint)fail('Démarrez le moteur intégré dans les réglages IA.');
    return {...config,ollamaURL:state.endpoint,modelsDirectory:state.modelsDirectory};
  }
  function run(kind,model,action){
    if(task)fail('Une tâche est déjà en cours.');
    const current=controller=new AbortController();
    task={kind,model:model||null,phase:'preparing',completedBytes:null,totalBytes:null};lastResult=null;
    const emit=event=>{
      if(controller!==current)return;
      task={...task,...event,kind,model:model||null};
      onProgress({...event,kind:kind==='runtime'?'local-runtime':'local-model'});
    };
    const operation=(async()=>{
      try{
        const result=await action(current.signal,emit);
        current.signal.throwIfAborted();
        lastResult={kind,model:model||null,success:true};
        return result;
      }catch(error){
        lastResult={kind,model:model||null,...(current.signal.aborted?{cancelled:true}:{error:error.message})};
        if(current.signal.aborted)return {cancelled:true};
        throw error;
      }finally{
        if(controller===current){controller=null;task=null;pending=null;onProgress(null);}
      }
    })();
    pending=operation;return operation;
  }
  async function install(){
    return run('runtime',null,async(signal,emit)=>{
      const options=await diagnosticOptions({engineMode:'managed'});
      await diagnostics.checkModel(LOCAL_VISION_MODELS[0].id,options,true);
      signal.throwIfAborted();
      await engine.install({signal,onProgress:emit});
      emit({phase:'starting',status:'starting',completedBytes:null,totalBytes:null});
      const result=await engine.start({signal});
      return {...result,job:null,lastResult:{kind:'runtime',success:true}};
    });
  }
  async function pull(input){
    const config=normalizeLocalConfig(input);
    // Reject arbitrary model names before installing/starting any process.
    if(!LOCAL_VISION_MODELS.some(model=>model.id===config.model))fail('Choisissez un modèle recommandé pour le téléchargement.');
    return run('model',config.model,async(signal,emit)=>{
      const options=await diagnosticOptions(config);
      await diagnostics.checkModel(options.model,options,true);
      signal.throwIfAborted();
      const effective=await resolve(options,{start:true,signal});
      return client({endpoint:effective.ollamaURL}).pullModel(effective.model,{signal,onProgress:emit});
    });
  }
  async function start(){
    return run('runtime',null,async(signal,emit)=>{
      emit({phase:'starting',status:'starting'});
      return engine.start({signal});
    });
  }
  async function stop(){if(task)fail('Une tâche est déjà en cours.');await engine.stop();return status();}
  const cancel=kind=>{if(!kind||task?.kind===kind)controller?.abort();};
  async function shutdown(){
    cancel();
    // A start in flight must finish its own abort cleanup before final stop.
    await Promise.allSettled([pending,engine.stop()]);
    await engine.stop();
  }
  return {status,install,start,stop,pull,cancel,shutdown,resolve,
    hardware:async input=>diagnostics.hardware(await diagnosticOptions(input)),
    recommendations:async input=>diagnostics.recommendations(await diagnosticOptions(input)),
    get busy(){return task!==null;}};
}
