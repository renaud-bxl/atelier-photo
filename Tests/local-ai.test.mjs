import test from 'node:test';
import assert from 'node:assert/strict';
import { globalAgent } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { createOllamaClient, LOCAL_VISION_MODELS, parseLocalRecommendation } from '../desktop/local-ai.mjs';
import { normalizeLoopbackURL, createLocalTransport, readLocalJSON } from '../desktop/loopback-http.mjs';
import { recommendationSchema } from '../desktop/ai-service.mjs';

const model = LOCAL_VISION_MODELS[0].id;
const imageData = await sharp({ create: { width: 1800, height: 1000, channels: 3, background: '#c0a080' } })
  .withMetadata({ orientation: 6, exif: { IFD0: { Artist: 'PRIVATE-METADATA' } } }).jpeg().toBuffer();
function validRecommendation() {
  const properties = recommendationSchema().properties.adjustments.properties;
  const adjustments = Object.fromEntries(Object.keys(properties).map(key => [key,
    key === 'flipHorizontal' ? false : ['contrast', 'saturation'].includes(key) ? 1 : ['cropX', 'cropY'].includes(key) ? 0.5 : 0]));
  adjustments.exposure = 0.25;
  return { adjustments, explanation: 'La lumière est légèrement relevée.' };
}
function response(value, statusCode = 200) {
  const stream = Readable.from([Buffer.from(JSON.stringify(value))]);
  stream.statusCode = statusCode; return stream;
}
function lines(value, chunkSize = Infinity) {
  const bytes = Buffer.from(value.map(item => JSON.stringify(item)).join('\n') + '\n');
  const chunks = []; for (let start = 0; start < bytes.length; start += chunkSize) chunks.push(bytes.subarray(start, start + chunkSize));
  const stream = Readable.from(chunks); stream.statusCode = 200; return stream;
}
function fixture(overrides = {}) {
  const calls = [];
  const routes = {
    '/api/version': () => ({ version: '0.17.1' }),
    '/api/show': () => ({ capabilities: ['completion', 'vision'], requires: '0.12.7' }),
    '/api/tags': () => ({ models: [{ name: model, size: 1900000000 }] }),
    '/api/chat': () => ({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(validRecommendation()) }, eval_count: 8, eval_duration: 5000000 }),
    '/api/ps': () => ({ models: [{ name: model, size: 2000, size_vram: 2000 }] }),
    ...overrides,
  };
  const transport = async (url, options) => {
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
    calls.push({ url, ...options });
    const route = routes[url.pathname]; if (!route) throw new Error(`Unexpected simulated route: ${url.pathname}`);
    const value = await route(options, url);
    return value && typeof value[Symbol.asyncIterator] === 'function' ? value : response(value);
  };
  return { calls, client: createOllamaClient({ transport }), transport };
}

test('loopback endpoints accept HTTP literals only and reject LAN, credentials, paths, queries and fragments', () => {
  assert.equal(normalizeLoopbackURL(), 'http://127.0.0.1:11434/');
  assert.equal(normalizeLoopbackURL('http://localhost:8188'), 'http://127.0.0.1:8188/');
  assert.equal(normalizeLoopbackURL('http://[::1]:11434'), 'http://[::1]:11434/');
  for (const endpoint of ['https://127.0.0.1:11434', 'http://192.168.1.2:11434', 'http://10.0.0.5:11434',
    'http://example.com', 'http://localhost.example.com', 'http://127.0.0.1.example.com', 'http://[::]:11434',
    'http://user:password@127.0.0.1:11434', 'http://127.0.0.1:11434/api/chat', 'http://127.0.0.1:11434/?target=remote',
    'http://127.0.0.1:11434/#fragment', 'file:///tmp/model', 'not a URL']) {
    assert.throws(() => normalizeLoopbackURL(endpoint), undefined, endpoint);
    assert.throws(() => createOllamaClient({ endpoint }), undefined, endpoint);
  }
});

