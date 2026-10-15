import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseSync } from 'rolldown/utils';
import { assessLocalModel } from '../desktop/hardware-profile.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const filename = 'src/LocalAIPanel.jsx';
const source = readFileSync(join(root, filename), 'utf8');
const parsed = parseSync(filename, source);
assert.deepEqual(parsed.errors, [], 'LocalAIPanel must be valid JSX');
const declarations = parsed.program.body.map(node => node.declaration || node);
const functionNode = name => declarations.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
const variableNode = name => declarations.find(node => node.type === 'VariableDeclaration' && node.declarations.some(value => value.id?.name === name));
const names = ['isLocalEndpoint', 'localDownloadState', 'localEngineOptions', 'reasonText', 'phaseText'];
const snippets = names.map(name => { const node = functionNode(name); assert.ok(node, name); return source.slice(node.start, node.end); });
const compatible = variableNode('compatibleModels');
assert.ok(compatible);
snippets.push(source.slice(compatible.start, compatible.end));
// Execute only the component's pure policy helpers, without a browser, IPC, or JSX runtime.
const helpers = vm.runInNewContext(`${snippets.join('\n')}\n({${names.join(',')},compatibleModels})`, { URL });
const GiB = 1024 ** 3;
const hardware = { memory: { totalBytes: 16 * GiB, freeBytes: 10 * GiB }, storage: { freeBytes: 50 * GiB }, gpu: { accelerationHint: null } };
const requirements = { downloadBytes: 3.3e9, estimatedWorkingBytes: 7 * GiB, minTotalMemoryBytes: 8 * GiB, recommendedMemoryBytes: 16 * GiB };
const recommendation = snapshot => ({ id: 'qwen3-vl:4b-instruct', assessment: assessLocalModel(snapshot, requirements) });

test('les adresses locales suivent le contrat HTTP du processus principal', () => {
  for (const value of ['http://localhost:11434', 'http://127.0.0.1:8188/', 'http://[::1]:11434']) assert.equal(helpers.isLocalEndpoint(value), true, value);
  for (const value of ['https://localhost:11434', 'http://example.com', 'http://127.0.0.1.evil.test', 'http://localhost@evil.test', 'http://user:password@localhost', 'http://127.0.0.1/api', 'http://127.0.0.1?host=example.com', 'file:///tmp/ollama', '', 'invalid']) assert.equal(helpers.isLocalEndpoint(value), false, value);
});

test('les modes séparent le moteur privé des adresses et dossiers de l’installation externe', () => {
  const previous = { model: 'existing:vision', ollamaURL: 'http://127.0.0.1:11500', modelsDirectory: '/external/models' };
  const external = helpers.localEngineOptions(previous);
  assert.equal(external.engineMode, 'external', 'legacy settings remain external');
  assert.equal(external.ollamaURL, previous.ollamaURL);
  assert.equal(external.modelsDirectory, previous.modelsDirectory);
  const managed = helpers.localEngineOptions({ ...previous, engineMode: 'managed' });
  assert.deepEqual(Object.keys(managed), ['engineMode']);
  assert.equal(managed.engineMode, 'managed');
  assert.equal(previous.ollamaURL, 'http://127.0.0.1:11500');
});

test('un téléchargement exige un diagnostic et bloque les pénuries confirmées', () => {
  assert.equal(helpers.localDownloadState(null, recommendation(hardware)).allowed, false);
  assert.equal(helpers.localDownloadState(hardware, null).allowed, false);
  const lowRAM = { ...hardware, memory: { totalBytes: 4 * GiB, freeBytes: 2 * GiB } };
  assert.equal(recommendation(lowRAM).assessment.status, 'insufficient');
  assert.equal(helpers.localDownloadState(lowRAM, recommendation(lowRAM)).allowed, false);
  const lowDisk = { ...hardware, storage: { freeBytes: 1e9 } };
  assert.equal(helpers.localDownloadState(lowDisk, recommendation(hardware)).allowed, false, 'recheck current disk space even if the recommendation was made earlier');
  assert.equal(helpers.localDownloadState(lowDisk, recommendation(lowDisk)).allowed, false);
});

test('un profil CPU lent reste utilisable et une mesure inconnue reste prudente', () => {
  assert.equal(recommendation(hardware).assessment.status, 'slow');
  assert.equal(helpers.localDownloadState(hardware, recommendation(hardware)).allowed, true);
  const unknown = { memory: { totalBytes: null, freeBytes: null }, storage: { freeBytes: null }, gpu: { accelerationHint: null } };
  assert.equal(recommendation(unknown).assessment.status, 'unknown');
  const state = helpers.localDownloadState(unknown, recommendation(unknown));
  assert.equal(state.allowed, true);
  assert.equal(state.unknown, true);
});

