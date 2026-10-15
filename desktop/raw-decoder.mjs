import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import sharp from 'sharp';

const EXTENSIONS = new Set([
  '.raw', '.dng', '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.sr2', '.srf',
  '.raf', '.orf', '.rw2', '.rwl', '.pef', '.ptx', '.srw', '.erf', '.mef', '.3fr',
  '.fff', '.iiq', '.kdc', '.dcr', '.mos', '.mrw', '.x3f', '.mdc', '.bay', '.cap',
]);
const CACHE_SCHEMA = 1;
const CACHE_LIMIT = 4 * 1024 ** 3;
const OWNER = 'com.rea.atelierphoto.raw16';
const FILE_PATTERN = /^atelier-raw16-v1-([a-f0-9]{64})\.tiff$/;
const MAX_PIXELS = 180_000_000;
const WRAPPER_VERSION = '@janhapke/libraw@0.1.0';
const inflight = new Map();
let queueTail = Promise.resolve();
let backendPromise;

export function isRaw(path) {
  return typeof path === 'string' && EXTENSIONS.has(extname(path).toLowerCase());
}

/** Metadata-only native openFile: no JS readFile of the RAW and no unpack/demosaic. */
export async function identifyRaw(path) {
  requireRAWPath(path);
  const canonical = await canonicalSource(path);
  const raw = await backend();
  let processor;
  try {
    processor = new raw.Processor();
    await processor.openFile(canonical.path);
    const metadata = processor.metadata;
    const sizes = metadata.sizes;
    const width = sizes?.oriented?.width ?? sizes?.width;
    const height = sizes?.oriented?.height ?? sizes?.height;
    validateDimensions(width, height);
    if (!(metadata.idata?.raw_count > 0)) throw safeError('Le fichier ne contient pas de données RAW décodables.');
    return {
      width, height, bits: 16, format: 'raw',
      make: metadata.idata.normalized_make ?? metadata.idata.make ?? '',
      model: metadata.idata.normalized_model ?? metadata.idata.model ?? '',
      rawWidth: sizes.raw_width, rawHeight: sizes.raw_height,
      sourceOrientation: sizes.flip, orientation: 1,
      // bits describes the processing target, not an assertion that every sensor is 16-bit.
      sourceBits: metadata.color?.raw_bps ?? null,
      decoder: processor.decoderInfo()?.decoder_name ?? '',
      librawVersion: raw.version(), cameraCount: raw.cameraCount(),
    };
  } catch (error) { throw mapError(error, 'identify'); }
  finally { processor?.close(); }
}

/**
 * Return a real developed 16-bit TIFF, not the embedded JPEG preview.
 * The application supplies its private cache root. Non-RAW sources pass through untouched.
 */
export async function resolveRawSource(path, { cacheDirectory, fullResolution = false, signal } = {}) {
  if (typeof path !== 'string') throw safeError('Le chemin de la photo doit être une chaîne.');
  if (!isRaw(path)) return path;
  requireRAWPath(path);
  checkAbort(signal);
  if (typeof cacheDirectory !== 'string' || !isAbsolute(cacheDirectory)) {
    throw safeError('Le développement RAW nécessite un dossier de cache local absolu.');
  }
  const source = await canonicalSource(path);
  const raw = await backend();
  const params = { use_camera_wb: true, output_bps: 16, no_auto_bright: true, half_size: !fullResolution };
  const version = `${WRAPPER_VERSION}|${raw.version()}|cache${CACHE_SCHEMA}`;
  const fingerprint = {
    path: source.path, mtimeNs: source.info.mtimeNs.toString(), size: source.info.size.toString(),
    params, version,
  };
  const key = createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex');
  const root = join(cacheDirectory, 'raw16-v1');
  const target = join(root, `atelier-raw16-v1-${key}.tiff`);
  const jobKey = `${root}\u0000${key}`;
  checkAbort(signal);
  let record = inflight.get(jobKey);
  if (!record || record.controller.signal.aborted) {
    record = { controller: new AbortController(), subscribers: 0, settled: false, promise: null };
    const ownedRecord = record;
    const run = () => decodeToCache({ source, raw, params, version, key, root, target, signal: ownedRecord.controller.signal });
    const task = queueTail.then(run, run);
    queueTail = task.catch(() => {});
    record.promise = task.finally(() => {
      ownedRecord.settled = true;
      if (inflight.get(jobKey) === ownedRecord) inflight.delete(jobKey);
    });
    // All observers can cancel before the queued native job starts.
    record.promise.catch(() => {});
    inflight.set(jobKey, record);
  }
  return observe(record, signal);
}

