import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { applyColorStyle, normalizeColorStyle, validateColorLUT } from '../desktop/color-style.mjs';
import { normalizeAdjustments, renderImage } from '../desktop/image-engine.mjs';

const LUT_ID = 'a'.repeat(64);
const frame = (pixels, channels = 4) => ({ data: Buffer.from(pixels), info: { width: pixels.length / channels, height: 1, channels } });
function cube(size = 2, operation = (r, g, b) => [r, g, b], domainMin = [0, 0, 0], domainMax = [1, 1, 1]) {
  const values = [];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    values.push(...operation(r / (size - 1), g / (size - 1), b / (size - 1)));
  }
  return { size, values, domainMin, domainMax };
}
async function mapped(pixels, lut, intensity = 1) {
  const image = frame(pixels);
  await applyColorStyle(image, { lutId: LUT_ID, lutIntensity: intensity }, lut);
  return [...image.data];
}

test('identity 2×2×2 LUT preserves all RGB bytes and alpha exactly', async () => {
  const bytes = [];
  for (let index = 0; index < 256; index++) bytes.push(index, 255 - index, (index * 71) % 256, index);
  assert.deepEqual(await mapped(bytes, cube()), bytes);
  const rgb = frame([2, 11, 255, 113, 219, 0], 3);
  await applyColorStyle(rgb, { lutId: LUT_ID }, cube());
  assert.deepEqual([...rgb.data], [2, 11, 255, 113, 219, 0]);
});

test('red-fastest cube ordering handles swizzle and inversion with known pixels', async () => {
  assert.deepEqual(await mapped([64, 128, 192, 37], cube(2, (r, g, b) => [b, r, g])), [192, 64, 128, 37]);
  assert.deepEqual(await mapped([51, 102, 204, 91], cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b])), [204, 153, 51, 91]);
});

test('trilinear interpolation uses all three fractions and each channel domain', async () => {
  const mixed = cube(2, (r, g, b) => [r * g, g * b, b * r]);
  assert.deepEqual(await mapped([128, 64, 192, 255], mixed), [32, 48, 96, 255]);
  const domain = cube(2, (r, g, b) => [r, g, b], [0.2, 0.1, 0.3], [0.8, 0.9, 0.7]);
  assert.deepEqual(await mapped([128, 102, 128, 15], domain), [128, 96, 129, 15]);
  assert.deepEqual(await mapped([0, 255, 0, 15], domain), [0, 255, 0, 15]);
  const defaults = cube(); delete defaults.domainMin; delete defaults.domainMax;
  assert.deepEqual(await mapped([64, 128, 192, 15], defaults), [64, 128, 192, 15]);
});

test('LUT intensity zero, one and fractional mixing have exact endpoints', async () => {
  const inverted = cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b]);
  const input = [40, 100, 180, 123];
  assert.deepEqual(await mapped(input, inverted, 0), input);
  assert.deepEqual(await mapped(input, inverted, 1), [215, 155, 75, 123]);
  assert.deepEqual(await mapped(input, inverted, 0.25), [84, 114, 154, 123]);
});

test('LUT schema, sample finiteness and domains are validated before pixels mutate', async () => {
  const invalid = [null, { ...cube(), size: 1 }, { ...cube(), size: 66 }, { ...cube(), size: 2.5 },
    { ...cube(), values: [0, 1, 2] }, { ...cube(), domainMin: [0, 0] },
    { ...cube(), domainMax: [1, 0, 1] }, { ...cube(), domainMax: [1, NaN, 1] },
    { ...cube(), values: cube().values.map((value, index) => index === 12 ? NaN : value) },
    { ...cube(), values: cube().values.map((value, index) => index === 12 ? Infinity : value) }];
  for (const lut of invalid) {
    const image = frame([50, 100, 150, 17]);
    await assert.rejects(applyColorStyle(image, { lutId: LUT_ID, grain: 100 }, lut), /LUT/);
    assert.deepEqual([...image.data], [50, 100, 150, 17]);
  }
  await assert.rejects(applyColorStyle(frame([1, 2, 3, 4]), { lutId: LUT_ID, lutIntensity: 0 }), /LUT/);
  const typed = cube(); typed.values = new Float32Array(typed.values);
  assert.equal((await validateColorLUT(typed)).size, 2);
});

