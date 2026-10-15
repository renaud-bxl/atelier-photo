import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_LANGUAGES = Object.freeze([
  ['fr', 'Français', 'fr_FR'], ['nl', 'Nederlands', 'nl_NL'], ['en', 'English', 'en_GB'],
  ['es', 'Español', 'es_ES'], ['zh', '简体中文', 'zh_CN'], ['ja', '日本語', 'ja_JP'],
  ['ar', 'العربية', 'ar_AR'], ['de', 'Deutsch', 'de_DE'], ['pt', 'Português', 'pt_PT'],
  ['it', 'Italiano', 'it_IT'], ['hi', 'हिन्दी', 'hi_IN'], ['ko', '한국어', 'ko_KR'],
]);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(root, 'site');
const marker = '.atelier-site-build.json';
const translationToken = /\{\{t:("(?:[^"\\]|\\.)*")\}\}/g;
const escapeHTML = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort().join(',');

export function validateCatalog(source, dictionary, language) {
  const keys = Object.keys(source).sort(), actual = Object.keys(dictionary).sort();
  if (JSON.stringify(keys) !== JSON.stringify(actual)) throw new Error(`${language}: translation keys differ from fr.json`);
  for (const key of keys) {
    const value = dictionary[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${language}: empty translation for ${key}`);
    if (placeholders(value) !== placeholders(key)) throw new Error(`${language}: placeholders differ for ${key}`);
  }
  for (const key of ['a', 'p', 'renaud2005@gmail.com', '· EUR']) if (dictionary[key] !== source[key]) throw new Error(`${language}: technical identity changed: ${key}`);
}

export function renderPage({ template, dictionary, language, siteURL }) {
  const entry = SITE_LANGUAGES.find(([code]) => code === language);
  if (!entry) throw new Error(`Unsupported site language: ${language}`);
  const base = new URL(siteURL);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const prefix = language === 'fr' ? './' : '../';
  const pageURL = code => new URL(code === 'fr' ? './' : `${code}/`, base).href;
  const pagePath = code => `${prefix}${code === 'fr' ? '' : `${code}/`}`;
  const translate = key => {
    if (!Object.hasOwn(dictionary, key)) throw new Error(`${language}: template message missing: ${key}`);
    return escapeHTML(dictionary[key]);
  };
  const values = {
    LANG: language, DIR: language === 'ar' ? 'rtl' : 'ltr', ASSET_PREFIX: prefix,
    CANONICAL: pageURL(language), OG_IMAGE: new URL('og/atelier-photo-beta-v1.png', base).href, OG_LOCALE: entry[2],
    MESSAGES: escapeHTML(JSON.stringify(dictionary)),
    HREFLANG: SITE_LANGUAGES.map(([code]) => `<link rel="alternate" hreflang="${code}" href="${escapeHTML(pageURL(code))}">`).concat(`<link rel="alternate" hreflang="x-default" href="${escapeHTML(pageURL('fr'))}">`).join('\n  '),
    LANGUAGE_OPTIONS: SITE_LANGUAGES.map(([code, name]) => `<option value="${pagePath(code)}" lang="${code}" dir="${code === 'ar' ? 'rtl' : 'ltr'}"${code === language ? ' selected' : ''}>${escapeHTML(name)}</option>`).join(''),
    LANGUAGE_LINKS: SITE_LANGUAGES.map(([code, name]) => `<a href="${pagePath(code)}" lang="${code}" hreflang="${code}" dir="${code === 'ar' ? 'rtl' : 'ltr'}"${code === language ? ' aria-current="page"' : ''}>${escapeHTML(name)}</a>`).join(' '),
  };
  // Replace structural tokens first: translated text is never interpreted as a template.
  let html = template.replace(/\{\{([A-Z_]+)\}\}/g, (token, name) => Object.hasOwn(values, name) ? values[name] : token);
  html = html.replace(translationToken, (_token, key) => translate(JSON.parse(key)));
  if (/\{\{(?:t:|[A-Z_]+\}\})/.test(html)) throw new Error(`${language}: unresolved template token`);
  return html;
}

export async function buildSite({ outDir = join(root, 'site-dist'), siteURL = process.env.SITE_URL || 'https://renaud-bxl.github.io/atelier-photo/' } = {}) {
  const base = new URL(siteURL);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error('SITE_URL must use HTTPS, or HTTP on localhost for a preview');
  if (base.username || base.password || base.search || base.hash) throw new Error('SITE_URL must not contain credentials, a query, or a fragment');
  const output = resolve(outDir);
  const sourceRelative = relative(output, sourceDirectory);
  if (!sourceRelative || !sourceRelative.startsWith('..') && !isAbsolute(sourceRelative)) throw new Error('The output directory must not contain the website sources');
  const [template, source, image] = await Promise.all([
    readFile(join(sourceDirectory, 'index.html'), 'utf8'),
    readFile(join(sourceDirectory, 'locales/fr.json'), 'utf8').then(JSON.parse),
    readFile(join(sourceDirectory, 'og/atelier-photo-beta-v1.png')),
  ]);
  if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || image.readUInt32BE(16) !== 1200 || image.readUInt32BE(20) !== 630) throw new Error('The shared OG image must be a 1200 × 630 PNG');
  const catalogs = await Promise.all(SITE_LANGUAGES.map(async ([language]) => {
    const dictionary = JSON.parse(await readFile(join(sourceDirectory, 'locales', `${language}.json`), 'utf8'));
    validateCatalog(source, dictionary, language);
    return { language, dictionary };
  }));
  // An incomplete translation never overwrites a previously generated site.
  let existing = [];
  try { existing = await readdir(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing.length && !existing.includes(marker)) throw new Error(`Refusing to replace an unmarked directory: ${output}`);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), '.atelier-site-'));
  try {
    for (const file of ['style.css', 'app.js', 'config.json']) await cp(join(sourceDirectory, file), join(staging, file));
    await cp(join(sourceDirectory, 'og'), join(staging, 'og'), { recursive: true });
    for (const { language, dictionary } of catalogs) {
      const directory = language === 'fr' ? staging : join(staging, language);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'index.html'), renderPage({ template, dictionary, language, siteURL: base.href }));
    }
    await writeFile(join(staging, '.nojekyll'), '');
    await writeFile(join(staging, marker), JSON.stringify({ languages: SITE_LANGUAGES.map(([code]) => code), messages: Object.keys(source).length }) + '\n');
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { output, languages: catalogs.length, messages: Object.keys(source).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  while (args.length) {
    const option = args.shift();
    if (option === '--out-dir' && args.length) options.outDir = args.shift();
    else if (option === '--site-url' && args.length) options.siteURL = args.shift();
    else throw new Error(`Unknown or incomplete option: ${option}`);
  }
  const result = await buildSite(options);
  console.log(`${result.languages} languages × ${result.messages} messages generated in ${result.output}`);
}
