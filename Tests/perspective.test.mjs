import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { applyPerspective } from '../desktop/perspective.mjs';
import { renderImage, normalizeAdjustments } from '../desktop/image-engine.mjs';

function bitmap(width = 1024, height = 128, alpha = 45000) {
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    data[index] = 12000 + x * 23 + y * 9;
    data[index + 1] = 18000 + x * 17 + y * 13;
    data[index + 2] = 24000 + x * 11 + y * 17;
    data[index + 3] = alpha;
  }
  return { data, info: { width, height, channels: 4, depth: 'ushort' } };
}
const sample = (image, x, y) => Array.from(image.data.subarray((y * image.info.width + x) * 4, (y * image.info.width + x) * 4 + 4));
async function encode(image) {
  return sharp(image.data, { raw: { width: image.info.width, height: image.info.height, channels: 4 } })
    .pipelineColourspace('rgb16').toColourspace('rgb16').png().toBuffer();
}
async function decode(buffer) {
  const result = await sharp(buffer).toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return { data: new Uint16Array(result.data.buffer, result.data.byteOffset, result.data.length / 2), info: result.info };
}

test('perspective defaults, bounds and neutral transform retain exact samples', async () => {
  const image = bitmap();
  assert.strictEqual(await applyPerspective(image), image);
  assert.strictEqual(await applyPerspective(image, NaN, Infinity), image);
  assert.equal(normalizeAdjustments().perspectiveHorizontal, 0);
  assert.equal(normalizeAdjustments().perspectiveVertical, 0);
  const adjustments = normalizeAdjustments({ perspectiveHorizontal: -8, perspectiveVertical: 9 });
  assert.equal(adjustments.perspectiveHorizontal, -0.5);
  assert.equal(adjustments.perspectiveVertical, 0.5);
  const clamped = await applyPerspective(image, -8, 9);
  const expected = await applyPerspective(image, -0.5, 0.5);
  assert.ok(Buffer.from(clamped.data.buffer).equals(Buffer.from(expected.data.buffer)));
});

test('inverse homography bilinearly samples the original 16-bit gradient', async () => {
  const image = bitmap(), h = 0.24, v = -0.13;
  const output = await applyPerspective(image, h, v);
  for (const [x, y] of [[300, 32], [450, 60], [650, 90], [720, 72]]) {
    const nx = (x + 0.5) * 2 / image.info.width - 1, ny = (y + 0.5) * 2 / image.info.height - 1;
    const divisor = 1 - 0.75 * h * nx - 0.75 * v * ny;
    const sx = (nx / divisor + 1) * image.info.width / 2 - 0.5;
    const sy = (ny / divisor + 1) * image.info.height / 2 - 0.5;
    const expected = [12000 + sx * 23 + sy * 9, 18000 + sx * 17 + sy * 13, 24000 + sx * 11 + sy * 17];
    const actual = sample(output, x, y);
    for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(actual[channel] - expected[channel]) <= 1);
    assert.equal(actual[3], 45000);
  }
  for (let channel = 0; channel < 3; channel++) {
    const levels = new Set();
    for (let x = 240; x < 780; x++) levels.add(sample(output, x, 64)[channel]);
    assert.ok(levels.size > 500, `channel ${channel} must retain real deep gradation`);
  }
});

test('projected grid lines stay straight and follow the expected converging geometry', async () => {
  const width = 320, height = 256, image = bitmap(width, height, 65535);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const grid = [64, 160, 224].some(line => Math.abs(x - line) <= 2) || [40, 128, 216].some(line => Math.abs(y - line) <= 2);
    const index = (y * width + x) * 4;
    image.data[index] = image.data[index + 1] = image.data[index + 2] = grid ? 2000 : 50000;
  }
  const horizontal = 0.25, vertical = 0.35, output = await applyPerspective(image, horizontal, vertical);
  const sourceLine = (224 + 0.5) * 2 / width - 1, positions = [];
  for (const y of [70, 100, 155, 185]) {
    const ny = (y + 0.5) * 2 / height - 1;
    const expectedX = ((sourceLine * (1 - 0.75 * vertical * ny) / (1 + sourceLine * 0.75 * horizontal)) + 1) * width / 2 - 0.5;
    let best = 65535, found = 0;
    for (let x = Math.floor(expectedX) - 5; x <= Math.ceil(expectedX) + 5; x++) {
      const value = sample(output, x, y)[0];
      if (value < best) { best = value; found = x; }
    }
    assert.ok(best < 3000, 'The actual transformed grid must contain the projected line');
    assert.ok(Math.abs(found - expectedX) < 3);
    positions.push([y, found]);
  }
  assert.ok(positions[0][1] - positions.at(-1)[1] > 8, 'Vertical keystone must converge the grid');
  const first = positions[0], last = positions.at(-1);
  for (const [y, x] of positions.slice(1, -1)) {
    const straightX = first[1] + (last[1] - first[1]) * (y - first[0]) / (last[0] - first[0]);
    assert.ok(Math.abs(x - straightX) < 2, 'A homography must preserve straight lines');
  }
});

