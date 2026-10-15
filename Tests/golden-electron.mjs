import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron } from 'playwright';
import sharp from 'sharp';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const require=createRequire(import.meta.url);
const temporary=await mkdtemp(join(tmpdir(),'atelier-golden-ui-'));
const data=join(temporary,'data');
await mkdir(data);
let app;
async function waitForBackend(page,predicate){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await page.evaluate(predicate))return;await page.waitForTimeout(80);}
  throw new Error('Le réglage attendu n’a pas été enregistré.');
}
try {
  const first=join(temporary,'composition-01.png'), second=join(temporary,'composition-02.png');
  const image=await sharp({create:{width:1200,height:800,channels:3,background:'#334a70'}}).png().toBuffer();
  await Promise.all([sharp(image).toFile(first),sharp(image).toFile(second)]);
  const env={...process.env,ATELIER_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:process.env.ATELIER_PACKAGED_EXE||require('electron'),args:process.env.ATELIER_PACKAGED_EXE?[]:[root],env,cwd:root});
  const page=await app.firstWindow();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('.app');
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},first);
  await page.getByRole('button',{name:'Importer',exact:true}).click();
  await page.getByTestId('photo-card').dblclick();
  await page.getByRole('button',{name:'Cadrage',exact:true}).click();
  const crop=page.getByRole('checkbox',{name:'Recadrer au nombre d’or',exact:true});
  const guide=page.getByRole('checkbox',{name:'Afficher le guide',exact:true});
  await crop.check();
  await waitForBackend(page,async()=>Math.abs((await window.atelier.list({limit:1})).items[0].adjustments.cropRatio-(1+Math.sqrt(5))/2)<1e-9);
  assert.equal(await page.getByTestId('golden-composition').count(),0);
  const before=await page.evaluate(async()=>JSON.stringify((await window.atelier.list({limit:1})).items[0].adjustments));
  await guide.check();
  await page.getByTestId('golden-composition').waitFor();
  await page.getByLabel('Orientation de la spirale',{exact:true}).selectOption('180');
  await page.getByRole('checkbox',{name:'Inverser la spirale',exact:true}).check();
  await page.getByRole('checkbox',{name:'Afficher les carrés',exact:true}).uncheck();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.atelier.list({limit:1})).items[0].adjustments)),before);
  await mkdir(join(root,'test-artifacts'),{recursive:true});
  await page.screenshot({path:join(root,'test-artifacts/golden-guide.png')});
  await guide.uncheck();
  assert.equal(await page.getByTestId('golden-composition').count(),0);
  assert.equal(await crop.isChecked(),true);
  assert.equal(await page.evaluate(async()=>JSON.stringify((await window.atelier.list({limit:1})).items[0].adjustments)),before);
  await guide.check();
  await page.getByLabel('Orientation de la spirale',{exact:true}).selectOption('90');
  await waitForBackend(page,async()=>Math.abs((await window.atelier.list({limit:1})).items[0].adjustments.cropRatio-2/(1+Math.sqrt(5)))<1e-9);
  await crop.uncheck();
  assert.equal(await guide.isChecked(),true);
  await page.getByTestId('golden-composition').waitFor();
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},second);
  await page.getByRole('button',{name:'Importer',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.filmstrip-heading')?.textContent.includes('2 photos'));
  await page.locator('.filmstrip-heading').getByRole('button',{name:'Tout sélectionner',exact:true}).click();
  await page.getByRole('button',{name:'Assistant IA',exact:true}).click();
  await page.getByRole('checkbox',{name:'Analyser les 2 photos sélectionnées',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Guide visible/masqué indépendant du cadrage, rotations/miroir sans effet export, ratio portrait, compteur en éditeur : validés. Aucun appel IA.');
} finally {
  await app?.close();await rm(temporary,{recursive:true,force:true});
}
