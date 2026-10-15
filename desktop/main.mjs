import { app, BrowserWindow, ipcMain, dialog, protocol, safeStorage, shell, Menu } from 'electron';
import { join, dirname, basename, extname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Catalog } from './catalog.mjs';
import { renderImage, thumbnail, getMetadata, normalizeAdjustments } from './image-engine.mjs';
import { recommend, edit } from './ai-service.mjs';
import { isRaw,identifyRaw,resolveRawSource } from './raw-decoder.mjs';
import { validateColorLUT } from './color-style.mjs';
import { decodeSpatialBase64 } from './media-input.mjs';
import { verifyModelAssets } from './model-assets.mjs';
import {createOllamaClient} from './local-ai.mjs';
import {DEFAULT_LOCAL_AI,normalizeLocalConfig,createLocalDiagnostics,assessLocalGeneration} from './local-runtime.mjs';
import {protectLocalRecommendation} from './local-recommendation.mjs';
import {createManagedOllama} from './managed-ollama.mjs';
import {createLocalEngineService} from './local-engine-service.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isTest = Boolean(process.env.ATELIER_TEST_DATA);
if (isTest) app.setPath('userData', process.env.ATELIER_TEST_DATA);
app.setName('Atelier Photo');
// One owner per catalogue/profile also prevents competing private AI processes.
if(!app.requestSingleInstanceLock())app.exit(0);
protocol.registerSchemesAsPrivileged([{ scheme: 'atelier', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
sharp.cache({ memory: 64, files: 16, items: 80 }); sharp.concurrency(2);
let window, faceWindow, catalog, settings = {}, vault = {}, encryptedCapability = null;
app.on('second-instance',()=>{
  if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}
  else app.emit('activate');
});
let job = null, aiController = null, localEngines;
const localDiagnostics=createLocalDiagnostics();
const faceCache = new Map(), faceRequests = new Map(), pendingFaces = new Map();
const previewCache = new Map(), pendingPreview = new Map(), pendingThumbnails = new Map(), previewRevision = new Map();
const sessionKeys = new Map();
const defaults = {
  provider: 'openai',
  models: { openai: 'gpt-6-luna', gemini: 'gemini-3.8-flash', claude: 'claude-sonnet-5-5' },
  imageModels: { openai: 'gpt-image-2.5-sunburst', gemini: 'gemini-3.1-flash-image', claude: '' },
  localAI:{...DEFAULT_LOCAL_AI,engineMode:'managed'}
};
const dataPath = name => join(app.getPath('userData'), name);
const progress = state => { if (window && !window.isDestroyed()) window.webContents.send('atelier:progress', state); };
const fail = message => { throw new Error(message); };
const photo = id => catalog.get(id) ?? fail('Photo introuvable dans le catalogue.');
const portrait = a => ['skinSmoothing','faceLight','teethWhitening','eyeBrightness','blemishReduction','skinEvenness','underEyeLight','eyeContrast','lipSaturation'].some(k => (a?.[k] || 0) > 0);
const providers = new Set(['openai','gemini','claude']);
const validProvider = p => providers.has(p)||p==='local' ? p : fail('Fournisseur IA non valide.');
const cloudProvider = p => providers.has(p) ? p : fail('Ce fournisseur n’utilise pas de clé API.');
const photoExtensions = new Set(['.jpg','.jpeg','.jpe','.png','.tif','.tiff','.webp','.avif','.heic','.heif','.hif']);
const supportedPhoto=path=>photoExtensions.has(extname(path).toLowerCase())||isRaw(path);
const readImageMetadata=path=>isRaw(path)?identifyRaw(path):getMetadata(path);
const imageSource=(path,fullResolution=false,signal)=>resolveRawSource(path,{cacheDirectory:dataPath('raw-cache'),fullResolution,signal});

function updatePhoto(id, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Réglages de photo non valides.');
  const next = { ...patch };
  if (Object.hasOwn(next, 'adjustments')) next.adjustments = normalizeAdjustments(next.adjustments);
  const result = catalog.update(id, next);
  if (Object.hasOwn(next, 'adjustments')) previewRevision.set(id, (previewRevision.get(id) ?? 0) + 1);
  return result;
}

async function readJSON(path, fallback) { try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return fallback; } }
async function atomicJSON(path, data) { const temp = `${path}.${randomUUID()}.tmp`; try { await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, path); } finally { await fs.rm(temp, { force: true }).catch(() => {}); } }
function encryptionAvailable() { encryptedCapability=safeStorage.isEncryptionAvailable() && !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text');return encryptedCapability; }
function keyFor(provider) {
  if (sessionKeys.has(provider)) return sessionKeys.get(provider);
  if (!vault[provider] || !encryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(vault[provider], 'base64')); } catch { return ''; }
}
function settingsPublic() { return { ...settings, keys: Object.fromEntries([...providers].map(p => [p, sessionKeys.has(p)||Boolean(vault[p])])), encryptedStorage: encryptedCapability, platform: process.platform, version: app.getVersion() }; }

