import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {_electron} from 'playwright';
import sharp from 'sharp';
import {syntheticBayerDNG} from './fixtures/synthetic-dng.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))),require=createRequire(import.meta.url);
const temporary=await mkdtemp(join(tmpdir(),'atelier-raw-gui-')),data=join(temporary,'data'),output=join(temporary,'export');
await mkdir(data);await mkdir(output);let app;
try{
  const path=join(temporary,'test-capteur.dng');await writeFile(path,syntheticBayerDNG(1024,600));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),original=hash(await readFile(path));
  const env={...process.env,ATELIER_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.ATELIER_PACKAGED_EXE||require('electron'),args:process.env.ATELIER_PACKAGED_EXE?[]:[root],cwd:root,env});
  const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('.app');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path);
  await page.getByRole('button',{name:'Importer',exact:true}).click();
  await page.getByTestId('photo-card').dblclick();
  const metadata=await page.evaluate(async()=>{const item=(await window.atelier.list({limit:1})).items[0];return window.atelier.metadata(item.id);});
  assert.equal(metadata.format,'raw');assert.equal(metadata.width,1024);assert.equal(metadata.height,600);
  await page.waitForFunction(()=>{const i=document.querySelector('.base-image');return i?.complete&&i.naturalWidth===512&&i.naturalHeight===300;});
  await page.getByLabel('Valeur Exposition',{exact:true}).fill('.6');
  await page.getByLabel('Valeur Exposition',{exact:true}).blur();
  await app.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},output);
  await page.getByRole('button',{name:'Exporter',exact:false}).first().click();
  await page.getByRole('button',{name:'TIFF',exact:true}).click();
  assert.equal(await page.getByLabel('Profondeur de couleur',{exact:true}).inputValue(),'16');
  await page.getByRole('button',{name:'Choisir le dossier et exporter',exact:true}).click();
  const deadline=Date.now()+30000;while(Date.now()<deadline){if((await readdir(output)).some(name=>name.endsWith('.tiff')))break;await page.waitForTimeout(100);}
  const files=await readdir(output);assert.equal(files.length,1);
  const target=join(output,files[0]),info=await sharp(target).metadata();
  assert.equal(info.width,1024);assert.equal(info.height,600);assert.equal(info.depth,'ushort');assert.equal(info.bitsPerSample,16);
  const decoded=await sharp(target).pipelineColourspace('rgb16').toColourspace('rgb16').raw({depth:'ushort'}).toBuffer({resolveWithObject:true});
  const values=new Uint16Array(decoded.data.buffer,decoded.data.byteOffset,decoded.data.length/2),levels=new Set();
  for(let x=0;x<1024;x++)levels.add(values[(200*1024+x)*decoded.info.channels]);
  assert.ok(levels.size>256,`${levels.size} actual RAW levels exported`);
  const cache=await readdir(join(data,'raw-cache/raw16-v1'));assert.equal(cache.filter(name=>name.endsWith('.tiff')).length,2);
  assert.equal(hash(await readFile(path)),original);assert.deepEqual(errors,[]);
  console.log(`Import DNG Bayer réel → aperçu demi-définition → exposition → TIFF pleine définition16 : ${levels.size} niveaux mesurés, deux caches distincts, source intacte.`);
}finally{await app?.close();await rm(temporary,{recursive:true,force:true});}
