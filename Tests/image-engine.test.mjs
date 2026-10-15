import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { getMetadata, normalizeAdjustments, renderImage, thumbnail } from '../desktop/image-engine.mjs';

const fixture = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="100"><defs><linearGradient id="g"><stop stop-color="#234557"/><stop offset="1" stop-color="#e7ba8b"/></linearGradient></defs><rect width="120" height="100" fill="url(#g)"/><rect x="36" y="30" width="14" height="9" fill="#999aaa"/><rect x="65" y="30" width="14" height="9" fill="#999aaa"/><rect x="48" y="61" width="26" height="9" fill="#ddcfaa"/><path d="M30 20h3v3h-3z M34 24h3v3h-3z M39 20h3v3h-3z M31 27h3v3h-3z M82 20h3v3h-3z" fill="#412519"/></svg>`);
const landmarks = { faces: [{ box: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
  leftEye: [{ x: 0.3, y: 0.30 }, { x: 0.42, y: 0.30 }, { x: 0.42, y: 0.39 }, { x: 0.3, y: 0.39 }],
  rightEye: [{ x: 0.54, y: 0.30 }, { x: 0.66, y: 0.30 }, { x: 0.66, y: 0.39 }, { x: 0.54, y: 0.39 }],
  mouth: [{ x: 0.4, y: 0.61 }, { x: 0.62, y: 0.61 }, { x: 0.62, y: 0.70 }, { x: 0.4, y: 0.70 }] }] };

async function withFixture(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), 'atelier-engine-'));
  const source = path.join(directory, 'photo.png');
  await writeFile(source, await sharp(fixture).png().toBuffer());
  try { await fn(source, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function pixels(buffer) { return sharp(buffer).ensureAlpha().raw().toBuffer(); }
async function pixel(buffer, x, y) {
  return sharp(buffer).extract({ left: x, top: y, width: 1, height: 1 }).ensureAlpha().raw().toBuffer();
}

test('EXIF orientation, metadata, thumbnail, rotation, crop and preview bounds agree', async () => withFixture(async (source, directory) => {
  const original = path.join(directory, 'oriented.jpg');
  await sharp(source).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toFile(original);
  const metadata = await getMetadata(original);
  assert.equal(metadata.width, 100); assert.equal(metadata.height, 120);
  const full = await sharp(await renderImage(original)).metadata();
  assert.equal(full.width, 100); assert.equal(full.height, 120); assert.equal(full.orientation ?? 1, 1);
  const small = await sharp(await thumbnail(original, 30)).metadata();
  assert.equal(small.width, 25); assert.equal(small.height, 30);
  const turn = await sharp(await renderImage(original, { rotation: 90 })).metadata();
  assert.equal(turn.width, 120); assert.equal(turn.height, 100);
  const crop = await sharp(await renderImage(original, { rotation: 90, flipHorizontal: true, cropRatio: 1 })).metadata();
  assert.equal(crop.width, 100); assert.equal(crop.height, 100);
  const diagonal = await sharp(await renderImage(original, { rotation: 45 }, { maxDimension: 32 })).metadata();
  assert.ok(diagonal.width <= 32 && diagonal.height <= 32);
  const large = await sharp({ create: { width: 2200, height: 1800, channels: 3, background: '#bbbbbb' } }).png().toBuffer();
  const preview = await sharp(await renderImage(large, { rotation: 45 }, { maxDimension: 1600 })).metadata();
  assert.ok(preview.width <= 1600 && preview.height <= 1600);
}));

test('global controls produce real pixel changes and inputs are bounded', async () => withFixture(async source => {
  const neutral = await pixels(await renderImage(source, {}, { format: 'png' }));
  for (const [control, value] of Object.entries({ exposure: 0.5, contrast: 1.4, saturation: 0.5, vibrance: 0.8,
    temperature: 70, tint: 70, highlights: -0.7, shadows: 0.8, sharpness: 1, clarity: 0.8, denoise: 0.8, vignette: 1 })) {
    const result = await pixels(await renderImage(source, { [control]: value }, { format: 'png' }));
    assert.notDeepEqual(result, neutral, `${control} should change pixels`);
  }
  const normalized = normalizeAdjustments({ exposure: Infinity, contrast: NaN, saturation: -100, shadows: 1000, rotation: 'bad' });
  assert.equal(normalized.exposure, 0); assert.equal(normalized.contrast, 1);
  assert.equal(normalized.saturation, 0); assert.equal(normalized.shadows, 1); assert.equal(normalized.rotation, 0);
  const bounded = await renderImage(source, { exposure: NaN, cropRatio: Infinity }, { maxDimension: NaN, quality: Infinity });
  assert.ok(bounded.length > 0);
}));

test('portrait controls require faces and preserve pixels outside face patches', async () => withFixture(async source => {
  const original = await renderImage(source, {}, { format: 'png' });
  const portrait = { skinSmoothing: 1, faceLight: 1, teethWhitening: 1, eyeBrightness: 1 };
  const absent = await renderImage(source, portrait, { format: 'png' });
  assert.deepEqual(await pixels(absent), await pixels(original));
  for (const control of Object.keys(portrait)) {
    const edited = await renderImage(source, { [control]: 1 }, { format: 'png', landmarks });
    assert.notDeepEqual(await pixels(edited), await pixels(original), `${control} should modify its detected region`);
    assert.deepEqual(await pixel(edited, 2, 2), await pixel(original, 2, 2), `${control} must preserve background`);
  }
  const bad = { faces: [{ box: { x: NaN, y: 0, width: 1, height: 1 } }, { box: { x: 2, y: 2, width: 1, height: 1 } }] };
  assert.deepEqual(await pixels(await renderImage(source, portrait, { format: 'png', landmarks: bad })), await pixels(original));
}));

test('exports encode JPEG PNG TIFF and WebP, watermark escapes text, originals remain unchanged', async () => withFixture(async source => {
  const before = await readFile(source);
  for (const format of ['jpeg', 'png', 'tiff', 'webp']) {
    const result = await renderImage(source, { exposure: 0.3 }, { format, quality: 90, watermark: 'Atelier <image href="file:///private/secret"/> & Photo' });
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.format, format); assert.equal(metadata.width, 120); assert.equal(metadata.height, 100);
  }
  assert.deepEqual(await readFile(source), before);
  await assert.rejects(renderImage(source, {}, { format: 'exe' }), /Format/);
}));

test('alpha survives colour, tone and portrait adjustments', async () => {
  const transparent = await sharp({ create: { width: 120, height: 100, channels: 4, background: { r: 150, g: 120, b: 100, alpha: 0.4 } } }).png().toBuffer();
  const result = await renderImage(transparent, { exposure: 0.3, contrast: 1.1, shadows: 0.5, faceLight: 0.8 }, { format: 'png', landmarks });
  const sourceAlpha = (await pixel(transparent, 60, 50))[3];
  assert.ok(Math.abs((await pixel(result, 60, 50))[3] - sourceAlpha) <= 1);
  assert.equal((await pixel(result, 2, 2))[3], sourceAlpha);
});

test('16-bit sources remain intact and PNG/TIFF exports use the 16-bit pipeline', async () => withFixture(async (_source, directory) => {
  const source = path.join(directory, 'source-16bit.png');
  await sharp(fixture).toColourspace('rgb16').png().toFile(source);
  const original = await readFile(source);
  assert.equal((await sharp(original).metadata()).depth, 'ushort');
  for (const format of ['png', 'tiff']) {
    const exported = await renderImage(source, { exposure: 0.2 }, { format });
    const metadata = await sharp(exported).metadata();
    assert.equal(metadata.depth, 'ushort');
    assert.equal(metadata.width, 120); assert.equal(metadata.height, 100);
  }
  assert.deepEqual(await readFile(source), original);
}));