const localOptions = input => normalizeLocalConfig({...settings.localAI,...input,comfyModels:{...settings.localAI?.comfyModels,...input?.comfyModels}});
const ollama = config => createOllamaClient({endpoint:config.ollamaURL});
async function analyse(config,options,item){
  if(config.provider!=='local')return recommend(config);
  if(!options)fail('Réglages IA locale manquants.');
  const effective=await localEngines.resolve(options,{start:true,signal:config.signal});
  await localDiagnostics.checkModel(effective.model,effective);
  const result=await ollama(effective).recommend({...config,model:effective.model});
  let facesDetected=false;
  if(portrait(result.adjustments)){
    try{facesDetected=Boolean((await detectFaces(item.id))?.faces?.length);}catch(error){if(config.signal?.aborted)throw error;}
  }
  config.signal?.throwIfAborted();
  return protectLocalRecommendation(result,{currentAdjustments:item.adjustments,facesDetected});
}
async function localEdit(config,options){
  const {editComfy}=await import('./comfy-service.mjs');
  return editComfy({...config,baseURL:options.comfyURL,models:options.comfyModels});
}
async function checkLocalGeneration(options,item,mode,margins,signal){
  if(!['diffusion','textEncoder','vae'].every(key=>options.comfyModels[key]))fail('Configurez ComfyUI dans les réglages IA pour créer une image ou des bordures en local.');
  const snapshot=await localDiagnostics.hardware(options);
  const metadata=await readImageMetadata(item.path);
  const radians=(item.adjustments.rotation||0)*Math.PI/180;
  let width=Math.ceil(Math.abs(metadata.width*Math.cos(radians))+Math.abs(metadata.height*Math.sin(radians)));
  let height=Math.ceil(Math.abs(metadata.height*Math.cos(radians))+Math.abs(metadata.width*Math.sin(radians)));
  const sourcePixels=mode==='expand'?Math.max(metadata.width*metadata.height,width*height):1600*1600;
  if(item.adjustments.cropRatio>0){const ratio=item.adjustments.cropRatio;const before=width;width=Math.max(1,Math.min(width,Math.floor(height*ratio)));height=Math.max(1,Math.min(height,Math.floor(before/ratio)));}
  let outputPixels=1600*1600;
  if(mode==='expand'){
    const values=Object.fromEntries(['left','right','top','bottom'].map(key=>[key,margins?.[key]??0]));
    if(Object.values(values).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>100))fail('Chaque marge doit être un pourcentage compris entre 0 et 100.');
    const canvasWidth=width+Math.round(width*values.left/100)+Math.round(width*values.right/100);
    const canvasHeight=height+Math.round(height*values.top/100)+Math.round(height*values.bottom/100);
    outputPixels=canvasWidth*canvasHeight;
    if(outputPixels>120000000||canvasWidth>32000||canvasHeight>32000)fail('Le canevas agrandi dépasse 120 millions de pixels ou 32 000 pixels sur un côté. Réduisez les marges ou la photo.');
  }
  const assessment=assessLocalGeneration(snapshot,{sourcePixels,outputPixels});
  if(assessment.status==='insufficient')fail('Les ressources mesurées de cet ordinateur sont insuffisantes pour cette retouche générative locale.');
  if(snapshot.gpu?.accelerationHint==='metal'&&Object.values(options.comfyModels).some(name=>/fp8/i.test(name)))fail('Cette configuration FP8 n’a pas été validée avec Metal. Choisissez le modèle BF16.');
  const {inspectComfy}=await import('./comfy-service.mjs');
  const status=await inspectComfy({baseURL:options.comfyURL,signal});
  if(!status.ready)fail('La configuration ComfyUI requise est indisponible. Vérifiez les composants et les modèles.');
}

