/**
 * Run with desktop access, from AtelierPhoto:
 *   npm run build && node Tests/project-roundtrip-electron.mjs
 * Packaged app, with the same two private test profiles:
 *   ATELIER_PACKAGED_EXE='/absolute/path/to/Atelier Photo.app/Contents/MacOS/Atelier Photo' node Tests/project-roundtrip-electron.mjs
 * Fixtures/reference only, without launching any GUI:
 *   node Tests/project-roundtrip-electron.mjs --check-fixtures
 * Uses two fresh private profiles, original synthetic PNG16/.cube fixtures, real IPC,
 * UI controls and native-dialog stubs. Never reads the user's app profile or API keys.
 */
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { normalizeAdjustments, renderImage } from '../desktop/image-engine.mjs';
import { parseCube } from '../desktop/preset-import.mjs';
import { Catalog } from '../desktop/catalog.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'atelier-project-roundtrip-')));
const fixtureOnly = process.argv.includes('--check-fixtures');
const packagedExecutable = process.env.ATELIER_PACKAGED_EXE;
const WIDTH = 512, HEIGHT = 64, SAVED_EXPOSURE = 0.47;
const SAVE_TITLE = 'Enregistrer les références et réglages du catalogue';
const OPEN_TITLE = 'Ouvrir un projet';
const LUT_TITLE = 'QA Original Bleu Cuivre';
const pageErrors = [];
let application, stage = 'initialisation';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const shaJSON = value => sha(JSON.stringify(value));
const jsonFile = async path => JSON.parse(await readFile(path, 'utf8'));
const delay = duration => new Promise(resolve => setTimeout(resolve, duration));