async function decodeToCache({ source, raw, params, version, key, root, target, signal }) {
  checkAbort(signal);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const owned = await ownedEntry(target);
  if (owned && await validTIFF(target)) {
    await writeMarker(target, { ...owned.marker, accessedAt: Date.now() });
    return target;
  }
  if (owned) {
    await unlink(target);
    await unlink(markerPath(target)).catch(() => {});
  } else if (await exists(target)) {
    throw safeError('Un fichier de cache RAW non reconnu existe déjà. Choisissez un autre dossier de cache.');
  }
  let temporary;
  try {
    checkAbort(signal);
    const bytes = await readFile(source.path, { signal });
    checkAbort(signal);
    const image = await raw.decode(bytes, { params, signal });
    checkAbort(signal);
    validateDimensions(image.width, image.height);
    if (image.bits !== 16 || ![1, 3, 4].includes(image.colors)
        || !Buffer.isBuffer(image.data) || image.data.length !== image.width * image.height * image.colors * 2
        || typeof image.toSharp !== 'function') {
      throw safeError('Le décodeur RAW n’a pas fourni de véritables pixels 16 bits.');
    }
    const currentSource = await stat(source.path, { bigint: true });
    if (currentSource.mtimeNs !== source.info.mtimeNs || currentSource.size !== source.info.size) {
      throw safeError('Le fichier RAW a changé pendant le développement. Réessayez.');
    }
    // LZW's bounded overhead fits this reservation; remove only cache entries we created.
    const reservation = Math.ceil(image.width * image.height * Math.max(image.colors, 3) * 2 * 1.6) + 1024 * 1024;
    await purgeOwned(root, reservation);
    temporary = join(root, `atelier-raw16-v1-${key}.${randomUUID()}.tmp.tiff`);
    // toSharp explicitly uses a Uint16Array for 16-bit buffers. Passing image.data as a
    // plain Buffer here would make sharp infer 8-bit input and corrupt sample precision.
    await image.toSharp(sharp).pipelineColourspace('rgb16').toColourspace('rgb16')
      .tiff({ compression: 'lzw' }).toFile(temporary);
    checkAbort(signal);
    if (!await validTIFF(temporary)) throw safeError('Le TIFF développé ne conserve pas une profondeur de 16 bits.');
    await chmod(temporary, 0o600);
    const written = await stat(temporary);
    if (written.size > CACHE_LIMIT) throw safeError('Le TIFF RAW dépasse la capacité du cache de 4 Go.');
    await purgeOwned(root, written.size + 16384);
    checkAbort(signal);
    const now = Date.now();
    // Commit ownership before the atomic TIFF rename. A crash can leave a harmless
    // orphan marker, but cannot leave a completed TIFF that the cache cannot recognize.
    await writeMarker(target, {
      owner: OWNER, schema: CACHE_SCHEMA, key, version, bits: 16,
      width: image.width, height: image.height, halfSize: params.half_size,
      size: written.size, mtimeMs: written.mtimeMs, createdAt: now, accessedAt: now,
      warnings: Array.isArray(image.warnings)
        ? image.warnings.filter(value => typeof value === 'string').slice(0, 8).map(value => value.slice(0, 256)) : [],
    });
    checkAbort(signal);
    await rename(temporary, target);
    temporary = null;
    return target;
  } catch (error) { throw mapError(error, 'decode'); }
  finally { if (temporary) await unlink(temporary).catch(() => {}); }
}

