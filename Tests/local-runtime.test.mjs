import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_LOCAL_AI, normalizeLocalConfig, engineAssessment, assessLocalGeneration, createLocalDiagnostics } from '../desktop/local-runtime.mjs';

const GiB = 1024 ** 3;
const volume = join(tmpdir(), 'atelier-diagnostics-invented');
const snapshot = (patch = {}) => ({ platform: 'linux', arch: 'x64', osVersion: '6.8.0', cpu: { name: 'Synthetic CPU', cores: 4 },
  memory: { totalBytes: 16 * GiB, freeBytes: 12 * GiB }, storage: { freeBytes: 100 * GiB, path: volume },
  gpu: { kind: 'unknown', name: null, vramBytes: null, accelerationHint: null }, warnings: [], ...patch });
function fixture({ present = [volume], data = snapshot(), environment = {}, inspect, platform = process.platform } = {}) {
  const calls = [];
  const diagnostics = createLocalDiagnostics({ environment, userHome: volume, platform, access: async path => { if (!present.includes(path)) throw Object.assign(new Error('ENOENT'),{code:'ENOENT'}); },
    inspect: inspect || (async options => { calls.push(options); return { ...data, storage: { ...data.storage, path: options.storagePath } }; }) });
  return { diagnostics, calls };
}

test('local settings normalize two independent loopback engines without storing any key', () => {
  const config = normalizeLocalConfig({ ollamaURL: 'http://localhost:11435', comfyURL: 'http://[::1]:8189', model: 'qwen3-vl:2b-instruct',
    comfyModels: { diffusion: 'flux-2-klein-4b.safetensors', textEncoder: 'qwen_3_4b.safetensors', vae: 'flux2-vae.safetensors' },
    apiKey: 'DO-NOT-SAVE-A-KEY-HERE', provider: 'openai', workflow: { code: 'do not run' } });
  assert.equal(config.ollamaURL, 'http://127.0.0.1:11435/'); assert.equal(config.comfyURL, 'http://[::1]:8189/');
  assert.equal(config.model, 'qwen3-vl:2b-instruct'); assert.equal(config.comfyModels.diffusion, 'flux-2-klein-4b.safetensors');
  assert.equal('apiKey' in config, false); assert.equal('provider' in config, false); assert.equal('workflow' in config, false);
  assert.deepEqual(Object.keys(config).sort(), ['comfyModels', 'comfyURL', 'model', 'modelsDirectory', 'ollamaURL']);
  assert.deepEqual(normalizeLocalConfig(), DEFAULT_LOCAL_AI);
});

test('local settings reject remote addresses, credentials, proxy paths, NUL and relative storage', () => {
  for (const input of [null, [], { ollamaURL: 'https://127.0.0.1:11434' }, { comfyURL: 'http://192.168.1.1:8188' },
    { comfyURL: 'http://127.0.0.1:8188/proxy' }, { ollamaURL: 'http://user:key@127.0.0.1:11434' },
    { comfyURL: 'http://127.0.0.1:8188/?target=remote' }, { model: 'model\nInjected' }, { model: 'x'.repeat(161) },
    { modelsDirectory: './models' }, { modelsDirectory: volume + '\0' }, { comfyModels: { vae: 'vae\r\nheader' } }]) assert.throws(() => normalizeLocalConfig(input));
});

test('measurement uses the selected models volume and does not create a directory', async () => {
  const requested = join(volume, 'external', 'models');
  const { diagnostics, calls } = fixture({ present: [requested] });
  const measured = await diagnostics.hardware({ modelsDirectory: requested });
  assert.deepEqual(calls, [{ storagePath: requested }]); assert.equal(measured.storage.path, requested); assert.equal(measured.storage.measuredPath, requested);
  assert.ok(!measured.warnings.includes('model_storage_configuration_unverified'));
  assert.equal(measured.storage.configurationVerified, true);
});

test('environment models directory is measured while its configuration stays explicitly unverified', async () => {
  const requested = join(volume, 'ollama-models');
  const { diagnostics, calls } = fixture({ environment: { OLLAMA_MODELS: requested }, present: [requested] });
  const measured = await diagnostics.hardware();
  assert.deepEqual(calls, [{ storagePath: requested }]); assert.ok(measured.warnings.includes('model_storage_configuration_unverified'));
  assert.equal(measured.storage.path, requested);
  assert.equal(measured.storage.configurationVerified, false);
});

test('a fresh default home directory can measure its future model volume without creating it', async () => {
  const { diagnostics, calls } = fixture({ platform: 'darwin' });
  await diagnostics.hardware();
  assert.deepEqual(calls, [{ storagePath: volume }]);
  assert.notEqual(calls[0].storagePath, dirname(volume));
});

test('a configured or environment external volume never falls back to the system disk when absent',async()=>{
  const missing=join(volume,'unmounted','models');
  for(const useEnvironment of [false,true]){
    const {diagnostics,calls}=fixture({environment:useEnvironment?{OLLAMA_MODELS:missing}:{},data:snapshot({storage:{freeBytes:null},warnings:['storage_detection_unavailable']})});
    const result=await diagnostics.hardware(useEnvironment?{}:{modelsDirectory:missing});
    assert.deepEqual(calls,[{storagePath:missing}]);assert.equal(result.storage.freeBytes,null);
  }
});

