import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderImage, normalizeAdjustments } from '../desktop/image-engine.mjs';
import { applyColorStyle } from '../desktop/color-style.mjs';

const width = 1024, height = 64;
function gradient(alpha = 65535) {
  const samples = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    samples[index] = 16000 + x * 4; samples[index + 1] = 25000 + x * 3;
    samples[index + 2] = 33000 + x * 2; samples[index + 3] = alpha;
  }
  return samples;
}
async function encode16(samples, format = 'png', w = width, h = height) {
  const image = sharp(samples, { raw: { width: w, height: h, channels: 4 } })
    .pipelineColourspace('rgb16').toColourspace('rgb16');
  return format === 'tiff' ? image.tiff({ compression: 'lzw' }).toBuffer() : image.png().toBuffer();
}
async function decode16(encoded) {
  const raw = await sharp(encoded).toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return { samples: new Uint16Array(raw.data.buffer, raw.data.byteOffset, raw.data.length / 2), ...raw.info };
}
function levels(image, channel, x = 240, length = 540, y = 32) {
  return new Set(Array.from({ length }, (_, index) => image.samples[(y * image.width + x + index) * 4 + channel])).size;
}
const landmarks = { faces: [{ box: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
  leftEye: [{ x: 0.25, y: 0.25 }, { x: 0.35, y: 0.25 }, { x: 0.35, y: 0.4 }, { x: 0.25, y: 0.4 }],
  rightEye: [{ x: 0.65, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.4 }, { x: 0.65, y: 0.4 }],
  mouth: [{ x: 0.4, y: 0.7 }, { x: 0.6, y: 0.7 }, { x: 0.6, y: 0.8 }, { x: 0.4, y: 0.8 }] }] };
function lut() {
  const values = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
    values.push(r * 0.95 + g * 0.02, g * 0.95 + b * 0.02, b * 0.95 + r * 0.02);
  }
  return { size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], values };
}
const source = await encode16(gradient());

test('PNG and TIFF exports retain more than 256 measured levels after neutral, exposure, curves/HSL/LUT and face masks', async () => {
  const original = Buffer.from(source);
  const sourcePixels = await decode16(source);
  for (let channel = 0; channel < 3; channel++) assert.equal(levels(sourcePixels, channel), 540);
  const variants = {
    neutral: {}, exposure: { exposure: 0.3 },
    curvesHSLandLUT: { toneCurves: { rgb: [[0, 0], [128, 140], [255, 255]], red: [[0, 0], [255, 250]] },
      hsl: { blue: { hue: 20, saturation: 20, luminance: 5 } }, lutId: 'b'.repeat(64), lutIntensity: 0.8 },
    skinAndFaceLight: { skinSmoothing: 1, faceLight: 0.2 }
  };
  for (const format of ['png', 'tiff']) for (const [name, adjustments] of Object.entries(variants)) {
    const output = await renderImage(source, adjustments, { format, landmarks, lut: lut() });
    assert.equal((await sharp(output).metadata()).depth, 'ushort', `${format}/${name}`);
    const actual = await decode16(output);
    for (let channel = 0; channel < 3; channel++) {
      assert.ok(levels(actual, channel) > 350, `${format}/${name}/channel ${channel} must retain real 16-bit gradation`);
    }
  }
  assert.deepEqual(source, original, 'Source bytes must remain unchanged');
});

test('each global/detail operation preserves deep tonal precision instead of promoting 8-bit results', async () => {
  for (const [control, value] of Object.entries({ contrast: 1.2, saturation: 1.1, vibrance: 0.4, temperature: 15,
    tint: 10, shadows: 0.4, highlights: -0.2, denoise: 0.5, sharpness: 0.4, clarity: 0.4, vignette: 0.5 })) {
    const image = await decode16(await renderImage(source, { [control]: value }, { format: 'png' }));
    for (let channel = 0; channel < 3; channel++) assert.ok(levels(image, channel) > 350, `${control}/channel ${channel}`);
  }
});

test('TIFF16 decoder input, full-range alpha and optional 8-bit outputs retain the correct sample domains', async () => {
  const graySamples = gradient(40000);
  for (let offset = 0; offset < graySamples.length; offset += 4) graySamples[offset + 1] = graySamples[offset + 2] = graySamples[offset];
  const tiff = await encode16(graySamples, 'tiff');
  const output = await renderImage(tiff, { exposure: 0.2, skinSmoothing: 0.8, faceLight: 0.1 }, { format: 'tiff', landmarks });
  const image = await decode16(output);
  for (let channel = 0; channel < 3; channel++) assert.ok(levels(image, channel) > 300);
  for (const [x, y] of [[2, 2], [512, 32], [800, 32]]) assert.ok(Math.abs(image.samples[(y * width + x) * 4 + 3] - 40000) <= 1);
  const eight = await renderImage(source, {}, { format: 'png', bitDepth: 8 });
  assert.equal((await sharp(eight).metadata()).depth, 'uchar');
  const expandedEight = await decode16(eight);
  for (let channel = 0; channel < 3; channel++) assert.ok(levels(expandedEight, channel) <= 256, 'Negative control must detect 8-bit quantization');
  assert.equal((await sharp(await renderImage(source, {}, { format: 'jpeg' })).metadata()).depth, 'uchar');
});

