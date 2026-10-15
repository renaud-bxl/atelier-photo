import sharp from 'sharp';
import { normalizeColorStyle, applyColorStyle, validateColorLUT } from './color-style.mjs';
import { pixelDepth, pixelInput, pixelShape, fromPixels, materializePixels, alphaPixels } from './image-pixels.mjs';
import { applyPerspective } from './perspective.mjs';

// Original files are read only. Every public operation returns an in-memory image.
// Coordinates use the auto-oriented image before user rotation, mirroring or crop.
const INPUT_OPTIONS = { failOn: 'error', limitInputPixels: 180_000_000, sequentialRead: true };
const SUPPORTED = new Set(['jpeg', 'png', 'webp', 'tiff', 'heif', 'avif', 'gif', 'jp2', 'jxl']);
const RANGES = {
  exposure: [-3, 3, 0], contrast: [0.5, 1.8, 1], saturation: [0, 2, 1],
  vibrance: [-1, 1, 0], temperature: [-100, 100, 0], tint: [-100, 100, 0],
  highlights: [-1, 1, 0], shadows: [0, 1, 0], sharpness: [0, 2, 0],
  clarity: [0, 1, 0], denoise: [0, 1, 0], vignette: [0, 2, 0],
  skinSmoothing: [0, 1, 0], faceLight: [0, 1, 0], teethWhitening: [0, 1, 0],
  blemishReduction: [0, 1, 0], skinEvenness: [0, 1, 0], underEyeLight: [0, 1, 0], eyeContrast: [0, 1, 0], lipSaturation: [0, 1, 0],
  eyeBrightness: [0, 1, 0], rotation: [-360, 360, 0], perspectiveHorizontal: [-0.5, 0.5, 0], perspectiveVertical: [-0.5, 0.5, 0],
  cropRatio: [0, 4, 0], cropX: [0, 1, 0.5], cropY: [0, 1, 0.5]
};
const clamp = (value, low, high, fallback = low) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

export function normalizeAdjustments(value = {}) {
  const result = {};
  for (const [key, [low, high, neutral]] of Object.entries(RANGES)) {
    result[key] = clamp(value?.[key], low, high, neutral);
  }
  result.flipHorizontal = value?.flipHorizontal === true;
  return {...result,...normalizeColorStyle(value)};
}

function maximumSize(value) {
  if (value === undefined || value === null) return null;
  return Math.round(clamp(value, 1, 32000, 1600));
}

const shape = pixelShape;
const from = fromPixels;
const bitmap = materializePixels;

async function sourceMetadata(sourcePath) {
  const metadata = await sharp(sourcePath, INPUT_OPTIONS).metadata();
  if (!SUPPORTED.has(metadata.format) || !metadata.width || !metadata.height) {
    throw new Error('Ce format de photo n’est pas pris en charge. Utilisez un JPEG, PNG, TIFF, WebP, AVIF ou HEIF compatible.');
  }
  return metadata;
}

/** Dimensions are returned in viewing orientation, including mirrored EXIF tags. */
export async function getMetadata(sourcePath) {
  const metadata = await sourceMetadata(sourcePath);
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation);
  return {
    width: swapsAxes ? metadata.height : metadata.width,
    height: swapsAxes ? metadata.width : metadata.height,
    originalWidth: metadata.width, originalHeight: metadata.height,
    format: metadata.format, space: metadata.space, channels: metadata.channels,
    depth: metadata.depth, density: metadata.density, hasAlpha: Boolean(metadata.hasAlpha),
    orientation: metadata.orientation ?? 1, pages: metadata.pages ?? 1
  };
}

export async function thumbnail(sourcePath, maxDimension = 320) {
  await sourceMetadata(sourcePath);
  const maximum = maximumSize(maxDimension) ?? 320;
  return sharp(sourcePath, INPUT_OPTIONS).autoOrient()
    .pipelineColourspace('rgb16')
    .resize({ width: maximum, height: maximum, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 82, chromaSubsampling: '4:4:4' }).toBuffer();
}

/**
 * @param {string|Buffer} sourcePath Original photo; never mutated.
 * @param {object} adjustments Photo controls, using neutral contrast/saturation = 1.
 * @param {object} options maxDimension omitted means full resolution. Preview callers use 1600.
 * @returns {Promise<Buffer>} Encoded JPEG, PNG, TIFF or WebP. The caller chooses an export path.
 */
