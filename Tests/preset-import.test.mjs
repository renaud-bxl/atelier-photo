import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { inspectPresetFolder, parseCube, parseXMP } from '../desktop/preset-import.mjs';
import { normalizeAdjustments, renderImage } from '../desktop/image-engine.mjs';

const xmp = (attributes = '', children = '') => `<?xml version="1.0"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" ${attributes}>${children}</rdf:Description>
</rdf:RDF></x:xmpmeta>`;
const curve = (name, points) => `<crs:${name}><rdf:Seq>${points.map(([x, y]) => `<rdf:li>${x}, ${y}</rdf:li>`).join('')}</rdf:Seq></crs:${name}>`;
const translated = (name, text) => `<crs:${name}><rdf:Alt><rdf:li xml:lang="fr">Autre nom</rdf:li><rdf:li xml:lang="x-default">${text}</rdf:li></rdf:Alt></crs:${name}>`;

test('XMP translates supported controls, clamps ranges, and keeps source identity', () => {
  const input = xmp(`crs:UUID="00112233-4455-6677-8899-AABBCCDDEEFF" crs:Exposure2012="8"
    crs:Contrast2012="-90" crs:Saturation="30" crs:Vibrance="-20"
    crs:Temperature="4500" crs:Tint="150" crs:Highlights2012="-60"
    crs:Shadows2012="50" crs:Sharpness="200" crs:LuminanceSmoothing="25"
    crs:Clarity2012="30" crs:PostCropVignetteAmount="-80" crs:Whites2012="140" crs:Blacks2012="-20"
    crs:GrainAmount="120" crs:HueAdjustmentRed="30" crs:SaturationAdjustmentBlue="-40"
    crs:LuminanceAdjustmentOrange="25" crs:SplitToningShadowHue="400"
    crs:SplitToningShadowSaturation="20" crs:SplitToningHighlightHue="35"
    crs:SplitToningHighlightSaturation="10" crs:SplitToningBalance="-180" crs:Copyright="Example creator"`,
  translated('Name', 'Test &amp; Light') + translated('Group', 'Portraits'));
  const preset = parseXMP(input, { filename: '/user/private/example.xmp' });
  assert.equal(preset.name, 'Test & Light');
  assert.equal(preset.category, 'Portraits');
  assert.equal(preset.sourceName, 'example.xmp');
  assert.equal(preset.copyright, 'Example creator');
  assert.equal(preset.sourceUUID, '00112233445566778899AABBCCDDEEFF');
  assert.match(preset.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(preset.sourceSettingsHash, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...preset.adjustments, toneCurves: null, hsl: null, splitToning: null }, {
    exposure: 3, contrast: 0.5, saturation: 1.3, vibrance: -0.2, temperature: -20, tint: 100,
    highlights: -0.6, shadows: 0.5, sharpness: 2, clarity: 0.3, denoise: 0.25, vignette: 1.6,
    skinSmoothing: 0, faceLight: 0, teethWhitening: 0, eyeBrightness: 0,
    rotation: 0, cropRatio: 0, flipHorizontal: false, whites: 100, blacks: -20, grain: 100,
    toneCurves: null, hsl: null, splitToning: null,
  });
  assert.deepEqual(preset.adjustments.hsl.red, { hue: 30, saturation: 0, luminance: 0 });
  assert.equal(preset.adjustments.hsl.blue.saturation, -40);
  assert.equal(preset.adjustments.hsl.orange.luminance, 25);
  assert.equal(Object.keys(preset.adjustments.hsl).length, 8);
  assert.deepEqual(preset.adjustments.splitToning, { shadowHue: 360, shadowSaturation: 20, highlightHue: 35, highlightSaturation: 10, balance: -100 });
  assert.equal(preset.compatibility, 'adapted');
  assert.ok(preset.supportedFields.includes('Exposure2012'));
});

