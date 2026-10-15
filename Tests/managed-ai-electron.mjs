/** Real Electron UI and IPC, with explicitly simulated downloads and inference. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {_electron} from 'playwright';
import {expect} from '@playwright/test';

const root=dirname(dirname(fileURLToPath(import.meta.url))),require=createRequire(import.meta.url);
const profile=await mkdtemp(join(tmpdir(),'atelier-managed-ui-'));
const env={...process.env,ATELIER_TEST_DATA:profile};
delete env.ELECTRON_RUN_AS_NODE;
for(const name of ['OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','ANTHROPIC_API_KEY','CLAUDE_API_KEY'])delete env[name];
let application;
const errors=[];
try{
  application=await _electron.launch({executablePath:process.env.ATELIER_PACKAGED_EXE||require('electron'),args:process.env.ATELIER_PACKAGED_EXE?[]:[root],cwd:root,env,chromiumSandbox:true,timeout:30000});
  assert.equal(await application.evaluate(({app})=>app.commandLine.hasSwitch('no-sandbox')),false);
  await application.evaluate(({ipcMain,BrowserWindow},profile)=>{
    const calls=[],model='qwen3-vl:2b-instruct';
    const state={supported:true,installed:false,running:false,version:'0.40.4',downloadBytes:167884528,requiredDiskBytes:2e9,license:'MIT',
      runtimeDirectory:profile+'/local-ai/ollama/v0.40.4',modelsDirectory:profile+'/local-ai/ollama/models',endpoint:null,job:null,lastResult:null};
    let pending,models=[];
    const send=event=>{for(const window of BrowserWindow.getAllWindows())window.webContents.send('atelier:progress',event);};
    const register=(name,handler)=>{ipcMain.removeHandler('atelier:'+name);ipcMain.handle('atelier:'+name,(_event,input)=>{calls.push({name,input});return handler(input);});};
    register('localEngineStatus',()=>structuredClone(state));
    const begin=kind=>{
      state.job={kind,phase:'download',completedBytes:40,totalBytes:100};state.lastResult=null;
      send({...state.job,kind:kind==='runtime'?'local-runtime':'local-model'});
      return new Promise(resolve=>{pending={kind,resolve};});
    };
    register('localEngineInstall',()=>begin('runtime'));
    register('localPull',input=>{assertNoRemote(input);return begin('model');});
    function assertNoRemote(input){if(input?.engineMode!=='managed'||'ollamaURL' in input||'modelsDirectory' in input)throw new Error('Unexpected external configuration');}
    const cancel=()=>{
      if(!pending)return;
      const {kind,resolve}=pending;pending=null;state.job=null;state.lastResult={kind,cancelled:true};send(null);resolve({cancelled:true});
    };
    register('cancelLocalEngineInstall',cancel);register('cancelLocalPull',cancel);
    register('localHardware',input=>{
      assertNoRemote(input);return {platform:'darwin',arch:'arm64',osVersion:'27.0',cpu:{name:'Synthetic QA CPU',cores:8},memory:{totalBytes:16*1024**3,freeBytes:12*1024**3},
        gpu:{name:null,accelerationHint:'unknown'},storage:{path:state.modelsDirectory,freeBytes:50*1024**3,configurationVerified:true},warnings:[]};
    });
    register('localRecommendations',input=>{assertNoRemote(input);return [2,4,8].map(size=>({id:`qwen3-vl:${size}b-instruct`,name:`Qwen3-VL Instruct ${size}B`,downloadBytes:size*1e9,downloadEstimated:true,
      license:'Apache-2.0',assessment:{status:size===8?'insufficient':'unknown',requiredDiskBytes:size*2e9+1e9,reasons:['resource_estimates_only']}}));});
    register('localStatus',input=>{assertNoRemote(input);return {available:state.running,version:state.version,models:structuredClone(models)};});
    register('localBenchmark',input=>{assertNoRemote(input);if(input.model!==model)throw new Error('Wrong selected model');return {validRecipe:true,elapsedMs:1250,acceleration:'unknown'};});
    register('localEngineStop',()=>{state.running=false;state.endpoint=null;return structuredClone(state);});
    register('localEngineStart',()=>{state.running=true;state.endpoint='http://127.0.0.1:54321/';return structuredClone(state);});
    globalThis.__managedUIQA={calls,state,finish:()=>{
      if(!pending)throw new Error('No pending simulated download');
      const {kind,resolve}=pending;pending=null;state.job=null;state.lastResult={kind,success:true};
      if(kind==='runtime'){state.installed=true;state.running=true;state.endpoint='http://127.0.0.1:54321/';}
      else models=[{name:model,local:true,capabilities:['vision'],size:1889519783}];
      send(null);resolve(kind==='runtime'?structuredClone(state):{name:model,local:true,capabilities:['vision']});
    }};
  },profile);
  const page=await application.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  const open=async()=>{
    await page.getByRole('button',{name:'Réglages IA',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByRole('button',{name:'IA locale',exact:true}).click();
    await dialog.getByTestId('managed-engine-panel').waitFor();return dialog;
  };
  let dialog=await open();
  const install=()=>dialog.getByTestId('managed-runtime-install');
  await page.getByText('Moteur non installé',{exact:true}).waitFor();
  assert.equal(await install().isDisabled(),true,'hardware must be checked before installation');
  const initial=await application.evaluate(()=>globalThis.__managedUIQA.calls.map(call=>call.name));
  assert.ok(initial.includes('localEngineStatus'));assert.ok(!initial.some(name=>['localEngineInstall','localPull','localHardware','localBenchmark','localEngineStart'].includes(name)));
  await dialog.getByRole('button',{name:'Vérifier cet ordinateur',exact:true}).click();
  await expect(install()).toBeEnabled();
  await install().click();
  await dialog.getByRole('progressbar',{name:'Téléchargement du moteur…',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Fermer',exact:true}).click();
  dialog=await open();
  const progress=dialog.getByRole('progressbar',{name:'Téléchargement du moteur…',exact:true});
  await progress.waitFor();assert.equal(await progress.getAttribute('value'),'40');
  assert.equal(await dialog.getByRole('button',{name:'Utiliser une installation existante',exact:true}).isDisabled(),true);
  await dialog.getByRole('button',{name:'Annuler l’installation',exact:true}).click();
  await dialog.getByText('Installation du moteur annulée.',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('progressbar').count(),0);
  await dialog.getByRole('button',{name:'Vérifier cet ordinateur',exact:true}).click();
  await install().click();
  await dialog.getByRole('button',{name:'Annuler l’installation',exact:true}).waitFor();
  await application.evaluate(()=>globalThis.__managedUIQA.finish());
  await dialog.getByText('Moteur en cours d’exécution',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Télécharger Qwen3-VL Instruct 2B',exact:true}).click();
  await dialog.getByRole('progressbar',{name:'Téléchargement du modèle…',exact:true}).waitFor();
  await application.evaluate(()=>globalThis.__managedUIQA.finish());
  await dialog.getByText('Modèle téléchargé · test nécessaire',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('combobox',{name:'Modèle d’analyse local',exact:true}).inputValue(),'qwen3-vl:2b-instruct');
  assert.equal(await dialog.getByRole('button',{name:'Modèle vérifié',exact:true}).count(),0);
  await dialog.getByRole('button',{name:'Tester ce modèle',exact:true}).click();
  await dialog.getByRole('button',{name:'Modèle vérifié',exact:true}).waitFor();
  await mkdir(join(root,'test-artifacts'),{recursive:true});
  await page.screenshot({path:join(root,'test-artifacts','managed-ai-setup.png')});
  await dialog.locator('footer').getByRole('button',{name:'Enregistrer',exact:true}).click();
  await dialog.waitFor({state:'hidden'});
  const saved=await page.evaluate(()=>window.atelier.getSettings());
  assert.equal(saved.provider,'local');assert.equal(saved.localAI.engineMode,'managed');assert.equal(saved.localAI.model,'qwen3-vl:2b-instruct');
  assert.equal(saved.localAI.ollamaURL,'http://127.0.0.1:11434/','private ephemeral port must not overwrite external connection settings');
  assert.deepEqual(errors,[]);
  console.log('ATELIER_MANAGED_UI_OK '+JSON.stringify({simulatedDownloads:true,simulatedInference:true,realElectronIPC:true,diagnosticRequired:true,reopenProgress:true,cancellation:true,modelSelection:true,testRequiredLabel:true,settingsSaved:true}));
}finally{
  await application?.close();await rm(profile,{recursive:true,force:true});
}