export async function renderImage(sourcePath, adjustments = {}, {
  maxDimension, format = 'jpeg', quality = 92, watermark = '', landmarks = null, lut = null, bitDepth = 16
} = {}) {
  const a = normalizeAdjustments(adjustments);
  const maximum = maximumSize(maxDimension);
  const outputFormat = String(format).toLowerCase().replace(/^jpg$/, 'jpeg').replace(/^tif$/, 'tiff');
  if (!['jpeg', 'png', 'tiff', 'webp'].includes(outputFormat)) throw new Error('Format d’export non pris en charge.');
  if (![8, 16].includes(bitDepth)) throw new Error('Format d’export non pris en charge.');
  const depth = 'ushort';
  // Reject unavailable/corrupt assets before decoding a potentially large photo.
  if (a.lutId) await validateColorLUT(lut);
  await sourceMetadata(sourcePath);
  const space = ['png', 'tiff'].includes(outputFormat) && bitDepth === 16 ? 'rgb16' : 'srgb';
  let input = sharp(sourcePath, INPUT_OPTIONS).autoOrient().pipelineColourspace('rgb16').toColourspace('rgb16');
  if (maximum) input = input.resize({ width: maximum, height: maximum, fit: 'inside', withoutEnlargement: true });
  let image = await bitmap(input, { depth });
  image = await globalAdjustments(image, a);
  image = await applyColorStyle(image,a,lut);
  image = await portraitAdjustments(image, a, landmarks);

  if (a.sharpness > 0 || a.clarity > 0) {
    image = await bitmap(from(image).sharpen({
      sigma: Math.min(10, 0.6 + a.clarity * 4 + a.sharpness * 0.35),
      m1: a.clarity * 0.65, m2: a.sharpness * 1.5 + a.clarity * 0.7,
      x1: 3, y2: 8 + a.clarity * 6, y3: 8
    }));
  }
  if (a.vignette > 0) image = await vignette(image, a.vignette);
  image = await transform(image, a, maximum);
  if (typeof watermark === 'string' && watermark.trim()) image = await watermarkImage(image, watermark);

  const qualityValue = Math.round(clamp(quality, 1, 100, 92));
  let output = from(image).withIccProfile('srgb').toColourspace(space);
  if (outputFormat === 'jpeg') output = output.flatten({ background: '#ffffff' }).jpeg({ quality: qualityValue, chromaSubsampling: '4:4:4' });
  if (outputFormat === 'png') output = output.png({ compressionLevel: 6, palette: false });
  if (outputFormat === 'tiff') output = output.tiff({ compression: 'lzw', predictor: 'horizontal' });
  if (outputFormat === 'webp') output = output.webp({ quality: qualityValue });
  return output.toBuffer();
}

async function globalAdjustments(image, a) {
  const full = pixelDepth(image) === 'ushort' ? 65535 : 255;
  const gain = 2 ** a.exposure * a.contrast;
  const offset = full * (128 / 255) * (1 - a.contrast);
  const warm = a.temperature / 100;
  const magenta = a.tint / 100;
  if (a.exposure || a.contrast !== 1 || warm || magenta || a.saturation !== 1 || a.denoise) {
    let effect = from(image).linear(
      [gain * (1 + warm * 0.22), gain * (1 - magenta * 0.12), gain * (1 - warm * 0.22), 1],
      [offset + magenta * full * (5 / 255), offset, offset + magenta * full * (5 / 255), 0]
    );
    if (a.saturation !== 1) effect = effect.modulate({ saturation: a.saturation });
    if (a.denoise > 0) effect = effect.median(3).blur(0.3 + a.denoise * 0.45);
    image = await bitmap(effect);
  }
  if (a.vibrance) {
    // LCH chroma favours the least saturated colours and protects saturated skin.
    const channel = await from(image).removeAlpha().toColourspace('lch').extractChannel(1)
      .raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    const chroma = await from(channel).linear(-2.2, 255).toColourspace('b-w').raw({ depth: 'uchar' }).toBuffer();
    const effect = await bitmap(from(image).modulate({ saturation: 1 + a.vibrance * 0.7 }));
    image = await blendLuminance(image, effect, chroma);
  }
  if (a.shadows > 0) {
    const mask = await luminance(image, -1.7, 255);
    const effect = await bitmap(from(image).modulate({ brightness: 1 + a.shadows * 0.7, lightness: a.shadows * 7 }));
    image = await blendLuminance(image, effect, mask);
  }
  if (a.highlights) {
    const mask = await luminance(image, 2.4, -255 * 0.95);
    const effect = await bitmap(from(image).modulate({ brightness: 1 + a.highlights * 0.35 }));
    image = await blendLuminance(image, effect, mask);
  }
  return image;
}