test('colour-style identity LUT and linear curves preserve exact ushort samples and alpha', async () => {
  const data = gradient(31000), copy = new Uint16Array(data);
  const identityValues = [];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) identityValues.push(r, g, b);
  const image = { data, info: { width, height, channels: 4, depth: 'ushort' } };
  await applyColorStyle(image, { toneCurves: { rgb: [[0, 0], [255, 255]] }, lutId: 'c'.repeat(64) },
    { size: 2, values: identityValues, domainMin: [0, 0, 0], domainMax: [1, 1, 1] });
  assert.deepEqual(data, copy);
});

test('8-bit export quantizes only after 16-bit shadow recovery and strong exposure', async () => {
  const w = 1024, h = 8, dark = new Uint16Array(w * h * 4);
  for (let index = 0; index < w * h; index++) {
    dark[index * 4] = dark[index * 4 + 1] = dark[index * 4 + 2] = 500 + index % w;
    dark[index * 4 + 3] = 65535;
  }
  const input = await encode16(dark, 'png', w, h);
  const adjustments = { exposure: 3, shadows: 0.3 };
  const sixteen = await renderImage(input, adjustments, { format: 'png', bitDepth: 16 });
  const eight = await renderImage(input, adjustments, { format: 'png', bitDepth: 8 });
  const expected = await sharp(sixteen).toColourspace('srgb').ensureAlpha().raw().toBuffer();
  const actual = await sharp(eight).ensureAlpha().raw().toBuffer();
  assert.deepEqual(actual, expected, 'Final 8-bit output must equal conversion of the fully processed 16-bit result');
  const prematurelyQuantized = await sharp(input).toColourspace('srgb').png().toBuffer();
  const wrong = await sharp(await renderImage(prematurelyQuantized, adjustments, { format: 'png', bitDepth: 8 })).ensureAlpha().raw().toBuffer();
  assert.notDeepEqual(actual, wrong, 'Working from an 8-bit input must not masquerade as the 16-bit pipeline');
  const correctLevels = new Set(Array.from({ length: w }, (_, index) => actual[index * 4])).size;
  const wrongLevels = new Set(Array.from({ length: w }, (_, index) => wrong[index * 4])).size;
  assert.ok(correctLevels > wrongLevels * 5);
});

test('crop positions are normalized, bounded and applied after rotation and mirroring', async () => {
  assert.equal(normalizeAdjustments().cropX, 0.5); assert.equal(normalizeAdjustments().cropY, 0.5);
  assert.equal(normalizeAdjustments({ cropX: -3, cropY: 9 }).cropX, 0);
  assert.equal(normalizeAdjustments({ cropX: -3, cropY: 9 }).cropY, 1);
  const w = 100, h = 40, data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const offset = (y * w + x) * 4; data[offset] = 2000 + x * 600;
    data[offset + 1] = 3000 + y * 600; data[offset + 2] = 20000; data[offset + 3] = 65535;
  }
  const input = await encode16(data, 'png', w, h);
  const left = await decode16(await renderImage(input, { cropRatio: 1, cropX: 0 }, { format: 'png' }));
  const right = await decode16(await renderImage(input, { cropRatio: 1, cropX: 1 }, { format: 'png' }));
  assert.equal(left.width, 40); assert.equal(left.height, 40);
  assert.ok(right.samples[0] - left.samples[0] > 30000);
  const flipped = await decode16(await renderImage(input, { cropRatio: 1, cropX: 0, flipHorizontal: true }, { format: 'png' }));
  assert.ok(flipped.samples[0] > right.samples[0]);
  const rotatedTop = await decode16(await renderImage(input, { cropRatio: 1, cropY: 0, rotation: 90 }, { format: 'png' }));
  const rotatedBottom = await decode16(await renderImage(input, { cropRatio: 1, cropY: 1, rotation: 90 }, { format: 'png' }));
  const fullRotation = await decode16(await renderImage(input, { rotation: 90 }, { format: 'png' }));
  assert.ok(Math.abs(rotatedTop.samples[0] - fullRotation.samples[0]) <= 2);
  assert.ok(Math.abs(rotatedBottom.samples[0] - fullRotation.samples[(60 * 40) * 4]) <= 2);
  assert.ok(Math.abs(rotatedTop.samples[0] - rotatedBottom.samples[0]) > 20000);
});
