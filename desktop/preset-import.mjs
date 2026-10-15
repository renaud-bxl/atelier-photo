import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, sep } from 'node:path';

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML = 'http://www.w3.org/XML/1998/namespace';
const DC = 'http://purl.org/dc/elements/1.1/';
const MAX_XMP = 2 * 1024 * 1024;
const COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const METADATA = new Set([
  'Name', 'ShortName', 'SortName', 'Group', 'Description', 'UUID', 'Version', 'ProcessVersion',
  'PresetType', 'Cluster', 'CameraModelRestriction', 'Copyright', 'ContactInfo', 'HasSettings',
  'SupportsAmount', 'SupportsAmount2', 'SupportsColor', 'SupportsMonochrome',
  'SupportsHighDynamicRange', 'SupportsNormalDynamicRange', 'SupportsSceneReferred',
  'SupportsOutputReferred', 'AsShotTemperature', 'AsShotTint', 'ToneCurveName', 'ToneCurveName2012',
]);
const NEUTRAL = Object.freeze({
  exposure: 0, contrast: 1, saturation: 1, vibrance: 0, temperature: 0, tint: 0,
  highlights: 0, shadows: 0, sharpness: 0, clarity: 0, denoise: 0, vignette: 0,
  skinSmoothing: 0, faceLight: 0, teethWhitening: 0, eyeBrightness: 0,
  rotation: 0, cropRatio: 0, flipHorizontal: false,
});
const SHA256 = value => createHash('sha256').update(value).digest('hex');
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const fail = message => { throw new Error(message); };

/**
 * Read an XMP preset as inert data. This adapts controls, not Adobe's RAW/profile rendering.
 * No external reference, entity, script, profile or embedded Adobe RGB table is executed.
 */
