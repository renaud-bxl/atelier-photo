import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { COMFY_DEFAULT_MODELS, COMFY_WORKFLOW_ID, inspectComfy, editComfy } from '../desktop/comfy-service.mjs';

const models = { ...COMFY_DEFAULT_MODELS };
const fields = {
  UNETLoader: ['unet_name', 'weight_dtype'], CLIPLoader: ['clip_name', 'type'], VAELoader: ['vae_name'],
  LoadImage: ['image'], CLIPTextEncode: ['text', 'clip'], ConditioningZeroOut: ['conditioning'],
  VAEEncode: ['pixels', 'vae'], ReferenceLatent: ['conditioning', 'latent'], RandomNoise: ['noise_seed'],
  KSamplerSelect: ['sampler_name'], Flux2Scheduler: ['steps', 'width', 'height'], EmptyFlux2LatentImage: ['width', 'height', 'batch_size'],
  CFGGuider: ['model', 'positive', 'negative', 'cfg'], SamplerCustomAdvanced: ['noise', 'guider', 'sampler', 'sigmas', 'latent_image'],
  VAEDecode: ['samples', 'vae'], SaveImage: ['images', 'filename_prefix'],
};
function info() {
  const result = Object.fromEntries(Object.entries(fields).map(([name, inputs]) => [name, { input: { required: Object.fromEntries(inputs.map(field => [field, ['STRING']])) }, python_module: 'nodes' }]));
  result.UNETLoader.input.required.unet_name = [[models.diffusion, 'other-model.safetensors', 'flux-2-klein-base-4b.safetensors', 'flux-2-klein-9b.safetensors', '../flux-2-klein-4b.safetensors', 'weights.ckpt']];
  result.UNETLoader.input.required.weight_dtype = [['default', 'fp8_e4m3fn']];
  result.CLIPLoader.input.required.clip_name = [[models.textEncoder, 'qwen_3_8b.safetensors']];
  result.CLIPLoader.input.required.type = [['flux2', 'stable_diffusion']];
  result.VAELoader.input.required.vae_name = [[models.vae]];
  result.KSamplerSelect.input.required.sampler_name = [['euler', 'dpmpp_2m']];
  // ReferenceLatent's latent input is optional in the core schema.
  result.ReferenceLatent.input.optional = { latent: result.ReferenceLatent.input.required.latent };
  delete result.ReferenceLatent.input.required.latent;
  return result;
}
function response(data, statusCode = 200) {
  const stream = Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data))]);
  stream.statusCode = statusCode; stream.headers = {}; return stream;
}
const source = () => sharp({ create: { width: 80, height: 48, channels: 4, background: { r: 180, g: 90, b: 40, alpha: 0.5 } } }).png().withExif({ IFD0: { Artist: 'PRIVATE PHOTO METADATA' } }).toBuffer();
function mockServer({ objectInfo = info(), onHistory, onUpload, onPrompt, output, outputReference, promptID, status, onRequest } = {}) {
  const calls = []; let graph, directory, jobID, uploaded;
  const transport = async (url, options = {}) => {
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '8188');
    calls.push({ path: url.pathname, url: url.href, ...options }); onRequest?.(url, options);
    if (url.pathname === '/object_info') return response(objectInfo);
    if (url.pathname === '/upload/image') {
      assert.equal(options.method, 'POST'); assert.ok(Buffer.isBuffer(options.body));
      assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=AtelierPhoto[a-z0-9]+$/i);
      const marker = Buffer.from('Content-Type: image/png\r\n\r\n');
      const start = options.body.indexOf(marker) + marker.length;
      const end = options.body.lastIndexOf(Buffer.from('\r\n--AtelierPhoto'));
      uploaded = options.body.subarray(start, end);
      const match = /name="subfolder"\r\n\r\n(atelier-photo\/[0-9a-f-]+)\r\n/.exec(options.body.toString('latin1'));
      assert.ok(match); directory = match[1];
      const metadata = await sharp(uploaded).metadata(); assert.equal(metadata.exif, undefined); assert.equal(metadata.format, 'png');
      await onUpload?.({ metadata, bytes: uploaded, directory, options });
      return response({ name: 'source.png', subfolder: directory, type: 'input' });
    }
    if (url.pathname === '/prompt') {
      graph = options.body.prompt; jobID = promptID || options.body.prompt_id;
      await onPrompt?.({ graph, body: options.body, directory });
      return response({ prompt_id: jobID, number: 2, node_errors: {} });
    }
    if (url.pathname.startsWith('/history/')) {
      assert.equal(url.pathname, `/history/${jobID}`);
      if (onHistory) return response(await onHistory({ graph, directory, jobID }));
      return response({ [jobID]: { status: status || { completed: true, status_str: 'success' }, outputs: { '17': { images: [outputReference || { filename: 'edit_00001_.png', subfolder: directory, type: 'output', url: 'https://untrusted.invalid/image.png' }] } } } });
    }
    if (url.pathname === '/view') {
      assert.deepEqual(Object.fromEntries(url.searchParams), { filename: 'edit_00001_.png', subfolder: directory, type: 'output' });
      const dimensions = graph['13'].inputs;
      const bytes = output || await sharp({ create: { width: dimensions.width, height: dimensions.height, channels: 3, background: '#468ac9' } }).png().withExif({ IFD0: { Artist: 'LOCAL WORKFLOW METADATA' } }).toBuffer();
      return response(bytes);
    }
    if (url.pathname === '/queue') {
      assert.deepEqual(options.body, { delete: [jobID] }); assert.equal(options.signal, undefined);
      return response({});
    }
    assert.fail(`Unexpected endpoint ${url.pathname}`);
  };
  return { transport, calls, get graph() { return graph; }, get directory() { return directory; }, get uploaded() { return uploaded; } };
}