test('un volume non confirmé ne prouve ni une pénurie ni une capacité disque suffisante', () => {
  const model = recommendation(hardware);
  for (const freeBytes of [GiB, 200 * GiB]) {
    const unverified = { ...hardware, storage: { path: '/home/user/.ollama/models', freeBytes, configurationVerified: false } };
    const state = helpers.localDownloadState(unverified, model);
    assert.equal(state.allowed, true, `unconfirmed disk measurement: ${freeBytes}`);
    assert.equal(state.unknown, true, 'even a comfortable reading may measure the wrong volume');
  }
  const confirmed = { ...hardware, storage: { freeBytes: GiB, configurationVerified: true } };
  assert.equal(helpers.localDownloadState(confirmed, model).allowed, false);
  assert.equal(helpers.localDownloadState(confirmed, model).reason, 'disk');
  const lowRAM = { ...hardware, memory: { totalBytes: 4 * GiB, freeBytes: GiB }, storage: { freeBytes: 200 * GiB, configurationVerified: false } };
  assert.equal(helpers.localDownloadState(lowRAM, recommendation(lowRAM)).allowed, false, 'confirmed RAM shortage remains blocking');
});

test('les explications distinguent estimation, lenteur, mémoire partagée et incompatibilité', () => {
  assert.equal(helpers.reasonText('engine_platform_unsupported'), 'Ce moteur intégré n’est pas disponible pour ce système.');
  assert.equal(helpers.reasonText('engine_os_too_old'), 'Cette version du système est trop ancienne pour le moteur intégré.');
  assert.equal(helpers.reasonText('engine_os_unverified'), 'La compatibilité de cette version du système reste à vérifier.');
  assert.equal(helpers.reasonText('resource_estimates_only'), 'Ces recommandations sont des estimations ; testez le modèle sur cet ordinateur.');
  assert.equal(helpers.reasonText('storage_below_required'), 'L’espace disponible est insuffisant pour ce modèle.');
  for (const code of ['memory_below_minimum', 'working_memory_above_total']) assert.equal(helpers.reasonText(code), 'La mémoire vive est insuffisante pour ce modèle.');
  assert.equal(helpers.reasonText('memory_below_recommended'), 'La mémoire disponible est limitée ; l’analyse peut être lente.');
  assert.equal(helpers.reasonText('free_memory_low'), 'La mémoire libre est basse ; le système peut encore récupérer de la mémoire.');
  assert.equal(helpers.reasonText('gpu_unified_memory_shared'), 'La mémoire graphique est partagée avec la mémoire vive.');
  assert.equal(helpers.reasonText('gpu_backend_unverified'), 'Les performances graphiques restent à vérifier.');
  assert.equal(helpers.reasonText('gpu_vram_unavailable'), 'Les performances graphiques restent à vérifier.');
});

test('le sélecteur accepte seulement des modèles locaux avec capacité vision déclarée', () => {
  const models = helpers.compatibleModels({ models: [
    { name: 'vision-local', local: true, capabilities: ['vision'] },
    { name: 'vision-in-name-only', local: true, capabilities: ['completion'] },
    { name: 'remote', local: false, capabilities: ['vision'] },
    { name: 'renamed-cloud', local: true, remote_model: 'original-cloud', capabilities: ['vision'] },
    { name: 'proxied', local: true, remote_host: 'https://example.com', capabilities: ['vision'] },
    { local: true, capabilities: ['vision'] },
  ] });
  assert.equal(models.length, 1);
  assert.equal(models[0].name, 'vision-local');
});

test('les phases sans taille ne prétendent pas afficher une progression mesurée', () => {
  assert.equal(helpers.phaseText(null), 'Préparation du téléchargement…');
  assert.equal(helpers.phaseText({ status: 'verifying sha256 digest', totalBytes: 100 }), 'Vérification des fichiers…');
  assert.equal(helpers.phaseText({ status: 'pulling layer', totalBytes: 100 }), 'Téléchargement du modèle…');
  assert.equal(helpers.phaseText({ status: 'success' }), 'Téléchargement terminé.');
  assert.equal(helpers.phaseText({ kind: 'runtime', phase: 'downloading', totalBytes: null }), 'Téléchargement du moteur…');
  assert.equal(helpers.phaseText({ kind: 'runtime', phase: 'extracting' }), 'Extraction du moteur…');
  assert.equal(helpers.phaseText({ kind: 'runtime', phase: 'starting' }), 'Démarrage du moteur…');
  assert.equal(helpers.phaseText({ kind: 'runtime', phase: 'ready' }), 'La préparation du moteur est en cours.', 'an install phase alone does not prove the engine has started');
});

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit, parent)); return; }
  if (node.type) visit(node, parent);
  for (const [key, value] of Object.entries(node)) if (!['start', 'end', 'raw', 'loc'].includes(key) && value && typeof value === 'object') walk(value, visit, node);
}