test('same-volume diagnostics share work and different volumes remain independent', async () => {
  const other = join(volume, 'other'); const { diagnostics, calls } = fixture({ present: [volume, other] });
  const [a, b] = await Promise.all([diagnostics.hardware({ modelsDirectory: volume }), diagnostics.hardware({ modelsDirectory: volume })]);
  assert.equal(calls.length, 1); assert.deepEqual(a, b);
  const c = await diagnostics.hardware({ modelsDirectory: other });
  assert.equal(calls.length, 2); assert.equal(c.storage.path, other);
});

test('unavailable hardware remains unknown instead of invented capacity', async () => {
  const { diagnostics } = fixture({ data: snapshot({ memory: { totalBytes: null, freeBytes: null }, storage: { freeBytes: null }, warnings: ['memory_detection_unavailable', 'storage_detection_unavailable'] }) });
  const hardware = await diagnostics.hardware();
  assert.equal(hardware.memory.totalBytes, null); assert.equal(hardware.storage.freeBytes, null);
  const recommendations = await diagnostics.recommendations();
  assert.ok(recommendations.every(model => model.assessment.status === 'unknown'));
  assert.ok(recommendations.every(model => model.assessment.reasons.includes('resource_estimates_only')));
});

test('known small vision models reject insufficient RAM before inference or download', async () => {
  const { diagnostics } = fixture({ data: snapshot({ memory: { totalBytes: 4 * GiB, freeBytes: 3 * GiB } }) });
  await assert.rejects(diagnostics.checkModel('qwen3-vl:2b-instruct'), /insuffisantes/);
  await assert.rejects(diagnostics.checkModel('qwen3-vl:2b-instruct', {}, true), /insuffisantes/);
});

test('download checks free storage but an installed model can infer without a second weights allocation', async () => {
  const { diagnostics } = fixture({ data: snapshot({ storage: { freeBytes: GiB }, memory: { totalBytes: 16 * GiB, freeBytes: 8 * GiB } }) });
  await assert.rejects(diagnostics.checkModel('qwen3-vl:2b-instruct', { modelsDirectory: volume }, true), /insuffisantes/);
  const hardware = await diagnostics.checkModel('qwen3-vl:2b-instruct', { modelsDirectory: volume });
  assert.equal(hardware.storage.freeBytes, GiB);
});

test('CPU-only machines keep a truthful slow estimate, without requiring a GPU', async () => {
  const { diagnostics } = fixture(); const list = await diagnostics.recommendations({ modelsDirectory: volume });
  assert.equal(list[0].assessment.status, 'slow'); assert.ok(list[0].assessment.reasons.includes('cpu_only_slow'));
  assert.ok(list[0].assessment.reasons.includes('resource_estimates_only'));
  await diagnostics.checkModel(list[0].id);
});

test('OS and architecture checks use the correct platform version fields', () => {
  const base = { status: 'recommended', reasons: ['resource_estimates_only'] };
  for (const hardware of [{ platform: 'darwin', arch: 'arm64', osVersion: '13.6.0' }, { platform: 'win32', arch: 'x64', osVersion: '10.0.19044' }, { platform: 'linux', arch: 'ia32', osVersion: '6.8' }]) assert.equal(engineAssessment(hardware, base).status, 'insufficient');
  for (const hardware of [{ platform: 'darwin', arch: 'arm64', osVersion: '14.0' }, { platform: 'win32', arch: 'x64', osVersion: '10.0.19045' }, { platform: 'linux', arch: 'arm64', osVersion: '6.8' }]) assert.equal(engineAssessment(hardware, base).status, 'recommended');
  assert.deepEqual(base.reasons, ['resource_estimates_only']);
});

test('a missing or malformed system version never becomes a recommended engine', () => {
  const base = { status: 'recommended', reasons: ['resource_estimates_only'] };
  for (const hardware of [{ platform: 'darwin', arch: 'arm64', osVersion: null }, { platform: 'win32', arch: 'x64', osVersion: '10.0' }, { platform: 'linux', arch: 'x64', osVersion: 'unknown' }]) {
    const result = engineAssessment(hardware, base);
    assert.equal(result.status, 'unknown'); assert.ok(result.reasons.includes('engine_os_unverified'));
    assert.equal(engineAssessment(hardware, { ...base, status: 'insufficient' }).status, 'insufficient');
  }
});

test('Linux default targets the standard service directory without treating it as confirmed server configuration', async () => {
  const directory = '/usr/share/ollama/.ollama/models';
  const { diagnostics, calls } = fixture({ platform: 'linux', present: [directory], data: snapshot({ gpu: { kind: 'discrete', accelerationHint: 'cuda' } }) });
  const measured = await diagnostics.hardware();
  assert.deepEqual(calls, [{ storagePath: directory }]);
  assert.equal(measured.storage.path, directory); assert.equal(measured.storage.configurationVerified, false);
  const models = await diagnostics.recommendations();
  assert.equal(models[0].assessment.status, 'unknown'); assert.ok(models[0].assessment.reasons.includes('storage_unknown'));
});

