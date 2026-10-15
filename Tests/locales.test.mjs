import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(dirname(dirname(fileURLToPath(import.meta.url))), 'locales');
const languages = ['fr', 'nl', 'en', 'es', 'zh', 'ja', 'ar', 'de', 'pt', 'it', 'hi', 'ko'];
const source = JSON.parse(readFileSync(join(directory, 'fr.json'), 'utf8'));
const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
const technical = new Set([
  '%', '↔', 'AbortError', 'Access-Control-Allow-Origin', 'AIServiceError', 'Cache-Control', 'Content-Type',
  'Atelier Photo', 'OpenAI', 'Gemini', 'Claude', 'Anthropic Claude', 'Google Gemini', 'atelier',
  'Escape', 'Space', 'Tab', 'npm start',
  'blue tiny', 'eyebrow blue', 'eyebrow custom-label', 'image-label after', 'image-label before',
  'modal small-modal', 'muted tiny', 'primary full', 'secondary compact {0}', 'secondary full',
  'side-section preset-section', 'text-button full', 'text-button full configure-ai',
]);
for (const key of Object.keys(source)) {
  if (key.startsWith('added_at ') || key.startsWith('AND name LIKE ') || key.includes('COLLATE NOCASE')) technical.add(key);
}

test('les douze langues couvrent le même catalogue complet de messages', async t => {
  assert.ok(Object.keys(source).length > 0, 'The source message catalog cannot be empty');
  const keys = Object.keys(source).sort();
  for (const language of languages) {
    await t.test(language, () => {
      const dictionary = JSON.parse(readFileSync(join(directory, `${language}.json`), 'utf8'));
      assert.deepEqual(Object.keys(dictionary).sort(), keys, `${language}: missing or unexpected translation keys`);
      for (const [key, value] of Object.entries(dictionary)) {
        assert.equal(typeof value, 'string', `${language}: ${key}`);
        assert.ok(value.trim(), `${language}: empty translation for ${key}`);
        assert.deepEqual(placeholders(value), placeholders(key), `${language}: placeholder mismatch for ${key}`);
      }
      for (const key of technical) assert.equal(dictionary[key], source[key], `${language}: technical token or brand changed: ${key}`);
      if (language !== 'fr') {
        for (const key of ['Votre bibliothèque', 'Réglages IA', 'Langue de l’interface', 'Exporter vos photos']) {
          assert.notEqual(dictionary[key], source[key], `${language}: untranslated interface label ${key}`);
        }
      }
    });
  }
});