export function parseXMP(text, { filename = '' } = {}) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_XMP) {
    fail('Le préréglage XMP est vide ou dépasse 2 Mo.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(text)) fail('Le document XMP contient un caractère XML invalide.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail('Les déclarations DOCTYPE et ENTITY sont interdites dans les préréglages.');
  const root = parseXML(text);
  const isRDFRoot = root.ns === RDF && ['RDF', 'Description'].includes(root.local);
  if (!isRDFRoot && !(root.local === 'xmpmeta' && root.ns === 'adobe:ns:meta/')) fail('La racine du document XMP n’est pas reconnue.');
  const rdf = root.ns === RDF && root.local === 'RDF' ? root
    : root.children.find(node => node.ns === RDF && node.local === 'RDF');
  const descriptions = root.ns === RDF && root.local === 'Description' ? [root]
    : (rdf?.children ?? []).filter(node => node.ns === RDF && node.local === 'Description');
  const description = descriptions.find(node => node.attributes.some(attribute => attribute.ns === CRS)
    || node.children.some(child => child.ns === CRS));
  if (!description) fail('Aucune Description RDF principale contenant des réglages Camera Raw n’a été trouvée.');

  const attributes = new Map(description.attributes.filter(attribute => attribute.ns === CRS)
    .map(attribute => [attribute.local, attribute.value]));
  const properties = new Map();
  for (const child of description.children.filter(node => node.ns === CRS)) {
    if (properties.has(child.local)) fail('Le préréglage contient des propriétés Camera Raw ambiguës.');
    properties.set(child.local, child);
  }
  const scalar = name => {
    const property = properties.get(name);
    if (property && !property.children.length) return nodeText(property).trim();
    return attributes.get(name);
  };
  const supported = new Set();
  const unsupported = new Set();
  const handled = new Set(METADATA);
  let hasEffect = false;
  let hasProfile = scalar('PresetType') === 'Look';
  const adjustments = {
    ...NEUTRAL, whites: 0, blacks: 0, grain: 0,
    toneCurves: { rgb: [[0, 0], [255, 255]], red: [], green: [], blue: [] },
    hsl: Object.fromEntries(COLORS.map(color => [color, { hue: 0, saturation: 0, luminance: 0 }])),
    splitToning: { shadowHue: 0, shadowSaturation: 0, highlightHue: 0, highlightSaturation: 0, balance: 0 },
  };

  function mapNumber(names, target, low, high, convert = n => n, { positiveOnly = false, neutral = 0 } = {}) {
    names = Array.isArray(names) ? names : [names];
    names.forEach(name => handled.add(name));
    const name = names.find(name => scalar(name) !== undefined);
    if (!name) return;
    const number = numeric(scalar(name));
    if (number === null || (positiveOnly && number < 0)) { unsupported.add(name); return; }
    const value = clamp(convert(number), low, high);
    target(value);
    supported.add(name);
    if (value !== neutral) hasEffect = true;
  }
  mapNumber(['Exposure2012', 'Exposure'], n => { adjustments.exposure = n; }, -3, 3);
  mapNumber(['Contrast2012', 'Contrast'], n => { adjustments.contrast = n; }, 0.5, 1.8, n => n / 100 + 1, { neutral: 1 });
  mapNumber('Saturation', n => { adjustments.saturation = n; }, 0, 2, n => n / 100 + 1, { neutral: 1 });
  mapNumber('Vibrance', n => { adjustments.vibrance = n; }, -1, 1, n => n / 100);
  const incrementalTemperature = ['IncrementalTemperature', 'TemperatureIncremental'].some(name => scalar(name) !== undefined);
  mapNumber(incrementalTemperature ? ['IncrementalTemperature', 'TemperatureIncremental'] : 'Temperature',
    n => { adjustments.temperature = n; }, -100, 100, incrementalTemperature ? n => n : n => (n - 6500) / 100);
  ['Temperature', 'IncrementalTemperature', 'TemperatureIncremental'].forEach(name => handled.add(name));
  mapNumber(['IncrementalTint', 'Tint'], n => { adjustments.tint = n; }, -100, 100);
  mapNumber(['Highlights2012', 'Highlights'], n => { adjustments.highlights = n; }, -1, 1, n => n / 100);
  mapNumber(['Shadows2012', 'Shadows'], n => { adjustments.shadows = n; }, 0, 1, n => n / 100, { positiveOnly: true });
  mapNumber('Sharpness', n => { adjustments.sharpness = n; }, 0, 2, n => n / 50);
  mapNumber(['LuminanceSmoothing', 'DenoiseLuminance', 'LuminanceNoiseReduction'], n => { adjustments.denoise = n; }, 0, 1, n => n / 100);
  mapNumber(['Clarity2012', 'Clarity'], n => { adjustments.clarity = n; }, 0, 1, n => n / 100, { positiveOnly: true });
  handled.add('PostCropVignetteAmount'); handled.add('VignetteAmount');
  const vignetteName = scalar('PostCropVignetteAmount') !== undefined ? 'PostCropVignetteAmount' : 'VignetteAmount';
  if (scalar(vignetteName) !== undefined) {
    const n = numeric(scalar(vignetteName));
    if (n === null || n > 0) unsupported.add(vignetteName);
    else { adjustments.vignette = clamp(-n / 50, 0, 2); supported.add(vignetteName); if (n < 0) hasEffect = true; }
  }
  mapNumber(['Whites2012', 'Whites'], n => { adjustments.whites = n; }, -100, 100);
  mapNumber(['Blacks2012', 'Blacks'], n => { adjustments.blacks = n; }, -100, 100);
  mapNumber('GrainAmount', n => { adjustments.grain = n; }, 0, 100);

  for (const color of COLORS) {
    const capitalized = color[0].toUpperCase() + color.slice(1);
    for (const [key, prefix] of [['hue', 'Hue'], ['saturation', 'Saturation'], ['luminance', 'Luminance']]) {
      mapNumber(`${prefix}Adjustment${capitalized}`, n => { adjustments.hsl[color][key] = n; }, -100, 100);
    }
  }
  for (const [source, target, high, low = 0] of [
    ['SplitToningShadowHue', 'shadowHue', 360], ['SplitToningShadowSaturation', 'shadowSaturation', 100],
    ['SplitToningHighlightHue', 'highlightHue', 360], ['SplitToningHighlightSaturation', 'highlightSaturation', 100],
    ['SplitToningBalance', 'balance', 100, -100],
  ]) mapNumber(source, n => { adjustments.splitToning[target] = n; }, low, high);

  for (const [channel, names] of [
    ['rgb', ['ToneCurvePV2012', 'ToneCurve']], ['red', ['ToneCurvePV2012Red', 'ToneCurveRed']],
    ['green', ['ToneCurvePV2012Green', 'ToneCurveGreen']], ['blue', ['ToneCurvePV2012Blue', 'ToneCurveBlue']],
  ]) {
    names.forEach(name => handled.add(name));
    const name = names.find(name => properties.has(name));
    if (!name) continue;
    const sequence = properties.get(name).children.find(node => node.ns === RDF && node.local === 'Seq');
    if (!sequence) { unsupported.add(name); continue; }
    const items = sequence.children.filter(node => node.ns === RDF && node.local === 'li');
    if (items.length < 2 || items.length > 256) { unsupported.add(name); continue; }
    const points = items.map(node => nodeText(node).trim().split(/\s*,\s*/).map(numeric));
    if (points.some(point => point.length !== 2 || point.some(n => n === null))) { unsupported.add(name); continue; }
    const bounded = points.map(([x, y]) => [clamp(x, 0, 255), clamp(y, 0, 255)]);
    if (bounded.some(([x], index) => index > 0 && x <= bounded[index - 1][0])) { unsupported.add(name); continue; }
    adjustments.toneCurves[channel] = bounded;
    supported.add(name);
    if (bounded.some(([x, y]) => x !== y)) hasEffect = true;
  }

  handled.add('ConvertToGrayscale');
  if (scalar('ConvertToGrayscale') !== undefined) {
    const gray = boolean(scalar('ConvertToGrayscale'));
    if (gray === null) unsupported.add('ConvertToGrayscale');
    else { supported.add('ConvertToGrayscale'); if (gray) { adjustments.saturation = 0; hasEffect = true; } }
  }
  handled.add('WhiteBalance');
  if (scalar('WhiteBalance') && !['Custom', 'As Shot'].includes(scalar('WhiteBalance'))) unsupported.add('WhiteBalance');
  if (scalar('WhiteBalance') === 'As Shot') unsupported.add('WhiteBalance');

  const ignoredDefaults = new Map([
    ['SharpenRadius', 1], ['SharpenDetail', 25], ['SharpenEdgeMasking', 0],
    ['LuminanceNoiseReductionDetail', 50], ['LuminanceNoiseReductionContrast', 0],
    ['ColorNoiseReductionDetail', 50], ['ColorNoiseReductionSmoothness', 50],
    ['ParametricShadowSplit', 25], ['ParametricMidtoneSplit', 50], ['ParametricHighlightSplit', 75],
    ['PostCropVignetteMidpoint', 50], ['PostCropVignetteFeather', 50], ['PostCropVignetteRoundness', 0],
    ['PostCropVignetteStyle', 1], ['PostCropVignetteHighlightContrast', 0], ['VignetteMidpoint', 50],
    ['GrainSize', 25], ['GrainFrequency', 50], ['GrainSeed', 0],
    ['PerspectiveScale', 100], ['LensProfileSetup', 'LensDefaults'], ['ColorGradeBlending', 50],
  ]);
  const allFields = new Set([...attributes.keys(), ...properties.keys()]);
  for (const name of allFields) {
    if (handled.has(name)) continue;
    const value = scalar(name);
    const profileField = name === 'Look' || name === 'LookStub' || /^(?:Table_|RGBTable|CameraProfile|Profile)/.test(name);
    if (profileField || (name === 'RequiresRGBTables' && boolean(value) !== false)) {
      if (value !== '' || properties.has(name)) { hasProfile = true; unsupported.add(name); }
      continue;
    }
    if (name === 'RequiresRGBTables') continue;
    if (name === 'OverrideLookVignette') continue;
    if (ignoredDefaults.has(name) && String(value) === String(ignoredDefaults.get(name))) continue;
    // Additional rendering controls are never assumed to have been reproduced.
    if (properties.has(name) || (value !== undefined && value !== '' && numeric(value) !== 0 && boolean(value) !== false)) {
      unsupported.add(name);
    }
  }
  if (!properties.has('ToneCurvePV2012') && !properties.has('ToneCurve')
      && scalar('ToneCurveName2012') && !['Linear', 'Custom'].includes(scalar('ToneCurveName2012'))) unsupported.add('ToneCurveName2012');

  // Hue/balance alone do not produce split toning while both saturations are zero.
  hasEffect = Object.entries(NEUTRAL).some(([name, neutral]) => adjustments[name] !== neutral)
    || ['whites', 'blacks', 'grain'].some(name => adjustments[name] !== 0)
    || Object.values(adjustments.hsl).some(band => Object.values(band).some(n => n !== 0))
    || adjustments.splitToning.shadowSaturation > 0 || adjustments.splitToning.highlightSaturation > 0
    || Object.values(adjustments.toneCurves).some(points => points.length &&
      (points[0][0] !== 0 || points[0][1] !== 0 || points.at(-1)[0] !== 255 || points.at(-1)[1] !== 255 || points.some(([x, y]) => x !== y)));
  const compatibility = hasProfile && !hasEffect ? 'profile-required'
    : !hasEffect && unsupported.size ? 'unsupported'
      : !supported.size ? 'unsupported' : unsupported.size || hasProfile ? 'partial' : 'adapted';
  const sourceName = cleanName(basename(String(filename || '')), 240);
  const localized = name => localizedText(properties.get(name)) || cleanName(attributes.get(name) ?? '', 240);
  const name = localized('Name') || cleanName(sourceName.replace(/\.xmp$/i, ''), 200) || 'Préréglage importé';
  const category = localized('Group') || 'Préréglages importés';
  const dcRights = descriptions.flatMap(node => node.children).find(node => node.ns === DC && node.local === 'rights');
  const copyright = cleanName(scalar('Copyright') || localizedText(dcRights), 2000);
  const sourceUUID = String(scalar('UUID') ?? '').replace(/[{}-]/g, '').toUpperCase();
  const settings = [
    [...attributes].filter(([name]) => !METADATA.has(name)).sort(([a], [b]) => a.localeCompare(b)),
    [...properties].filter(([name]) => !METADATA.has(name)).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, node]) => [name, canonicalNode(node)]),
  ];
  return {
    name, category, adjustments, compatibility,
    supportedFields: [...supported].sort(), unsupportedFields: [...unsupported].sort(),
    sourceHash: SHA256(text), sourceUUID: /^[A-F0-9]{32}$/.test(sourceUUID) ? sourceUUID : '',
    sourceSettingsHash: SHA256(JSON.stringify(settings)), copyright, sourceName,
  };
}