function makeWindow() {
  const macTitleBar = process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 } } : {};
  const w = new BrowserWindow({ width: 1480, height: 980, minWidth: 1060, minHeight: 680, backgroundColor: '#101113', icon:join(root,'dist/app-icon.png'), title: 'Atelier Photo', ...macTitleBar, webPreferences: { preload: join(root, 'desktop/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', event => event.preventDefault());
  w.loadFile(join(root, 'dist/index.html')).catch(error => { console.error('Interface indisponible :', error.message); });
  w.on('closed', () => { if (window === w) { window = null; faceWindow?.close(); } });
  return w;
}

let faceReadyPromise;
async function ensureFaceWorker() {
  if (faceReadyPromise) return faceReadyPromise;
  const worker = new BrowserWindow({ show: false, webPreferences: { preload: join(root, 'desktop/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true } });
  faceWindow = worker;
  worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  worker.webContents.on('will-navigate', event => event.preventDefault());
  let rejectStartup;
  const readiness = new Promise((resolveReady, reject) => {
    rejectStartup = reject;
    const timer = setTimeout(() => reject(new Error('La détection du visage n’a pas démarré.')), 45000);
    worker._ready = error => { clearTimeout(timer); error ? reject(new Error(error)) : resolveReady(); };
    worker.once('closed', () => clearTimeout(timer));
  });
  const reset = error => {
    if (faceWindow !== worker) return;
    faceWindow = null; faceReadyPromise = null;
    rejectStartup(error);
    for (const pending of faceRequests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    faceRequests.clear();
    if (!worker.isDestroyed()) worker.destroy();
  };
  worker.once('closed', () => reset(new Error('La fenêtre de détection a été fermée.')));
  worker.webContents.once('render-process-gone', () => reset(new Error('Le moteur de détection a été interrompu.')));
  faceReadyPromise = readiness.catch(error => { reset(error); throw error; });
  worker.loadFile(join(root, 'dist/face-worker.html')).catch(rejectStartup);
  return faceReadyPromise;
}

async function detectFaces(id) {
  const item = photo(id), stat = await fs.stat(item.path);
  const key = `${id}:${stat.mtimeMs}:${stat.size}`;
  if (faceCache.has(key)) return faceCache.get(key);
  if (pendingFaces.has(key)) return pendingFaces.get(key);
  const pending = (async () => {
    await ensureFaceWorker();
    if (!faceWindow || faceWindow.isDestroyed()) fail('Le moteur de détection est indisponible.');
    if (faceRequests.size >= 64) fail('Le moteur de détection est occupé. Réessayez dans un instant.');
    const requestId = randomUUID();
    const result = await new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { faceRequests.delete(requestId); reject(new Error('Détection du visage interrompue.')); }, 45000);
      faceRequests.set(requestId, { resolve: resolveResult, reject, timer });
      faceWindow.webContents.send('atelier:faceTask', { requestId, id });
    });
    faceCache.set(key, result);
    if (faceCache.size > 800) faceCache.delete(faceCache.keys().next().value);
    return result;
  })();
  pendingFaces.set(key, pending);
  try { return await pending; } finally { if (pendingFaces.get(key) === pending) pendingFaces.delete(key); }
}

let imageActive = 0;
const imageWaiting = [];
function pumpImages() {
  while (imageActive < 2 && imageWaiting.length) {
    const entry = imageWaiting.shift();
    entry.signal?.removeEventListener('abort', entry.abort);
    if (entry.signal?.aborted) { entry.reject(new Error('Aperçu annulé.')); continue; }
    imageActive++;
    Promise.resolve().then(entry.action).then(entry.resolve, entry.reject).finally(() => { imageActive--; pumpImages(); });
  }
}
function boundedImage(action, { signal, kind = 'essential' } = {}) {
  return new Promise((resolveAction, reject) => {
    if (signal?.aborted) return reject(new Error('Aperçu annulé.'));
    if (imageWaiting.length >= 128) {
      const stale = imageWaiting.findIndex(entry => entry.kind !== 'essential');
      if (stale < 0) return reject(new Error('Le moteur photo est occupé. Réessayez dans un instant.'));
      const [entry] = imageWaiting.splice(stale, 1);
      entry.signal?.removeEventListener('abort', entry.abort);
      entry.reject(new Error('Aperçu remplacé par une demande récente.'));
    }
    const entry = { action, resolve: resolveAction, reject, signal, kind };
    entry.abort = () => { const index = imageWaiting.indexOf(entry); if (index >= 0) { imageWaiting.splice(index, 1); reject(new Error('Aperçu annulé.')); } };
    signal?.addEventListener('abort', entry.abort, { once: true });
    if (kind === 'essential') imageWaiting.unshift(entry); else imageWaiting.push(entry);
    pumpImages();
  });
}

// Share work without allowing one disconnected <img> to cancel another consumer.
function sharedImage(map, key, create, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Aperçu annulé.'));
  let entry = map.get(key);
  if (!entry || entry.controller.signal.aborted) {
    entry = { controller: new AbortController(), users: 0, settled: false };
    const current = entry;
    entry.promise = Promise.resolve().then(() => create(current.controller.signal)).finally(() => {
      current.settled = true;
      if (map.get(key) === current) map.delete(key);
    });
    map.set(key, entry);
  }
  entry.users++;
  return new Promise((resolveResult, reject) => {
    let finished = false;
    const done = (callback, value) => {
      if (finished) return;
      finished = true; signal?.removeEventListener('abort', abort);
      entry.users--;
      if (!entry.users && !entry.settled) entry.controller.abort();
      callback(value);
    };
    const abort = () => done(reject, new Error('Aperçu annulé.'));
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(value => done(resolveResult, value), error => done(reject, error));
  });
}

async function preview(id, original = false, signal) {
  const item = photo(id), stat = await fs.stat(item.path);
  const a = original ? {} : item.adjustments;
  const revision = previewRevision.get(id) ?? 0;
  const cacheKey = `${id}:${stat.mtimeMs}:${stat.size}:${original ? 'original' : revision}:${JSON.stringify(a)}`;
  if (previewCache.has(cacheKey)) return previewCache.get(cacheKey);
  return sharedImage(pendingPreview, cacheKey, async workSignal => {
    if (!original) await new Promise(resolveDelay => setTimeout(resolveDelay, 40));
    workSignal.throwIfAborted();
    if (!original && revision !== (previewRevision.get(id) ?? 0)) return preview(id, false, workSignal);
    const landmarks = !original && portrait(a) ? await detectFaces(id) : null;
    workSignal.throwIfAborted();
    const result = await boundedImage(async () => {
      if (!original && revision !== (previewRevision.get(id) ?? 0)) return null;
      const source=await imageSource(item.path,false,workSignal);
      const bytes = await renderImage(source, a, { maxDimension: 1600, landmarks, lut:await loadLUT(a.lutId) });
      if (!workSignal.aborted) previewCache.set(cacheKey, bytes);
      while (previewCache.size > 8) previewCache.delete(previewCache.keys().next().value);
      return bytes;
    }, { signal: workSignal, kind: original ? 'essential' : 'preview' });
    return result ?? preview(id, false, workSignal);
  }, signal);
}

async function photoThumbnail(id, signal) {
  const item = photo(id), stat = await fs.stat(item.path);
  const hash = createHash('sha256').update(`${item.path}:${stat.mtimeMs}:${stat.size}`).digest('hex');
  const path = dataPath(`thumbnails/${hash}.jpg`);
  try { return await fs.readFile(path); } catch {}
  return sharedImage(pendingThumbnails, hash, workSignal => boundedImage(async () => {
    const source=await imageSource(item.path,false,workSignal);
    const bytes = await thumbnail(source);
    await fs.writeFile(path, bytes).catch(() => {});
    return bytes;
  }, { signal: workSignal, kind: 'thumbnail' }), signal);
}

function within(base, candidate) { const child = relative(base, candidate); return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); }

function registerProtocol() {
  protocol.handle('atelier', async request => {
    try {
      const url = new URL(request.url);
      if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
      const id = decodeURIComponent(url.pathname.slice(1));
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      if (url.host === 'assets') {
        const base = resolve(root, 'dist/models');
        const path = resolve(base, id);
        if (!within(base, path) || !within(await fs.realpath(base), await fs.realpath(path))) return new Response(null, { status: 403 });
        const extension = extname(path);
        headers['Content-Type'] = extension === '.wasm' ? 'application/wasm' : ['.js','.mjs'].includes(extension) ? 'application/javascript' : 'application/octet-stream';
        return new Response(request.method === 'HEAD' ? null : await fs.readFile(path), { headers });
      }
      if (!['preview','thumbnail'].includes(url.host) || !/^[a-f0-9-]{36}$/i.test(id)) return new Response(null, { status: 404 });
      const buffer = url.host === 'thumbnail' ? await photoThumbnail(id, request.signal) : await preview(id, url.searchParams.get('original') === '1', request.signal);
      headers['Content-Type'] = 'image/jpeg'; return new Response(request.method === 'HEAD' ? null : buffer, { headers });
    } catch (error) { return new Response('Image indisponible', { status: 422, headers: { 'Access-Control-Allow-Origin': '*' } }); }
  });
}

async function importEntries(entries, folder = false) {
  if (job||localEngines?.busy) fail('Une tâche est déjà en cours.');
  job = { cancelled: false }; const current = job;
  let added = 0, skipped = 0, found = 0, batch = []; const errors = [];
  async function flush() {
    if (!batch.length) return;
    const valid = [], metadata = new Map();
    for (const path of batch) {
      if (current.cancelled) break;
      if (!supportedPhoto(path)) { skipped++; continue; }
      try { const info = await readImageMetadata(path); valid.push(path); metadata.set(path, info); }
      catch { skipped++; if (errors.length < 15) errors.push(`${basename(path)} : format non pris en charge ou photo illisible.`); }
    }
    const result = catalog.importPaths(valid); added += result.added; skipped += result.skipped; batch = [];
    for (const path of valid) {
      const item = catalog.getByPath(path), info = metadata.get(path);
      if (item) catalog.update(item.id, { width: info.width, height: info.height });
    }
    progress({ kind: 'import', current: found, text: `${added.toLocaleString('fr')} photos ajoutées`, added, skipped });
    await new Promise(resolveYield => setImmediate(resolveYield));
  }
  async function walk(path) {
    if (current.cancelled) return;
    let stat; try { stat = await fs.lstat(path); } catch { skipped++; return; }
    if (stat.isSymbolicLink()) { skipped++; return; }
    if (stat.isDirectory() && folder) {
      try { const dir = await fs.opendir(path); for await (const entry of dir) { if (current.cancelled) break; if (!entry.name.startsWith('.')) await walk(join(path, entry.name)); } } catch { skipped++; }
    } else if (stat.isFile()) { found++; batch.push(path); if (batch.length >= 200) await flush(); }
  }
  try { for (const path of entries) await walk(path); await flush(); return { added, skipped, errors, cancelled: current.cancelled }; }
  finally { job = null; progress(null); }
}

function selectedItems(selection = {}) {
  if (selection.all) {
    return (function* () { let offset = 0; while (true) { const page = catalog.list({ ...selection.query, offset, limit: 100 }); if (!page.items.length) break; yield* page.items; offset += page.items.length; } })();
  }
  const ids = Array.isArray(selection.ids) ? [...new Set(selection.ids)] : [];
  return ids.map(id => photo(id));
}

async function uniqueDestination(directory, name, extension) {
  const stem = basename(name, extname(name)).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
  for (let i = 0; i < 100000; i++) {
    const path = join(directory, `${stem}_atelier${i ? `_${i}` : ''}.${extension}`);
    try { await fs.access(path); } catch { return path; }
  }
  fail('Impossible de choisir un nom d’export libre.');
}

function handle(name, callback, worker = false) {
  ipcMain.handle(`atelier:${name}`, async (event, ...args) => {
    const expected = worker ? faceWindow : window;
    if (!expected || expected.isDestroyed() || event.sender.id !== expected.webContents.id || event.senderFrame !== event.sender.mainFrame) fail('Appel non autorisé.');
    return callback(...args);
  });
}


const lutCache = new Map();
async function loadLUT(id) {
  if(!id)return null;
  if(!/^[a-f0-9]{64}$/.test(id))fail('LUT non valide.');
  if(lutCache.has(id))return lutCache.get(id);
  const data=await readJSON(dataPath(`luts/${id}.json`),null);
  if(!data)fail('La LUT de ce préréglage est introuvable.');
  lutCache.set(id,data);while(lutCache.size>4)lutCache.delete(lutCache.keys().next().value);return data;
}
async function importStyleEntries(entries) {
  if(job||localEngines?.busy)fail('Une tâche est déjà en cours.');
  const {parseXMP,parseCube}=await import('./preset-import.mjs');
  const current=job={cancelled:false};let added=0,skipped=0,partial=0,unavailable=0;const errors=[];
  const existing=catalog.presets(),known=new Set(existing.map(p=>p.adjustments?._import?.hash).filter(Boolean));
  const names=new Map(existing.map(p=>[p.name.toLocaleLowerCase(),p.adjustments?._import?.hash]));
  const paths=[];
  async function collect(path){
    if(current.cancelled)return;const stat=await fs.lstat(path).catch(()=>null);if(!stat||stat.isSymbolicLink())return;
    if(stat.isDirectory()){for await(const entry of await fs.opendir(path)){if(!entry.name.startsWith('.'))await collect(join(path,entry.name));}}
    else if(['.xmp','.cube'].includes(extname(path).toLowerCase()))paths.push(path);
  }
  try {
    for(const path of entries)await collect(path);
    for(const path of paths){
      if(current.cancelled)break;
      try{
        const stat=await fs.stat(path);if(stat.size>32*1024*1024)fail('Fichier de style trop volumineux.');
        const text=await fs.readFile(path,'utf8'),hash=createHash('sha256').update(text).digest('hex');
        if(known.has(hash)){skipped++;continue;}
        let name,adjustments,meta;
        if(extname(path).toLowerCase()==='.cube'){
          const lut=parseCube(text);name=lut.title||basename(path,'.cube');
          await atomicJSON(dataPath(`luts/${hash}.json`),{...lut,values:Array.from(lut.values)});
          adjustments=normalizeAdjustments({lutId:hash,lutIntensity:1});
          meta={type:'LUT',hash,sourceName:basename(path),compatibility:'adapted',category:'LUT',supportedFields:['LUT 3D'],unsupportedFields:[],copyright:''};
        }else{
          const parsed=parseXMP(text,{filename:basename(path)});name=parsed.name;
          adjustments=normalizeAdjustments(parsed.adjustments);
          meta={type:'XMP',hash,sourceName:parsed.sourceName,category:parsed.category||'Styles importés',compatibility:parsed.compatibility,supportedFields:parsed.supportedFields,unsupportedFields:parsed.unsupportedFields,copyright:parsed.copyright};
          if(parsed.compatibility==='partial')partial++;if(['profile-required','unsupported'].includes(parsed.compatibility))unavailable++;
        }
        name=String(name).slice(0,100);
        if(names.has(name.toLocaleLowerCase())&&names.get(name.toLocaleLowerCase())!==hash)name=`${name.slice(0,88)} · ${hash.slice(0,6)}`;
        catalog.savePreset(name,{...adjustments,_import:meta});known.add(hash);names.set(name.toLocaleLowerCase(),hash);added++;
      }catch(error){skipped++;if(errors.length<20)errors.push(`${basename(path)} : ${error.message}`);}
      if((added+skipped)%20===0){progress({kind:'styles',current:added+skipped,total:paths.length,text:`${added} styles importés`});await new Promise(r=>setImmediate(r));}
    }
    return {added,skipped,partial,unavailable,errors,cancelled:current.cancelled};
  }finally{job=null;progress(null);}
}

function registerIPC() {
  handle('list', options => catalog.list(options));
  handle('getPhoto',id=>photo(id));
  handle('counts', () => catalog.counts());
  handle('importPhotos', async () => { const r = await dialog.showOpenDialog(window, { properties: ['openFile','multiSelections'], filters: [{name:'Photos',extensions:['jpg','jpeg','png','tif','tiff','webp','avif','heic','heif','raw','dng','cr2','cr3','nef','nrw','arw','raf','orf','rw2','rwl','pef','srw','iiq','3fr','fff','x3f']}] }); return r.canceled ? null : importEntries(r.filePaths); });
  handle('importFolder', async () => { const r = await dialog.showOpenDialog(window, { properties: ['openDirectory','multiSelections'] }); return r.canceled ? null : importEntries(r.filePaths, true); });
  handle('importDropped', paths => { if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) fail('Fichiers non valides.'); return importEntries(paths, true); });
  handle('update', updatePhoto);
  handle('metadata', async id => { const item = photo(id), metadata = await readImageMetadata(item.path); catalog.update(id, { width: metadata.width, height: metadata.height }); return metadata; });
  handle('remove', ids => {
    if (!Array.isArray(ids)) fail('Sélection non valide.');
    const result = catalog.remove(ids);
    for (const id of ids) {
      previewRevision.delete(id);
      for (const key of previewCache.keys()) if (key.startsWith(`${id}:`)) previewCache.delete(key);
      for (const key of faceCache.keys()) if (key.startsWith(`${id}:`)) faceCache.delete(key);
    }
    return result;
  });
  handle('importPresets', async ({folder=false}={}) => { const r=await dialog.showOpenDialog(window,{title:'Importer XMP / LUT',properties:folder?['openDirectory']:['openFile','multiSelections'],filters:folder?[]:[{name:'Préréglages et LUTs',extensions:['xmp','cube']}]});return r.canceled?null:importStyleEntries(r.filePaths); });
  handle('presets', () => catalog.presets());
  handle('savePreset', (name,a) => catalog.savePreset(name, normalizeAdjustments(a)));
  handle('deletePreset', id => catalog.removePreset(id));
  handle('detectFaces', id => detectFaces(id));
  handle('cancelJob', () => { if (job) { job.cancelled = true; if (job.kind === 'ai') aiController?.abort(); } localEngines.cancel(); });
  handle('sync', async (selection, adjustments) => {
    if (job||localEngines?.busy) fail('Une tâche est déjà en cours.');
    const a = normalizeAdjustments(adjustments); const current = job = { cancelled: false }; let count = 0;
    try {
      // Snapshot IDs: changing the edited filter during pagination must not skip rows.
      const ids = Array.from(selectedItems(selection), p => p.id);
      for (const id of ids) {
        if (current.cancelled) break;
        updatePhoto(id, { adjustments: a }); count++;
        if (count % 100 === 0) { progress({kind:'sync',text:`${count} réglages synchronisés`,current:count,total:ids.length}); await new Promise(r => setImmediate(r)); }
      }
      return { count };
    } finally { job = null; progress(null); }
  });
  handle('exportPhotos', async (selection, options = {}) => {
    if (job||localEngines?.busy) fail('Une tâche est déjà en cours.');
    const r = await dialog.showOpenDialog(window, { title:'Choisir le dossier d’export',properties:['openDirectory','createDirectory'] }); if (r.canceled) return null;
    const current = job = { cancelled:false }; let count = 0; const errors = []; const directory = r.filePaths[0];
    const format = ['jpeg','png','tiff'].includes(options.format) ? options.format : 'jpeg';
    try {
      const ids = Array.from(selectedItems(selection), item => item.id);
      let processed = 0;
      for (const id of ids) {
        if (current.cancelled) break;
        let item;
        try {
          item = photo(id);
          progress({kind:'export',current:processed,total:ids.length,text:`Export : ${item.name}`});
          const landmarks = portrait(item.adjustments) ? await detectFaces(item.id) : null;
          const lut=await loadLUT(item.adjustments.lutId);
          const bytes = await boundedImage(async () => renderImage(await imageSource(item.path,true),item.adjustments,{format,quality:Number(options.quality)||92,maxDimension:options.maxDimension ? Number(options.maxDimension) : undefined,watermark:String(options.watermark||'').slice(0,200),landmarks,lut,bitDepth:options.bitDepth===8?8:16}));
          const destination = await uniqueDestination(directory,item.name,format === 'jpeg' ? 'jpg' : format);
          await fs.writeFile(destination, bytes, { flag:'wx' }); count++;
        } catch (error) { if (errors.length < 30) errors.push(`${item?.name || id} : ${error.message}`); }
        processed++;
        await new Promise(r => setImmediate(r));
      }
      return {count,errors,cancelled:current.cancelled,directory};
    } finally { job = null; progress(null); }
  });
  handle('saveSpatialPreview',async({id,pngBase64}={})=>{
    photo(id);
    const bytes=decodeSpatialBase64(pngBase64),decoder=sharp(bytes,{limitInputPixels:4096*4096,failOn:'error'}),metadata=await decoder.metadata();
    if(metadata.format!=='png'||metadata.width>4096||metadata.height>4096)fail('Aperçu spatial trop volumineux.');
    const path=dataPath(`generated/${randomUUID()}.png`);await decoder.png().toFile(path);catalog.importPaths([path]);
    const item=catalog.getByPath(path);return catalog.update(item.id,{width:metadata.width,height:metadata.height});
  });
  handle('getSettings', () => settingsPublic());
  handle('setLanguage', async language => { if(!['fr','nl','en','es','zh','ja','ar','de','pt','it','hi','ko'].includes(language))fail('Langue non valide.'); settings.language=language;await atomicJSON(dataPath('settings.json'),settings);await updateMenu();return language; });
  handle('saveSettings', async next => {
    if (!next || typeof next !== 'object') fail('Réglages IA non valides.');
    const localAI=normalizeLocalConfig(next.localAI??settings.localAI);
    settings = { language:settings.language||'fr', provider:validProvider(next.provider), models:{}, imageModels:{},localAI };
    for (const p of providers) {
      settings.models[p] = String(next.models?.[p] || defaults.models[p]).slice(0,120);
      settings.imageModels[p] = String(next.imageModels?.[p] || defaults.imageModels[p]).slice(0,120);
    }
    await atomicJSON(dataPath('settings.json'),settings); return settingsPublic();
  });
  handle('saveKey', async (provider, key) => {
    cloudProvider(provider); if (typeof key !== 'string' || key.trim().length < 10 || key.length > 1024 || /\s/.test(key.trim())) fail('La clé API semble incorrecte.');
    sessionKeys.set(provider, key.trim());
    if (encryptionAvailable()) { vault[provider] = safeStorage.encryptString(key.trim()).toString('base64'); await atomicJSON(dataPath('keys.encrypted.json'),vault); }
    else { delete vault[provider]; await atomicJSON(dataPath('keys.encrypted.json'),vault); }
    return settingsPublic();
  });
  handle('deleteKey', async provider => { cloudProvider(provider);sessionKeys.delete(provider);delete vault[provider];await atomicJSON(dataPath('keys.encrypted.json'),vault);return settingsPublic(); });
  handle('localHardware',input=>localEngines.hardware(localOptions(input)));
  handle('localRecommendations',input=>localEngines.recommendations(localOptions(input)));
  handle('chooseLocalModelDirectory',async()=>{const result=await dialog.showOpenDialog(window,{title:'Choisir le dossier des modèles Ollama',properties:['openDirectory']});return result.canceled?null:result.filePaths[0];});
  handle('localStatus',async input=>{try{const options=await localEngines.resolve(localOptions(input));return await ollama(options).status();}catch(error){return {available:false,models:[],error:error.message};}});
  const idleLocalEngine=()=>{if(job||aiController||localEngines.busy)fail('Une tâche est déjà en cours.');};
  handle('localEngineStatus',()=>localEngines.status());
  handle('localEngineInstall',()=>{idleLocalEngine();return localEngines.install();});
  handle('localEngineStart',()=>{idleLocalEngine();return localEngines.start();});
  handle('localEngineStop',()=>{idleLocalEngine();return localEngines.stop();});
  handle('cancelLocalEngineInstall',()=>localEngines.cancel('runtime'));
  handle('localPull',async input=>{
    idleLocalEngine();return localEngines.pull(localOptions(input));
  });
  handle('cancelLocalPull',()=>localEngines.cancel('model'));
  handle('localBenchmark',async input=>{
    idleLocalEngine();
    const controller=aiController=new AbortController();
    const current=job={kind:'ai',cancelled:false};
    progress({kind:'ai',text:'Test local en cours…'});
    try{
      const options=await localEngines.resolve(localOptions(input),{start:true,signal:controller.signal});
      await localDiagnostics.checkModel(options.model,options);
      const imageData=await sharp({create:{width:192,height:128,channels:3,background:'#567c94'}}).png().toBuffer();
      const result=await ollama(options).recommend({imageData,model:options.model,language:settings.language||'fr',instruction:'Analyse cette image de test synthétique et propose tous les réglages du schéma. Garde les contrôles portrait et géométrie neutres.',signal:controller.signal});
      return {...result.metrics,validRecipe:true};
    }finally{if(aiController===controller)aiController=null;if(job===current)job=null;progress(null);}
  });
  handle('comfyStatus',async input=>{
    const options=localOptions({comfyURL:input?.baseURL??settings.localAI.comfyURL});
    const {inspectComfy}=await import('./comfy-service.mjs');
    try{const [status,hardware]=await Promise.all([inspectComfy({baseURL:options.comfyURL}),localDiagnostics.hardware(options)]);return {...status,assessment:assessLocalGeneration(hardware)};}catch(error){return {ready:false,models:{diffusion:[],textEncoder:[],vae:[]},missingNodes:[],error:error.message};}
  });
  handle('openLocalInstaller',async({engine}={})=>{
    if(!['ollama','comfyui'].includes(engine))fail('Moteur local non valide.');
    // A diagnostic never installs software, drivers or a model in the background.
    const options=localOptions(),hardware=await localDiagnostics.hardware(options);
    if(engine==='ollama'&&(await localDiagnostics.recommendations(options)).every(model=>model.assessment.status==='insufficient'))fail('Aucun des modèles proposés ne respecte les ressources mesurées de cet ordinateur.');
    if(engine==='comfyui'&&assessLocalGeneration(hardware).status==='insufficient')fail('Les ressources mesurées de cet ordinateur sont insuffisantes pour cette retouche générative locale.');
    const url=engine==='ollama'?`https://ollama.com/download/${({darwin:'mac',win32:'windows',linux:'linux'})[process.platform]||''}`:'https://docs.comfy.org/installation/system_requirements';
    await shell.openExternal(url);
  });
  handle('cancelAI', () => { if (job?.kind === 'ai') job.cancelled = true; aiController?.abort(); });
  handle('ai', async ({id,instruction,mode,margins}) => {
    if (job||aiController||localEngines?.busy) fail('Une tâche est déjà en cours.');
    if(!['recommend','edit','expand'].includes(mode))fail('Mode IA non valide.');
    if(mode==='expand'&&typeof instruction==='string'&&!instruction.trim())instruction='Prolonge naturellement la scène dans les marges demandées.';
    const item = photo(id), provider = validProvider(settings.provider), apiKey = keyFor(provider);
    const localConfig=provider==='local'?localOptions():null;
    if (provider!=='local'&&!apiKey) fail(`Ajoutez votre clé ${provider} dans les réglages IA.`);
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 10000) fail('Ajoutez une consigne de retouche.');
    const controller = aiController = new AbortController();
    const current=job={kind:'ai',cancelled:false};
    try {
      if(provider==='local'){
        if(mode==='recommend'){const effective=await localEngines.resolve(localConfig,{start:true,signal:controller.signal});await localDiagnostics.checkModel(effective.model,effective);await ollama(effective).inspectModel(effective.model,{signal:controller.signal});}
        else await checkLocalGeneration(localConfig,item,mode,margins,controller.signal);
      }
      // Recommendations are absolute settings; analyse the original to avoid
      // applying the same exposure/colour correction twice on an edited preview.
      let bytes;
      if(mode==='expand'){
        if(provider==='claude')fail('Choisissez OpenAI ou Gemini pour agrandir la photo.');
        const landmarks=portrait(item.adjustments)?await detectFaces(id):null,lut=await loadLUT(item.adjustments.lutId);
        bytes=await boundedImage(async()=>renderImage(await imageSource(item.path,true,controller.signal),item.adjustments,{format:'png',bitDepth:16,landmarks,lut}),{signal:controller.signal});
      }else bytes=await preview(id,mode==='recommend',controller.signal);
      const config = {imageData:bytes,instruction,provider,model:(mode === 'recommend' ? settings.models : settings.imageModels)[provider],apiKey,language:settings.language||'fr',signal:controller.signal};
      if (mode !== 'recommend') {
        const generator=provider==='local'?config=>localEdit(config,localConfig):edit;
        const output = await boundedImage(()=>mode==='expand'?(import('./outpainting.mjs').then(({expandImage})=>expandImage({...config,margins,...(provider==='local'?{generate:generator}:{})}))):generator(config),{signal:controller.signal}); const path = dataPath(`generated/${randomUUID()}.png`);
        await fs.writeFile(path,output,{flag:'wx'});catalog.importPaths([path]);
        const result = catalog.getByPath(path);
        if (result) { const metadata = await readImageMetadata(path); catalog.update(result.id,{width:metadata.width,height:metadata.height}); }
        return {mode,item:result,explanation:'Nouvelle variante créée. La photo source est conservée.'};
      }
      const result = await analyse(config,localConfig,item);
      return {mode:'recommend',photoId:id,...result};
    } finally { if(aiController===controller)aiController = null;if(job===current)job=null; }
  });
  handle('aiBatch', async (selection, { instruction,expectedCount } = {}) => {
    if (job || aiController||localEngines?.busy) fail('Une tâche est déjà en cours.');
    const provider = validProvider(settings.provider), apiKey = keyFor(provider);
    const localConfig=provider==='local'?localOptions():null;
    if (provider!=='local'&&!apiKey) fail(`Ajoutez votre clé ${provider} dans les réglages IA.`);
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 10000) fail('Ajoutez une consigne de retouche.');
    const ids = Array.from(selectedItems(selection), item => item.id);
    if(!Number.isSafeInteger(expectedCount)||expectedCount!==ids.length)fail('La sélection a changé. Vérifiez le nombre de photos puis relancez l’analyse IA.');
    const current = job = { kind: 'ai', cancelled: false };
    const controller = aiController = new AbortController();
    let count = 0, processed = 0; const errors = [];
    try {
      for (const id of ids) {
        if (current.cancelled || controller.signal.aborted) break;
        let item;
        try {
          item = photo(id);
          progress({ kind: 'ai', current: processed, total: ids.length, text: `Analyse IA : ${item.name}` });
          const bytes = await preview(id, true,controller.signal);
          if (current.cancelled || controller.signal.aborted) break;
          const result = await analyse({ imageData: bytes, instruction, provider,
            model: settings.models[provider], apiKey, language:settings.language||'fr', signal: controller.signal },localConfig,item);
          if (current.cancelled || controller.signal.aborted) break;
          updatePhoto(id, { adjustments: normalizeAdjustments(result.adjustments) });
          count++;
        } catch (error) {
          if (current.cancelled || controller.signal.aborted) break;
          if (errors.length < 30) errors.push(`${item?.name || id} : ${error.message}`);
        }
        processed++;
        progress({ kind: 'ai', current: processed, total: ids.length, text: `${count} photos analysées par IA` });
        await new Promise(resolveYield => setImmediate(resolveYield));
      }
      return { count, processed, total: ids.length, errors, cancelled: current.cancelled || controller.signal.aborted };
    } finally {
      if (aiController === controller) aiController = null;
      if (job === current) job = null;
      progress(null);
    }
  });
  handle('saveProject', async () => {
    const r = await dialog.showSaveDialog(window,{defaultPath:'Mon atelier.atelier',filters:[{name:'Projet Atelier Photo',extensions:['atelier']}]});if(r.canceled)return null;
    const items=Array.from(selectedItems({all:true}),p=>({path:p.path,adjustments:p.adjustments,rating:p.rating,picked:p.picked}));
    const luts={};
    for(const id of new Set(items.map(p=>p.adjustments.lutId).filter(Boolean))){
      const data=await loadLUT(id);await validateColorLUT(data);
      luts[id]={sha256:createHash('sha256').update(JSON.stringify(data)).digest('hex'),data};
    }
    const destination=extname(r.filePath).toLowerCase()==='.atelier'?r.filePath:`${r.filePath}.atelier`;
    const project={version:2,photos:items,luts};
    if(Buffer.byteLength(JSON.stringify(project))>100*1024*1024)fail('Projet trop volumineux.');
    await atomicJSON(destination,project);return destination;
  });
  handle('openProject', async () => {
    if(job||localEngines?.busy)fail('Une tâche est déjà en cours.');
    const r=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'Projet Atelier Photo',extensions:['atelier']}]});if(r.canceled)return null;
    const stat=await fs.stat(r.filePaths[0]);if(stat.size>100*1024*1024)fail('Projet trop volumineux.');
    const data=await readJSON(r.filePaths[0],null);if(![1,2].includes(data?.version)||!Array.isArray(data.photos))fail('Projet non valide.');
    const assets=Object.entries(data.luts||{});
    if(assets.length>128)fail('Le projet contient trop de LUTs.');
    for(const [id,asset] of assets){
      if(!/^[a-f0-9]{64}$/.test(id)||!asset?.data)fail('LUT de projet non valide.');
      await validateColorLUT(asset.data);
      const digest=createHash('sha256').update(JSON.stringify(asset.data)).digest('hex');
      if(digest!==asset.sha256)fail('La LUT du projet est endommagée.');
      const existing=await readJSON(dataPath(`luts/${id}.json`),null);
      if(existing&&createHash('sha256').update(JSON.stringify(existing)).digest('hex')!==digest)fail('Une LUT différente utilise déjà cet identifiant.');
    }
    for(const [id,asset] of assets){await atomicJSON(dataPath(`luts/${id}.json`),asset.data);lutCache.delete(id);}
    const current=job={cancelled:false};let count=0,skipped=0;
    try {
      for(const p of data.photos){
        if(current.cancelled)break;
        if(typeof p?.path!=='string'||!isAbsolute(p.path)||!supportedPhoto(p.path)){skipped++;continue;}
        try{
          const metadata=await readImageMetadata(p.path);if(p.adjustments?.lutId)await loadLUT(p.adjustments.lutId);catalog.importPaths([p.path]);const existing=catalog.getByPath(p.path);
          if(existing){updatePhoto(existing.id,{adjustments:normalizeAdjustments(p.adjustments),rating:Math.min(5,Math.max(0,Math.round(Number(p.rating)||0))),picked:p.picked===true,width:metadata.width,height:metadata.height});count++;}
          else skipped++;
        }catch{skipped++;}
        if((count+skipped)%100===0){progress({kind:'import',current:count+skipped,total:data.photos.length,text:`${count} photos du projet chargées`});await new Promise(r=>setImmediate(r));}
      }
      return {count,skipped,cancelled:current.cancelled};
    }finally{job=null;progress(null);}
  });
  handle('openExternal', async url => { const parsed=new URL(url);if(parsed.protocol!=='https:'||!['platform.openai.com','aistudio.google.com','console.anthropic.com','www.paypal.com','github.com'].includes(parsed.hostname))fail('Lien non autorisé.');await shell.openExternal(parsed.href); });
  handle('faceReady', error => {faceWindow?._ready?.(typeof error==='string'?error:undefined);},true);
  handle('completeFaceTask', (requestId,landmarks,error) => {const pending=faceRequests.get(requestId);if(!pending)return;clearTimeout(pending.timer);faceRequests.delete(requestId);if(error)pending.reject(new Error('Détection du visage indisponible pour cette photo.'));else pending.resolve(landmarks);},true);
}