test('normalization clamps controls, validates SHA-256 LUT IDs and ignores malformed curves', () => {
  assert.deepEqual(normalizeColorStyle(null), {});
  const style = normalizeColorStyle({ whites: 200, blacks: -200, grain: NaN, lutId: 'A'.repeat(64), lutIntensity: 2,
    hsl: { blue: { hue: Infinity, saturation: -500, luminance: 50 } },
    toneCurves: { rgb: [[255, 255], [0, 0]], red: [[0, 0], [0, 255]], blue: [[0, 0], [255, NaN]] } });
  assert.equal(style.whites, 100); assert.equal(style.blacks, -100); assert.equal(style.grain, undefined);
  assert.equal(style.lutId, LUT_ID); assert.equal(style.lutIntensity, 1);
  assert.deepEqual(style.hsl.blue, { hue: 0, saturation: -100, luminance: 50 });
  assert.deepEqual(style.toneCurves, { rgb: [[0, 0], [255, 255]] });
  assert.throws(() => normalizeColorStyle({ lutId: '../evil.cube' }), /LUT/);
  assert.equal(normalizeAdjustments({ whites: 23 }).whites, 23);
});

test('master and per-channel curves compose without rounding intermediate values', async () => {
  const identity = frame([0, 127, 255, 11]);
  await applyColorStyle(identity, { toneCurves: { rgb: [[0, 0], [255, 255]] } });
  assert.deepEqual([...identity.data], [0, 127, 255, 11]);
  const small = frame([1, 1, 1, 11]);
  await applyColorStyle(small, { toneCurves: { rgb: [[0, 0], [255, 127.5]], red: [[0, 0], [255, 127.5]] } });
  assert.deepEqual([...small.data], [0, 1, 1, 11]);
  const channels = frame([64, 128, 192, 53]);
  await applyColorStyle(channels, { toneCurves: { red: [[0, 255], [255, 0]], green: [[0, 0], [255, 127.5]], blue: [[0, 0], [255, 255]] } });
  assert.deepEqual([...channels.data], [191, 64, 192, 53]);
});

test('65- and 256-point XMP curves survive normalization and change rendered pixels', async () => {
  for (const length of [65, 256]) {
    const points = Array.from({ length }, (_, index) => {
      const x = index / (length - 1) * 255;
      return [x, 255 * (x / 255) ** 0.9];
    });
    const style = normalizeColorStyle({ toneCurves: { rgb: points } });
    assert.equal(style.toneCurves.rgb.length, length);
    const image = frame([64, 128, 192, 77]);
    await applyColorStyle(image, style);
    for (let channel = 0; channel < 3; channel++) {
      const input = [64, 128, 192][channel];
      assert.ok(Math.abs(image.data[channel] - Math.round(255 * (input / 255) ** 0.9)) <= 1);
      assert.ok(image.data[channel] > input);
    }
    assert.equal(image.data[3], 77);
  }
});

test('all eight HSL families change their colours while neutral grays remain neutral', async () => {
  const samples = { red: [200, 70, 70], orange: [200, 135, 70], yellow: [200, 200, 70], green: [70, 200, 70],
    aqua: [70, 200, 200], blue: [70, 70, 200], purple: [135, 70, 200], magenta: [200, 70, 200] };
  for (const [name, sample] of Object.entries(samples)) {
    const image = frame([...sample, 61]);
    await applyColorStyle(image, { hsl: { [name]: { hue: 50, luminance: 20 } } });
    assert.notDeepEqual([...image.data].slice(0, 3), sample, name);
    assert.equal(image.data[3], 61);
  }
  const gray = frame([0, 0, 0, 19, 128, 128, 128, 29, 255, 255, 255, 39]);
  const before = Buffer.from(gray.data);
  await applyColorStyle(gray, { hsl: { red: { hue: 100, saturation: 100, luminance: 100 } } });
  assert.deepEqual(gray.data, before);
});

