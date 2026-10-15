import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Run after npm run build. This uses the real Electron bridge with an isolated catalog.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const { _electron } = await import(pathToFileURL(join(root, 'node_modules/playwright/index.mjs')));
const sharp = require('sharp');
const { Catalog } = await import(pathToFileURL(join(root, 'desktop/catalog.mjs')));
const languages = ['fr', 'nl', 'en', 'es', 'zh', 'ja', 'ar', 'de', 'pt', 'it', 'hi', 'ko'];
const dictionaries = Object.fromEntries(languages.map(code => [code, JSON.parse(readFileSync(join(root, 'locales', `${code}.json`), 'utf8'))]));
const temporary = mkdtempSync(join(tmpdir(), 'atelier-i18n-test-'));
const data = join(temporary, 'catalog');
const screenshots = join(root, 'test-artifacts');
mkdirSync(data);
mkdirSync(screenshots, { recursive: true });
const environment = { ...process.env, ATELIER_TEST_DATA: data };
delete environment.ELECTRON_RUN_AS_NODE;
let application;
let ratedPhotoId;
const errors = [];

async function launch() {
  application = await _electron.launch({ executablePath: process.env.ATELIER_PACKAGED_EXE||require('electron'), args: process.env.ATELIER_PACKAGED_EXE?[]:[root], cwd: root, env: environment, timeout: 30_000 });
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('photo-card').first().waitFor({ timeout: 30_000 });
  return page;
}

async function expectLanguage(page, code) {
  const expected = dictionaries[code];
  await page.waitForFunction(({ code, heading }) => document.documentElement.lang === code && document.querySelector('.toolbar h1')?.textContent === heading, { code, heading: expected['Votre bibliothèque'] });
  assert.equal(await page.locator('.language-select').inputValue(), code);
  assert.equal(await page.locator('.language-select').getAttribute('aria-label'), expected['Langue de l’interface']);
  assert.equal(await page.locator('.header-end button[aria-label]').getAttribute('aria-label'), expected['Réglages IA']);
  assert.equal(await page.locator('html').getAttribute('dir'), code === 'ar' ? 'rtl' : 'ltr');
  assert.equal(await page.locator('.brand-light').textContent(), 'photo', 'The brand must remain Atelier Photo in every language');
  assert.ok((await page.locator('.library-summary').textContent()).includes(expected.photos), `${code}: the composite photo counter must be translated`);
  assert.equal(await application.evaluate(({Menu})=>Menu.getApplicationMenu().items[1].submenu.items[0].label),expected['Annuler la retouche'],`${code}: native Undo menu`);
  const starSuffix = ({ nl: 'ren', de: 'e', it: 'e', ja: '', zh: '', ar: '', hi: '', ko: '' })[code] ?? 's';
  const starLabel = expected[', {0} étoile{1}'].replace('{0}', '2').replace('{1}', starSuffix);
  assert.equal(await page.locator(`[data-photo-id="${ratedPhotoId}"]`).getAttribute('aria-label'), `landscape.jpg${starLabel}`, `${code}: photo names stay intact while ratings are translated`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(async language => (await window.atelier.getSettings()).language === language, code)) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`Backend language not persisted: ${code}`);
}

try {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#91bfd8"/><stop offset="1" stop-color="#25455d"/></linearGradient></defs><rect width="900" height="600" fill="url(#g)"/><circle cx="720" cy="120" r="48" fill="#fce4b8"/><path d="M0 420 220 130 420 390 620 200 900 440V600H0Z" fill="#243f4c"/><path d="m220 130-55 75 58-15 38 34Z" fill="#f1f0e9"/></svg>';
  const files = [];
  for (const name of ['landscape.jpg', 'studio.jpg']) {
    const file = join(temporary, name);
    await sharp(Buffer.from(svg)).jpeg().toFile(file);
    files.push(file);
  }
  const catalog = new Catalog(data);
  catalog.importPaths(files);
  const selected = catalog.getByPath(files[0]);
  ratedPhotoId = selected.id;
  catalog.update(selected.id, { rating: 2 });
  catalog.close();

  let page = await launch();
  await page.getByTestId('photo-card').first().click();
  for (const code of languages) {
    await page.locator('.language-select').selectOption(code);
    await expectLanguage(page, code);
    const expected = dictionaries[code];
    if (['en', 'nl', 'ar'].includes(code)) await page.screenshot({ path: join(screenshots, `i18n-${code}.png`) });

    await page.getByRole('button', { name: expected['Réglages IA'], exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('heading', { name: expected['Votre assistant IA'], exact: true }).waitFor();
    await settings.locator('footer').getByRole('button', { name: expected['Enregistrer'], exact: true }).waitFor();
    const modelLabel = await settings.locator('label').first().textContent();
    assert.ok(modelLabel.includes(expected['Modèle d’analyse ·']), `${code}: analysis-model label was not translated`);
    assert.deepEqual(await page.evaluate(async () => (await window.atelier.getSettings()).keys), { openai: false, gemini: false, claude: false });
    if (code === 'en') await page.screenshot({ path: join(screenshots, 'i18n-en-settings.png') });
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'hidden' });

    await page.getByRole('button', { name: expected['Exporter'], exact: true }).click();
    const exporting = page.getByRole('dialog');
    await exporting.getByRole('heading', { name: expected['Exporter vos photos'], exact: true }).waitFor();
    await exporting.getByRole('button', { name: expected['Choisir le dossier et exporter'], exact: true }).waitFor();
    await exporting.getByRole('button', { name: expected['Annuler'], exact: true }).click();
    await exporting.waitFor({ state: 'hidden' });
    console.log(`${code}: heading, accessibility labels, settings, export and ${code === 'ar' ? 'RTL' : 'LTR'} passed.`);
  }

  await page.locator('.language-select').selectOption('nl');
  await expectLanguage(page, 'nl');
  await application.close(); application = null;
  page = await launch();
  await expectLanguage(page, 'nl');
  console.log('Restart: Dutch persisted in both application settings and the renderer.');
  await page.locator('.language-select').selectOption('fr');
  await expectLanguage(page, 'fr');
  await application.close(); application = null;
  page = await launch();
  await expectLanguage(page, 'fr');
  assert.deepEqual(errors, []);
  console.log('French restored and persisted after another restart. No API key write or provider request.');
} catch (error) {
  if (application) {
    try { const page = await application.firstWindow(); await page.screenshot({ path: join(screenshots, 'i18n-failure.png') }); } catch { /* Preserve the assertion failure. */ }
  }
  throw error;
} finally {
  if (application) await application.close();
  rmSync(temporary, { recursive: true, force: true });
}
