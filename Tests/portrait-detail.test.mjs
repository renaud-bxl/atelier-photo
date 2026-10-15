import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { renderImage, normalizeAdjustments } from '../desktop/image-engine.mjs';

const controls = ['blemishReduction', 'skinEvenness', 'underEyeLight', 'eyeContrast', 'lipSaturation'];
const width = 320, height = 240;
const rectangle = (x, y, w, h, sw = width, sh = height) => [
  { x: x / sw, y: y / sh }, { x: (x + w) / sw, y: y / sh },
  { x: (x + w) / sw, y: (y + h) / sh }, { x: x / sw, y: (y + h) / sh }
];
const landmarks = { faces: [{ box: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
  leftEye: rectangle(85, 70, 40, 20), rightEye: rectangle(190, 70, 40, 20),
  leftIris: rectangle(99, 74, 12, 12), rightIris: rectangle(204, 74, 12, 12),
  mouth: rectangle(140, 155, 40, 15), outerLips: rectangle(130, 145, 60, 35) }] };

async function encode(samples, w, h) {
  return sharp(samples, { raw: { width: w, height: h, channels: 4 } }).pipelineColourspace('rgb16').toColourspace('rgb16').png().toBuffer();
}
async function decode(encoded) {
  const raw = await sharp(encoded).toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return { data: new Uint16Array(raw.data.buffer, raw.data.byteOffset, raw.data.length / 2), ...raw.info };
}
function pixel(image, x, y) { return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)]; }
const luma = p => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
const distance = (a, b) => a.slice(0, 3).reduce((sum, value, channel) => sum + Math.abs(value - b[channel]), 0);

async function fixture() {
  const samples = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4, texture = (x + y) % 2 ? 96 : -96;
    samples[index] = 33000 + x * 14 + texture;
    samples[index + 1] = 28000 + y * 9 + texture;
    samples[index + 2] = 25000 + x * 5 + texture;
    samples[index + 3] = 50000;
    if (x >= 75 && x < 95 && y >= 115 && y < 135) { samples[index] += 3000; samples[index + 1] -= 892; }
  }
  function fill(x, y, w, h, color) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      samples.set([...color, 50000], (row * width + col) * 4);
    }
  }
  fill(85, 70, 40, 20, [54000, 55000, 57000]); fill(190, 70, 40, 20, [54000, 55000, 57000]);
  fill(99, 74, 12, 12, [18000, 22000, 30000]); fill(204, 74, 12, 12, [18000, 22000, 30000]);
  fill(130, 145, 60, 35, [46000, 18000, 23000]); fill(140, 155, 40, 15, [20000, 24000, 20000]);
  const spot = (125 * width + 105) * 4;
  samples[spot] += 8000; samples[spot + 1] -= 6500; samples[spot + 2] -= 4500;
  return encode(samples, width, height);
}
const source = await fixture();
const neutral = await decode(await renderImage(source, {}, { format: 'png' }));

test('new portrait controls are bounded, inactive without faces, and require real iris/lip landmarks', async () => {
  for (const control of controls) {
    assert.equal(normalizeAdjustments()[control], 0);
    assert.equal(normalizeAdjustments({ [control]: 8 })[control], 1);
    assert.equal(normalizeAdjustments({ [control]: NaN })[control], 0);
  }
  const all = Object.fromEntries(controls.map(control => [control, 1]));
  assert.ok(Buffer.from((await decode(await renderImage(source, all, { format: 'png' }))).data.buffer).equals(Buffer.from(neutral.data.buffer)));
  const incomplete = structuredClone(landmarks);
  delete incomplete.faces[0].leftIris; delete incomplete.faces[0].rightIris; delete incomplete.faces[0].outerLips;
  assert.ok(Buffer.from((await decode(await renderImage(source, { eyeContrast: 1, lipSaturation: 1 }, { format: 'png', landmarks: incomplete }))).data.buffer).equals(Buffer.from(neutral.data.buffer)));
});

test('each detailed retouch changes its target, preserves the background and 16-bit alpha', async () => {
  const target = { blemishReduction: [105, 125], skinEvenness: [75, 120], underEyeLight: [105, 103], eyeContrast: [105, 80], lipSaturation: [160, 150] };
  for (const control of controls) {
    const result = await decode(await renderImage(source, { [control]: 1 }, { format: 'png', landmarks }));
    assert.ok(distance(pixel(result, ...target[control]), pixel(neutral, ...target[control])) > 10, `${control} must alter its actual target`);
    for (const point of [[2, 2], [20, 125], [300, 125], [160, 235]]) assert.deepEqual(pixel(result, ...point), pixel(neutral, ...point), `${control} must preserve pixels outside the face`);
    for (const point of Object.values(target)) assert.equal(pixel(result, ...point)[3], 50000);
  }
});