test('transparent exterior and premultiplied interpolation prevent hidden-color fringes', async () => {
  const image = bitmap(128, 128, 65535);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = (y * 128 + x) * 4;
    if (x < 64) image.data.set([65535, 0, 65535, 0], i);
    else image.data.set([10000, 30000, 50000, 45000], i);
  }
  const result = await applyPerspective(image, 0.5, 0.5);
  let clear = 0, partial = 0;
  for (let i = 0; i < result.data.length; i += 4) {
    const alpha = result.data[i + 3];
    if (!alpha) { clear++; assert.equal(result.data[i] + result.data[i + 1] + result.data[i + 2], 0); }
    else {
      assert.equal(result.data[i], 10000); assert.equal(result.data[i + 1], 30000); assert.equal(result.data[i + 2], 50000);
      if (alpha < 45000) partial++;
    }
  }
  assert.ok(clear > 128 && partial > 50);
});

test('engine applies perspective after rotation/mirror, before crop and keeps PNG16/TIFF16 precision', async () => {
  const source = await encode(bitmap()), adjustments = { rotation: 90, flipHorizontal: true, perspectiveHorizontal: 0.22, perspectiveVertical: -0.1, cropRatio: 1, cropX: 0.3, cropY: 0.7 };
  const rotated = await sharp(source).pipelineColourspace('rgb16').flop().rotate(90).toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const expectedImage = await applyPerspective(rotated, adjustments.perspectiveHorizontal, adjustments.perspectiveVertical);
  const size = 128, left = 0, top = Math.min(1024 - size, Math.floor(0.7 * 1024 - size / 2));
  const expected = await decode(await sharp(expectedImage.data, { raw: { width: 128, height: 1024, channels: 4 } }).pipelineColourspace('rgb16')
    .extract({ left, top, width: size, height: size }).withIccProfile('srgb').toColourspace('rgb16').png().toBuffer());
  const output = await decode(await renderImage(source, adjustments, { format: 'png' }));
  assert.equal(output.info.width, size); assert.equal(output.info.height, size);
  const expectedSamples = expected.data;
  let maxDifference = 0;
  for (let index = 0; index < expectedSamples.length; index++) maxDifference = Math.max(maxDifference, Math.abs(output.data[index] - expectedSamples[index]));
  assert.ok(maxDifference <= 2, `Geometry reference maximum sample difference: ${maxDifference}`);
  for (const format of ['png', 'tiff']) {
    const result = await decode(await renderImage(source, { perspectiveHorizontal: 0.2, perspectiveVertical: -0.1 }, { format }));
    assert.equal(result.info.depth, 'ushort');
    for (let channel = 0; channel < 3; channel++) {
      const levels = new Set();
      for (let x = 240; x < 780; x++) levels.add(sample(result, x, 64)[channel]);
      assert.ok(levels.size > 500);
    }
  }
});

test('large perspective operations yield while enforcing the bounded bitmap contract', async () => {
  let yielded = false;
  const pending = applyPerspective(bitmap(), 0.2, 0.2);
  setImmediate(() => { yielded = true; });
  await pending;
  assert.ok(yielded);
  await assert.rejects(applyPerspective({ data: new Uint16Array(4), info: { width: 180_000_001, height: 1, channels: 4, depth: 'ushort' } }, 0.1, 0), /Dimensions/);
});