/** Inspect user-selected XMPs without modifying files or writing a preset catalogue. */
export async function inspectPresetFolder(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('Choisissez un dossier absolu de préréglages.');
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) fail('Le chemin choisi n’est pas un dossier.');
  const files = [];
  const errors = [];
  async function walk(folder, depth = 0) {
    if (depth > 24) fail('Le dossier de préréglages contient trop de niveaux.');
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        if (/\.xmp$/i.test(entry.name)) errors.push({ sourceName: entry.name, message: 'Lien symbolique ignoré.' });
        continue;
      }
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.xmp') files.push(path);
      if (files.length > 20_000) fail('Le dossier contient trop de préréglages.');
    }
  }
  await walk(root);
  const presets = [];
  const hashes = new Set();
  const uuidSettings = new Set();
  const names = new Set();
  let parsed = 0;
  let duplicates = 0;
  const summary = { filesFound: files.length, parsed: 0, presets: 0, duplicates: 0, errors: 0,
    compatibility: { adapted: 0, partial: 0, 'profile-required': 0, unsupported: 0 },
    supportedFields: Object.create(null), unsupportedFields: Object.create(null) };
  for (const file of files) {
    try {
      const resolved = await realpath(file);
      if (!resolved.startsWith(root + sep)) fail('Le fichier est en dehors du dossier choisi.');
      if ((await stat(resolved)).size > MAX_XMP) fail('Le préréglage XMP dépasse 2 Mo.');
      const bytes = await readFile(resolved);
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const preset = parseXMP(text, { filename: basename(file) });
      parsed += 1;
      const uuidKey = preset.sourceUUID ? `${preset.sourceUUID}:${preset.sourceSettingsHash}` : '';
      if (hashes.has(preset.sourceHash) || (uuidKey && uuidSettings.has(uuidKey))) { duplicates += 1; continue; }
      hashes.add(preset.sourceHash); if (uuidKey) uuidSettings.add(uuidKey);
      const originalName = preset.name;
      let suffix = 2;
      while (names.has(preset.name.toLocaleLowerCase('en'))) preset.name = `${originalName} (${suffix++})`;
      names.add(preset.name.toLocaleLowerCase('en'));
      presets.push(preset);
      summary.compatibility[preset.compatibility] += 1;
      for (const name of preset.supportedFields) summary.supportedFields[name] = (summary.supportedFields[name] ?? 0) + 1;
      for (const name of preset.unsupportedFields) summary.unsupportedFields[name] = (summary.unsupportedFields[name] ?? 0) + 1;
    } catch (error) {
      errors.push({ sourceName: basename(file), message: error instanceof Error ? error.message : 'Préréglage illisible.' });
    }
  }
  Object.assign(summary, { parsed, presets: presets.length, duplicates, errors: errors.length });
  return { presets, errors, summary };
}