test('remote_host, remote_model and cloud tags are refused before image decoding or transmission', async () => {
  for (const remote of [{ remote_host: 'https://cloud.example.invalid' }, { remote_model: 'large-remote-model' }]) {
    const { client, calls } = fixture({ '/api/show': () => ({ capabilities: ['vision'], ...remote }) });
    await assert.rejects(client.recommend({ model, instruction: 'Éclaircir.', imageData: Buffer.from('deliberately invalid image') }), /cloud/);
    assert.deepEqual(calls.map(call => call.url.pathname), ['/api/show']);
    assert.ok(calls.every(call => !call.body?.messages && !call.body?.images));
  }
  const { client, calls } = fixture();
  for (const remoteModel of ['model:cloud', 'model:120b-cloud', 'cloud/model:latest']) {
    await assert.rejects(client.recommend({ model: remoteModel, instruction: 'Éclaircir.', imageData }), /modèle/);
  }
  assert.equal(calls.length, 0);
});

test('model inspection requires vision, valid engine versions and the model minimum version', async () => {
  for (const capabilities of [undefined, [], ['completion'], 'vision']) {
    const { client, calls } = fixture({ '/api/show': () => ({ capabilities }) });
    await assert.rejects(client.inspectModel(model), /photos/);
    assert.equal(calls.length, 1);
  }
  for (const version of ['0.12.6', 'invalid']) {
    const { client, calls } = fixture({ '/api/version': () => ({ version }) });
    await assert.rejects(client.recommend({ model, instruction: 'Éclaircir.', imageData }), /jour|version/);
    assert.ok(!calls.some(call => call.url.pathname === '/api/chat'));
  }
  const newerRequirement = fixture({ '/api/show': () => ({ capabilities: ['vision'], requires: '0.18.0' }) });
  await assert.rejects(newerRequirement.client.inspectModel(model), /jour/);
  const supported = fixture({ '/api/version': () => ({ version: 'v0.12.7' }) });
  assert.equal((await supported.client.inspectModel(model)).local, true);
});

test('status offers only local vision models and never sends an image or loads weights', async () => {
  const { client, calls } = fixture({
    '/api/tags': () => ({ models: [{ name: model, size: 1234 }, { name: 'text:latest' }, { name: 'remote:latest', remote_host: 'https://cloud.invalid' }, { name: 'other:latest', remote_model: 'remote' }, { name: 'large:cloud' }] }),
    '/api/show': ({ body }) => ({ capabilities: body.model === 'text:latest' ? ['completion'] : ['vision'] }),
  });
  const result = await client.status();
  assert.equal(result.available, true); assert.equal(result.models.length, 1); assert.equal(result.models[0].name, model); assert.equal(result.models[0].size, 1234);
  assert.ok(calls.every(call => ['/api/version', '/api/tags', '/api/show'].includes(call.url.pathname)));
  assert.deepEqual(calls.filter(call => call.url.pathname === '/api/show').map(call => call.body.model), [model, 'text:latest']);
  const oversized = fixture({ '/api/tags': () => ({ models: Array.from({ length: 501 }, () => ({ name: model })) }) });
  await assert.rejects(oversized.client.status(), /liste/);
});

test('metadata inspection is capped at four workers and 64 models with bounded, shared abort signals', async () => {
  let active = 0, peak = 0;
  const { client, calls } = fixture({
    '/api/tags': () => ({ models: Array.from({ length: 70 }, (_, index) => ({ name: `vision${index}:latest` })) }),
    '/api/show': async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return { capabilities: ['vision'] }; },
  });
  const result = await client.status(), metadata = calls.filter(call => call.url.pathname === '/api/show');
  assert.equal(result.models.length, 64); assert.equal(metadata.length, 64); assert.ok(peak <= 4);
  assert.ok(metadata.every(call => call.timeoutMs <= 8000 && call.signal instanceof AbortSignal));
  assert.ok(calls.every(call => call.signal === metadata[0].signal));
});

test('recommendations send an oriented, metadata-free reduced JPEG and demand a complete JSON schema', async () => {
  const original = Buffer.from(imageData), { client, calls } = fixture();
  const result = await client.recommend({ model, instruction: 'Éclaircir naturellement.', imageData, language: 'en' });
  assert.equal(result.local, true); assert.equal(result.adjustments.exposure, 0.25); assert.equal(result.adjustments.contrast, 1);
  assert.equal(result.metrics.acceleration, 'gpu'); assert.equal(result.metrics.evalTokens, 8);
  const sent = calls.find(call => call.url.pathname === '/api/chat');
  assert.equal(sent.method, 'POST'); assert.equal(sent.body.stream, false); assert.equal(sent.body.keep_alive, 0);
  assert.equal(sent.body.model, model); assert.equal(sent.body.options.temperature, 0);
  assert.deepEqual(sent.body.format, recommendationSchema()); assert.ok(sent.body.messages[0].content.includes('en anglais'));
  const bytes = Buffer.from(sent.body.messages[1].images[0], 'base64'), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.height, LOCAL_VISION_MODELS[0].maxDimension);
  assert.ok(metadata.width < metadata.height); assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined); assert.equal(metadata.orientation, undefined);
  assert.ok(imageData.equals(original));
});

