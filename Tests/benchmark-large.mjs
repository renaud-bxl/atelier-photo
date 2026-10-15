// Opt-in, one-source benchmark. It is deliberately excluded from npm test.
// Run: node Tests/benchmark-large.mjs
// Every stage runs sequentially in a fresh Node process; no GUI, network or user photo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Catalog } from '../desktop/catalog.mjs';
import { getMetadata, normalizeAdjustments, renderImage } from '../desktop/image-engine.mjs';

const WIDTH = 9000, HEIGHT = 5000, MEGAPIXELS = WIDTH * HEIGHT / 1e6;
const MIB = 1024 ** 2;
const filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(filename));
sharp.cache({ memory: 64, files: 16, items: 80 });
sharp.concurrency(2);

const polygon = (left, top, right, bottom) => [
  { x: left, y: top }, { x: right, y: top },
  { x: right, y: bottom }, { x: left, y: bottom },
];
// These are deterministic test masks, not a claim that the synthetic picture is
// a detected human portrait. Face detection/model quality is outside this benchmark.
const landmarks = { faces: [{
  box: { x: 0.38, y: 0.12, width: 0.24, height: 0.58 },
  leftEye: polygon(0.425, 0.29, 0.468, 0.32),
  rightEye: polygon(0.532, 0.29, 0.575, 0.32),
  leftIris: polygon(0.441, 0.296, 0.452, 0.314),
  rightIris: polygon(0.548, 0.296, 0.559, 0.314),
  mouth: polygon(0.465, 0.51, 0.535, 0.53),
  outerLips: polygon(0.45, 0.49, 0.55, 0.55),
}] };
const color = {
  exposure: 0.2, contrast: 1.05, saturation: 1.04, temperature: 4, tint: 2,
  vibrance: 0.1, shadows: 0.15, highlights: -0.12, denoise: 0.12,
  sharpness: 0.2, clarity: 0.1, vignette: 0.15,
  toneCurves: { rgb: [[0, 0], [128, 132], [255, 255]] },
  hsl: { orange: { hue: 2, saturation: 5, luminance: 2 } },
};
const portrait = {
  skinSmoothing: 0.25, faceLight: 0.1, teethWhitening: 0.15, eyeBrightness: 0.12,
  blemishReduction: 0.3, skinEvenness: 0.2, underEyeLight: 0.2,
  eyeContrast: 0.15, lipSaturation: 0.12,
};
const perspective = { perspectiveHorizontal: 0.08, perspectiveVertical: -0.04 };
const combined = { ...color, ...portrait, ...perspective };

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function precisionSample(input) {
  // Decode a narrow interior row only. This avoids adding another 45 MP raw
  // buffer merely for validation, and avoids transparent perspective borders.
  const { data, info } = await sharp(input, { limitInputPixels: WIDTH * HEIGHT })
    .pipelineColourspace('rgb16').toColourspace('rgb16')
    .extract({ left: 400, top: 700, width: 4096, height: 1 })
    .raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const samples = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const distinct = [new Set(), new Set(), new Set()];
  let nonExpanded8BitSamples = 0;
  for (let offset = 0; offset < samples.length; offset += info.channels) {
    for (let channel = 0; channel < 3; channel++) {
      distinct[channel].add(samples[offset + channel]);
      if (samples[offset + channel] % 257 !== 0) nonExpanded8BitSamples++;
    }
  }
  return { distinctLevelsRGB: distinct.map(values => values.size), nonExpanded8BitSamples };
}