async function updateMenu(){
  const table=await readJSON(join(root,'locales',`${settings.language||'fr'}.json`),{});
  const t=text=>table[text]||text;
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:app.name,submenu:[{role:'about',label:t('À propos')},{type:'separator'},{role:'quit',label:t('Quitter')}]},{label:t('Édition'),submenu:[{role:'undo',label:t('Annuler la retouche')},{role:'redo',label:t('Rétablir')},{type:'separator'},{role:'cut',label:t('Couper')},{role:'copy',label:t('Copier')},{role:'paste',label:t('Coller')},{role:'selectAll',label:t('Tout sélectionner')}]},{label:t('Affichage'),submenu:[{role:'reload',label:t('Actualiser')},{role:'toggleDevTools',label:t('Outils de développement')},{role:'togglefullscreen',label:t('Plein écran')}]}]));
}

app.whenReady().then(async () => {
  if(process.argv.includes('--test-native-backend')){
    const raw=await import('@janhapke/libraw');
    if(raw.cameraCount()<1000)throw new Error('Le moteur RAW est incomplet.');
    const sample=await sharp({create:{width:2,height:2,channels:3,background:'#345678'}}).png().toBuffer();
    if((await sharp(sample).metadata()).width!==2)throw new Error('Le moteur photo est indisponible.');
    await verifyModelAssets(join(root,'dist/models'));
    console.log('ATELIER_NATIVE_OK',JSON.stringify({platform:process.platform,arch:process.arch,libraw:raw.version(),sharp:sharp.versions.sharp}));
    app.exit(0);return;
  }
  await fs.mkdir(app.getPath('userData'),{recursive:true});
  for(const directory of ['thumbnails','generated','luts','raw-cache']) await fs.mkdir(dataPath(directory),{recursive:true});
  catalog=new Catalog(app.getPath('userData'));
  localEngines=createLocalEngineService({engine:createManagedOllama({userDataDirectory:app.getPath('userData')}),diagnostics:localDiagnostics,onProgress:progress});
  settings={...defaults,...await readJSON(dataPath('settings.json'),{} )};
  settings.models={...defaults.models,...settings.models};settings.imageModels={...defaults.imageModels,...settings.imageModels};
  try{settings.localAI=normalizeLocalConfig(settings.localAI);}catch{settings.localAI=normalizeLocalConfig();}
  vault=await readJSON(dataPath('keys.encrypted.json'),{});
  registerProtocol();registerIPC();
  await updateMenu();
  const importIndex=process.argv.indexOf('--import-presets');
  if(importIndex>=0&&process.argv[importIndex+1]){const r=await importStyleEntries([resolve(process.argv[importIndex+1])]);console.log('Import de styles personnels :',JSON.stringify({added:r.added,skipped:r.skipped,partial:r.partial,unavailable:r.unavailable}));}
  window=makeWindow();
  app.on('activate',()=>{if(!window)window=makeWindow();});
}).catch(error=>{console.error('Atelier Photo : démarrage impossible.',error.message);app.exit(1);});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
let shutdownStarted=false,shutdownComplete=false;
app.on('before-quit',event=>{
  if(shutdownComplete)return;
  event.preventDefault();
  if(shutdownStarted)return;
  shutdownStarted=true;
  job&&(job.cancelled=true);aiController?.abort();
  Promise.resolve(localEngines?.shutdown()).catch(error=>console.error('Arrêt du moteur local :',error.message)).finally(()=>{
    catalog?.close();shutdownComplete=true;app.quit();
  });
});