function expressionNamed(name) {
  let declaration;
  walk(parsed.program, node => { if (node.type === 'VariableDeclarator' && node.id?.name === name) declaration = node; });
  assert.ok(declaration, name);
  return source.slice(declaration.init.start, declaration.init.end);
}

test('la réouverture restaure la tâche et son annulation sans démarrer le moteur', async () => {
  const progressRevision = { current: 0 }, localJobRef = { current: false }, snapshots = [], progress = [], failures = [], cancelling = { current: false };
  let state = { supported: true, installed: false, running: false, job: { kind: 'runtime', phase: 'downloading', completedBytes: 400, totalBytes: 1000 } }, reads = 0;
  const refresh = vm.runInNewContext(`(${expressionNamed('refreshEngine')})`, {
    api: { localEngineStatus: async () => { reads++; return state; } }, alive: { current: true }, progressRevision, localJobRef, cancelling,
    setEngine: value => snapshots.push(value), setProgress: value => progress.push(value), setCancellingJob: () => {}, setError: value => failures.push(value), setNotice: () => {},
  });
  await refresh();
  assert.equal(reads, 1);
  assert.equal(snapshots.at(-1).job.completedBytes, 400);
  assert.equal(localJobRef.current, true);
  assert.equal(progress.length, 0, 'a restored job must not be cleared');
  const calls = [];
  for (const kind of ['runtime', 'model']) {
    const cancel = vm.runInNewContext(`(${expressionNamed('cancelPull')})`, {
      cancelling: { current: false }, cancellingJob: false, activeJob: { kind }, setCancellingJob: () => {},
      invoke: async name => { calls.push(name); }, fail: cause => { throw cause; },
    });
    await cancel();
  }
  assert.deepEqual(calls, ['cancelLocalEngineInstall', 'cancelLocalPull']);
  state = { ...state, job: null, lastResult: { kind: 'runtime', error: 'Synthetic download failure' } };
  await refresh();
  assert.equal(localJobRef.current, false);
  assert.equal(progress.at(-1), null);
  assert.equal(failures.at(-1), 'Synthetic download failure');
});

test('une progression récente ne peut pas être effacée par un ancien snapshot', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; }), progressRevision = { current: 0 }, applied = [];
  const refresh = vm.runInNewContext(`(${expressionNamed('refreshEngine')})`, {
    api: { localEngineStatus: () => pending }, progressRevision, alive: { current: true },
    setEngine: value => applied.push(value), localJobRef: { current: true }, cancelling: { current: false }, setProgress: () => {}, setCancellingJob: () => {},
  });
  const result = refresh();
  progressRevision.current++;
  resolve({ job: null });
  await result;
  assert.equal(applied.length, 0);
});

test('installer choisit le mode géré sans enregistrer le port privé ni modifier les options externes', async () => {
  const calls = [], changes = [];
  const snapshot = { installed: true, running: true, endpoint: 'http://127.0.0.1:49123/' };
  const install = vm.runInNewContext(`(${expressionNamed('installEngine')})`, {
    operation: async (_name, action) => action(), hardware, current: { current: { engineMode: 'managed', ollamaURL: 'http://127.0.0.1:11500', modelsDirectory: '/external/models' } }, alive: { current: true },
    invoke: async name => { calls.push(name); return snapshot; }, setEngine: () => {}, change: patch => changes.push(patch),
    inspect: async options => { assert.equal(options.engineMode, 'managed'); assert.deepEqual(Object.keys(options), ['engineMode']); },
    setNotice: () => {}, refreshEngine: async () => snapshot,
  });
  assert.equal(calls.length, 0);
  await install();
  assert.deepEqual(calls, ['localEngineInstall']);
  assert.deepEqual(Object.keys(changes[0]), ['engineMode']);
  assert.equal(changes[0].engineMode, 'managed');
});