test('discovery offers only the compatible installed models and verifies core schemas', async () => {
  const server = mockServer();
  const result = await inspectComfy({ transport: server.transport });
  assert.equal(result.ready, true); assert.equal(result.validatedInference, false); assert.equal(result.workflow, COMFY_WORKFLOW_ID);
  assert.deepEqual(result.models, { diffusion: [models.diffusion], textEncoder: [models.textEncoder], vae: [models.vae] });
  assert.deepEqual(result.missingNodes, []); assert.equal(server.calls.length, 1);
  const missing = info(); delete missing.ReferenceLatent;
  missing.KSamplerSelect.input.required.sampler_name = [['lcm']];
  missing.CLIPLoader.python_module = 'custom_nodes.unverified';
  const no = await inspectComfy({ transport: mockServer({ objectInfo: missing }).transport });
  assert.equal(no.ready, false); assert.deepEqual(new Set(no.missingNodes), new Set(['ReferenceLatent', 'KSamplerSelect', 'CLIPLoader']));
});

test('loopback validation precedes every network request', async () => {
  let calls = 0; const transport = () => { calls += 1; assert.fail('network must not be used'); };
  for (const baseURL of ['https://127.0.0.1:8188', 'http://192.168.0.1:8188', 'http://example.com:8188', 'http://127.0.0.1:8188/proxy', 'http://user:secret@127.0.0.1:8188', 'http://127.0.0.1:8188/?url=https://remote.invalid']) {
    await assert.rejects(inspectComfy({ baseURL, transport }));
    await assert.rejects(editComfy({ baseURL, imageData: await source(), instruction: 'Retouche', models, transport }));
  }
  assert.equal(calls, 0);
});