test('relative white balance overrides the absolute approximation and negative-only controls are reported', () => {
  const preset = parseXMP(xmp('crs:Temperature="2000" crs:IncrementalTemperature="15" crs:Tint="10" crs:IncrementalTint="-5" crs:Shadows2012="-50" crs:Clarity2012="-10" crs:PostCropVignetteAmount="25"'));
  assert.equal(preset.adjustments.temperature, 15);
  assert.equal(preset.adjustments.tint, -5);
  assert.equal(preset.adjustments.shadows, 0);
  assert.equal(preset.adjustments.clarity, 0);
  assert.equal(preset.adjustments.vignette, 0);
  assert.equal(preset.compatibility, 'partial');
  assert.deepEqual(preset.unsupportedFields, ['Clarity2012', 'PostCropVignetteAmount', 'Shadows2012']);
});

test('only direct CRS properties are used; nested Look attributes never masquerade as real edits', () => {
  const look = '<crs:Look><rdf:Description crs:Exposure2012="3" crs:Saturation="100" crs:Name="Hidden look"/></crs:Look>';
  const root = parseXMP(xmp('crs:Exposure2012="0.5"', look));
  assert.equal(root.adjustments.exposure, 0.5);
  assert.equal(root.adjustments.saturation, 1);
  assert.equal(root.compatibility, 'partial');
  const profile = parseXMP(xmp('crs:Exposure2012="0" crs:SplitToningShadowHue="180"', look));
  assert.equal(profile.adjustments.exposure, 0);
  assert.equal(profile.compatibility, 'profile-required');
  assert.ok(profile.unsupportedFields.includes('Look'));
  assert.throws(() => parseXMP('<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"><crs:Look>'
    + xmp('crs:Exposure2012="3"') + '</crs:Look></x:xmpmeta>'));
});

test('Adobe RGB tables and profiles cannot become false neutral presets', () => {
  for (const attributes of [
    'crs:PresetType="Look" crs:RGBTable="opaque-table-id"',
    'crs:RequiresRGBTables="True" crs:Table_TEST="opaque-data"',
    'crs:CameraProfile="Adobe Standard" crs:Exposure2012="0"',
    'crs:LookStub="True" crs:Contrast2012="0"',
  ]) assert.equal(parseXMP(xmp(attributes)).compatibility, 'profile-required');
  assert.equal(parseXMP(xmp('crs:Texture="35"')).compatibility, 'unsupported');
  assert.equal(parseXMP(xmp('crs:Exposure2012="0" crs:RequiresRGBTables="False"')).compatibility, 'adapted');
});

test('curves keep channel identity, bounds and strict X order', () => {
  const preset = parseXMP(xmp('', curve('ToneCurvePV2012', [[0, -10], [128, 160], [255, 300]])
    + curve('ToneCurvePV2012Red', [[0, 10], [255, 250]])
    + curve('ToneCurvePV2012Green', [[0, 0], [255, 255]])));
  assert.deepEqual(preset.adjustments.toneCurves.rgb, [[0, 0], [128, 160], [255, 255]]);
  assert.deepEqual(preset.adjustments.toneCurves.red, [[0, 10], [255, 250]]);
  assert.deepEqual(preset.adjustments.toneCurves.blue, []);
  assert.equal(preset.compatibility, 'adapted');
  const invalid = parseXMP(xmp('crs:Exposure2012="0.2"', curve('ToneCurvePV2012', [[0, 0], [0, 60], [255, 255]])));
  assert.equal(invalid.compatibility, 'partial');
  assert.deepEqual(invalid.adjustments.toneCurves.rgb, [[0, 0], [255, 255]]);
  assert.ok(invalid.unsupportedFields.includes('ToneCurvePV2012'));
});

test('namespace aliases, direct scalar elements and safe predefined/numeric entities are supported', () => {
  const value = xmp('', '<crs:Exposure2012>0.75</crs:Exposure2012>' + translated('Name', 'Clair &#x26; d&#233;taillé'));
  const preset = parseXMP(value.replaceAll('crs:', 'camera:').replace('xmlns:crs=', 'xmlns:camera='));
  assert.equal(preset.adjustments.exposure, 0.75);
  assert.equal(preset.name, 'Clair & détaillé');
});