test('ouvrir la carte n’installe rien, ne télécharge rien et ne lance pas d’inférence', () => {
  const calls = [];
  walk(parsed.program, (node, parent) => {
    if (node.type === 'CallExpression' && node.callee?.name === 'useEffect') {
      walk(node.arguments[0], child => {
        if (child.type === 'CallExpression') calls.push(child.callee?.name || child.callee?.property?.name || '');
      });
    }
  });
  assert.ok(calls.includes('onProgress'));
  assert.ok(calls.includes('refreshEngine'), 'reopening reads the engine snapshot');
  assert.ok(!calls.some(name => /localPull|localBenchmark|openLocalInstaller|invoke|fetch|inspectLocalGraphics|localEngineInstall|localEngineStart|localEngineStop/.test(name)));
});

test('le contexte graphique est sondé après le diagnostic explicite sans modifier le profil Ollama', async () => {
  let declaration;
  walk(parsed.program, node => { if (node.type === 'VariableDeclarator' && node.id?.name === 'diagnose') declaration = node; });
  assert.ok(declaration);
  const probeCalls = [];
  walk(parsed.program, node => { if (node.type === 'CallExpression' && node.callee?.name === 'inspectLocalGraphics') probeCalls.push(node); });
  assert.equal(probeCalls.length, 1, 'no graphics probe at module initialization');
  assert.ok(probeCalls[0].start > declaration.start && probeCalls[0].end < declaration.end);

  for (const graphics of [{ webgl: false, webgl2: false }, { webgl: true, webgl2: false }, { webgl: true, webgl2: true }]) {
    let completeHardware;
    const hardwareResponse = new Promise(resolve => { completeHardware = resolve; });
    const snapshots = [], receivedRecommendations = [], backendRecommendations = [recommendation(hardware)];
    let probes = 0;
    const diagnose = vm.runInNewContext(`(${source.slice(declaration.init.start, declaration.init.end)})`, {
      operation: async (_name, action) => action(), current: { current: {} }, alive: { current: true },
      localEngineOptions: helpers.localEngineOptions,
      setHardware: value => snapshots.push(value), setRecommendations: value => receivedRecommendations.push(value), setBenchmark: () => {},
      invoke: name => name === 'localHardware' ? hardwareResponse : Promise.resolve(backendRecommendations),
      inspectLocalGraphics: () => { probes++; return Object.freeze(graphics); },
    });
    assert.equal(probes, 0, 'creating the action must not inspect the browser');
    const pending = diagnose();
    assert.equal(probes, 0, 'wait for the requested hardware snapshot before probing graphics');
    completeHardware(hardware);
    await pending;
    assert.equal(probes, 1);
    assert.equal(snapshots.at(-1).graphics, graphics);
    assert.equal(snapshots.at(-1).gpu, hardware.gpu, 'browser graphics cannot replace the Ollama GPU profile');
    assert.equal(snapshots.at(-1).memory, hardware.memory);
    assert.equal(receivedRecommendations.at(-1), backendRecommendations, 'browser blocklisting cannot downgrade Ollama recommendations');
  }
});

test('tous les messages de la carte et des parcours locaux existent dans les douze langues', () => {
  const fixture = JSON.parse(readFileSync(join(root, 'Tests/fixtures/local-ai-messages.json'), 'utf8'));
  const messages = new Set(fixture);
  const visibleAttributes = new Set(['title', 'aria-label', 'placeholder', 'alt']);
  function add(value) { if (typeof value === 'string' && /\p{L}/u.test(value) && value.trim() !== 'Ollama') messages.add(value.replace(/\s+/g, ' ').trim()); }
  function rendered(expression) {
    if (!expression) return;
    if (expression.type === 'Literal') add(expression.value);
    if (expression.type === 'ConditionalExpression') { rendered(expression.consequent); rendered(expression.alternate); }
    if (expression.type === 'LogicalExpression') rendered(expression.right);
  }
  walk(parsed.program, (node, parent) => {
    if (node.type === 'JSXText') add(node.value);
    if (node.type === 'JSXAttribute' && visibleAttributes.has(node.name?.name)) rendered(node.value?.expression || node.value);
    if (node.type === 'CallExpression' && ['translate', 'formatMessage'].includes(node.callee?.name)) rendered(node.arguments[0]);
    if (node.type === 'NewExpression' && node.callee?.name === 'Error') rendered(node.arguments[0]);
    if (node.type === 'JSXExpressionContainer' && parent?.type !== 'JSXAttribute') rendered(node.expression);
  });
  for (const name of ['reasonText', 'phaseText']) walk(functionNode(name), node => {
    if (node.type === 'Literal' && typeof node.value === 'string' && (/[À-ž]/u.test(node.value) || node.value.includes(' '))) add(node.value);
  });
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const code of ['fr', 'nl', 'en', 'es', 'zh', 'ja', 'ar', 'de', 'pt', 'it', 'hi', 'ko']) {
    const catalog = JSON.parse(readFileSync(join(root, 'locales', `${code}.json`), 'utf8'));
    for (const key of messages) {
      assert.ok(typeof catalog[key] === 'string' && catalog[key].trim(), `${code}: missing ${key}`);
      assert.deepEqual(placeholders(catalog[key]), placeholders(key), `${code}: ${key}`);
    }
  }
});

