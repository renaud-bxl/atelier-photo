import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {_electron} from 'playwright';
import sharp from 'sharp';
import {syntheticBayerDNG} from './fixtures/synthetic-dng.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url))),require=createRequire(import.meta.url);
async function verifyWindowsRuntimeModules(application){
  assert.equal(process.platform,'win32','Native DLL provenance is a Windows-only check.');
  assert.ok(process.env.ATELIER_PACKAGED_EXE,'DLL provenance requires an actual packaged executable.');
  const executable=await realpath(process.env.ATELIER_PACKAGED_EXE),applicationRoot=await realpath(dirname(executable));
  assert.equal((await realpath(await application.evaluate(({app})=>app.getPath('exe')))).toLowerCase(),executable.toLowerCase());
  const pid=application.process().pid;
  assert.ok(Number.isSafeInteger(pid)&&pid>0,'The exact application process must still be running.');
  const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  // Get-Process -Module is read-only and inspects only our own x64 application.
  // https://learn.microsoft.com/powershell/module/microsoft.powershell.management/get-process
  const script=`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $atelierModules=@(Get-Process -Id ${pid} -Module -ErrorAction Stop | Where-Object { $_.ModuleName -match '^(vcruntime140(_1)?|msvcp140|vcomp140)\\.dll$' } | Select-Object ModuleName,FileName); ConvertTo-Json -InputObject $atelierModules -Compress`;
  const {stdout}=await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000,maxBuffer:1024*1024,encoding:'utf8'});
  const modules=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
  assert.ok(Array.isArray(modules),'PowerShell must return a module array.');
  // libraw@0.1.0 win32-x64 PE imports these three directly; VCOMP140 is
  // delay-loaded and an individual RAW fixture need not invoke OpenMP.
  for(const required of ['vcruntime140.dll','vcruntime140_1.dll','msvcp140.dll'])assert.ok(modules.some(item=>item.ModuleName?.toLowerCase()===required),`${required} must be loaded after actual RAW processing.`);
  assert.equal(dirname(await realpath(join(applicationRoot,'vcomp140.dll'))).toLowerCase(),applicationRoot.toLowerCase(),'The delivered application must include its own OpenMP DLL.');
  for(const item of modules){
    assert.equal(typeof item.FileName,'string');
    const location=await realpath(item.FileName),child=relative(applicationRoot.toLowerCase(),location.toLowerCase());
    assert.ok(child&&child!=='..'&&!child.startsWith(`..${sep}`)&&!isAbsolute(child),`${item.ModuleName} came from outside the delivered application: ${location}`);
  }
  // ucrtbase.dll remains a Windows system component and is deliberately excluded.
  const openmpLoaded=modules.some(item=>item.ModuleName?.toLowerCase()==='vcomp140.dll');
  console.log('ATELIER_PACKAGED_DLLS_OK '+JSON.stringify({modules,openmpLoaded}));
  if(!openmpLoaded)console.log('OpenMP DLL is bundled but was not loaded by this RAW fixture; OpenMP loader provenance remains unexercised.');
}
const temporary=await mkdtemp(join(tmpdir(),'atelier-raw-gui-')),data=join(temporary,'data'),output=join(temporary,'export');
await mkdir(data);await mkdir(output);let app;
try{
  const path=join(temporary,'test-capteur.dng');await writeFile(path,syntheticBayerDNG(1024,600));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),original=hash(await readFile(path));
  const env={...process.env,ATELIER_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.ATELIER_PACKAGED_EXE||require('electron'),args:process.env.ATELIER_PACKAGED_EXE?[]:[root],cwd:root,env,chromiumSandbox:true});
  assert.equal(await app.evaluate(({app})=>app.commandLine.hasSwitch('no-sandbox')),false,'RAW QA must preserve the Chromium sandbox.');
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),data,'RAW QA must use its isolated catalogue.');
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
  if(process.env.ATELIER_VERIFY_NATIVE_DLLS==='1')await verifyWindowsRuntimeModules(app);
  console.log(`Import DNG Bayer réel → aperçu demi-définition → exposition → TIFF pleine définition16 : ${levels.size} niveaux mesurés, deux caches distincts, source intacte.`);
}finally{await app?.close();await rm(temporary,{recursive:true,force:true});}