async function eventually(read, predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await delay(40);
  }
  assert.fail(`${message}; dernière valeur : ${JSON.stringify(last)}`);
}
async function pixels16(bytes) {
  return sharp(bytes).pipelineColourspace('rgb16').toColourspace('rgb16').removeAlpha()
    .raw({ depth: 'ushort' }).toBuffer();
}
async function affineOracle(source, exposure) {
  const sourcePixels = await sharp(source).autoOrient().pipelineColourspace('rgb16').toColourspace('rgb16')
    .ensureAlpha().raw({ depth: 'ushort' }).toBuffer();
  const original = new Uint16Array(sourcePixels.buffer, sourcePixels.byteOffset, sourcePixels.length / 2);
  const gain = 2 ** exposure;
  const exposed = await sharp(original, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .pipelineColourspace('rgb16').linear([gain, gain, gain, 1], [0, 0, 0, 0])
    .toColourspace('rgb16').raw({ depth: 'ushort' }).toBuffer();
  const values = new Uint16Array(exposed.buffer, exposed.byteOffset, exposed.length / 2);
  const expected = new Uint16Array(values.length);
  // Direct affine calculation, without parseCube, validateColorLUT or LUT interpolation.
  for (let i = 0; i < values.length; i += 4) {
    expected[i] = Math.round(.05 * 65535 + .6 * values[i + 2]);
    expected[i + 1] = Math.round(.1 * 65535 + .75 * values[i + 1]);
    expected[i + 2] = Math.round(.1 * 65535 + .7 * values[i]);
    expected[i + 3] = values[i + 3];
  }
  // Encode the independent pixels using the same declared output colour profile.
  // ICC conversion does not commute with a channel-mixing LUT applied after export.
  return sharp(expected, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .pipelineColourspace('rgb16').withIccProfile('srgb').toColourspace('rgb16').png().toBuffer();
}
async function assertReference(source, adjustments, lut, exportedBytes) {
  const expected = await renderImage(source, adjustments, { format: 'png', bitDepth: 16, quality: 92, lut });
  const exposed = await renderImage(source, { ...adjustments, lutId: undefined, lutIntensity: undefined }, { format: 'png', bitDepth: 16 });
  const independent = await affineOracle(source, adjustments.exposure);
  const [actual, reference, plain, independentPixels] = await Promise.all([
    pixels16(exportedBytes ?? expected), pixels16(expected), pixels16(exposed), pixels16(independent),
  ]);
  assert.deepEqual(actual, reference, 'L’export IPC doit correspondre exactement au rendu du moteur avec la LUT embarquée.');
  assert.notDeepEqual(actual, plain, 'Une LUT manquante ou ignorée ne doit pas produire silencieusement un rendu sans style.');
  const samples = new Uint16Array(actual.buffer, actual.byteOffset, actual.length / 2);
  const wantedSamples = new Uint16Array(independentPixels.buffer, independentPixels.byteOffset, independentPixels.length / 2);
  // Independent affine oracle for this invented cube: R=.05+.6B, G=.1+.75G, B=.1+.7R.
  let maximumDifference = 0, maximumAt = null;
  for (let i = 0; i < samples.length; i += 3) {
    const wanted = [...wantedSamples.subarray(i, i + 3)];
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(samples[i + channel] - wanted[channel]);
      if (difference > maximumDifference) { maximumDifference = difference; maximumAt = { pixel: i / 3, channel, actual: [...samples.subarray(i, i + 3)], wanted }; }
    }
  }
  assert.ok(maximumDifference <= 2, `La couleur doit suivre la transformation indépendante de la LUT (écart ${maximumDifference}/65535) : ${JSON.stringify(maximumAt)}.`);
  assert.ok(new Set(Array.from({ length: WIDTH }, (_, x) => samples[x * 3 + 2])).size > 256, 'Le dégradé exporté doit conserver plus de 256 niveaux.');
  assert.ok(samples.some(sample => sample % 257 !== 0), 'Le PNG16 doit contenir des valeurs autres qu’un simple rééchelonnement 8 bits.');
  return { maximumDifference, expected };
}

async function createFixtures() {
  const sources = join(temporary, 'sources');
  await mkdir(sources);
  const source = join(sources, 'photo-originale-synthetique.png');
  const cube = join(sources, 'bleu-cuivre-original.cube');
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const offset = (y * WIDTH + x) * 3;
    samples[offset] = 1000 + Math.round(x / (WIDTH - 1) * 40000);
    samples[offset + 1] = 2000 + Math.round(y / (HEIGHT - 1) * 35000);
    samples[offset + 2] = 8000 + Math.round(((x * 13 + y * 19) % 509) / 508 * 30000);
  }
  await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .pipelineColourspace('rgb16').toColourspace('rgb16')
    .withMetadata({ exif: { IFD0: { Artist: 'Mire originale de test Atelier Photo' } } }).png().toFile(source);
  const lines = [`TITLE "${LUT_TITLE}"`, '# Original synthetic affine test cube; red changes fastest.',
    'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) {
    lines.push([.05 + .6 * b, .1 + .75 * g, .1 + .7 * r].map(value => value.toFixed(6)).join(' '));
  }
  const text = `${lines.join('\n')}\n`;
  await writeFile(cube, text);
  const originalHashes = new Map([[source, sha(await readFile(source))], [cube, sha(await readFile(cube))]]);
  return { source, cube, text, lut: parseCube(text), lutId: sha(text), originalHashes };
}
async function originalsIntact(fixture) {
  for (const [path, digest] of fixture.originalHashes) assert.equal(sha(await readFile(path)), digest, 'Les fichiers originaux inventés doivent rester inchangés.');
}
async function launchProfile(profile) {
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ language: 'fr' }));
  const env = { ...process.env, ATELIER_TEST_DATA: profile };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY']) delete env[name];
  const { _electron } = await import('playwright');
  application = await _electron.launch({ executablePath: packagedExecutable || require('electron'), args: packagedExecutable ? [] : [root], cwd: root, env, timeout: 30000 });
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), profile, 'Le profil personnel ne doit jamais être utilisé.');
  await application.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => done({ cancel: true }));
  });
  const page = await application.firstWindow();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.waitForSelector('.app');
  assert.deepEqual(await page.evaluate(async () => (await window.atelier.getSettings()).keys), { openai: false, gemini: false, claude: false });
  assert.equal(await page.evaluate(async () => (await window.atelier.counts()).all), 0);
  return page;
}
async function stubOpen(paths, expected) {
  await application.evaluate(({ dialog }, { paths, expected }) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (expected === 'directory' && !options.properties?.includes('openDirectory')) throw new Error('Dialogue de dossier attendu.');
      if (expected !== 'directory' && !options.filters?.some(filter => filter.extensions?.includes(expected))) throw new Error(`Filtre natif ${expected} attendu.`);
      return { canceled: false, filePaths: paths };
    };
  }, { paths, expected });
}
async function dismissToast(page) {
  const close = page.getByRole('button', { name: 'Fermer la notification', exact: true });
  if (await close.count()) await close.click();
}
async function item(page, id) {
  return page.evaluate(id => window.atelier.getPhoto(id), id);
}
async function assertInspector(page, expected) {
  assert.equal(Number(await page.getByLabel('Valeur Exposition', { exact: true }).inputValue()), expected.exposure);
  assert.equal(Number(await page.getByLabel('Valeur Saturation', { exact: true }).inputValue()), expected.saturation);
  const intensity = page.getByLabel('Valeur Intensité LUT', { exact: true });
  if (expected.lutId) assert.equal(Number(await intensity.inputValue()), expected.lutIntensity);
  else assert.equal(await intensity.count(), 0);
}
async function assertRestoredFor(page, id, expected, duration = 1200) {
  await eventually(() => item(page, id), row => isDeepStrictEqual(row.adjustments,expected), 'Le catalogue n’a pas restauré les réglages du projet.');
  await eventually(() => page.evaluate(expected => {
    const exposure = document.querySelector('input[aria-label="Valeur Exposition"]');
    const saturation = document.querySelector('input[aria-label="Valeur Saturation"]');
    const lut = document.querySelector('input[aria-label="Valeur Intensité LUT"]');
    return exposure && saturation && Number(exposure.value) === expected.exposure && Number(saturation.value) === expected.saturation
      && (expected.lutId ? lut && Number(lut.value) === expected.lutIntensity : !lut);
  }, expected), Boolean, 'L’inspecteur doit refléter le projet restauré avant le contrôle de stabilité.');
  const until = Date.now() + duration;
  do {
    assert.deepEqual((await item(page, id)).adjustments, expected, 'Une ancienne sauvegarde automatique a écrasé le projet restauré.');
    await assertInspector(page, expected);
    await delay(50);
  } while (Date.now() < until);
}
async function quickEditAndClick(page, exposure, title) {
  await page.getByLabel('Valeur Exposition', { exact: true }).fill(String(exposure));
  // DOM click runs the real React action immediately, without Playwright's stability
  // delay. It exercises the 180ms pending-save window rather than waiting it away.
  await page.getByTitle(title, { exact: true }).evaluate(button => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    button.click();
  });
}
async function closeAndCheckProfile(profile, fixture, expected) {
  await application.close(); application = null;
  const catalog = new Catalog(profile);
  try {
    const stored = catalog.getByPath(fixture.source);
    assert.deepEqual(stored.adjustments, expected, 'Les réglages doivent rester corrects dans SQLite après fermeture.');
  } finally { catalog.close(); }
  await assert.rejects(access(join(profile, 'keys.encrypted.json')), { code: 'ENOENT' });
  await originalsIntact(fixture);
}