function observe(record, signal) {
  return new Promise((resolve, reject) => {
    record.subscribers += 1;
    let done = false;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      record.subscribers -= 1;
      if (!record.subscribers && !record.settled) record.controller.abort();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    record.promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function backend() {
  if (!backendPromise) {
    backendPromise = import('@janhapke/libraw').catch(() => {
      backendPromise = null;
      throw safeError('Le moteur RAW LibRaw est indisponible sur ce système. Vérifiez les dépendances natives de l’application.');
    });
  }
  return backendPromise;
}
function requireRAWPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !isRaw(path)) {
    throw safeError('Choisissez le chemin absolu d’un fichier RAW pris en charge.');
  }
}
async function canonicalSource(path) {
  try {
    const canonical = await realpath(path);
    const info = await stat(canonical, { bigint: true });
    if (!info.isFile() || info.size <= 0n || info.size > 2n * 1024n ** 3n) throw safeError('Le fichier RAW est vide ou dépasse 2 Go.');
    return { path: canonical, info };
  } catch (error) {
    if (error?.name === 'RawDecoderError') throw error;
    throw safeError('Le fichier RAW est introuvable ou inaccessible.');
  }
}
function validateDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || width > 32000 || height > 32000 || width * height > MAX_PIXELS) {
    throw safeError('Les dimensions du fichier RAW dépassent les limites du moteur photo.');
  }
}
async function validTIFF(path) {
  try {
    const metadata = await sharp(path, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
    return metadata.format === 'tiff' && metadata.depth === 'ushort' && metadata.bitsPerSample === 16
      && metadata.width > 0 && metadata.height > 0 && [1, 3, 4].includes(metadata.channels);
  } catch { return false; }
}
const markerPath = path => `${path}.json`;
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function ownedEntry(path) {
  try {
    const name = basename(path);
    const match = name.match(FILE_PATTERN);
    if (!match) return null;
    const info = await lstat(path);
    const markerInfo = await lstat(markerPath(path));
    if (!info.isFile() || info.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 16384) return null;
    const marker = JSON.parse(await readFile(markerPath(path), 'utf8'));
    if (marker.owner !== OWNER || marker.schema !== CACHE_SCHEMA || marker.key !== match[1]
        || marker.bits !== 16 || marker.size !== info.size || marker.mtimeMs !== info.mtimeMs
        || !Number.isFinite(marker.accessedAt)) return null;
    return { path, info, marker, cacheBytes: info.size + markerInfo.size };
  } catch { return null; }
}
async function writeMarker(path, value) {
  const temporary = `${markerPath(path)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, markerPath(path));
  } finally { await unlink(temporary).catch(() => {}); }
}
async function purgeOwned(root, reservation = 0) {
  if (reservation > CACHE_LIMIT) throw safeError('Ce développement RAW dépasse la capacité du cache de 4 Go.');
  const entries = [];
  for (const name of await readdir(root)) {
    if (!FILE_PATTERN.test(name)) continue;
    const entry = await ownedEntry(join(root, name));
    if (entry) entries.push(entry);
  }
  let total = entries.reduce((sum, entry) => sum + entry.cacheBytes, 0);
  entries.sort((a, b) => a.marker.accessedAt - b.marker.accessedAt);
  for (const entry of entries) {
    if (total + reservation <= CACHE_LIMIT) break;
    // Recheck ownership before removal; unrelated files, symlinks and original RAWs are excluded.
    if (!await ownedEntry(entry.path)) continue;
    await unlink(entry.path);
    await unlink(markerPath(entry.path)).catch(() => {});
    total -= entry.cacheBytes;
  }
  if (total + reservation > CACHE_LIMIT) throw safeError('Le cache RAW ne dispose pas de suffisamment d’espace.');
}
function safeError(message) { const error = new Error(message); error.name = 'RawDecoderError'; return error; }
function abortError() { return new DOMException('Le développement RAW a été annulé.', 'AbortError'); }
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function mapError(error, operation) {
  if (error?.aborted || error?.name === 'AbortError' || error?.name === 'LIBRAW_CANCELLED_BY_CALLBACK') return abortError();
  if (error?.name === 'RawDecoderError') return error;
  if (operation === 'identify') return safeError('Ce fichier RAW est illisible, endommagé ou non pris en charge par LibRaw.');
  if (error?.code === 'ENOSPC') return safeError('Le disque ne dispose pas de suffisamment d’espace pour le cache RAW.');
  return safeError('Le développement RAW 16 bits a échoué. Le fichier peut être endommagé ou son format non pris en charge.');
}
