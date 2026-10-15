/**
 * After the final npm run build, run with desktop/socket permission:
 *   node Tests/local-ai-electron.mjs
 * Packaged executable, with the same private profile and synthetic server:
 *   ATELIER_PACKAGED_EXE='/absolute/path/to/Atelier Photo' node Tests/local-ai-electron.mjs
 * Safe fixture-only verification, without Electron or a listening socket:
 *   node Tests/local-ai-electron.mjs --check-fixtures
 * Every photograph, settings file, catalogue and HTTP response is synthetic.
 * No Ollama process, model download, cloud key or personal profile is used.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { Catalog } from '../desktop/catalog.mjs';
import { recommendationSchema } from '../desktop/ai-service.mjs';
import { renderImage } from '../desktop/image-engine.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url))), require = createRequire(import.meta.url);
const fixtureOnly = process.argv.includes('--check-fixtures');
const packagedExecutable = process.env.ATELIER_PACKAGED_EXE;
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'atelier-local-ai-qa-')));
const profile = join(temporary, 'profile'), modelDirectory = join(temporary, 'models'), outputDirectory = join(temporary, 'exports');
const screenshotDirectory = join(root, 'test-artifacts');
const source = join(temporary, 'mire-originale-16bits.png');
const MODEL = 'qa-local-vision:latest', EXPOSURE = 0.4, WIDTH = 1024, HEIGHT = 128;
const explanation = 'La mire synthétique reçoit une lumière légèrement relevée.';
const schema = recommendationSchema();
const recipe = { adjustments: Object.fromEntries(Object.keys(schema.properties.adjustments.properties).map(key =>
  [key, key === 'flipHorizontal' ? false : ['contrast', 'saturation'].includes(key) ? 1 : ['cropX', 'cropY'].includes(key) ? 0.5 : 0])), explanation };
recipe.adjustments.exposure = EXPOSURE;
const portraitControls = ['skinSmoothing', 'faceLight', 'teethWhitening', 'eyeBrightness', 'blemishReduction', 'skinEvenness', 'underEyeLight', 'eyeContrast', 'lipSaturation'];
// Reproduce the semantic failure found in the real small model: a response can
// pass the schema while suggesting an unwanted square crop and portrait edits.
const contradictoryRecipe = structuredClone(recipe);
Object.assign(contradictoryRecipe.adjustments, { cropRatio: 1, rotation: 15, cropX: 0.2, cropY: 0.8, flipHorizontal: true });
for (const key of portraitControls) contradictoryRecipe.adjustments[key] = 0.1;
const requests = [], serverErrors = [], pageErrors = [];
let application, server, stage = 'fixtures', photoId, originalHash;
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function eventually(read, predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    last = await read(); if (predicate(last)) return last;
    await delay(50);
  }
  throw new Error(message + '; last result: ' + JSON.stringify(last));
}
async function rgba16(bytes) {
  const value = await sharp(bytes).toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return { ...value, samples: new Uint16Array(value.data.buffer, value.data.byteOffset, value.data.byteLength / 2) };
}
async function makeFixture() {
  await Promise.all([profile, modelDirectory, outputDirectory].map(path => mkdir(path)));
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const offset = (y * WIDTH + x) * 3;
    samples[offset] = 12000 + x * 23 + y * 3;
    samples[offset + 1] = 18000 + x * 17 + y * 5;
    samples[offset + 2] = 24000 + x * 11 + y * 7;
  }
  await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).pipelineColourspace('rgb16')
    .toColourspace('rgb16').withMetadata({ exif: { IFD0: { Artist: 'Original synthetic QA fixture' } } }).png().toFile(source);
  originalHash = hash(await readFile(source));
  const catalogue = new Catalog(profile);
  try { catalogue.importPaths([source]); photoId = catalogue.getByPath(source).id; }
  finally { catalogue.close(); }
  const decoded = await rgba16(source);
  for (let channel = 0; channel < 3; channel++) {
    const levels = new Set(Array.from({ length: WIDTH }, (_, x) => decoded.samples[x * 4 + channel]));
    assert.ok(levels.size > 500, 'The fixture itself must have genuine deep precision.');
  }
}

function fakeOllama() {
  return createServer(async (request, response) => {
    try {
      assert.ok(['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress));
      assert.equal(request.headers.authorization, undefined);
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; assert.ok(size < 2 * 1024 * 1024); chunks.push(chunk); }
      const body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      const record = { path, method: request.method, model: body?.model ?? null };
      requests.push(record);
      let data;
      if (path === '/api/version') data = { version: '0.17.1' };
      else if (path === '/api/tags') data = { models: [{ name: MODEL, model: MODEL, size: 1 }] };
      else if (path === '/api/show') {
        assert.equal(body.model, MODEL); assert.equal(body.images, undefined);
        data = { capabilities: ['completion', 'vision'], requires: '0.12.7' };
      } else if (path === '/api/chat') {
        assert.equal(body.model, MODEL); assert.equal(body.stream, false); assert.equal(body.keep_alive, 0);
        assert.deepEqual(body.format, schema);
        assert.ok(body.messages[1].content.includes('mire synthétique'));
        assert.equal(body.apiKey, undefined);
        assert.equal(body.messages[1].images.length, 1);
        const preview = Buffer.from(body.messages[1].images[0], 'base64'), metadata = await sharp(preview).metadata();
        assert.equal(metadata.format, 'jpeg'); assert.ok(metadata.width <= 768 && metadata.height <= 768);
        assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
        record.preview = { width: metadata.width, height: metadata.height, exif: Boolean(metadata.exif) };
        data = { model: MODEL, done: true, done_reason: 'stop', eval_count: 40, eval_duration: 1000000,
          message: { role: 'assistant', content: JSON.stringify(contradictoryRecipe) } };
      } else if (path === '/api/ps') data = { models: [] };
      else throw new Error('Unexpected engine route: ' + path);
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data));
    } catch (error) {
      serverErrors.push(error.message); response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"error":"Synthetic test server rejected request"}');
    }
  });
}
async function listen(instance, port = 0) {
  await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen({ host: '127.0.0.1', port }, () => { instance.removeListener('error', reject); resolve(); }); });
  return instance.address().port;
}
async function closeServer(instance) { if (instance?.listening) await new Promise((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); }
async function settingsHaveNoKeys(page) {
  assert.deepEqual(await page.evaluate(async () => (await window.atelier.getSettings()).keys), { openai: false, gemini: false, claude: false });
}
async function networkGuard() {
  await application.evaluate(({ session, shell }) => {
    globalThis.__localAIQA = { external: [] };
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => {
      const url = new URL(details.url), local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (!local) globalThis.__localAIQA.external.push({ source: 'chromium', host: url.hostname });
      done({ cancel: !local });
    });
    shell.openExternal = async url => { globalThis.__localAIQA.external.push({ source: 'shell', url }); throw new Error('External launch forbidden in isolated QA.'); };
    const net = process.getBuiltinModule('net'), connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...arguments_) {
      const args = Array.isArray(arguments_[0]) ? arguments_[0] : arguments_;
      const options = args[0];
      const host = options && typeof options === 'object' ? options.host ?? options.hostname : typeof args[1] === 'string' ? args[1] : null;
      if (host && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
        globalThis.__localAIQA.external.push({ source: 'node', host });
        throw new Error('External TCP connection forbidden in isolated QA.');
      }
      return connect.apply(this, arguments_);
    };
  });
}
async function stubDirectory(path) {
  await application.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (!options.properties?.includes('openDirectory')) throw new Error('Expected a directory dialog.');
      return { canceled: false, filePaths: [directory] };
    };
  }, path);
}
async function dismissToast(page) {
  const close = page.getByRole('button', { name: 'Fermer la notification', exact: true });
  if (await close.count()) await close.click();
}

try {
  await makeFixture();
  if (fixtureOnly) {
    assert.equal((await sharp(source).metadata()).depth, 'ushort');
    assert.equal(hash(await readFile(source)), originalHash);
    console.log('Fixture verified: original PNG16, >500 measured levels/channel, private catalogue, complete synthetic recipe. No socket or GUI launched.');
  } else {
    // Obtain an unused loopback port, then close it so the first UI check sees a
    // genuinely absent service. This never contacts an installed Ollama instance.
    stage = 'reserve private loopback port';
    server = fakeOllama(); const port = await listen(server); await closeServer(server);
    const endpoint = `http://127.0.0.1:${port}/`;
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ language: 'fr', provider: 'openai' }));
    const env = { ...process.env, ATELIER_TEST_DATA: profile };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[key];
    const { _electron } = await import('playwright');
    stage = 'launch isolated Electron profile';
    application = await _electron.launch({ executablePath: packagedExecutable || require('electron'), args: packagedExecutable ? [] : [root], cwd: root, env, timeout: 30_000 });
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile);
    await networkGuard();
    const page = await application.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.getByTestId('photo-card').first().waitFor({ timeout: 30_000 });
    await settingsHaveNoKeys(page);

    stage = 'local provider and hardware UI';
    await page.getByRole('button', { name: 'Réglages IA', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'IA locale', exact: true }).click();
    const panel = dialog.getByTestId('local-ai-panel'); await panel.waitFor();
    assert.equal(await panel.getByText('Aucune clé API nécessaire.', { exact: true }).count(), 1);
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    await panel.getByLabel('Adresse du moteur local', { exact: true }).fill(endpoint);
    await stubDirectory(modelDirectory);
    await panel.getByRole('button', { name: 'Choisir le dossier des modèles', exact: true }).click();
    await panel.getByRole('button', { name: 'Vérifier cet ordinateur', exact: true }).click();
    const recommendations = panel.getByRole('region', { name: 'Modèles conseillés pour cet ordinateur', exact: true });
    await eventually(() => recommendations.locator('article').count(), count => count === 3, 'The three model profiles were not rendered.');
    const diagnostic = panel.getByRole('region', { name: 'Diagnostic local', exact: true });
    const measurements = await diagnostic.locator('dl').evaluate(element => Object.fromEntries([...element.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling?.textContent])));
    for (const key of ['Système', 'Version du système', 'Architecture', 'Processeur', 'Mémoire vive', 'Mémoire libre mesurée', 'Carte graphique', 'Espace disponible']) assert.ok(measurements[key], `${key} must be shown`);
    const actualHardware = await page.evaluate(options => window.atelier.localHardware(options), { modelsDirectory: modelDirectory });
    assert.equal(measurements['Version du système'], actualHardware.osVersion || 'Information indisponible');
    assert.equal(measurements.Architecture, actualHardware.arch);
    if (Number.isFinite(actualHardware.memory.totalBytes)) {
      const expectedRAM = new Intl.NumberFormat('fr', { maximumFractionDigits: 1 }).format(actualHardware.memory.totalBytes / 1e9) + ' GB';
      assert.equal(measurements['Mémoire vive'], expectedRAM, 'The UI must show measured RAM, not an invented preset.');
    }
    assert.ok(measurements['Dossier des modèles'].includes(modelDirectory));
    const profileNames = await recommendations.locator('article strong').allTextContents();
    assert.deepEqual(profileNames, ['Qwen3-VL Instruct 2B', 'Qwen3-VL Instruct 4B', 'Qwen3-VL Instruct 8B']);
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: join(screenshotDirectory, 'local-ai-hardware.png') });

    stage = 'honest absent-service message';
    await panel.getByRole('button', { name: 'Détecter les modèles', exact: true }).click();
    await panel.getByText('Le service local ne répond pas. Ouvrez Ollama, puis réessayez.', { exact: true }).waitFor();
    assert.equal(await panel.getByText('Service local disponible', { exact: true }).count(), 0);
    assert.equal(requests.length, 0); await settingsHaveNoKeys(page);
    await page.screenshot({ path: join(screenshotDirectory, 'local-ai-service-absent.png') });

    stage = 'simulated Ollama discovery and settings save';
    await listen(server, port);
    await panel.getByRole('button', { name: 'Détecter les modèles', exact: true }).click();
    await panel.getByText('Service local disponible', { exact: true }).waitFor();
    await panel.getByLabel('Modèle d’analyse local', { exact: true }).selectOption(MODEL);
    await dialog.locator('footer').getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const settings = await page.evaluate(() => window.atelier.getSettings());
    assert.equal(settings.provider, 'local'); assert.equal(settings.localAI.model, MODEL); assert.equal(settings.localAI.ollamaURL, endpoint);
    await settingsHaveNoKeys(page); await dismissToast(page);

    stage = 'real IPC analysis, proposal and apply';
    await page.getByTestId('photo-card').first().dblclick();
    await page.locator('.base-image').waitFor({ state: 'visible' });
    const faces = await page.evaluate(id => window.atelier.detectFaces(id), photoId);
    assert.equal(faces.faces.length, 0, 'The actual local face detector must find no person in this synthetic gradient.');
    await page.getByRole('button', { name: 'Assistant IA', exact: true }).click();
    await page.getByRole('button', { name: 'Proposer des réglages', exact: true }).click();
    await page.getByLabel('Consigne de retouche IA', { exact: true }).fill('Éclaircis légèrement cette mire synthétique et conserve sa précision.');
    await page.getByRole('button', { name: 'Analyser cette photo', exact: true }).click();
    await page.locator('.ai-result').getByText(explanation, { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal((await page.evaluate(id => window.atelier.getPhoto(id), photoId)).adjustments.exposure ?? 0, 0, 'A proposal must wait for Apply.');
    await page.screenshot({ path: join(screenshotDirectory, 'local-ai-proposal.png') });
    await page.getByRole('button', { name: 'Appliquer les réglages', exact: true }).click();
    await eventually(() => page.evaluate(id => window.atelier.getPhoto(id), photoId), item => item.adjustments.exposure === EXPOSURE, 'The local proposal was not applied.');
    const applied = await page.evaluate(id => window.atelier.getPhoto(id), photoId);
    for (const [key, expected] of Object.entries({ rotation: 0, cropRatio: 0, cropX: 0.5, cropY: 0.5, flipHorizontal: false })) assert.equal(applied.adjustments[key], expected, `Local analysis changed the manual composition: ${key}`);
    for (const key of portraitControls) assert.equal(applied.adjustments[key], 0, `No-face analysis left a portrait adjustment active: ${key}`);
    await settingsHaveNoKeys(page);

    stage = 'real IPC/UI PNG16 export';
    await stubDirectory(outputDirectory);
    await page.getByRole('button', { name: 'Exporter', exact: true }).click();
    const exporting = page.getByRole('dialog');
    await exporting.getByRole('button', { name: 'PNG', exact: true }).click();
    assert.equal(await exporting.getByLabel('Profondeur de couleur', { exact: true }).inputValue(), '16');
    assert.equal(await exporting.getByLabel('Dimensions', { exact: true }).inputValue(), '');
    await exporting.getByRole('button', { name: 'Choisir le dossier et exporter', exact: true }).click();
    const files = await eventually(() => readdir(outputDirectory), names => names.some(name => name.endsWith('.png')), 'The PNG16 export did not appear.');
    const exported = join(outputDirectory, files.find(name => name.endsWith('.png')));
    await eventually(() => page.locator('.toast').textContent().catch(() => ''), value => value?.includes('1 photo(s) exportée(s)'), 'Export completion was not confirmed.');
    const metadata = await sharp(exported).metadata();
    assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.width, WIDTH); assert.equal(metadata.height, HEIGHT);
    const pixels = await rgba16(exported), original = await rgba16(source);
    assert.ok(!pixels.data.equals(original.data), 'The exported image must actually reflect the applied proposal.');
    const levelsPerChannel = Array.from({ length: 3 }, (_, channel) => new Set(Array.from({ length: WIDTH }, (_, x) => pixels.samples[x * 4 + channel])).size);
    for (let channel = 0; channel < 3; channel++) assert.ok(levelsPerChannel[channel] > 500, `Export channel ${channel} lost 16-bit levels.`);
    const expected = await rgba16(await renderImage(source, recipe.adjustments, { format: 'png', bitDepth: 16 }));
    assert.ok(pixels.data.equals(expected.data), 'The real IPC export must match the proposed absolute adjustments.');
    const sourceHashAfter = hash(await readFile(source));
    assert.equal(sourceHashAfter, originalHash);
    assert.equal((await readdir(modelDirectory)).length, 0, 'No model must have been downloaded.');
    assert.deepEqual(serverErrors, []); assert.deepEqual(pageErrors, []);
    assert.deepEqual(await application.evaluate(() => globalThis.__localAIQA.external), []);
    assert.equal(requests.filter(record => record.path === '/api/chat').length, 1);
    assert.ok(requests.every(record => ['/api/version', '/api/tags', '/api/show', '/api/chat', '/api/ps'].includes(record.path)));
    await settingsHaveNoKeys(page);
    const vault = await readFile(join(profile, 'keys.encrypted.json'), 'utf8').catch(error => error.code === 'ENOENT' ? '{}' : Promise.reject(error));
    assert.deepEqual(JSON.parse(vault), {});
    await writeFile(join(screenshotDirectory, 'local-ai-proof.json'), JSON.stringify({
      mode: packagedExecutable ? 'packaged' : 'source', syntheticFixture: true, simulatedOllama: true,
      source: { width: WIDTH, height: HEIGHT, sha256Before: originalHash, sha256After: sourceHashAfter },
      rawModelGeometry: { rotation: contradictoryRecipe.adjustments.rotation, cropRatio: contradictoryRecipe.adjustments.cropRatio, flipHorizontal: contradictoryRecipe.adjustments.flipHorizontal },
      appliedGeometry: Object.fromEntries(['rotation', 'cropRatio', 'cropX', 'cropY', 'flipHorizontal'].map(key => [key, applied.adjustments[key]])),
      detectedFaces: faces.faces.length, portraitControls: Object.fromEntries(portraitControls.map(key => [key, applied.adjustments[key]])),
      output: { width: metadata.width, height: metadata.height, depth: metadata.depth, sampledLevelsPerChannel: levelsPerChannel, exactEngineOracle: true },
      cloudKeysPresent: false, externalConnectionAttempts: 0, downloadedModels: 0, requests: requests.map(record => record.path),
    }, null, 2) + '\n');
    console.log('PASS: isolated local provider without keys; real hardware/OS UI and three profiles; honest absent service; contradictory geometry suppressed and no-face portraits neutralized; PNG16 ' + levelsPerChannel.join('/') + ' levels/channel; original SHA-256 unchanged; no downloads or external connections.');
  }
} catch (error) {
  if (application) try { await mkdir(screenshotDirectory, { recursive: true }); await (await application.firstWindow()).screenshot({ path: join(screenshotDirectory, 'local-ai-failure.png') }); } catch { /* Preserve the original failure. */ }
  error.message = `[${stage}] ${error.message}`; throw error;
} finally {
  try { if (application) await application.close(); }
  finally { try { await closeServer(server); } finally { await rm(temporary, { recursive: true, force: true }); } }
}
