import { randomUUID, randomInt } from 'node:crypto';
import sharp from 'sharp';
import { localRequest, normalizeLoopbackURL, readLocalJSON } from './loopback-http.mjs';

const MiB = 1024 * 1024;
const MAX_INPUT = 100 * MiB;
const MAX_PIXELS = 120_000_000;
const MAX_OUTPUT = 12 * MiB;
const MAX_PREVIEW_PIXELS = 1024 * 1024;
const MAX_PREVIEW_EDGE = 1400;
const GENERATION_TIMEOUT = 30 * 60 * 1000;
const OUTPUT_NODE = '17';
const activeServers = new Set();

export const COMFY_WORKFLOW_ID = 'atelier-flux2-klein-4b-distilled-edit-v1';
export const COMFY_DEFAULT_MODELS = Object.freeze({
  diffusion: 'flux-2-klein-4b.safetensors',
  textEncoder: 'qwen_3_4b.safetensors',
  vae: 'flux2-vae.safetensors',
});

// These are core API nodes, flattened from the official single-reference template:
// https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_flux2_klein_image_edit_4b_distilled.json
// Scaling is done locally instead of ImageScaleToTotalPixels/GetImageSize so neither
// an oversized reference nor arbitrary user workflow nodes can enter the server.
const NODE_INPUTS = Object.freeze({
  UNETLoader: ['unet_name', 'weight_dtype'],
  CLIPLoader: ['clip_name', 'type'],
  VAELoader: ['vae_name'],
  LoadImage: ['image'],
  CLIPTextEncode: ['text', 'clip'],
  ConditioningZeroOut: ['conditioning'],
  VAEEncode: ['pixels', 'vae'],
  ReferenceLatent: ['conditioning', 'latent'],
  RandomNoise: ['noise_seed'],
  KSamplerSelect: ['sampler_name'],
  Flux2Scheduler: ['steps', 'width', 'height'],
  EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  CFGGuider: ['model', 'positive', 'negative', 'cfg'],
  SamplerCustomAdvanced: ['noise', 'guider', 'sampler', 'sigmas', 'latent_image'],
  VAEDecode: ['samples', 'vae'],
  SaveImage: ['images', 'filename_prefix'],
});

function fail(message) { const error = new Error(message); error.name = 'ComfyError'; throw error; }
function cancelled(signal) { if (signal?.aborted) throw new DOMException('La génération locale a été annulée.', 'AbortError'); }
function endpoint(value = 'http://127.0.0.1:8188') { return normalizeLoopbackURL(value, 8188); }
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function nodeInputs(info) { return { ...info?.input?.required, ...info?.input?.optional }; }
function choices(info, field) { const value = nodeInputs(info)[field]?.[0]; return Array.isArray(value) ? value : []; }
function safeModel(value) {
  return typeof value === 'string' && value.length <= 240 && !/[\x00-\x1f\x7f:]/.test(value)
    && value.split(/[\\/]/).every(part => /^[a-zA-Z0-9][a-zA-Z0-9 _().+-]*$/.test(part) && part !== '..')
    && /\.safetensors$/i.test(value);
}
function modelKind(value, kind) {
  if (!safeModel(value)) return false;
  const name = value.split(/[\\/]/).at(-1);
  if (kind === 'diffusion') return /^flux[-_. ]?2[-_. ]klein[-_. ]?4b(?:[-_. ](?:fp8|bf16|fp16))?\.safetensors$/i.test(name);
  return kind === 'textEncoder' ? /^qwen_3_4b\.safetensors$/i.test(name) : /^flux2-vae\.safetensors$/i.test(name);
}
function listModels(info, node, field, kind) {
  return [...new Set(choices(info[node], field).filter(name => modelKind(name, kind)))].slice(0, 256);
}
function compatibleNode(info, name, fields) {
  const entry = info[name];
  if (!object(entry)) return false;
  if (typeof entry.python_module === 'string' && !/^(?:nodes|comfy_extras\.nodes_[a-zA-Z0-9_]+)$/.test(entry.python_module)) return false;
  const inputs = nodeInputs(entry);
  return fields.every(field => Array.isArray(inputs[field]));
}