test('blemish correction attenuates a small spot without removing normal fine texture or eye detail', async () => {
  const result = await decode(await renderImage(source, { blemishReduction: 1 }, { format: 'png', landmarks }));
  const surrounding = pixel(neutral, 104, 125);
  assert.ok(distance(pixel(result, 105, 125), surrounding) < distance(pixel(neutral, 105, 125), surrounding) * 0.6);
  assert.deepEqual(pixel(result, 105, 80), pixel(neutral, 105, 80));
  assert.deepEqual(pixel(result, 115, 125), pixel(neutral, 115, 125), 'Normal high-frequency skin texture must not be globally blurred');
});

test('chroma evening preserves luminance texture; eye/lip masks protect the surrounding anatomy', async () => {
  const even = await decode(await renderImage(source, { skinEvenness: 1 }, { format: 'png', landmarks }));
  for (const point of [[75, 120], [76, 120], [77, 120]]) assert.ok(Math.abs(luma(pixel(even, ...point)) - luma(pixel(neutral, ...point))) < 80);
  const beforeTexture = luma(pixel(neutral, 76, 120)) - luma(pixel(neutral, 77, 120));
  const afterTexture = luma(pixel(even, 76, 120)) - luma(pixel(even, 77, 120));
  assert.ok(Math.abs(beforeTexture - afterTexture) < 80);
  const under = await decode(await renderImage(source, { underEyeLight: 1 }, { format: 'png', landmarks }));
  assert.ok(luma(pixel(under, 105, 103)) > luma(pixel(neutral, 105, 103)));
  assert.deepEqual(pixel(under, 105, 80), pixel(neutral, 105, 80));
  const iris = await decode(await renderImage(source, { eyeContrast: 1 }, { format: 'png', landmarks }));
  assert.deepEqual(pixel(iris, 90, 80), pixel(neutral, 90, 80), 'Sclera outside the iris must stay unchanged');
  const lips = await decode(await renderImage(source, { lipSaturation: 1 }, { format: 'png', landmarks }));
  assert.deepEqual(pixel(lips, 160, 162), pixel(neutral, 160, 162), 'The mouth cavity/teeth must be excluded');
});

test('the changed regions of every detailed portrait operation retain over 256 real levels per channel', async () => {
  const w = 1024, h = 256, samples = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const offset = (y * w + x) * 4, value = x * 5 + y * 13;
    samples[offset] = 18000 + value; samples[offset + 1] = 25000 + value; samples[offset + 2] = 32000 + value; samples[offset + 3] = 65535;
    if (x % 7 === 0 && y % 7 === 0) { samples[offset] += 6000; samples[offset + 1] -= 4500; samples[offset + 2] -= 3500; }
  }
  const input = await encode(samples, w, h), original = await decode(await renderImage(input, {}, { format: 'png' }));
  const faces = { faces: [{ box: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
    leftEye: rectangle(240, 55, 130, 40, w, h), rightEye: rectangle(650, 55, 130, 40, w, h),
    leftIris: rectangle(270, 60, 70, 30, w, h), rightIris: rectangle(680, 60, 70, 30, w, h),
    mouth: rectangle(430, 190, 150, 15, w, h), outerLips: rectangle(400, 175, 210, 45, w, h) }] };
  for (const control of controls) {
    const output = await decode(await renderImage(input, { [control]: 1 }, { format: 'png', landmarks: faces }));
    const unique = [new Set(), new Set(), new Set()]; let changed = 0;
    for (let offset = 0; offset < output.data.length; offset += 4) {
      if (Math.abs(output.data[offset] - original.data[offset]) + Math.abs(output.data[offset + 1] - original.data[offset + 1]) + Math.abs(output.data[offset + 2] - original.data[offset + 2]) < 4) continue;
      changed++;
      for (let channel = 0; channel < 3; channel++) unique[channel].add(output.data[offset + channel]);
    }
    assert.ok(changed > 300, `${control} must produce a measurable region`);
    for (let channel = 0; channel < 3; channel++) assert.ok(unique[channel].size > 256, `${control}/channel ${channel}: genuine 16-bit detail is required`);
  }
});