test('malformed XML, DTDs, entity declarations, unknown entities and oversized input are rejected', () => {
  for (const input of [
    '<!DOCTYPE x SYSTEM "file:///private/data"><x/>',
    '<!ENTITY local "value">' + xmp('crs:Exposure2012="1"'),
    xmp('crs:Exposure2012="1"').replace('</rdf:RDF>', '</wrong>'),
    xmp('crs:Exposure2012="1" crs:Exposure2012="2"'),
    xmp('crs:Name="&unknown;"'),
    xmp('crs:Name="&#0;"'),
    xmp('crs:Name="bad\u0000name"'),
    xmp('crs:Name="unfinished'),
    xmp('crs:Exposure2012="1"') + '<second/>',
    ' '.repeat(2 * 1024 * 1024 + 1),
  ]) assert.throws(() => parseXMP(input));
  const malformedNumber = parseXMP(xmp('crs:Exposure2012="NaN" crs:Contrast2012="20"'));
  assert.equal(malformedNumber.adjustments.exposure, 0);
  assert.ok(malformedNumber.unsupportedFields.includes('Exposure2012'));
  assert.equal(malformedNumber.compatibility, 'partial');
});

test('folder inspection deduplicates identical data/UUID settings while preserving changed variants and rights', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-preset-test-'));
  try {
    await mkdir(join(directory, 'nested'));
    const first = xmp('crs:UUID="00112233445566778899AABBCCDDEEFF" crs:Exposure2012="0.5" crs:Copyright="Test rights"', translated('Name', 'My preset'));
    await writeFile(join(directory, 'a.xmp'), first);
    await writeFile(join(directory, 'copy.xmp'), first);
    await writeFile(join(directory, 'nested', 'whitespace.XMP'), first.replace('crs:Exposure2012="0.5"', 'crs:Exposure2012 = "0.5"'));
    await writeFile(join(directory, 'variant.xmp'), first.replace('Exposure2012="0.5"', 'Exposure2012="1.0"'));
    await writeFile(join(directory, 'broken.xmp'), '<bad>');
    const result = await inspectPresetFolder(directory);
    assert.equal(result.summary.filesFound, 5);
    assert.equal(result.summary.parsed, 4);
    assert.equal(result.summary.duplicates, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.presets.length, 2);
    assert.deepEqual(result.presets.map(preset => preset.name), ['My preset', 'My preset (2)']);
    assert.ok(result.presets.every(preset => preset.copyright === 'Test rights'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const identityCube = () => {
  const rows = ['TITLE "Identity # test"', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) rows.push(`${r} ${g} ${b}`);
  return rows.join('\n');
};
test('CUBE 2×2×2 identity retains red-fast ordering and numeric domains', () => {
  const lut = parseCube(identityCube());
  assert.equal(lut.title, 'Identity # test');
  assert.equal(lut.size, 2);
  assert.deepEqual(lut.domainMin, [0, 0, 0]);
  assert.deepEqual(lut.domainMax, [1, 1, 1]);
  assert.equal(lut.values.length, 24);
  assert.deepEqual(lut.values.slice(0, 12), [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  assert.ok(lut.values.every(Number.isFinite));
});
test('CUBE rejects 1D tables, invalid sizes, counts, NaN and invalid domains', () => {
  for (const value of [
    'LUT_1D_SIZE 2\n0 0 0\n1 1 1',
    identityCube().replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 66'),
    identityCube().replace('LUT_3D_SIZE 2', 'LUT_3D_SIZE 1'),
    identityCube().replace('0 0 0\n1 0 0', 'NaN 0 0\n1 0 0'),
    identityCube().split('\n').slice(0, -1).join('\n'),
    identityCube() + '\n1 1 1',
    identityCube().replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX 0 1 1'),
    identityCube().replace('DOMAIN_MIN 0 0 0', 'DOMAIN_MIN Infinity 0 0'),
  ]) assert.throws(() => parseCube(value));
});

test('imported exposure survives the current engine normalization and changes a synthetic gradient', async () => {
  const width = 32;
  const height = 8;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels.fill(x * 6, (y * width + x) * 3, (y * width + x + 1) * 3);
  const source = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const preset = parseXMP(xmp('crs:Exposure2012="1"'));
  assert.equal(normalizeAdjustments(preset.adjustments).exposure, 1);
  const output = await renderImage(source, preset.adjustments, { format: 'png' });
  const image = await sharp(output).removeAlpha().raw().toBuffer();
  assert.ok(image[16 * 3] > pixels[16 * 3] + 20);
});