test('a fixed reference-image graph produces a decoded metadata-free PNG', async () => {
  const original = await source(), originalCopy = Buffer.from(original);
  const server = mockServer({ onPrompt({ graph, body, directory }) {
    assert.equal(Object.keys(graph).length, 17); assert.deepEqual(new Set(Object.values(graph).map(node => node.class_type)), new Set(Object.keys(fields)));
    assert.equal(graph['1'].inputs.unet_name, models.diffusion); assert.equal(graph['2'].inputs.type, 'flux2');
    assert.equal(graph['4'].inputs.image, `${directory}/source.png`);
    assert.equal(graph['5'].inputs.text, 'Éclaircir naturellement le visage.');
    assert.deepEqual(graph['8'].inputs, { conditioning: ['5', 0], latent: ['7', 0] });
    assert.deepEqual(graph['9'].inputs, { conditioning: ['6', 0], latent: ['7', 0] });
    assert.equal(graph['10'].inputs.noise_seed, 123); assert.equal(graph['11'].inputs.sampler_name, 'euler');
    assert.equal(graph['12'].inputs.steps, 4); assert.equal(graph['14'].inputs.cfg, 1);
    assert.deepEqual(graph['13'].inputs, { width: 80, height: 48, batch_size: 1 });
    assert.equal(graph['17'].inputs.filename_prefix, `${directory}/edit`);
    assert.match(body.prompt_id, /^[0-9a-f-]{36}$/); assert.match(body.client_id, /^[0-9a-f-]{36}$/);
    assert.equal('workflow' in body, false);
    for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) { assert.ok(graph[value[0]]); assert.ok(Number.isInteger(value[1]) && value[1] >= 0); }
  } });
  const result = await editComfy({ imageData: original, instruction: ' Éclaircir naturellement le visage. ', models, seed: 123, transport: server.transport });
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 80); assert.equal(metadata.height, 48); assert.equal(metadata.exif, undefined);
  assert.deepEqual(original, originalCopy); assert.deepEqual(server.calls.map(call => call.path), ['/object_info', '/upload/image', '/prompt', '/history/' + server.calls[2].body.prompt_id, '/view']);
  assert.ok(server.calls.every(call => !call.url.includes('untrusted.invalid')));
});

test('input preparation caps megapixels/edges and strips metadata before upload', async () => {
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#a67862' } }).jpeg().withExif({ IFD0: { Artist: 'PRIVATE' } }).toBuffer();
  const server = mockServer({ onUpload({ metadata }) {
    assert.ok(metadata.width * metadata.height <= 1024 * 1024); assert.ok(Math.max(metadata.width, metadata.height) <= 1400);
    assert.equal(metadata.width % 16, 0); assert.equal(metadata.height % 16, 0); assert.equal(metadata.exif, undefined);
  } });
  const result = await editComfy({ imageData: photo, instruction: 'Une lumière douce', models, transport: server.transport });
  assert.equal((await sharp(result).metadata()).width, server.graph['13'].inputs.width);
});

test('masked expansion data is validated without claiming masked model inference', async () => {
  const photo = await source();
  const mask = await sharp({ create: { width: 80, height: 48, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const server = mockServer();
  await editComfy({ imageData: photo, maskData: mask, instruction: 'Étendre les bordures', models, transport: server.transport });
  assert.equal(Object.values(server.graph).some(node => /mask/i.test(node.class_type)), false);
  assert.equal(server.calls.some(call => call.path === '/upload/mask'), false);
  const invalidMask = await sharp(mask).resize(16, 16).png().toBuffer();
  const no = mockServer();
  await assert.rejects(editComfy({ imageData: photo, maskData: invalidMask, instruction: 'Retouche', models, transport: no.transport }), /masque/i);
  assert.deepEqual(no.calls.map(call => call.path), ['/object_info']);
});

test('invalid models, instructions, seeds, raster data and source dimensions fail safely', async () => {
  const photo = await source();
  for (const options of [{ models: { ...models, diffusion: '../flux-2-klein-4b.safetensors' } }, { models: { ...models, diffusion: 'flux-2-klein-9b.safetensors' } }, { models: { ...models, diffusion: 'flux-2-klein-base-4b.safetensors' } }, { seed: -1 }, { seed: 2 ** 53 }, { instruction: '' }, { instruction: 'x'.repeat(10001) }]) {
    const server = mockServer();
    await assert.rejects(editComfy({ imageData: photo, instruction: 'Retouche', models, transport: server.transport, ...options }));
    assert.equal(server.calls.length, 0);
  }
  for (const imageData of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.alloc(0), Buffer.alloc(100 * 1024 * 1024 + 1), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
    const server = mockServer();
    await assert.rejects(editComfy({ imageData, instruction: 'Retouche', models, transport: server.transport }));
    assert.equal(server.calls.some(call => call.path === '/upload/image'), false);
  }
});

test('missing models/nodes prevent uploading any photograph', async () => {
  const absent = info(); absent.VAELoader.input.required.vae_name = [[]];
  const server = mockServer({ objectInfo: absent });
  await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, transport: server.transport }), /composants et modèles/i);
  assert.deepEqual(server.calls.map(call => call.path), ['/object_info']);
});

