import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import * as libraw from '@janhapke/libraw';
import sharp from 'sharp';
import { isRaw, identifyRaw, resolveRawSource } from '../desktop/raw-decoder.mjs';

// Original synthetic fixture: a 16-bit RGGB sensor ramp, no embedded JPEG or camera photo.
// TIFF/DNG tag layout is standard; the upstream LibRaw fixture documentation informed
// the required tag set, not the image content or this writer implementation.
import { syntheticBayerDNG } from './fixtures/synthetic-dng.mjs';

async function fixture(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-raw16-test-'));
  const path = join(directory, 'synthetic.dng');
  await writeFile(path, syntheticBayerDNG());
  try { return await callback({ directory, path, cacheDirectory: join(directory, 'cache') }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function ushortPixels(path) {
  const { data, info } = await sharp(path).pipelineColourspace('rgb16').toColourspace('rgb16')
    .raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  return { samples: new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2), info };
}

test('native package loads and advertises camera models and the expected LibRaw version', () => {
  assert.match(libraw.version(), /0\.22\.2/);
  assert.ok(libraw.cameraCount() > 1000);
  assert.equal(libraw.cameraList().length, libraw.cameraCount());
  assert.ok(libraw.cameraList().some(name => /Canon/.test(name)));
  assert.ok(libraw.cameraList().some(name => /Nikon/.test(name)));
});

test('RAW extension detection is case insensitive and non-RAW paths pass through unchanged', async () => {
  for (const name of ['photo.DNG', 'image.NEF', '/camera/file.cr3', 'photo.ARW', 'image.raf', 'file.RW2']) assert.equal(isRaw(name), true);
  for (const value of ['photo.jpeg', 'file.tiff', 'image.png', '', null]) assert.equal(isRaw(value), false);
  assert.equal(await resolveRawSource('/not-read/photo.tiff'), '/not-read/photo.tiff');
});

test('metadata-only identification reads an actual Bayer DNG with no embedded preview', async () => fixture(async ({ path }) => {
  const metadata = await identifyRaw(path);
  assert.equal(metadata.width, 1024); assert.equal(metadata.height, 64);
  assert.equal(metadata.bits, 16); assert.equal(metadata.format, 'raw');
  assert.match(metadata.make, /Atelier Photo/);
  assert.match(metadata.model, /Synthetic/);
  const proc = new libraw.Processor();
  try { await proc.openFile(path); assert.equal(proc.metadata.idata.raw_count, 1); }
  finally { proc.close(); }
}));

test('native demosaic produces cached TIFF16 with over 256 real levels and a lossless TIFF round trip', async () => fixture(async ({ path, cacheDirectory, directory }) => {
  const original = createHash('sha256').update(await readFile(path)).digest('hex');
  const cached = await resolveRawSource(path, { cacheDirectory, fullResolution: true });
  const metadata = await sharp(cached).metadata();
  assert.equal(metadata.format, 'tiff'); assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.bitsPerSample, 16);
  assert.equal(metadata.width, 1024); assert.equal(metadata.height, 64);
  const { samples, info } = await ushortPixels(cached);
  const redValues = new Set();
  for (let i = 0; i < samples.length; i += info.channels) redValues.add(samples[i]);
  assert.ok(redValues.size > 256, `Only ${redValues.size} distinct red samples`);
  assert.ok([...redValues].some(value => value % 257 !== 0), 'Data must not be an 8-bit image widened to 16-bit');
  const roundTrip = join(directory, 'roundtrip.tiff');
  await sharp(cached).pipelineColourspace('rgb16').toColourspace('rgb16').tiff({ compression: 'lzw' }).toFile(roundTrip);
  const again = await ushortPixels(roundTrip);
  assert.deepEqual(again.samples, samples);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), original);
}));

test('preview is half-size but still TIFF16; full-resolution export uses a different cache key', async () => fixture(async ({ path, cacheDirectory }) => {
  const preview = await resolveRawSource(path, { cacheDirectory });
  const full = await resolveRawSource(path, { cacheDirectory, fullResolution: true });
  assert.notEqual(preview, full);
  assert.match(basename(full), /^atelier-raw16-v1-[a-f0-9]{64}\.tiff$/);
  const small = await sharp(preview).metadata(); const large = await sharp(full).metadata();
  assert.equal(small.width, large.width / 2); assert.equal(small.height, large.height / 2);
  assert.equal(small.bitsPerSample, 16);
}));

test('concurrent identical requests share one atomic cache result and preserve unrelated files', async () => fixture(async ({ path, cacheDirectory }) => {
  const [first, second] = await Promise.all([
    resolveRawSource(path, { cacheDirectory, fullResolution: true }),
    resolveRawSource(path, { cacheDirectory, fullResolution: true }),
  ]);
  assert.equal(first, second);
  const firstStat = await stat(first);
  const same = await resolveRawSource(path, { cacheDirectory, fullResolution: true });
  assert.equal(same, first); assert.equal((await stat(first)).mtimeMs, firstStat.mtimeMs);
  const folder = join(cacheDirectory, 'raw16-v1');
  await writeFile(join(folder, 'user-document.txt'), 'Never remove user files');
  const files = await readdir(folder);
  assert.equal(files.filter(name => name.endsWith('.tiff')).length, 1);
  assert.equal(files.some(name => name.includes('.tmp')), false);
  const marker = JSON.parse(await readFile(first + '.json', 'utf8'));
  assert.equal(marker.owner, 'com.rea.atelierphoto.raw16'); assert.equal(marker.bits, 16);
  assert.match(marker.version, /@janhapke\/libraw@0\.1\.0/);
}));

test('canonical path and source mtime participate in the cache identity', async () => fixture(async ({ path, cacheDirectory }) => {
  const first = await resolveRawSource(path, { cacheDirectory });
  const alias = await resolveRawSource(join(path, '..', 'synthetic.dng'), { cacheDirectory });
  assert.equal(first, alias);
  const old = await stat(path);
  await utimes(path, old.atime, new Date(old.mtimeMs + 2000));
  const changed = await resolveRawSource(path, { cacheDirectory });
  assert.notEqual(changed, first);
}));

test('invalid RAWs fail explicitly and never fall back to a JPEG or bogus TIFF', async () => fixture(async ({ directory, cacheDirectory }) => {
  const invalid = join(directory, 'broken.nef'); await writeFile(invalid, 'This is not a RAW file');
  await assert.rejects(identifyRaw(invalid), /RAW/);
  await assert.rejects(resolveRawSource(invalid, { cacheDirectory }), /RAW/);
  const jpeg = join(directory, 'jpeg-renamed.dng');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#abcdef' } }).jpeg().toFile(jpeg);
  await assert.rejects(resolveRawSource(jpeg, { cacheDirectory }), /RAW/);
}));

test('cancelled request does not create output and does not cancel another caller', async () => fixture(async ({ path, cacheDirectory }) => {
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(resolveRawSource(path, { cacheDirectory, signal: stopped.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  const cancelled = resolveRawSource(path, { cacheDirectory, fullResolution: true, signal: controller.signal });
  const active = resolveRawSource(path, { cacheDirectory, fullResolution: true });
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  const result = await active;
  assert.equal((await sharp(result).metadata()).bitsPerSample, 16);
}));