test('split-toning balance, whites/blacks and deterministic monochrome grain behave as documented', async () => {
  const positive = frame([128, 128, 128, 53]), negative = frame([128, 128, 128, 53]);
  const split = { shadowHue: 240, shadowSaturation: 100, highlightHue: 0, highlightSaturation: 100 };
  await applyColorStyle(positive, { splitToning: { ...split, balance: 100 } });
  await applyColorStyle(negative, { splitToning: { ...split, balance: -100 } });
  assert.ok(positive.data[0] > positive.data[2]); assert.ok(negative.data[2] > negative.data[0]);
  assert.equal(positive.data[3], 53);
  const whites = frame([30, 30, 30, 19, 220, 220, 220, 29]);
  const blacks = frame([...whites.data]);
  await applyColorStyle(whites, { whites: 50 }); await applyColorStyle(blacks, { blacks: 50 });
  assert.ok(whites.data[4] - 220 > whites.data[0] - 30);
  assert.ok(blacks.data[0] - 30 > blacks.data[4] - 220);
  const noisy = frame(Array.from({ length: 100 }, () => [128, 128, 128, 71]).flat());
  const again = frame([...noisy.data]);
  await applyColorStyle(noisy, { grain: 70 }); await applyColorStyle(again, { grain: 70 });
  assert.deepEqual(noisy.data, again.data);
  assert.ok(new Set(Array.from({ length: 100 }, (_, index) => noisy.data[index * 4])).size > 5);
  for (let index = 0; index < noisy.data.length; index += 4) {
    assert.equal(noisy.data[index], noisy.data[index + 1]); assert.equal(noisy.data[index], noisy.data[index + 2]); assert.equal(noisy.data[index + 3], 71);
  }
});

test('large pixel loops yield to the event loop and reject invalid bitmap layouts', async () => {
  const data = Buffer.alloc(256 * 1024 * 4, 100);
  const image = { data, info: { width: 1024, height: 256, channels: 4 } };
  let finished = false, responsive = false;
  const pending = applyColorStyle(image, { lutId: LUT_ID }, cube(2, (r, g, b) => [1 - r, 1 - g, 1 - b])).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(() => { responsive = !finished; resolve(); }));
  await pending; assert.equal(responsive, true);
  assert.equal(data[0], 155); assert.equal(data[3], 100);
  await assert.rejects(applyColorStyle({ data: Buffer.from([1, 2]), info: { width: 1, height: 1, channels: 2 } }, { grain: 20 }), /Dimensions/);
  await assert.rejects(applyColorStyle({ data: Buffer.from([1, 2, 3]), info: { width: 180000001, height: 1, channels: 3 } }, { grain: 20 }), /Dimensions/);
});

test('renderImage applies LUT/style options, preserves PNG alpha, and refuses missing assets', async () => {
  const input = await sharp(Buffer.from([64, 128, 192, 51]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const result = await renderImage(input, { lutId: LUT_ID }, { format: 'png', lut: cube(2, (r, g, b) => [b, r, g]) });
  assert.deepEqual([...await sharp(result).ensureAlpha().raw().toBuffer()], [192, 64, 128, 51]);
  await assert.rejects(renderImage(input, { lutId: LUT_ID }, { format: 'png' }), /LUT/);
  const invalid = cube(); invalid.values[23] = NaN;
  await assert.rejects(renderImage(input, { lutId: LUT_ID }, { format: 'png', lut: invalid }), /LUT/);
});
