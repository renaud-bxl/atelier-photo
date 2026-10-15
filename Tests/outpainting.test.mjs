import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { expandImage } from '../desktop/outpainting.mjs';
import { edit, parseRecommendation } from '../desktop/ai-service.mjs';

const config = { provider: 'openai', model: 'gpt-image-2.5-sunburst', apiKey: 'only-an-offline-test-key' };
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fromURL = value => Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
const aiPixels = await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 10, g: 20, b: 200, alpha: 1 } } })
  .withMetadata({ exif: { IFD0: { Artist: 'Provider metadata must not persist' } } }).png().toBuffer();

async function source16(width = 301, height = 19, metadata = true) {
  const samples = new Uint16Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    samples[pixel * 4] = (500 + pixel * 5) % 65536;
    samples[pixel * 4 + 1] = (1023 + pixel * 7) % 65536;
    samples[pixel * 4 + 2] = (25000 + pixel * 3) % 65536;
    samples[pixel * 4 + 3] = [0, 7000, 32768, 65535][pixel % 4];
  }
  let image = sharp(samples, { raw: { width, height, channels: 4 } })
    .pipelineColourspace('rgb16').toColourspace('rgb16');
  if (metadata) image = image.withMetadata({ exif: { IFD0: { Artist: 'Private source metadata', Copyright: 'Synthetic test' } } });
  return image.png().toBuffer();
}
async function raw16(bytes, rectangle) {
  let image = sharp(bytes);
  if (rectangle) image = image.extract(rectangle);
  return image.pipelineColourspace('rgb16').toColourspace('rgb16').ensureAlpha().raw({ depth: 'ushort' }).toBuffer();
}
function mockImages(t, inspect = () => {}) {
  return t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    await inspect(url, options, body);
    return url.startsWith('https://api.openai.com/')
      ? response({ data: [{ b64_json: aiPixels.toString('base64') }] })
      : response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: aiPixels.toString('base64') } }] } }] });
  });
}

test('OpenAI expands asymmetric margins and preserves every original RGBA16 sample, including alpha-zero RGB', async t => {
  const imageData = await source16();
  const inputHash = createHash('sha256').update(imageData).digest('hex');
  let request;
  mockImages(t, async (url, options, body) => {
    request = body;
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(options.redirect, 'error');
    const padded = fromURL(body.images[0].image_url);
    const mask = fromURL(body.mask.image_url);
    const [photoMetadata, maskMetadata] = await Promise.all([sharp(padded).metadata(), sharp(mask).metadata()]);
    assert.equal(photoMetadata.width, 406); assert.equal(photoMetadata.height, 48);
    assert.equal(maskMetadata.width, photoMetadata.width); assert.equal(maskMetadata.height, photoMetadata.height);
    assert.equal(photoMetadata.exif, undefined); assert.equal(maskMetadata.exif, undefined);
    const maskPixels = await sharp(mask).ensureAlpha().raw().toBuffer();
    assert.equal(maskPixels[3], 0);
    assert.equal(maskPixels[((19 * 406 + 75) * 4) + 3], 255); // Source alpha-zero pixel is protected too.
    assert.equal(maskPixels[((37 * 406 + 375) * 4) + 3], 255);
    assert.equal(maskPixels[((19 * 406 + 376) * 4) + 3], 0);
    const paddedPixels = await sharp(padded).ensureAlpha().raw().toBuffer();
    assert.equal(paddedPixels[((19 * 406 + 75) * 4) + 3], 0);
  });
  const png = await expandImage({ ...config, imageData, margins: { left: 25, right: 10, top: 100, bottom: 50 }, instruction: 'Prolonger la lumière du matin.' });
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png'); assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.width, 406); assert.equal(metadata.height, 48); assert.equal(metadata.channels, 4);
  for (const field of ['exif', 'xmp', 'icc', 'orientation']) assert.equal(metadata[field], undefined);
  const original = await raw16(imageData);
  const center = await raw16(png, { left: 75, top: 19, width: 301, height: 19 });
  assert.deepEqual(center, original);
  const samples = new Uint16Array(original.buffer, original.byteOffset, original.length / 2);
  assert.ok(new Set(Array.from({ length: 301 }, (_, i) => samples[i * 4])).size > 256);
  assert.ok(samples.some(value => value % 257 !== 0));
  assert.equal(samples[3], 0); assert.notEqual(samples[0], 0);
  assert.equal(samples[7], 7000); assert.equal(samples[11], 32768);
  const corner = await raw16(png, { left: 0, top: 0, width: 1, height: 1 });
  // libvips expands RGB8 to RGB16 with an 8-bit shift; alpha remains full scale.
  assert.deepEqual([...new Uint16Array(corner.buffer, corner.byteOffset, 4)], [2560, 5120, 51200, 65535]);
  assert.equal(createHash('sha256').update(imageData).digest('hex'), inputHash);
  assert.match(request.prompt, /Prolonger la lumière du matin/);
});

test('large padded image and mask are both limited to 1400px; output returns full dimensions', async t => {
  const imageData = await source16(1800, 50, false);
  mockImages(t, async (_url, _options, body) => {
    const image = await sharp(fromURL(body.images[0].image_url)).metadata();
    const mask = await sharp(fromURL(body.mask.image_url)).metadata();
    assert.equal(image.width, 1400); assert.ok(image.height <= 1400);
    assert.equal(image.width, mask.width); assert.equal(image.height, mask.height);
  });
  const result = await expandImage({ ...config, imageData, margins: { left: 25, right: 50, top: 20, bottom: 40 } });
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.width, 3150); assert.equal(metadata.height, 80);
  assert.deepEqual(await raw16(result, { left: 450, top: 10, width: 1800, height: 50 }), await raw16(imageData));
});

