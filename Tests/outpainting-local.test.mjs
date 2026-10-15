import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { expandImage } from '../desktop/outpainting.mjs';

async function fixture() {
  const width = 48, height = 32, samples = new Uint16Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    samples[pixel * 4] = (pixel * 41 + 3) % 65536;
    samples[pixel * 4 + 1] = (pixel * 17 + 711) % 65536;
    samples[pixel * 4 + 2] = (pixel * 29 + 3701) % 65536;
    samples[pixel * 4 + 3] = [0, 17011, 44001, 65535][pixel % 4];
  }
  const imageData = await sharp(samples, { raw: { width, height, channels: 4 } }).pipelineColourspace('rgb16').toColourspace('rgb16').png().withExif({ IFD0: { Artist: 'PRIVATE ORIGINAL METADATA' } }).toBuffer();
  return { imageData, width, height };
}
const raw16 = image => sharp(image).pipelineColourspace('rgb16').toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer();

test('local expansion uses its injected generator without cloud requests and copies every original RGBA16 sample', async () => {
  const { imageData, width, height } = await fixture(), source = await raw16(imageData), copy = Buffer.from(imageData);
  const previousFetch = globalThis.fetch; let fetches = 0, generated = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('Cloud calls are forbidden in this test'); };
  try {
    const result = await expandImage({ imageData, provider: 'local', margins: { left: 25, right: 50, top: 50, bottom: 25 }, instruction: 'Continuer le fond naturellement.',
      generate: async config => {
        generated++; assert.equal(config.provider, 'local'); assert.ok(!config.apiKey);
        assert.match(config.instruction, /rectangle original commence en x=12, y=16/);
        const metadata = await sharp(config.imageData).metadata();
        assert.equal(metadata.width, 84); assert.equal(metadata.height, 56); assert.equal(metadata.exif, undefined);
        // A local reference model may return a different image resolution and
        // may repaint the center. Neither can alter protected source samples.
        return sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 0, g: 120, b: 240, alpha: 1 } } }).png().withExif({ IFD0: { Artist: 'GENERATOR METADATA' } }).toBuffer();
      } });
    assert.equal(fetches, 0); assert.equal(generated, 1); assert.deepEqual(imageData, copy);
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.width, 84); assert.equal(metadata.height, 56); assert.equal(metadata.bitsPerSample, 16); assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.exif, undefined);
    const pixels = await raw16(result), canvasWidth = 84;
    for (let row = 0; row < height; row++) assert.deepEqual(pixels.subarray(((row + 16) * canvasWidth + 12) * 8, ((row + 16) * canvasWidth + 12 + width) * 8), source.subarray(row * width * 8, (row + 1) * width * 8));
    assert.notDeepEqual(pixels.subarray(0, 8), source.subarray(0, 8));
  } finally { globalThis.fetch = previousFetch; }
});

test('local expansion requires its local generator and never falls back to a cloud provider', async () => {
  const { imageData } = await fixture(), previousFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected cloud request'); };
  try {
    await assert.rejects(expandImage({ imageData, provider: 'local', margins: { left: 25 } }), /moteur de génération/);
    const intentionalError = new Error('Local generator unavailable');
    await assert.rejects(expandImage({ imageData, provider: 'local', margins: { left: 25 }, generate: async () => { throw intentionalError; } }), error => error === intentionalError);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('local expansion validates margins and cancellation before invoking generation', async () => {
  const { imageData } = await fixture(), controller = new AbortController(); let calls = 0;
  const generate = async () => { calls++; assert.fail('Generator must not run'); };
  for (const margins of [{ left: -1 }, { right: 101 }, { top: Number.NaN }, { bottom: '20' }, { other: 20 }, {}]) await assert.rejects(expandImage({ imageData, provider: 'local', margins, generate }));
  controller.abort();
  await assert.rejects(expandImage({ imageData, provider: 'local', margins: { left: 25 }, signal: controller.signal, generate }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('cancellation after local generation prevents returning a new photo', async () => {
  const { imageData } = await fixture(), controller = new AbortController();
  await assert.rejects(expandImage({ imageData, provider: 'local', margins: { left: 25 }, signal: controller.signal,
    generate: async () => { controller.abort(); return imageData; } }), { name: 'AbortError' });
});