test('les erreurs du moteur géré et de son service sont traduites sans charger le moteur', () => {
  const messages = new Set();
  const add = node => { if (node?.type === 'Literal' && typeof node.value === 'string') messages.add(node.value); };
  for (const file of ['desktop/managed-ollama.mjs', 'desktop/local-engine-service.mjs', 'desktop/local-runtime.mjs']) {
    const backend = parseSync(file, readFileSync(join(root, file), 'utf8'));
    assert.deepEqual(backend.errors, [], file);
    if (file.endsWith('local-runtime.mjs')) {
      // Cover the engine-mode validation without treating internal technical errors as UI copy.
      walk(backend.program, node => {
        if (node.type !== 'IfStatement') return;
        let validatesMode = false;
        walk(node.test, part => { if (part.type === 'Identifier' && part.name === 'engineMode') validatesMode = true; });
        if (validatesMode) walk(node.consequent, part => {
          if (part.type === 'CallExpression' && part.callee?.name === 'fail') add(part.arguments[0]);
        });
      });
      continue;
    }
    walk(backend.program, node => {
      if (node.type === 'VariableDeclarator' && node.id?.name === 'ERR') {
        for (const property of node.init?.arguments?.[0]?.properties || []) add(property.value);
      }
      if (node.type === 'NewExpression' && ['Error', 'DOMException'].includes(node.callee?.name)) add(node.arguments[0]);
      if (node.type === 'CallExpression' && node.callee?.name === 'fail') add(node.arguments[0]);
    });
  }
  assert.ok(messages.size > 0, 'extract the user-visible backend error catalog');
  for (const code of ['fr', 'nl', 'en', 'es', 'zh', 'ja', 'ar', 'de', 'pt', 'it', 'hi', 'ko']) {
    const catalog = JSON.parse(readFileSync(join(root, 'locales', `${code}.json`), 'utf8'));
    for (const key of messages) {
      assert.ok(typeof catalog[key] === 'string' && catalog[key].trim(), `${code}: missing backend error ${key}`);
      if (code !== 'fr') assert.notEqual(catalog[key], key, `${code}: untranslated backend error ${key}`);
    }
  }
});

test('les messages Claude mentionnent ComfyUI et conservent les anciennes traductions', () => {
  const current = [
    'Claude analyse les photos et propose des réglages. Pour une retouche générative d’image, choisissez OpenAI, Gemini ou ComfyUI en mode local.',
    'Claude propose des réglages. Choisissez OpenAI, Gemini ou ComfyUI en mode local pour générer une image retouchée.',
  ];
  const previous = [
    'Claude analyse les photos et propose des réglages. Pour une retouche générative d’image, choisissez OpenAI ou Gemini.',
    'Claude propose des réglages. Choisissez OpenAI ou Gemini pour générer une image retouchée.',
  ];
  const precision = 'Cette configuration FP8 n’a pas été validée avec Metal. Choisissez le modèle BF16.';
  for (const code of ['fr', 'nl', 'en', 'es', 'zh', 'ja', 'ar', 'de', 'pt', 'it', 'hi', 'ko']) {
    const catalog = JSON.parse(readFileSync(join(root, 'locales', `${code}.json`), 'utf8'));
    for (const key of current) for (const brand of ['Claude', 'OpenAI', 'Gemini', 'ComfyUI']) assert.ok(catalog[key]?.includes(brand), `${code}: ${brand}`);
    for (const key of previous) assert.ok(catalog[key]?.trim(), `${code}: previous message removed`);
    for (const token of ['FP8', 'Metal', 'BF16']) assert.ok(catalog[precision]?.includes(token), `${code}: ${token}`);
  }
});