test('Gemini uses image instructions without an explicit OpenAI mask and still restores the source', async t => {
  const imageData = await source16(30, 20, false);
  mockImages(t, (_url, _options, body) => {
    assert.equal(body.mask, undefined);
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    assert.match(body.contents[0].parts[1].text, /rectangle original commence en x=0, y=10/);
    assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'image/png');
  });
  const result = await expandImage({ ...config, provider: 'gemini', model: 'gemini-3.1-flash-image', imageData, margins: { top: 50, right: 100 } });
  assert.equal((await sharp(result).metadata()).width, 60);
  assert.equal((await sharp(result).metadata()).height, 30);
  assert.deepEqual(await raw16(result, { left: 0, top: 10, width: 30, height: 20 }), await raw16(imageData));
});

test('margins and provider are validated before any paid request', async t => {
  const imageData = await source16(8, 8, false);
  const mock = mockImages(t);
  for (const margins of [null, [], { left: -1 }, { right: 101 }, { top: NaN }, { bottom: Infinity }, { left: '10' }, { left: true }, { center: 25 }, {}, { left: 0.001 }]) {
    await assert.rejects(expandImage({ ...config, imageData, margins }), { name: 'OutpaintingError' });
  }
  await assert.rejects(expandImage({ provider: 'claude' }), /Claude/);
  await assert.rejects(expandImage({ ...config, provider: 'other', imageData, margins: { left: 10 } }), /moteur de génération/);
  await assert.rejects(expandImage({ ...config, imageData: Buffer.from('bad'), margins: { left: 50 } }), /lire/);
  await assert.rejects(expandImage({ ...config, imageData: Buffer.alloc(100 * 1024 * 1024 + 1), margins: { left: 50 } }), /100 Mo/);
  await assert.rejects(expandImage({ ...config, imageData, instruction: 'x'.repeat(10001), margins: { left: 50 } }), /10 000/);
  assert.equal(mock.mock.callCount(), 0);
});

test('canvas dimensions and pixel budget are enforced before full-resolution decoding or network', async t => {
  const mock = mockImages(t);
  await assert.rejects(expandImage({ ...config, imageData: monochromePNG(6000, 6000), margins: { left: 100, right: 100, top: 100, bottom: 100 } }), /120 millions/);
  await assert.rejects(expandImage({ ...config, imageData: monochromePNG(20000, 1), margins: { left: 100, right: 100 } }), /32 000/);
  assert.equal(mock.mock.callCount(), 0);
});

test('cancellation prevents requests or stops processing without exposing a key', async t => {
  const imageData = await source16(30, 20, false);
  const before = new AbortController(); before.abort();
  const mock = mockImages(t);
  await assert.rejects(expandImage({ ...config, imageData, margins: { left: 50 }, signal: before.signal }), { name: 'AbortError' });
  assert.equal(mock.mock.callCount(), 0);
  const during = new AbortController();
  mock.mock.mockImplementation(async () => { during.abort(); throw new Error(`private failure ${config.apiKey}`); });
  await assert.rejects(expandImage({ ...config, imageData, margins: { bottom: 50 }, signal: during.signal }), error => error.name === 'AbortError' && !error.message.includes(config.apiKey));
});

test('explicit masks reject dimension mismatch, missing alpha, opaque masks and non-OpenAI providers', async t => {
  const imageData = await source16(30, 20, false);
  const mock = mockImages(t);
  const make = (width, channels, alpha = 0) => sharp({ create: { width, height: 20, channels, background: { r: 0, g: 0, b: 0, alpha } } }).png().toBuffer();
  for (const maskData of [Buffer.from('bad'), await make(20, 4), await make(30, 3), await make(30, 4, 1)]) {
    await assert.rejects(edit({ ...config, imageData, instruction: 'Extend', maskData }), /masque/);
  }
  await assert.rejects(edit({ ...config, provider: 'gemini', imageData, instruction: 'Extend', maskData: await make(30, 4) }), /masque/);
  assert.equal(mock.mock.callCount(), 0);
});

test('new portrait and crop parameters retain neutral defaults and bounded absolute values', () => {
  const { adjustments } = parseRecommendation(JSON.stringify({ adjustments: {
    blemishReduction: 9, skinEvenness: -3, underEyeLight: 0.15, eyeContrast: '0.2', lipSaturation: 0.3, cropX: 2,
  } }));
  assert.equal(adjustments.blemishReduction, 1); assert.equal(adjustments.skinEvenness, 0);
  assert.equal(adjustments.underEyeLight, 0.15); assert.equal(adjustments.eyeContrast, 0.2);
  assert.equal(adjustments.lipSaturation, 0.3); assert.equal(adjustments.cropX, 1); assert.equal(adjustments.cropY, 0.5);
});

// Valid, original, compact 1-bit grayscale PNG: large dimensions need no huge RGB fixture.
function monochromePNG(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 1;
  const chunk = (name, bytes) => {
    const type = Buffer.from(name); const body = Buffer.concat([type, bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((Math.ceil(width / 8) + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