/** Metadata only. ready means the fixed graph's nodes/models are available,
 * not that inference speed, hardware suitability or output quality was tested.
 * transport is an internal test seam; never accept it from renderer/IPC data. */
export async function inspectComfy({ baseURL, signal, transport = localRequest } = {}) {
  const base = endpoint(baseURL);
  cancelled(signal);
  const info = await readLocalJSON(await transport(new URL('/object_info', base), { signal, timeoutMs: 8000 }), 8 * MiB);
  cancelled(signal);
  if (!object(info)) fail('La liste des composants ComfyUI est non valide.');
  const missingNodes = Object.entries(NODE_INPUTS).filter(([name, fields]) => !compatibleNode(info, name, fields)).map(([name]) => name);
  for (const [name, field, option] of [['UNETLoader', 'weight_dtype', 'default'], ['CLIPLoader', 'type', 'flux2'], ['KSamplerSelect', 'sampler_name', 'euler']]) {
    if (!choices(info[name], field).includes(option) && !missingNodes.includes(name)) missingNodes.push(name);
  }
  const models = {
    diffusion: listModels(info, 'UNETLoader', 'unet_name', 'diffusion'),
    textEncoder: listModels(info, 'CLIPLoader', 'clip_name', 'textEncoder'),
    vae: listModels(info, 'VAELoader', 'vae_name', 'vae'),
  };
  return { ready: missingNodes.length === 0 && Object.values(models).every(list => list.length > 0), models, missingNodes, workflow: COMFY_WORKFLOW_ID, validatedInference: false };
}

function makeGraph({ models, image, instruction, width, height, seed, directory }) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  return {
    '1': node('UNETLoader', { unet_name: models.diffusion, weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: models.textEncoder, type: 'flux2', device: 'default' }),
    '3': node('VAELoader', { vae_name: models.vae }),
    '4': node('LoadImage', { image }),
    '5': node('CLIPTextEncode', { clip: ['2', 0], text: instruction }),
    '6': node('ConditioningZeroOut', { conditioning: ['5', 0] }),
    '7': node('VAEEncode', { pixels: ['4', 0], vae: ['3', 0] }),
    '8': node('ReferenceLatent', { conditioning: ['5', 0], latent: ['7', 0] }),
    '9': node('ReferenceLatent', { conditioning: ['6', 0], latent: ['7', 0] }),
    '10': node('RandomNoise', { noise_seed: seed }),
    '11': node('KSamplerSelect', { sampler_name: 'euler' }),
    '12': node('Flux2Scheduler', { steps: 4, width, height }),
    '13': node('EmptyFlux2LatentImage', { width, height, batch_size: 1 }),
    '14': node('CFGGuider', { model: ['1', 0], positive: ['8', 0], negative: ['9', 0], cfg: 1 }),
    '15': node('SamplerCustomAdvanced', { noise: ['10', 0], guider: ['14', 0], sampler: ['11', 0], sigmas: ['12', 0], latent_image: ['13', 0] }),
    '16': node('VAEDecode', { samples: ['15', 0], vae: ['3', 0] }),
    [OUTPUT_NODE]: node('SaveImage', { images: ['16', 0], filename_prefix: `${directory}/edit` }),
  };
}