try {
  const fixture = await createFixtures();
  const preliminary = normalizeAdjustments({ exposure: SAVED_EXPOSURE, lutId: fixture.lutId, lutIntensity: 1 });
  const oracle = await assertReference(fixture.source, preliminary, fixture.lut);
  if (fixtureOnly) {
    await originalsIntact(fixture);
    console.log(`Fixtures originales et oracle couleur indépendants validés : PNG16 >256 niveaux, LUT 2³, écart ${oracle.maximumDifference}/65535. Aucune interface lancée.`);
  } else {
    await access(packagedExecutable || join(root, 'dist/index.html'));
    const profileA = join(temporary, 'profile-A'), profileB = join(temporary, 'profile-B');
    const project = join(temporary, 'projet-v2.atelier');
    stage = 'profil A : import de la photo et de la LUT';
    let page = await launchProfile(profileA);
    await stubOpen([fixture.source], 'png');
    await page.getByRole('button', { name: 'Importer', exact: true }).click();
    await page.getByTestId('photo-card').waitFor();
    await page.getByTestId('photo-card').dblclick();
    await page.getByLabel('Valeur Exposition', { exact: true }).waitFor();
    await page.locator('.preset-browse-link').click();
    await page.getByRole('dialog', { name: 'Styles & préréglages', exact: true }).waitFor();
    await stubOpen([fixture.cube], 'cube');
    await page.getByRole('button', { name: 'Importer XMP / LUT', exact: true }).click();
    const preset = await eventually(() => page.evaluate(() => window.atelier.presets()),
      rows => rows.some(row => row.name === LUT_TITLE), 'La LUT inventée n’a pas été importée.');
    assert.equal(preset.find(row => row.name === LUT_TITLE).adjustments.lutId, fixture.lutId);
    await page.getByPlaceholder('Rechercher un style…', { exact: true }).fill(LUT_TITLE);
    await page.locator('.style-apply').filter({ hasText: LUT_TITLE }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const idA = (await page.evaluate(() => window.atelier.list({ limit: 1 }))).items[0].id;
    await eventually(() => item(page, idA), row => row.adjustments.lutId === fixture.lutId, 'Le préréglage n’a pas été appliqué.');
    await dismissToast(page);

    stage = 'profil A : clic Enregistrer pendant une modification non encore autosauvegardée';
    await application.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, project.slice(0, -'.atelier'.length));
    await quickEditAndClick(page, SAVED_EXPOSURE, SAVE_TITLE);
    const saved = await eventually(() => jsonFile(project).catch(() => null), value => value?.version === 2, 'Le projet v2 n’a pas été créé.');
    assert.equal(saved.photos.length, 1);
    assert.equal(saved.photos[0].path, fixture.source);
    assert.equal(saved.photos[0].adjustments.exposure, SAVED_EXPOSURE, 'Enregistrer doit vider l’édition courante avant de lire le catalogue.');
    assert.equal(saved.photos[0].adjustments.lutId, fixture.lutId);
    assert.equal(saved.photos[0].adjustments.lutIntensity, 1);
    assert.deepEqual(saved.photos[0].adjustments, preliminary);
    const savedAdjustments = saved.photos[0].adjustments;
    const asset = saved.luts[fixture.lutId];
    assert.ok(asset?.data); assert.equal(shaJSON(asset.data), asset.sha256);
    assert.deepEqual(asset.data, fixture.lut);
    await assertInspector(page, savedAdjustments);

    stage = 'profil A : réouverture sur la photo active, anciennes autosauvegardes';
    await stubOpen([project], 'atelier');
    await quickEditAndClick(page, -1.13, OPEN_TITLE);
    await eventually(() => page.locator('.toast').textContent().catch(() => ''), text => text?.includes('références de projet ouvertes'), 'L’action Ouvrir ne s’est pas terminée.');
    await assertRestoredFor(page, idA, savedAdjustments);
    await closeAndCheckProfile(profileA, fixture, savedAdjustments);
    console.log('Profil A : import photo/LUT natif, préréglage, enregistrement immédiat v2 et restauration inspecteur/catalogue stables après 1,2 s : validés.');

    stage = 'profil B : projet portable dans un profil neuf sans LUT';
    page = await launchProfile(profileB);
    assert.deepEqual(await readdir(join(profileB, 'luts')), []);
    assert.deepEqual(await page.evaluate(() => window.atelier.presets()), []);
    await stubOpen([project], 'atelier');
    await page.getByTitle(OPEN_TITLE, { exact: true }).click();
    await page.getByTestId('photo-card').waitFor();
    await page.getByTestId('photo-card').dblclick();
    const idB = (await page.evaluate(() => window.atelier.list({ limit: 1 }))).items[0].id;
    const transferred = await jsonFile(join(profileB, 'luts', `${fixture.lutId}.json`));
    assert.equal(shaJSON(transferred), asset.sha256, 'La LUT embarquée doit être recopiée dans le profil neuf avec son contenu exact.');
    assert.deepEqual(transferred, asset.data);
    await assertRestoredFor(page, idB, savedAdjustments, 500);

    stage = 'profil B : export PNG16 réel avec la LUT transférée';
    const exports = join(temporary, 'exports'); await mkdir(exports);
    await dismissToast(page); await stubOpen([exports], 'directory');
    await page.getByRole('button', { name: 'Exporter', exact: true }).click();
    const exportDialog = page.getByRole('dialog'); await exportDialog.waitFor();
    await exportDialog.getByRole('button', { name: 'PNG', exact: true }).click();
    await exportDialog.getByLabel('Profondeur de couleur', { exact: true }).selectOption('16');
    await exportDialog.getByLabel('Dimensions', { exact: true }).selectOption('');
    await exportDialog.getByRole('checkbox', { name: 'Ajouter un filigrane', exact: true }).uncheck();
    await exportDialog.getByRole('button', { name: 'Choisir le dossier et exporter', exact: true }).click();
    const files = await eventually(() => readdir(exports), files => files.length > 0, 'L’export n’a pas créé de fichier.');
    assert.equal(files.length, 1); assert.match(files[0], /\.png$/);
    await eventually(() => page.locator('.toast').textContent().catch(() => ''), text => text?.includes('1 photo(s) exportée(s)'), 'L’export n’est pas terminé.');
    const exported = await readFile(join(exports, files[0]));
    const metadata = await sharp(exported).metadata();
    assert.equal(metadata.width, WIDTH); assert.equal(metadata.height, HEIGHT);
    assert.equal(metadata.format, 'png'); assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.bitsPerSample, 16);
    await assertReference(fixture.source, savedAdjustments, asset.data, exported);
    console.log('Profil B : LUT absente avant ouverture, copie et SHA-256 exacts, export PNG16 réel identique au moteur et à l’oracle couleur indépendant : validés.');

    stage = 'profil B : rejet d’une LUT embarquée altérée';
    const corrupt = structuredClone(saved);
    corrupt.luts[fixture.lutId].data.values[0] += .02; // Valid cube values, stale content digest.
    const corruptPath = join(temporary, 'projet-corrompu.atelier');
    await writeFile(corruptPath, JSON.stringify(corrupt));
    await dismissToast(page); await stubOpen([corruptPath], 'atelier');
    await page.getByTitle(OPEN_TITLE, { exact: true }).click();
    await eventually(() => page.locator('.toast.error').textContent().catch(() => ''), text => /LUT.*endommagée/.test(text ?? ''), 'La LUT dont le SHA-256 ne correspond plus doit être refusée.');
    await assertRestoredFor(page, idB, savedAdjustments, 400);
    assert.equal(shaJSON(await jsonFile(join(profileB, 'luts', `${fixture.lutId}.json`))), asset.sha256);

    stage = 'profil B : compatibilité d’un projet version 1';
    const legacyAdjustments = normalizeAdjustments({ exposure: -.22, saturation: .74, contrast: 1.1 });
    const legacy = { version: 1, photos: [{ path: fixture.source, adjustments: legacyAdjustments, rating: 2, picked: true }] };
    const legacyPath = join(temporary, 'projet-v1.atelier'); await writeFile(legacyPath, JSON.stringify(legacy));
    await dismissToast(page); await stubOpen([legacyPath], 'atelier');
    await page.getByTitle(OPEN_TITLE, { exact: true }).click();
    await eventually(() => page.locator('.toast').textContent().catch(() => ''), text => text?.includes('références de projet ouvertes'), 'Le projet version 1 doit rester lisible.');
    await assertRestoredFor(page, idB, legacyAdjustments, 500);
    const legacyItem = await item(page, idB);
    assert.equal(legacyItem.rating, 2); assert.equal(legacyItem.picked, true); assert.equal(legacyItem.adjustments.lutId, undefined);
    assert.equal((await page.evaluate(() => window.atelier.counts())).all, 1);
    await closeAndCheckProfile(profileB, fixture, legacyAdjustments);
    assert.deepEqual(pageErrors, [], 'Aucune erreur JavaScript renderer ne doit accompagner le scénario.');
    console.log('LUT corrompue refusée sans écraser le profil, version 1 restaurée, originaux intacts, aucune clé créée : validés.');
    console.log('Projets/LUT : scénario complet réussi. Les deux profils et tous les fichiers inventés sont supprimés. Aucun appel IA.');
  }
} catch (error) {
  console.error(`Échec du scénario projets/LUT — ${stage}.`);
  throw error;
} finally {
  try { await application?.close(); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
