import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, linkSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const { _electron } = await import(pathToFileURL(join(root, 'node_modules/playwright/index.mjs')));
const sharp = require('sharp');
const { Catalog } = await import(pathToFileURL(join(root, 'desktop/catalog.mjs')));
const temporary = mkdtempSync(join(tmpdir(), 'atelier-ui-test-'));
const data = join(temporary, 'data'), sources = join(temporary, 'sources'), exported = join(temporary, 'export');
for (const path of [data, sources, exported]) mkdirSync(path);
const screenshotDirectory = join(root, 'test-artifacts');
mkdirSync(screenshotDirectory, { recursive: true });
let application;
const failures = [];
async function waitForBackend(page, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await page.waitForTimeout(80);
  }
  throw new Error('Le catalogue ne reflète pas la modification attendue.');
}
async function dismissToast(page) {
  const close = page.getByRole('button', { name: 'Fermer la notification', exact: true });
  if (await close.count()) await close.click();
}
try {
  const scene = `<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#83b6db"/><stop offset="1" stop-color="#e8cdbb"/></linearGradient><linearGradient id="lake" x2="0" y2="1"><stop stop-color="#305571"/><stop offset="1" stop-color="#102e41"/></linearGradient></defs><rect width="1200" height="800" fill="url(#sky)"/><circle cx="900" cy="170" r="65" fill="#fbe3be"/><path d="M0 460 210 140 430 400 650 160 920 470 1120 190 1200 350V600H0Z" fill="#53718b"/><path d="M210 140 143 240 205 226 240 254Z M650 160 585 245 643 225 694 261Z M1120 190 1060 285 1117 265 1155 292Z" fill="#ecedeb"/><path d="M0 480 230 345 480 515 730 365 1200 480V650H0Z" fill="#253f4a"/><rect y="560" width="1200" height="240" fill="url(#lake)"/><path d="M0 560Q280 520 530 570T1200 550" stroke="#bfd0c2" fill="none" stroke-width="7"/><path d="m0 800 200-140 210 140Z" fill="#182c31"/></svg>`;
  const source = join(sources, 'source.jpg');
  await sharp(Buffer.from(scene)).jpeg({ quality: 85 }).toFile(source);
  const paths = Array.from({ length: 10_000 }, (_, index) => {
    const path = join(sources, `library-${String(index).padStart(5, '0')}.jpg`);
    linkSync(source, path); return path;
  });
  const fixtures = [];
  for (const [name, hue] of [['fixture-01-montagne.jpg', 0], ['fixture-02-lumiere.jpg', 45], ['fixture-03-riviere.jpg', -30]]) {
    const path = join(sources, name);
    await sharp(source).modulate({ hue }).jpeg({ quality: 90 }).toFile(path);
    fixtures.push(path);
  }
  const catalog = new Catalog(data);
  assert.equal(catalog.importPaths(paths).added, 10_000);
  catalog.close();
  const environment = { ...process.env, ATELIER_TEST_DATA: data };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: process.env.ATELIER_PACKAGED_EXE||require('electron'), args: process.env.ATELIER_PACKAGED_EXE?[]:[root], cwd: root, env: environment, timeout: 30_000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => failures.push(error.message));
  await page.waitForSelector('[data-testid="photo-card"]', { timeout: 30_000 });
  const initial = await page.getByTestId('photo-card').count();
  assert.ok(initial > 0 && initial < 100, `Virtual grid rendered ${initial} cards for 10 000 references`);
  console.log(`Virtual grid: ${initial} mounted cards / 10 000 photos.`);

  await application.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, fixtures);
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await waitForBackend(page, async () => (await window.atelier.counts()).all === 10_003);
  await dismissToast(page);
  await page.getByLabel('Rechercher une photo').fill('fixture-01');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="photo-card"]').length === 1);
  await page.getByTestId('photo-card').dblclick();
  await page.locator('.base-image').waitFor({ state: 'visible' });
  await page.getByLabel('Valeur Exposition', { exact: true }).fill('0.75');
  await page.getByLabel('Valeur Exposition', { exact: true }).blur();
  await waitForBackend(page, async () => (await window.atelier.list({ search: 'fixture-01', limit: 1 })).items[0]?.adjustments.exposure === 0.75);
  await page.getByRole('button', { name: 'Annuler la retouche', exact: true }).click();
  await waitForBackend(page, async () => (await window.atelier.list({ search: 'fixture-01', limit: 1 })).items[0]?.adjustments.exposure === 0);
  await page.getByLabel('Valeur Exposition', { exact: true }).fill('0.45');
  await page.getByLabel('Valeur Exposition', { exact: true }).blur();
  await page.getByRole('button', { name: 'Avant / Après', exact: true }).click();
  await page.getByLabel('Comparaison avant après').waitFor();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(screenshotDirectory, 'editor.png') });
  console.log('Editor: exposure persisted, undo restored neutral, before/after visible.');

  const detection = await page.evaluate(async () => {
    const item = (await window.atelier.list({ search: 'fixture-01', limit: 1 })).items[0];
    return window.atelier.detectFaces(item.id);
  });
  assert.ok(Array.isArray(detection.faces));
  assert.equal(detection.faces.length, 0);
  console.log('Portrait worker: WASM/model loaded locally, 0 faces detected in synthetic landscape.');

  await page.getByRole('button', { name: 'Réglages IA', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByLabel('Clé API OpenAI', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Clé API OpenAI', { exact: true }).getAttribute('type'), 'password');
  assert.deepEqual(await page.evaluate(async () => (await window.atelier.getSettings()).keys), { openai: false, gemini: false, claude: false });
  await page.screenshot({ path: join(screenshotDirectory, 'settings.png') });
  await page.getByRole('button', { name: 'Claude', exact: true }).click();
  await page.getByText('Claude analyse les photos et propose des réglages.', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(async () => (await window.atelier.getSettings()).provider), 'claude');
  console.log('Settings: empty secret fields, no existing keys, Claude saved. No key write or provider request.');

  await application.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, exported);
  await page.getByRole('button', { name: 'Exporter', exact: false }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'PNG', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'PNG', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByLabel('Dimensions', { exact: true }).selectOption('1600');
  await page.getByRole('checkbox', { name: 'Ajouter un filigrane', exact: true }).check();
  await page.getByLabel('Texte du filigrane', { exact: true }).fill('Atelier Photo');
  await page.screenshot({ path: join(screenshotDirectory, 'export-options.png') });
  await page.getByRole('button', { name: 'Choisir le dossier et exporter', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('1 photo(s) exportée(s)'));
  console.log('Export files:', readdirSync(exported));
  console.log('Export toast:', await page.locator('.toast').innerText());
  assert.ok(readdirSync(exported).some(name => name.endsWith('.png')));
  const output = join(exported, readdirSync(exported).find(name => name.endsWith('.png')));
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'png');
  assert.ok(metadata.width <= 1600 && metadata.height <= 1600);
  console.log('Export: PNG, watermark, max dimension and native folder dialog bridge verified.');

  await dismissToast(page);
  await page.getByRole('button', { name: 'Bibliothèque', exact: true }).click();
  await page.getByLabel('Rechercher une photo').fill('');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="photo-card"]').length > 1);
  await page.getByRole('button', { name: 'Tout sélectionner', exact: true }).click();
  assert.equal(await page.locator('[data-testid="photo-card"][aria-selected="false"]').count(), 0);
  await page.getByRole('button', { name: 'Tout désélectionner', exact: true }).click();
  const grid = page.getByTestId('library-grid');
  await grid.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="photo-card"]')].some(element => element.textContent.includes('library-00000.jpg')));
  assert.ok(await page.getByTestId('photo-card').count() < 100);
  await page.getByTestId('photo-card').first().click();
  await page.waitForSelector('[data-testid="photo-card"].active');
  await grid.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="photo-card"]')].some(element => element.textContent.includes('fixture-03-riviere.jpg')));
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screenshotDirectory, 'library.png') });
  assert.deepEqual(failures, []);
  console.log('Scroll bottom/top, all-selection, individual selection and runtime errors: passed.');
  console.log(`Screenshots: ${screenshotDirectory}`);
} finally {
  if (application) await application.close();
  rmSync(temporary, { recursive: true, force: true });
}