async function luminance(image, gain, bias) {
  // This is a mask only. Photo colours continue through the 16-bit pipeline.
  const gray = await from(image).removeAlpha().greyscale().toColourspace('b-w')
    .raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  return sharp(gray.data, { raw: { width: gray.info.width, height: gray.info.height, channels: 1 } })
    .linear(gain, bias).toColourspace('b-w').raw({ depth: 'uchar' }).toBuffer();
}

async function blendLuminance(base, effect, alpha) {
  // removeAlpha is a late sharp operation; materialise it before appending a mask.
  const rgb = await bitmap(from(effect).removeAlpha(), { alpha: false });
  const mask = await alphaPixels(alpha, base.info.width, base.info.height, pixelDepth(base));
  // A pipeline colourspace would expand the one-channel mask to RGB before
  // band-joining. Both typed inputs already carry their correct precision.
  const layer = await bitmap(sharp(pixelInput(rgb), { raw: shape(rgb) })
    .joinChannel(pixelInput(mask), { raw: shape(mask) }), { depth: pixelDepth(base), alpha: false });
  // Source-atop preserves the original transparency while applying the adjustment.
  return bitmap(from(base).composite([{ input: pixelInput(layer), raw: shape(layer), blend: 'atop' }]));
}

function normalizeFaces(landmarks, width, height) {
  if (!Array.isArray(landmarks?.faces)) return [];
  const faces = [];
  for (const candidate of landmarks.faces.slice(0, 30)) {
    const b = candidate?.box;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) continue;
    const x = clamp(b.x, 0, 1), y = clamp(b.y, 0, 1);
    const right = clamp(b.x + b.width, 0, 1), bottom = clamp(b.y + b.height, 0, 1);
    const left = Math.floor(x * width), top = Math.floor(y * height);
    const patchWidth = Math.min(width - left, Math.ceil((right - x) * width));
    const patchHeight = Math.min(height - top, Math.ceil((bottom - y) * height));
    if (patchWidth < 8 || patchHeight < 8) continue;
    const points = (list) => Array.isArray(list) ? list.slice(0, 100)
      .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
      .map(p => ({ x: clamp(p.x * width - left, 0, patchWidth), y: clamp(p.y * height - top, 0, patchHeight) })) : [];
    faces.push({ left, top, width: patchWidth, height: patchHeight,
      leftEye: points(candidate.leftEye), rightEye: points(candidate.rightEye), mouth: points(candidate.mouth),
      leftIris: points(candidate.leftIris), rightIris: points(candidate.rightIris), outerLips: points(candidate.outerLips) });
  }
  return faces;
}

function polygon(points, fill = 'white') {
  if (points.length < 3) return '';
  return `<polygon points="${points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}" fill="${fill}"/>`;
}

function featureHole(points, margin) {
  if (points.length < 3) return '';
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  const right = Math.max(...points.map(p => p.x)), bottom = Math.max(...points.map(p => p.y));
  return `<ellipse cx="${(x + right) / 2}" cy="${(y + bottom) / 2}" rx="${(right - x) / 2 + margin}" ry="${(bottom - y) / 2 + margin}" fill="black"/>`;
}