/** Standard 3D .cube order: red changes fastest, then green, then blue. */
export function parseCube(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32 * 1024 * 1024) fail('La LUT CUBE est vide ou dépasse 32 Mo.');
  let title = '';
  let size;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const seen = new Set();
  const values = [];
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^TITLE\s/.test(trimmed)) {
      if (seen.has('TITLE')) fail('La LUT contient plusieurs titres.');
      const match = trimmed.match(/^TITLE\s+"([^"\r\n]*)"\s*(?:#.*)?$/);
      if (!match) fail('Le titre de la LUT est invalide.');
      title = cleanName(match[1], 240); seen.add('TITLE'); continue;
    }
    const line = trimmed.replace(/\s*#.*$/, '').trim();
    const tokens = line.split(/\s+/);
    const directive = tokens[0];
    if (directive === 'LUT_1D_SIZE') fail('Les LUT CUBE 1D ne sont pas prises en charge. Choisissez une LUT 3D.');
    if (['LUT_3D_SIZE', 'DOMAIN_MIN', 'DOMAIN_MAX'].includes(directive)) {
      if (seen.has(directive)) fail('La LUT contient une directive répétée.');
      seen.add(directive);
      if (directive === 'LUT_3D_SIZE') {
        size = numeric(tokens[1]);
        if (tokens.length !== 2 || !Number.isInteger(size) || size < 2 || size > 65) fail('La taille de la LUT 3D doit être comprise entre 2 et 65.');
      } else {
        const domain = tokens.slice(1).map(numeric);
        if (domain.length !== 3 || domain.some(n => n === null)) fail('Le domaine de la LUT est invalide.');
        if (directive === 'DOMAIN_MIN') domainMin = domain; else domainMax = domain;
      }
      continue;
    }
    const row = tokens.map(numeric);
    if (!size || row.length !== 3 || row.some(n => n === null)) fail('La LUT contient une ligne ou une directive non prise en charge.');
    values.push(...row);
    if (values.length > size ** 3 * 3) fail('La LUT contient trop de valeurs.');
  }
  if (!size || values.length !== size ** 3 * 3) fail('La LUT ne contient pas le nombre de valeurs attendu.');
  if (domainMin.some((minimum, index) => minimum >= domainMax[index])) fail('Les bornes du domaine de la LUT sont invalides.');
  return { title, size, domainMin, domainMax, values };
}