function rasterSignature(bytes) {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    || ['49492a00', '4d4d002a', '49492b00', '4d4d002b'].includes(bytes.subarray(0, 4).toString('hex'));
}
async function prepareImage(imageData, maskData, signal) {
  if (!Buffer.isBuffer(imageData) || !imageData.length || imageData.length > MAX_INPUT || !rasterSignature(imageData)) fail('Fournissez une photo PNG, JPEG, WebP ou TIFF de moins de 100 Mo.');
  try {
    const metadata = await sharp(imageData, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
    if ((metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height || metadata.width > 32000 || metadata.height > 32000) fail('La photo doit contenir une seule image de moins de 120 millions de pixels.');
    const swapped = [5, 6, 7, 8].includes(metadata.orientation);
    const originalWidth = swapped ? metadata.height : metadata.width;
    const originalHeight = swapped ? metadata.width : metadata.height;
    if (maskData !== undefined) {
      if (!Buffer.isBuffer(maskData) || !maskData.length || maskData.length > 14 * MiB) fail('Le masque local est illisible ou trop volumineux.');
      const mask = await sharp(maskData, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
      if (mask.format !== 'png' || !mask.hasAlpha || (mask.pages ?? 1) !== 1 || (mask.orientation ?? 1) !== 1 || mask.width !== originalWidth || mask.height !== originalHeight) fail('Le masque doit être un PNG avec transparence, aux dimensions de la photo orientée.');
      // The reference-image graph is not masked inpainting. The outer application
      // must replace protected original pixels locally after generation.
    }
    const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(originalWidth, originalHeight), Math.sqrt(MAX_PREVIEW_PIXELS / (originalWidth * originalHeight)));
    const width = Math.max(16, Math.floor(originalWidth * scale / 16) * 16);
    const height = Math.max(16, Math.floor(originalHeight * scale / 16) * 16);
    const data = await sharp(imageData, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate()
      .resize(width, height, { fit: 'fill' }).toColourspace('srgb').png().toBuffer();
    cancelled(signal);
    if (data.length > 8 * MiB) fail('L’aperçu de la photo dépasse la taille autorisée.');
    return { data, width, height };
  } catch (error) {
    if (['AbortError', 'ComfyError'].includes(error?.name)) throw error;
    fail('Impossible de préparer cette photo pour la génération locale.');
  }
}

function multipart(image, directory) {
  const boundary = `AtelierPhoto${randomUUID().replaceAll('-', '')}`;
  const fields = [['type', 'input'], ['subfolder', directory], ['overwrite', 'false']].map(([name, value]) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  const body = Buffer.concat([...fields, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`), image, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('La génération locale a été annulée.', 'AbortError')); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
async function readImage(response, width, height, signal) {
  if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) fail('ComfyUI n’a pas renvoyé l’image attendue.');
  const chunks = []; let total = 0;
  for await (const chunk of response) {
    cancelled(signal); const data = Buffer.from(chunk); total += data.length;
    if (total > MAX_OUTPUT) { response.destroy?.(); fail('L’image générée dépasse la taille autorisée.'); }
    chunks.push(data);
  }
  const data = Buffer.concat(chunks);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('ComfyUI n’a pas renvoyé une image PNG.');
  try {
    const metadata = await sharp(data, { limitInputPixels: MAX_PREVIEW_PIXELS, failOn: 'error' }).metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1 || metadata.width !== width || metadata.height !== height) fail('Les dimensions de l’image générée ne correspondent pas au canevas demandé.');
    // Decode and encode the image rather than trusting a filename/header. Metadata
    // containing the workflow, prompt or local paths is deliberately removed.
    const output = await sharp(data, { limitInputPixels: MAX_PREVIEW_PIXELS, failOn: 'error' }).toColourspace('srgb').png().toBuffer();
    cancelled(signal); return output;
  } catch (error) {
    if (['AbortError', 'ComfyError'].includes(error?.name)) throw error;
    fail('L’image générée par ComfyUI est illisible.');
  }
}

/** Runs only the fixed local single-photo edit graph. No model downloads, API
 * keys, arbitrary workflow JSON, remote URLs or global interrupts are accepted.
 * maskData is validated but has no masking effect in this graph; callers must
 * recompose protected source pixels themselves. Returns a metadata-free PNG. */
export async function editComfy({ imageData, maskData, instruction, baseURL, models, seed, signal, transport = localRequest, pollIntervalMs = 750 } = {}) {
  const base = endpoint(baseURL);
  cancelled(signal);
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 10000) fail('Ajoutez une consigne de retouche de moins de 10 000 caractères.');
  if (!object(models) || !['diffusion', 'textEncoder', 'vae'].every(kind => modelKind(models[kind], kind))) fail('Choisissez les trois modèles FLUX.2 Klein 4B Distilled installés dans ComfyUI.');
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) fail('La graine de génération doit être un entier positif.');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 10000) fail('Délai de suivi local non valide.');
  if (activeServers.has(base)) fail('Une génération locale est déjà en cours dans Atelier Photo.');
  activeServers.add(base);
  const timeout = new AbortController();
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const deadline = setTimeout(() => timeout.abort(), GENERATION_TIMEOUT);
  let promptID; let submitted = false; let complete = false;
  const json = async (path, body, requestSignal = combined, timeoutMs = 15000) => readLocalJSON(await transport(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', body, signal: requestSignal ?? undefined, timeoutMs }), 2 * MiB);
  try {
    const state = await inspectComfy({ baseURL: base, signal: combined, transport });
    if (!state.ready) fail('ComfyUI ne dispose pas des composants et modèles requis pour FLUX.2 Klein 4B Distilled.');
    if (!Object.keys(COMFY_DEFAULT_MODELS).every(kind => state.models[kind].includes(models[kind]))) fail('Un modèle sélectionné n’est plus disponible dans ComfyUI. Actualisez la liste des modèles.');
    const prepared = await prepareImage(imageData, maskData, combined);
    const directory = `atelier-photo/${randomUUID()}`;
    const upload = multipart(prepared.data, directory);
    const uploaded = await readLocalJSON(await transport(new URL('/upload/image', base), { method: 'POST', ...upload, signal: combined, timeoutMs: 30000 }), 65536);
    if (uploaded?.name !== 'source.png' || uploaded?.subfolder !== directory || uploaded?.type !== 'input') fail('ComfyUI a renvoyé un emplacement de photo inattendu.');
    cancelled(combined);
    promptID = randomUUID();
    const prompt = makeGraph({ models, image: `${directory}/source.png`, instruction: instruction.trim(), width: prepared.width, height: prepared.height, seed: seed ?? randomInt(0, 2 ** 48 - 1), directory });
    submitted = true;
    const queued = await json('/prompt', { prompt, client_id: randomUUID(), prompt_id: promptID });
    if (typeof queued?.prompt_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(queued.prompt_id)) fail('ComfyUI n’a pas confirmé la génération locale.');
    promptID = queued.prompt_id;
    if (object(queued.node_errors) && Object.keys(queued.node_errors).length) fail('ComfyUI a refusé le workflow. Mettez le moteur à jour et vérifiez les modèles sélectionnés.');
    while (true) {
      cancelled(combined);
      const history = await json(`/history/${encodeURIComponent(promptID)}`);
      const item = history?.[promptID];
      if (item !== undefined && !object(item)) fail('Le suivi de génération ComfyUI est non valide.');
      if (item?.status?.status_str === 'error' || item?.status?.messages?.some?.(entry => Array.isArray(entry) && ['execution_error', 'execution_interrupted'].includes(entry[0]))) fail('La génération locale a échoué. Vérifiez la mémoire disponible et la compatibilité des modèles dans ComfyUI.');
      if (item?.status?.completed === true) {
        const images = item.outputs?.[OUTPUT_NODE]?.images;
        if (!Array.isArray(images) || images.length !== 1) fail('ComfyUI n’a pas produit l’image attendue.');
        const image = images[0];
        if (!object(image) || image.type !== 'output' || image.subfolder !== directory || !/^edit_[0-9]{5,12}_\.png$/.test(image.filename)) fail('ComfyUI a renvoyé un emplacement de résultat inattendu.');
        const view = new URL('/view', base);
        view.search = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: 'output' }).toString();
        const result = await readImage(await transport(view, { signal: combined, timeoutMs: 30000 }), prepared.width, prepared.height, combined);
        complete = true; return result;
      }
      await wait(pollIntervalMs, combined);
    }
  } catch (error) {
    if (timeout.signal.aborted) fail('La génération locale a dépassé 30 minutes. Essayez une machine plus adaptée ou vérifiez ComfyUI.');
    if (signal?.aborted || error?.name === 'AbortError') throw new DOMException('La génération locale a été annulée.', 'AbortError');
    if (error?.name === 'ComfyError') throw error;
    fail('Le service ComfyUI local ne répond pas correctement. Ouvrez ComfyUI, puis vérifiez ses modèles et sa configuration.');
  } finally {
    clearTimeout(deadline);
    if (submitted && !complete && promptID) {
      // Remove only this request if still queued. Never clear the queue or call
      // /interrupt: another application's running job must remain untouched.
      // A job already running can finish in ComfyUI after the caller cancels.
      try { await json('/queue', { delete: [promptID] }, null, 3000); } catch { /* Best-effort removal; no global fallback. */ }
    }
    activeServers.delete(base);
  }
}