test('local composition is always preserved after raw validation, even when a valid response contradicts the instruction', async () => {
  const value = validRecommendation(), portrait = ['skinSmoothing', 'faceLight', 'teethWhitening', 'eyeBrightness', 'blemishReduction', 'skinEvenness', 'underEyeLight', 'eyeContrast', 'lipSaturation'];
  Object.assign(value.adjustments, { rotation: 15, cropRatio: 1, cropX: 0.2, cropY: 0.8, flipHorizontal: true });
  for (const key of portrait) value.adjustments[key] = 0.1;
  const content = JSON.stringify(value), raw = parseLocalRecommendation(content);
  assert.equal(raw.adjustments.cropRatio, 1); assert.equal(raw.adjustments.rotation, 15); assert.equal(raw.adjustments.flipHorizontal, true);
  const { client } = fixture({ '/api/chat': () => ({ done: true, message: { content } }) });
  const result = await client.recommend({ model, imageData, instruction: 'Conserve exactement le cadrage, sans rotation ni retournement.' });
  for (const [key, expected] of Object.entries({ rotation: 0, cropRatio: 0, cropX: 0.5, cropY: 0.5, flipHorizontal: false })) assert.equal(result.adjustments[key], expected, key);
  assert.equal(result.adjustments.exposure, 0.25);
  assert.deepEqual(result.constraints, { geometryPreserved: true });
  // Face detection and feature masks belong to main; the client must not claim
  // to have detected a face or silently erase a legitimate portrait correction.
  for (const key of portrait) assert.equal(result.adjustments[key], 0.1);
  assert.equal(parseLocalRecommendation(content).adjustments.cropRatio, 1, 'Raw parser semantics must remain unchanged.');
  value.adjustments.rotation = 999;
  const invalid = fixture({ '/api/chat': () => ({ done: true, message: { content: JSON.stringify(value) } }) });
  await assert.rejects(invalid.client.recommend({ model, imageData, instruction: 'Conserve le cadrage.' }), /valides/);
});

test('the documented 2B failure is reproduced from observed controls, without claiming a captured byte-for-byte response', async () => {
  // Reconstructed from docs/LOCAL-AI-REAL-QA.md. The original full JSON was not
  // retained: unreported controls use documented neutral schema values here.
  const observed = validRecommendation();
  observed.adjustments.exposure = 0.2; observed.adjustments.cropRatio = 1;
  for (const key of ['skinSmoothing', 'faceLight', 'teethWhitening', 'eyeBrightness', 'blemishReduction', 'skinEvenness', 'underEyeLight', 'eyeContrast', 'lipSaturation',
    'vibrance', 'highlights', 'shadows', 'sharpness', 'clarity', 'denoise', 'vignette']) observed.adjustments[key] = 0.1;
  const content = JSON.stringify(observed), raw = parseLocalRecommendation(content);
  assert.equal(Object.keys(raw.adjustments).length, 26);
  assert.equal(raw.adjustments.cropRatio, 1);
  const { client } = fixture({ '/api/chat': () => ({ done: true, message: { content } }) });
  const result = await client.recommend({ model, imageData, instruction: 'Éclaircis très légèrement avec exposure 0.2 et garde tous les autres réglages neutres. Conserve le cadrage.' });
  assert.equal(result.adjustments.cropRatio, 0); assert.equal(result.adjustments.exposure, 0.2);
  assert.equal(result.constraints.geometryPreserved, true);
  // Composition protection is deterministic, not a claim that the small model
  // understood or followed the remaining aesthetic instructions correctly.
  assert.equal(result.adjustments.vibrance, 0.1);
});