function numeric(value) {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function boolean(value) {
  if (typeof value !== 'string') return null;
  if (/^(true|1)$/i.test(value.trim())) return true;
  if (/^(false|0)$/i.test(value.trim())) return false;
  return null;
}
function cleanName(text, maximum) { return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum); }
function nodeText(node) { return node ? node.content.map(item => typeof item === 'string' ? item : nodeText(item)).join('') : ''; }
function localizedText(node) {
  if (!node) return '';
  const alt = node.children.find(child => child.ns === RDF && child.local === 'Alt');
  const items = alt?.children.filter(child => child.ns === RDF && child.local === 'li') ?? [];
  const chosen = items.find(item => item.attributes.some(attribute => attribute.ns === XML && attribute.local === 'lang' && attribute.value === 'x-default')) ?? items[0];
  return cleanName(nodeText(chosen ?? node), 240);
}
function canonicalNode(node) {
  return [node.ns, node.local,
    node.attributes.map(attribute => [attribute.ns, attribute.local, attribute.value]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    node.content.map(item => typeof item === 'string' ? item.trim() : canonicalNode(item)).filter(item => item !== '')];
}

// A bounded inert XML reader, intentionally excluding DTDs, external entities and recovery modes.
function parseXML(input) {
  const text = input.replace(/^\uFEFF/, '');
  const document = { ns: '', local: '#document', children: [], content: [], scope: Object.assign(Object.create(null), { xml: XML }) };
  const stack = [document];
  let count = 0;
  let offset = 0;
  const appendText = (value, cdata = false) => {
    if (!value) return;
    const decoded = cdata ? value : decodeXML(value);
    if (stack.length === 1 && decoded.trim()) fail('Texte en dehors de la racine XML.');
    stack.at(-1).content.push(decoded);
  };
  while (offset < text.length) {
    const open = text.indexOf('<', offset);
    if (open === -1) { appendText(text.slice(offset)); break; }
    appendText(text.slice(offset, open));
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end === -1 || text.slice(open + 4, end).includes('--')) fail('Commentaire XML invalide.');
      offset = end + 3; continue;
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) fail('Instruction XML incomplète.');
      offset = end + 2; continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end === -1 || stack.length === 1) fail('Section CDATA invalide.');
      appendText(text.slice(open + 9, end), true); offset = end + 3; continue;
    }
    if (text.startsWith('<!', open)) fail('Déclaration XML non prise en charge.');
    let quote = '';
    let end = open + 1;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') fail('Balise XML invalide.');
    }
    if (end === text.length || quote) fail('Balise XML incomplète.');
    let body = text.slice(open + 1, end);
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      if (stack.length <= 1 || stack.at(-1).name !== name) fail('Les balises XML ne correspondent pas.');
      stack.pop(); offset = end + 1; continue;
    }
    const selfClosing = /\/\s*$/.test(body);
    if (selfClosing) body = body.replace(/\/\s*$/, '');
    const match = body.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/);
    if (!match) fail('Nom de balise XML invalide.');
    const name = match[1];
    const rawAttributes = parseAttributes(match[2]);
    const parent = stack.at(-1);
    const scope = Object.assign(Object.create(null), parent.scope);
    for (const [attributeName, value] of rawAttributes) {
      if (attributeName === 'xmlns') scope[''] = value;
      else if (attributeName.startsWith('xmlns:')) {
        const prefix = attributeName.slice(6);
        if (prefix === 'xmlns' || (prefix === 'xml' && value !== XML)) fail('Déclaration d’espace de noms XML invalide.');
        scope[prefix] = value;
      }
    }
    const expanded = expandName(name, scope, false);
    const attributes = [];
    const identities = new Set();
    for (const [attributeName, value] of rawAttributes) {
      if (attributeName === 'xmlns' || attributeName.startsWith('xmlns:')) continue;
      const expandedAttribute = expandName(attributeName, scope, true);
      const identity = `${expandedAttribute.ns}\u0000${expandedAttribute.local}`;
      if (identities.has(identity)) fail('Attribut XML répété.');
      identities.add(identity); attributes.push({ ...expandedAttribute, value });
    }
    const node = { name, ...expanded, attributes, children: [], content: [], scope };
    parent.children.push(node); parent.content.push(node);
    count += 1;
    if (count > 30_000 || stack.length > 40) fail('Le préréglage XML est trop complexe.');
    if (!selfClosing) stack.push(node);
    offset = end + 1;
  }
  if (stack.length !== 1 || document.children.length !== 1) fail('Le document XML est incomplet ou contient plusieurs racines.');
  return document.children[0];
}
function parseAttributes(text) {
  const attributes = [];
  const names = new Set();
  let offset = 0;
  while (offset < text.length) {
    const whitespace = text.slice(offset).match(/^\s+/);
    if (!whitespace) fail('Les attributs XML doivent être séparés par des espaces.');
    offset += whitespace[0].length;
    if (offset === text.length) break;
    const match = text.slice(offset).match(/^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])/);
    if (!match) fail('Attribut XML invalide.');
    const [head, name, quote] = match;
    offset += head.length;
    const end = text.indexOf(quote, offset);
    if (end === -1 || text.slice(offset, end).includes('<') || names.has(name)) fail('Valeur d’attribut XML invalide.');
    names.add(name); attributes.push([name, decodeXML(text.slice(offset, end))]); offset = end + 1;
    if (attributes.length > 1024) fail('Trop d’attributs XML.');
  }
  return attributes;
}
function expandName(name, scope, attribute) {
  const parts = name.split(':');
  if (parts.length > 2 || parts.some(part => !part)) fail('Nom XML invalide.');
  if (parts.length === 1) return { ns: attribute ? '' : scope[''] ?? '', local: parts[0] };
  if (!Object.hasOwn(scope, parts[0])) fail('Préfixe XML non déclaré.');
  return { ns: scope[parts[0]], local: parts[1] };
}
function decodeXML(text) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(text)) fail('Entité XML inconnue ou invalide.');
  return text.replace(/&([^;]+);/g, (_, value) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, value)) return named[value];
    const number = value.startsWith('#x') ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    if (!Number.isInteger(number) || !(number === 9 || number === 10 || number === 13 || number >= 32)
        || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff) || number === 0xfffe || number === 0xffff) fail('Référence de caractère XML invalide.');
    return String.fromCodePoint(number);
  });
}