async function generateSource(path) {
  // Original, deterministic 16-bit scene: broad sky/landscape gradients and a
  // central skin-colour test region with eyes/lips and tiny coloured residuals.
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  const horizontal = Float64Array.from({ length: WIDTH }, (_, x) => x / (WIDTH - 1));
  const mountain = Int32Array.from({ length: WIDTH }, (_, x) =>
    HEIGHT * (0.62 - 0.15 * Math.abs(Math.sin(x / WIDTH * Math.PI * 3))));
  for (let y = 0; y < HEIGHT; y++) {
    const v = y / (HEIGHT - 1);
    for (let x = 0; x < WIDTH; x++) {
      const u = horizontal[x], offset = (y * WIDTH + x) * 3;
      let r = 13000 + 18000 * u + 3000 * v;
      let g = 17000 + 19000 * u + 5000 * v;
      let b = 24000 + 15000 * u + 6000 * v;
      if (y > mountain[x]) { r = 7000 + 18000 * u + 4000 * v; g = 13000 + 21000 * u + 3000 * v; b = 16000 + 19000 * u + 2000 * v; }
      const dx = (u - 0.5) / 0.12, dy = (v - 0.41) / 0.29;
      if (dx * dx + dy * dy < 1) {
        r = 42000 + 2500 * dx + 1000 * dy; g = 31000 + 2100 * dx + 800 * dy; b = 27000 + 1700 * dx + 700 * dy;
        if (v > 0.29 && v < 0.32 && (u > 0.425 && u < 0.468 || u > 0.532 && u < 0.575)) { r *= 0.45; g *= 0.45; b *= 0.45; }
        if (v > 0.49 && v < 0.55 && u > 0.45 && u < 0.55) { r *= 0.9; g *= 0.6; b *= 0.65; }
        if (x % 137 < 3 && y % 113 < 3) { r += 6500; g -= 2500; b -= 1500; }
      }
      samples[offset] = Math.round(r); samples[offset + 1] = Math.round(g); samples[offset + 2] = Math.round(b);
    }
  }
  await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } })
    .pipelineColourspace('rgb16').toColourspace('rgb16')
    .tiff({ compression: 'lzw', predictor: 'horizontal' }).toFile(path);
  const metadata = await sharp(path).metadata();
  assert.equal(metadata.width, WIDTH); assert.equal(metadata.height, HEIGHT);
  assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.bitsPerSample, 16);
  const precision = await precisionSample(path);
  assert.ok(precision.distinctLevelsRGB.every(value => value > 256));
  assert.ok(precision.nonExpanded8BitSamples > 0);
  return { width: WIDTH, height: HEIGHT, megapixels: MEGAPIXELS, bytes: (await stat(path)).size, precision, sha256: await hashFile(path) };
}

async function runStage(stage, directory) {
  const source = join(directory, 'synthetic-45mp-16bit.tiff');
  if (stage === 'generate') return generateSource(source);
  if (stage === 'metadata-import') {
    const metadata = await getMetadata(source), catalog = new Catalog(join(directory, 'catalog'));
    try {
      assert.deepEqual(catalog.importPaths([source]), { added: 1, skipped: 0 });
      const item = catalog.getByPath(source);
      catalog.update(item.id, { width: metadata.width, height: metadata.height });
      assert.equal(catalog.list({ limit: 1 }).total, 1);
      return { width: metadata.width, height: metadata.height, depth: metadata.depth, catalogPhotos: 1 };
    } finally { catalog.close(); }
  }
  const configurations = {
    'preview-color': { adjustments: color, options: { maxDimension: 1600, format: 'jpeg' } },
    'preview-portrait': { adjustments: portrait, options: { maxDimension: 1600, format: 'jpeg', landmarks } },
    'preview-perspective': { adjustments: perspective, options: { maxDimension: 1600, format: 'jpeg' } },
    'export-tiff16': { adjustments: combined, options: { format: 'tiff', bitDepth: 16, landmarks } },
    'export-jpeg': { adjustments: combined, options: { format: 'jpeg', quality: 92, landmarks } },
  };
  const configuration = configurations[stage];
  assert.ok(configuration, 'Unknown benchmark stage');
  const started = performance.now();
  const bytes = await renderImage(source, configuration.adjustments, configuration.options);
  const renderSeconds = (performance.now() - started) / 1000;
  const output = join(directory, stage + (stage === 'export-tiff16' ? '.tiff' : '.jpg'));
  await writeFile(output, bytes, { flag: 'wx' });
  const metadata = await sharp(output).metadata();
  if (stage.startsWith('export')) {
    assert.equal(metadata.width, WIDTH); assert.equal(metadata.height, HEIGHT);
  } else assert.ok(Math.max(metadata.width, metadata.height) <= 1600);
  const result = { width: metadata.width, height: metadata.height, depth: metadata.depth, bytes: bytes.length, renderSeconds };
  if (stage === 'export-tiff16') {
    assert.equal(metadata.depth, 'ushort'); assert.equal(metadata.bitsPerSample, 16);
    result.precision = await precisionSample(output);
    assert.ok(result.precision.distinctLevelsRGB.every(value => value > 256), 'Full export must retain real deep gradation');
    assert.ok(result.precision.nonExpanded8BitSamples > 0, '16-bit samples must not be expanded 8-bit values');
  }
  if (stage === 'export-jpeg') assert.equal(metadata.depth, 'uchar');
  return result;
}