test('cancellation deletes only this queued job and never interrupts another job', async () => {
  const controller = new AbortController(); let ownID;
  const server = mockServer({ onHistory({ jobID }) { ownID = jobID; controller.abort(); return {}; } });
  await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, signal: controller.signal, transport: server.transport, pollIntervalMs: 0 }), { name: 'AbortError' });
  const queue = server.calls.filter(call => call.path === '/queue');
  assert.equal(queue.length, 1); assert.deepEqual(queue[0].body, { delete: [ownID] });
  assert.equal(queue[0].body.clear, undefined); assert.ok(server.calls.every(call => call.path !== '/interrupt'));
  const before = mockServer();
  await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, signal: controller.signal, transport: before.transport }), { name: 'AbortError' });
  assert.equal(before.calls.length, 0);
});

test('cancellation immediately after submission still removes the server-confirmed own job', async () => {
  const controller = new AbortController(); const assigned = '84df54ca-bd2e-44e1-82f0-b17d97e555e0';
  const server = mockServer({ promptID: assigned, onPrompt() { controller.abort(); } });
  await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, signal: controller.signal, transport: server.transport }), { name: 'AbortError' });
  assert.deepEqual(server.calls.at(-1).body, { delete: [assigned] });
});

test('untrusted output paths and URLs are rejected before any image download', async () => {
  for (const outputReference of [{ filename: '../private.png', subfolder: 'atelier-photo', type: 'output' }, { filename: 'edit_00001_.png', subfolder: '../../private', type: 'output' }, { filename: 'https://example.com/image.png', subfolder: '', type: 'output' }, { filename: 'edit_00001_.png', subfolder: '', type: 'input' }]) {
    const server = mockServer({ outputReference });
    await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, transport: server.transport }), /emplacement de résultat/i);
    assert.equal(server.calls.some(call => call.path === '/view'), false); assert.equal(server.calls.at(-1).path, '/queue');
  }
});

test('invalid, truncated, oversized or wrongly sized generated images are rejected', async () => {
  const small = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#c33' } }).png().toBuffer();
  for (const output of [Buffer.from('<html>not an image</html>'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(12 * 1024 * 1024 + 1), small]) {
    const server = mockServer({ output });
    await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, transport: server.transport }), /image|dimensions/i);
    assert.equal(server.calls.at(-1).path, '/queue');
  }
});

test('server execution errors and transport bodies never leak provider diagnostics', async () => {
  const secret = 'PRIVATE-PROMPT-AND-LOCAL-PATH';
  const server = mockServer({ status: { completed: false, status_str: 'error', messages: [['execution_error', { exception_message: secret }]] } });
  await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, transport: server.transport }), error => { assert.ok(!error.message.includes(secret)); return /mémoire disponible/.test(error.message); });
  await assert.rejects(editComfy({ imageData: await source(), instruction: 'Retouche', models, transport() { throw new Error(secret); } }), error => { assert.ok(!error.message.includes(secret)); return /service ComfyUI/.test(error.message); });
});

test('malformed or oversized component metadata cannot mark ComfyUI ready', async () => {
  await assert.rejects(inspectComfy({ transport: async () => response([]) }), /non valide/);
  await assert.rejects(inspectComfy({ transport: async () => response(Buffer.alloc(8 * 1024 * 1024 + 1, 32)) }), /volumineuse/);
  await assert.rejects(inspectComfy({ transport: async () => response({ error: 'PRIVATE' }, 302) }), error => !error.message.includes('PRIVATE'));
});