async function regionMask(face, kind, strength) {
  const { width: w, height: h } = face;
  let content;
  if (kind === 'eyes') content = polygon(face.leftEye) + polygon(face.rightEye);
  else if (kind === 'iris') content = polygon(face.leftIris) + polygon(face.rightIris);
  else if (kind === 'teeth') content = polygon(face.mouth);
  else if (kind === 'lips') content = face.outerLips.length >= 3 ? polygon(face.outerLips) + polygon(face.mouth, 'black') : '';
  else if (kind === 'underEyes') {
    content = '';
    for (const eye of [face.leftEye, face.rightEye]) {
      if (eye.length < 3) continue;
      const minX = Math.min(...eye.map(p => p.x)), maxX = Math.max(...eye.map(p => p.x));
      const minY = Math.min(...eye.map(p => p.y)), maxY = Math.max(...eye.map(p => p.y));
      const eyeWidth = maxX - minX, eyeHeight = Math.max(2, maxY - minY);
      content += `<ellipse cx="${(minX + maxX) / 2}" cy="${maxY + eyeHeight * 0.65}" rx="${eyeWidth * 0.62}" ry="${eyeHeight * 0.55}" fill="white"/>`;
    }
    content += polygon(face.leftEye, 'black') + polygon(face.rightEye, 'black');
  }
  else {
    content = `<ellipse cx="${w / 2}" cy="${h * 0.52}" rx="${w * 0.44}" ry="${h * 0.46}" fill="white"/>`;
    if (kind === 'skin' || kind === 'blemish') {
      content += featureHole(face.leftEye, w * 0.035) + featureHole(face.rightEye, w * 0.035) + featureHole(face.mouth, w * 0.04);
      // Preserve the nose's high-contrast detail when removing small spots.
      if (kind === 'blemish') content += `<ellipse cx="${w * 0.5}" cy="${h * 0.55}" rx="${w * 0.11}" ry="${h * 0.1}" fill="black"/>`;
    }
  }
  if (!content) return null;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><mask id="m"><rect width="100%" height="100%" fill="black"/>${content}</mask></defs><rect width="100%" height="100%" fill="white" opacity="${strength}" mask="url(#m)"/></svg>`);
  const feather = kind === 'iris' || kind === 'lips' ? 0.004 : kind === 'eyes' || kind === 'teeth' || kind === 'underEyes' ? 0.006 : 0.018;
  return sharp(svg).blur(Math.max(0.3, w * feather)).png().toBuffer();
}

const smoothstep = (low, high, value) => { const t = Math.max(0, Math.min(1, (value - low) / (high - low))); return t * t * (3 - 2 * t); };

/** Small-feature processing: masks change local pixels, not the whole face. */
async function targetedPortrait(patch, face, kind, strength, reference = null) {
  const maskKind = kind === 'blemish' ? 'blemish' : kind === 'evenness' ? 'skin' : kind === 'underEye' ? 'underEyes' : kind;
  const mask = await regionMask(face, maskKind, strength);
  if (!mask) return patch;
  const alpha = await sharp(mask).extractChannel('alpha').toColourspace('b-w').raw().toBuffer();
  const data = pixelInput(patch), source = reference ? pixelInput(reference) : null;
  const maximum = pixelDepth(patch) === 'ushort' ? 65535 : 255;
  const channels = patch.info.channels;
  for (let pixel = 0, offset = 0; pixel < alpha.length; pixel++, offset += channels) {
    const weight = alpha[pixel] / 255;
    if (weight > 0) {
      const r = data[offset] / maximum, g = data[offset + 1] / maximum, b = data[offset + 2] / maximum;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let nr = r, ng = g, nb = b;
      if (kind === 'blemish') {
        const rr = source[offset] / maximum, rg = source[offset + 1] / maximum, rb = source[offset + 2] / maximum;
        const residual = Math.max(Math.abs(r - rr), Math.abs(g - rg), Math.abs(b - rb));
        // Only localized residuals above normal skin texture and below strong
        // facial edges are replaced by the edge-preserving median reference.
        const localized = smoothstep(0.018, 0.065, residual) * (1 - smoothstep(0.18, 0.32, residual));
        const amount = weight * localized;
        nr += (rr - r) * amount; ng += (rg - g) * amount; nb += (rb - b) * amount;
      } else if (kind === 'evenness') {
        const rr = source[offset] / maximum, rg = source[offset + 1] / maximum, rb = source[offset + 2] / maximum;
        const referenceLuma = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb;
        // Smooth chroma while retaining each original pixel's luminance and texture.
        nr += ((rr - referenceLuma) - (r - lum)) * weight;
        ng += ((rg - referenceLuma) - (g - lum)) * weight;
        nb += ((rb - referenceLuma) - (b - lum)) * weight;
      } else if (kind === 'underEye') {
        const lift = weight * 0.1 * (1 - lum) ** 2;
        nr += lift; ng += lift; nb += lift;
      } else if (kind === 'iris') {
        const difference = (lum - 0.35) * weight * 0.5;
        nr += difference; ng += difference; nb += difference;
      } else if (kind === 'lips') {
        const amount = weight * 0.7;
        nr += (r - lum) * amount; ng += (g - lum) * amount; nb += (b - lum) * amount;
      }
      data[offset] = Math.round(Math.max(0, Math.min(1, nr)) * maximum);
      data[offset + 1] = Math.round(Math.max(0, Math.min(1, ng)) * maximum);
      data[offset + 2] = Math.round(Math.max(0, Math.min(1, nb)) * maximum);
    }
    if ((pixel + 1) % 32768 === 0) await new Promise(resolveYield => setImmediate(resolveYield));
  }
  return patch;
}

async function portraitAdjustments(image, a, landmarks) {
  if (!a.skinSmoothing && !a.faceLight && !a.teethWhitening && !a.eyeBrightness && !a.blemishReduction &&
      !a.skinEvenness && !a.underEyeLight && !a.eyeContrast && !a.lipSaturation) return image;
  const faces = normalizeFaces(landmarks, image.info.width, image.info.height);
  if (!faces.length) return image;
  // Process only face patches; the detail loops yield regularly to the main loop.
  for (const face of faces) {
    const hasSkinFeatures = face.leftEye.length >= 3 && face.rightEye.length >= 3 && face.mouth.length >= 3;
    const hasEyes = face.leftEye.length >= 3 || face.rightEye.length >= 3;
    const hasIris = face.leftIris.length >= 3 || face.rightIris.length >= 3;
    if (!(a.faceLight || ((a.skinSmoothing || a.blemishReduction || a.skinEvenness) && hasSkinFeatures) ||
        (a.teethWhitening && face.mouth.length >= 3) || ((a.eyeBrightness || a.underEyeLight) && hasEyes) ||
        (a.eyeContrast && hasIris) || (a.lipSaturation && face.outerLips.length >= 3))) continue;
    const bounds = { left: face.left, top: face.top, width: face.width, height: face.height };
    let patch = await bitmap(from(image).extract(bounds));
    if (a.blemishReduction > 0 && hasSkinFeatures) {
      const size = Math.max(3, Math.min(7, Math.round(Math.min(face.width, face.height) * 0.012) | 1));
      const reference = await bitmap(from(patch).median(size));
      patch = await targetedPortrait(patch, face, 'blemish', a.blemishReduction * 0.85, reference);
    }
    if (a.skinEvenness > 0 && hasSkinFeatures) {
      const reference = await bitmap(from(patch).median(3).blur(Math.max(0.3, Math.min(face.width, face.height) * 0.018)));
      patch = await targetedPortrait(patch, face, 'evenness', a.skinEvenness * 0.7, reference);
    }
    const apply = async (kind, strength, effect) => {
      const mask = await regionMask(face, kind, strength);
      if (!mask) return;
      let layer = await bitmap(effect);
      layer = await bitmap(from(layer).composite([{ input: mask, blend: 'dest-in' }]));
      if (kind === 'teeth') {
        const alpha = await luminance(patch, 4, -255 * 1.8);
        const brightMask = await sharp({ create: { width: face.width, height: face.height, channels: 3, background: 'white' } })
          .joinChannel(alpha, { raw: { width: face.width, height: face.height, channels: 1 } }).raw().toBuffer();
        layer = await bitmap(from(layer).composite([{ input: brightMask, raw: { width: face.width, height: face.height, channels: 4 }, blend: 'dest-in' }]));
      }
      patch = await bitmap(from(patch).composite([{ input: pixelInput(layer), raw: shape(layer), blend: 'atop' }]));
    };
    if (a.skinSmoothing > 0) {
      // Missing landmarks must not blur eyes or lips through an unprotected oval.
      if (face.leftEye.length >= 3 && face.rightEye.length >= 3 && face.mouth.length >= 3) {
        await apply('skin', a.skinSmoothing * 0.6, from(patch).median(3).blur(Math.max(0.3, Math.min(face.width, face.height) * 0.006)));
      }
    }
    if (a.faceLight > 0) await apply('face', a.faceLight * 0.8, from(patch).modulate({ brightness: 1.3 }));
    if (a.teethWhitening > 0) await apply('teeth', a.teethWhitening * 0.8, from(patch).modulate({ saturation: 0.45, brightness: 1.15 }));
    if (a.eyeBrightness > 0) await apply('eyes', a.eyeBrightness * 0.8, from(patch).modulate({ brightness: 1.3 }));
    if (a.underEyeLight > 0) patch = await targetedPortrait(patch, face, 'underEye', a.underEyeLight * 0.8);
    if (a.eyeContrast > 0) patch = await targetedPortrait(patch, face, 'iris', a.eyeContrast * 0.8);
    if (a.lipSaturation > 0) patch = await targetedPortrait(patch, face, 'lips', a.lipSaturation * 0.8);
    // The patch is already composited against the original and has its alpha.
    // Copying its rows avoids a second premultiply/unpremultiply rounding of
    // untouched semi-transparent pixels, and leaves all outside pixels exact.
    const destination = pixelInput(image), processed = pixelInput(patch);
    const channels = image.info.channels, rowLength = face.width * channels;
    for (let row = 0; row < face.height; row++) {
      const start = row * rowLength;
      destination.set(processed.subarray(start, start + rowLength), ((row + face.top) * image.info.width + face.left) * channels);
      if ((row + 1) % 128 === 0) await new Promise(resolveYield => setImmediate(resolveYield));
    }
  }
  return image;
}

async function transform(image, a, maximum) {
  if (a.flipHorizontal || a.rotation % 360 !== 0) {
    let pipe = from(image);
    if (a.flipHorizontal) pipe = pipe.flop();
    if (a.rotation % 360 !== 0) pipe = pipe.rotate(a.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    image = await bitmap(pipe);
  }
  image = await applyPerspective(image, a.perspectiveHorizontal, a.perspectiveVertical);
  if (a.cropRatio > 0) {
    const width = Math.max(1, Math.min(image.info.width, Math.floor(image.info.height * a.cropRatio)));
    const height = Math.max(1, Math.min(image.info.height, Math.floor(image.info.width / a.cropRatio)));
    image = await bitmap(from(image).extract({ left: Math.min(image.info.width - width, Math.max(0, Math.floor(a.cropX * image.info.width - width / 2))),
      top: Math.min(image.info.height - height, Math.max(0, Math.floor(a.cropY * image.info.height - height / 2))), width, height }));
  }
  if (maximum && Math.max(image.info.width, image.info.height) > maximum) {
    image = await bitmap(from(image).resize({ width: maximum, height: maximum, fit: 'inside', withoutEnlargement: true }));
  }
  return image;
}

async function vignette(image, amount) {
  const { width, height } = image.info;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="v"><stop offset="30%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="${Math.min(0.8, amount * 0.4)}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`);
  return bitmap(from(image).composite([{ input: svg, blend: 'atop' }]));
}

function escapeXML(value) {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

async function watermarkImage(image, input) {
  const { width, height } = image.info;
  const text = escapeXML(input.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180));
  const margin = Math.max(2, Math.min(width, height) * 0.025);
  const size = Math.max(4, Math.min(width, height) * 0.028);
  const textWidth = Math.min(width - margin * 4, input.length * size * 0.56);
  const boxWidth = Math.max(1, textWidth + margin), boxHeight = Math.min(height, size * 1.8);
  const right = width - margin, bottom = height - margin;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${right - boxWidth}" y="${bottom - boxHeight}" width="${boxWidth}" height="${boxHeight}" rx="${size * 0.2}" fill="black" fill-opacity="0.35"/><text x="${right - margin / 2}" y="${bottom - size * 0.45}" text-anchor="end" font-family="sans-serif" font-size="${size}" fill="white" textLength="${Math.max(1, textWidth)}" lengthAdjust="spacingAndGlyphs">${text}</text></svg>`);
  return bitmap(from(image).composite([{ input: svg, blend: 'atop' }]));
}