test('local JSON validation rejects missing/extra keys, coercion, range errors and empty explanations', async () => {
  const variants = [
    value => { delete value.adjustments.contrast; },
    value => { value.adjustments.notSupported = 1; },
    value => { value.extra = 'not supported'; },
    value => { value.adjustments.exposure = '0.2'; },
    value => { value.adjustments.exposure = 8; },
    value => { value.adjustments.flipHorizontal = 1; },
    value => { value.explanation = ''; },
    value => { value.explanation = 'x'.repeat(4001); },
  ];
  for (const mutate of variants) {
    const value = validRecommendation(); mutate(value);
    const { client } = fixture({ '/api/chat': () => ({ done: true, message: { content: JSON.stringify(value) } }) });
    await assert.rejects(client.recommend({ model, instruction: 'Naturel.', imageData }));
  }
  for (const override of [{ done: false }, {}, { done: true, done_reason: 'length' }, { done: true, error: 'PRIVATE-SERVER-ERROR' }, { done: true, remote_model: 'remote' }, { done: true, remote_host: 'https://remote.invalid' }]) {
    const { client } = fixture({ '/api/chat': () => ({ message: { content: JSON.stringify(validRecommendation()) }, ...override }) });
    await assert.rejects(client.recommend({ model, instruction: 'Naturel.', imageData }), error => !error.message.includes('PRIVATE-SERVER-ERROR'));
  }
});

test('recommendation cancellation and invalid inputs prevent image requests', async () => {
  const { client, calls } = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(client.recommend({ model, instruction: 'Naturel.', imageData, signal: controller.signal }), { name: 'AbortError' });
  for (const invalid of [{ instruction: '' }, { instruction: 'x'.repeat(10001) }, { imageData: Buffer.alloc(0) }, { model: 'bad model' }]) {
    await assert.rejects(client.recommend({ model, instruction: 'Naturel.', imageData, ...invalid }));
  }
  assert.equal(calls.length, 0);
  const invalidImage = fixture();
  await assert.rejects(invalidImage.client.recommend({ model, instruction: 'Naturel.', imageData: Buffer.from('not a photo') }));
  assert.ok(!invalidImage.calls.some(call => call.url.pathname === '/api/chat'));
});

test('pull is allowlisted and aggregates actual NDJSON byte progress including split UTF-8', async () => {
  const a = 'sha256:' + 'a'.repeat(64), b = 'sha256:' + 'b'.repeat(64), progress = [];
  const { client, calls } = fixture({ '/api/pull': () => lines([
    { status: 'Téléchargement des paramètres…' }, { status: 'pulling', digest: a, total: 1000, completed: 200 },
    { status: 'pulling', digest: b, total: 500, completed: 100 }, { status: 'pulling', digest: a, total: 1000, completed: 1000 },
    { status: 'success' },
  ], 11) });
  const result = await client.pullModel(model, { onProgress: value => progress.push(value) });
  assert.equal(result.local, true); assert.equal(progress[0].status, 'Téléchargement des paramètres…');
  assert.equal(progress[0].completedBytes, null); assert.equal(progress[0].totalBytes, null);
  assert.deepEqual(progress.slice(1, 4).map(value => [value.completedBytes, value.totalBytes]), [[200, 1000], [300, 1500], [1100, 1500]]);
  assert.equal(progress.at(-1).completedBytes, 1100, 'Do not invent a 100% byte count on a success phase');
  assert.deepEqual(calls.find(call=>call.url.pathname==='/api/pull').body, { model, stream: true });
  const rejected = fixture();
  for (const other of ['arbitrary:latest', 'model:cloud', '../model']) await assert.rejects(rejected.client.pullModel(other), /recommandé/);
  assert.equal(rejected.calls.length, 0);
});

