import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {_electron} from 'playwright';
import sharp from 'sharp';

const root=dirname(dirname(fileURLToPath(import.meta.url))),require=createRequire(import.meta.url);
const temporary=await mkdtemp(join(tmpdir(),'atelier-spatial-')),data=join(temporary,'data');await mkdir(data);
let app;
try{
  const path=join(temporary,'spatial-source.png');
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#a0d0ff"/><stop offset="1" stop-color="#fff0b0"/></linearGradient></defs><rect width="1200" height="800" fill="url(#sky)"/><circle cx="800" cy="160" r="70" fill="#fff0c5"/><path d="M0 620 180 240 440 630 720 320 1050 620 1200 430V800H0Z" fill="#4d6b82"/><path d="M0 720 200 600 470 750 700 590 1000 740 1200 650V800H0Z" fill="#183c3a"/><rect x="170" y="470" width="30" height="260" fill="#382f2a"/><path d="M185 250 75 590H295Z" fill="#254f40"/></svg>';
  await sharp(Buffer.from(svg)).png().toFile(path);
  const original=createHash('sha256').update(await readFile(path)).digest('hex');
  const env={...process.env,ATELIER_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.ATELIER_PACKAGED_EXE||require('electron'),args:process.env.ATELIER_PACKAGED_EXE?[]:[root],cwd:root,env});
  const page=await app.firstWindow(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/i.test(request.url()))external.push(request.url());});
  await page.waitForSelector('.app');
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},path);
  await page.getByRole('button',{name:'Importer',exact:true}).click();
  await page.getByTestId('photo-card').dblclick();
  await page.getByRole('button',{name:'Cadrage',exact:true}).click();
  await page.getByRole('button',{name:'Explorer la profondeur',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  const start=Date.now();
  while(Date.now()-start<130000){
    const state=await page.evaluate(()=>({error:document.querySelector('.spatial-error')?.textContent,ready:document.querySelector('.spatial-stage canvas')?.style.visibility==='visible'}));
    if(state.error)throw new Error(state.error);
    if(state.ready)break;
    await page.waitForTimeout(200);
  }
  const canvas=page.getByTestId('spatial-canvas');
  await canvas.waitFor({state:'visible'});
  console.log(`Modèle local + inférence de profondeur : ${((Date.now()-start)/1000).toFixed(1)} s.`);
  const capture=()=>canvas.evaluate(element=>element.toDataURL('image/png').split(',')[1]);
  const before=await capture();
  await page.getByLabel('Déplacement horizontal',{exact:true}).fill('7');
  await page.getByLabel('Déplacement vertical',{exact:true}).fill('-3');
  await page.waitForTimeout(250);
  const after=await capture();assert.notEqual(after,before,'Moving the depth mesh must alter the rendered pixels');
  const decoded=await sharp(Buffer.from(after,'base64')).raw().toBuffer();
  assert.ok(new Set(decoded).size>50,'Spatial view must contain the actual photograph, not a blank canvas');
  await mkdir(join(root,'test-artifacts'),{recursive:true});await page.screenshot({path:join(root,'test-artifacts/spatial-view.png')});
  await page.getByRole('checkbox',{name:'Afficher la carte de profondeur',exact:true}).check();
  const map=await capture();assert.notEqual(map,after);
  await page.getByRole('checkbox',{name:'Afficher la carte de profondeur',exact:true}).uncheck();
  await page.getByRole('button',{name:'Exporter l’aperçu spatial',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(async()=>(await window.atelier.counts()).all),2);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),original);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('Vrai modèle ONNX local, maillage WebGL avec relief, déplacement, carte de profondeur, création PNG et source préservée : validés. Aucune requête HTTP.');
}finally{await app?.close();await rm(temporary,{recursive:true,force:true});}