test('confirming an inferred directory invalidates its cached unverified assessment', async () => {
  const directory = join(volume, '.ollama', 'models');
  const { diagnostics, calls } = fixture({ platform: 'darwin', present: [directory], data: snapshot({ gpu: { kind: 'discrete', accelerationHint: 'cuda' } }) });
  assert.equal((await diagnostics.recommendations())[0].assessment.status, 'unknown');
  assert.equal((await diagnostics.recommendations({ modelsDirectory: directory }))[0].assessment.status, 'recommended');
  assert.equal(calls.length, 2);
});

test('an unverified environment directory never proves that the real model volume has enough or insufficient disk', async () => {
  for (const freeBytes of [GiB, 100 * GiB]) {
    const { diagnostics } = fixture({ environment: { OLLAMA_MODELS: volume }, data: snapshot({ storage: { freeBytes }, gpu: { kind: 'discrete', accelerationHint: 'cuda' } }) });
    assert.equal((await diagnostics.recommendations())[0].assessment.status, 'unknown');
    await diagnostics.checkModel('qwen3-vl:2b-instruct', {}, true);
  }
});

test('a slow native diagnostic stays deduplicated after the completed-result TTL', async () => {
  const realNow = Date.now; let clock = realNow(), count = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  Date.now = () => clock;
  try {
    const { diagnostics } = fixture({ inspect: async () => { count++; await waiting; return snapshot(); } });
    const a = diagnostics.hardware({ modelsDirectory: volume });
    await new Promise(resolve => setImmediate(resolve)); clock += 2000;
    const b = diagnostics.hardware({ modelsDirectory: volume });
    await new Promise(resolve => setImmediate(resolve)); release();
    await Promise.all([a, b]);
    assert.equal(count, 1, 'An in-flight native inspection must not expire before it finishes');
  } finally { release?.(); Date.now = realNow; }
});

test('generative budgets are independent of the small Ollama analysis model', () => {
  const hardware = snapshot({ memory: { totalBytes: 8 * GiB, freeBytes: 6 * GiB } });
  const assessment = assessLocalGeneration(hardware);
  assert.equal(assessment.status, 'insufficient');
  assert.ok(assessment.requiredMemoryBytes > hardware.memory.totalBytes);
  assert.ok(assessment.reasons.includes('resource_estimates_only'));
  assert.ok(assessment.reasons.includes('memory_below_minimum'));
});

test('measured dedicated VRAM can reduce the host budget without becoming an inference guarantee', () => {
  const dedicated = snapshot({ memory: { totalBytes: 16 * GiB, freeBytes: 6 * GiB }, gpu: { kind: 'discrete', name: 'Synthetic CUDA GPU', vramBytes: 12 * GiB, accelerationHint: 'cuda' } });
  const assessment = assessLocalGeneration(dedicated, { sourcePixels: 1600 * 1600, outputPixels: 1024 * 1024 });
  assert.notEqual(assessment.status, 'insufficient'); assert.notEqual(assessment.status, 'recommended');
  assert.ok(assessment.reasons.includes('gpu_backend_unverified'));
  assert.equal(assessLocalGeneration(snapshot({ memory: { totalBytes: 16 * GiB, freeBytes: 6 * GiB } })).status, 'insufficient');
  for(const kind of ['unknown','integrated','unified'])assert.equal(assessLocalGeneration({...dedicated,gpu:{...dedicated.gpu,kind}}).status,'insufficient','A shared or unclassified heap must not reduce host RAM requirements');
});

test('outpainting budgets include both the full source and enlarged canvas allocations', () => {
  const hardware = snapshot({ memory: { totalBytes: 128 * GiB, freeBytes: 50 * GiB }, gpu: { kind: 'discrete', name: 'Synthetic GPU', vramBytes: 12 * GiB, accelerationHint: 'cuda' } });
  const ordinary = assessLocalGeneration(hardware, { sourcePixels: 1024 * 1024, outputPixels: 1024 * 1024 });
  const expanded = assessLocalGeneration(hardware, { sourcePixels: 60_000_000, outputPixels: 120_000_000 });
  assert.ok(expanded.requiredMemoryBytes > ordinary.requiredMemoryBytes);
  assert.ok(expanded.requiredMemoryBytes >= 60_000_000 * 8 + 120_000_000 * 24);
  assert.notEqual(expanded.status, 'recommended');
});

test('unknown capacity and reclaimable-memory estimates never fabricate a recommended generative profile', () => {
  const unknown = assessLocalGeneration(snapshot({ memory: { totalBytes: null, freeBytes: null } }));
  assert.equal(unknown.status, 'unknown');
  const reclaimable = assessLocalGeneration(snapshot({ memory: { totalBytes: 64 * GiB, freeBytes: 0 }, gpu: { kind: 'unified', name: 'Synthetic Apple GPU', vramBytes: null, accelerationHint: 'metal' } }));
  assert.notEqual(reclaimable.status, 'insufficient'); assert.notEqual(reclaimable.status, 'recommended');
});