test('pull cancellation destroys the stream and does not inspect or load a model afterward', async () => {
  const controller = new AbortController(); let stream;
  const { client, calls } = fixture({ '/api/pull': () => { stream = lines([{ status: 'pulling' }, { status: 'success' }], 1); return stream; } });
  await assert.rejects(client.pullModel(model, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.ok(stream.destroyed); assert.deepEqual(calls.map(value => value.url.pathname), ['/api/version','/api/pull']); assert.strictEqual(calls[0].signal, controller.signal);
  const cancelled = fixture(), stopped = new AbortController(); stopped.abort();
  await assert.rejects(cancelled.client.pullModel(model, { signal: stopped.signal }), { name: 'AbortError' }); assert.equal(cancelled.calls.length, 0);
});

test('pull rejects malformed, oversized, incomplete and server-error streams without echoing private messages', async () => {
  const cases = [Readable.from([Buffer.from('not JSON\n')]), lines([{ status: 'pulling' }]), lines([{ error: 'PRIVATE-SERVER-ERROR' }]),
    Readable.from([Buffer.alloc(16 * 1024 * 1024 + 1, 32)]), lines([{ status: 'x'.repeat(65537) }, { status: 'success' }])];
  for (const stream of cases) {
    const { client } = fixture({ '/api/pull': () => stream });
    await assert.rejects(client.pullModel(model), error => !error.message.includes('PRIVATE-SERVER-ERROR'));
  }
});

test('pull rejects invalid digests, excessive layers and byte sums beyond integer precision', async () => {
  const badDigest = [{ status: 'pulling', digest: '../not-a-hash', total: 10, completed: 0 }, { status: 'success' }];
  const tooMany = Array.from({ length: 129 }, (_, index) => ({ status: 'pulling', digest: 'sha256:' + index.toString(16).padStart(64, '0'), total: 10, completed: 1 }));
  const overflow = [0, 1].map(index => ({ status: 'pulling', digest: 'sha256:' + String(index).repeat(64), total: Number.MAX_SAFE_INTEGER, completed: Number.MAX_SAFE_INTEGER }));
  for (const items of [badDigest, [...tooMany, { status: 'success' }], [...overflow, { status: 'success' }]]) {
    const observed = [], { client } = fixture({ '/api/pull': () => lines(items) });
    await assert.rejects(client.pullModel(model, { onProgress: item => observed.push(item) }), /progression/);
    assert.ok(observed.every(item => [item.completedBytes, item.totalBytes].every(value => value === null || Number.isSafeInteger(value))));
  }
});

function mockHTTP(statusCode = 200, value = { version: '0.17.1' }) {
  const requests = [];
  const send = (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = (timeout, action) => { req.timeout = timeout; req.timeoutAction = action; return req; };
    req.destroy = error => { req.destroyed = true; queueMicrotask(() => req.emit('error', error)); };
    req.end = payload => { req.payload = payload; queueMicrotask(() => {
      const incoming = response(value, statusCode); incoming.headers = { location: 'http://192.168.1.2/private' }; callback(incoming);
    }); };
    requests.push({ url, options, req }); return req;
  };
  return { requests, request: createLocalTransport(send) };
}

test('direct loopback HTTP canonicalizes localhost, uses bounded sockets and never includes credentials', async () => {
  const { requests, request } = mockHTTP();
  const incoming = await request('http://localhost:11434/api/version', { timeoutMs: 8000 });
  assert.equal((await readLocalJSON(incoming)).version, '0.17.1'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, '127.0.0.1'); assert.equal(requests[0].url.pathname, '/api/version'); assert.equal(requests[0].req.timeout, 8000);
  assert.ok(requests[0].options.agent && requests[0].options.agent !== globalAgent, 'Local images must not inherit an HTTP_PROXY-enabled global agent');
  assert.deepEqual(requests[0].options.agent.options.proxyEnv, {});
  for (const url of ['http://user:secret@127.0.0.1:11434/api/version', 'http://192.168.1.2/api/version', 'https://127.0.0.1/api/version']) {
    await assert.rejects(async () => request(url));
  }
  assert.equal(requests.length, 1);
});

test('local HTTP rejects redirects and aborted requests without following a Location or using fetch', async () => {
  const { requests, request } = mockHTTP(302);
  await assert.rejects(request('http://127.0.0.1:11434/api/version'), /refusé/);
  assert.equal(requests.length, 1);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(request('http://127.0.0.1:11434/api/version', { signal: stopped.signal }), { name: 'AbortError' });
  assert.equal(requests.length, 1);
});

test('local JSON parser bounds response size and rejects HTTP errors and invalid JSON', async () => {
  await assert.rejects(readLocalJSON(response({ error: 'PRIVATE' }, 500)), /refusé/);
  await assert.rejects(readLocalJSON(Readable.from([Buffer.from('invalid')])), /non valide/);
  const oversized = response({ value: 'x'.repeat(100) });
  await assert.rejects(readLocalJSON(oversized, 16), /volumineuse/); assert.ok(oversized.destroyed);
});
