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
const names = ['isLocalEndpoint', 'localDownloadState', 'reasonText', 'phaseText'];
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
  assert.equal(helpers.reasonText('resource_estimates_only'), 'Ces recommandations sont des estimations ; testez le modèle sur cet ordinateur.');
  assert.equal(helpers.reasonText('storage_below_required'), 'L’espace disponible est insuffisant pour ce modèle.');
  for (const code of ['memory_below_minimum', 'working_memory_above_total']) assert.equal(helpers.reasonText(code), 'La mémoire vive est insuffisante pour ce modèle.');
  assert.equal(helpers.reasonText('memory_below_recommended'), 'La mémoire disponible est limitée ; l’analyse peut être lente.');
  assert.equal(helpers.reasonText('free_memory_low'), 'La mémoire libre est basse ; le système peut encore récupérer de la mémoire.');
  assert.equal(helpers.reasonText('gpu_unified_memory_shared'), 'La mémoire graphique est partagée avec la mémoire vive.');
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
});

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit, parent)); return; }
  if (node.type) visit(node, parent);
  for (const [key, value] of Object.entries(node)) if (!['start', 'end', 'raw', 'loc'].includes(key) && value && typeof value === 'object') walk(value, visit, node);
}

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
  assert.ok(!calls.some(name => /localPull|localBenchmark|openLocalInstaller|invoke|fetch|inspectLocalGraphics/.test(name)));
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