async function isolatedStage(stage, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename, '--stage', stage, directory], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { if (stderr.length < 16_384) stderr += data; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0) return reject(new Error(`${stage} failed (${signal || code}): ${stderr.slice(0, 1500)}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid benchmark result for ${stage}: ${stdout.slice(0, 300)}`)); }
    });
  });
}

if (process.argv[2] === '--stage') {
  const stage = process.argv[3], directory = process.argv[4];
  const start = performance.now(), initialRss = process.memoryUsage().rss;
  let peakSampledRss = initialRss, lastTick = performance.now(), maximumEventLoopDelay = 0;
  const monitor = setInterval(() => {
    const now = performance.now(); maximumEventLoopDelay = Math.max(maximumEventLoopDelay, now - lastTick - 25); lastTick = now;
    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
  }, 25);
  try {
    const result = await runStage(stage, directory);
    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss);
    const usage = process.resourceUsage();
    console.log(JSON.stringify({ stage, seconds: (performance.now() - start) / 1000,
      renderSeconds: result.renderSeconds ?? null, peakRssMiB: usage.maxRSS / 1024,
      peakSampledRssMiB: peakSampledRss / MIB, initialRssMiB: initialRss / MIB,
      maximumEventLoopDelayMs: Math.max(0, maximumEventLoopDelay),
      userCpuSeconds: usage.userCPUTime / 1e6, systemCpuSeconds: usage.systemCPUTime / 1e6, ...result }));
  } finally { clearInterval(monitor); }
} else {
  assert.equal(process.argv.length, 2, 'Run this fixed-size benchmark without options');
  const temporary = await mkdtemp(join(os.tmpdir(), 'atelier-benchmark-45mp-'));
  try {
    const stages = [];
    for (const stage of ['generate', 'metadata-import', 'preview-color', 'preview-portrait', 'preview-perspective', 'export-tiff16', 'export-jpeg']) {
      console.error(`Benchmark ${MEGAPIXELS} MP — ${stage} (sequential)`);
      const result = await isolatedStage(stage, temporary); stages.push(result);
      console.error(`${stage}: ${result.seconds.toFixed(2)} s; peak RSS ${(result.peakRssMiB / 1024).toFixed(2)} GiB`);
    }
    const finalHash = await hashFile(join(temporary, 'synthetic-45mp-16bit.tiff'));
    assert.equal(finalHash, stages[0].sha256, 'Original source must remain byte-for-byte unchanged');
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), environment: { node: process.version,
      platform: process.platform, arch: process.arch, osRelease: os.release(),
      cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 1024 ** 3,
      sharp: sharp.versions.sharp, vips: sharp.versions.vips, sharpConcurrency: sharp.concurrency(), sharpCacheMiB: 64 },
      oneSource: { width: WIDTH, height: HEIGHT, megapixels: MEGAPIXELS, precision: 'RGB ushort, generated here', sha256: finalHash },
      stages, sourceUnchanged: true, fullResolutionConcurrency: 1, temporaryFilesRemovedOnExit: true,
      normalizedCombinedAdjustments: normalizeAdjustments(combined) }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
