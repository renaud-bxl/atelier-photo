import { pixelDepth, pixelInput } from './image-pixels.mjs';

// Independent, bounded 8/16-bit sRGB processing. Lightroom/XMP controls are
// approximations; Adobe RAW development, camera profiles and proprietary looks
// are not reproduced. Curves use piecewise linear interpolation, not Adobe's spline.
const COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];
const CHANNELS = ['red', 'green', 'blue'];
const LUT_ERROR = 'La LUT de ce préréglage est introuvable ou invalide.';
const YIELD_PIXELS = 32768;
const clamp = (v, lo, hi, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const unit = value => Math.max(0, Math.min(1, value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const yieldToIPC = () => new Promise(resolve => setImmediate(resolve));

export function normalizeColorStyle(value = {}) {
  if (!object(value)) return {};
  const result = {};
  for (const key of ['whites', 'blacks', 'grain']) {
    const amount = clamp(value[key], key === 'grain' ? 0 : -100, 100);
    if (amount) result[key] = amount;
  }
  if (object(value.toneCurves)) {
    const curves = {};
    for (const key of ['rgb', ...CHANNELS]) {
      const points = value.toneCurves[key];
      // A malformed curve is ignored as a unit; never splice out bad points and
      // silently change the shape of a preset's remaining curve.
      if (!Array.isArray(points) || points.length < 2 || points.length > 256 ||
          !points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v)))) continue;
      const sorted = points.map(([x, y]) => [clamp(x, 0, 255), clamp(y, 0, 255)]).sort((a, b) => a[0] - b[0]);
      if (sorted.every((p, i) => i === 0 || p[0] > sorted[i - 1][0])) curves[key] = sorted;
    }
    if (Object.keys(curves).length) result.toneCurves = curves;
  }
  if (object(value.hsl)) {
    const hsl = {};
    for (const key of COLORS) {
      const c = value.hsl[key];
      if (!object(c)) continue;
      const values = { hue: clamp(c.hue, -100, 100), saturation: clamp(c.saturation, -100, 100), luminance: clamp(c.luminance, -100, 100) };
      if (values.hue || values.saturation || values.luminance) hsl[key] = values;
    }
    if (Object.keys(hsl).length) result.hsl = hsl;
  }
  if (object(value.splitToning)) {
    const s = value.splitToning;
    const split = { shadowHue: clamp(s.shadowHue, 0, 360), shadowSaturation: clamp(s.shadowSaturation, 0, 100),
      highlightHue: clamp(s.highlightHue, 0, 360), highlightSaturation: clamp(s.highlightSaturation, 0, 100), balance: clamp(s.balance, -100, 100) };
    if (split.shadowSaturation || split.highlightSaturation) result.splitToning = split;
  }
  if (value.lutId !== undefined && value.lutId !== null && value.lutId !== '') {
    if (typeof value.lutId !== 'string' || !/^[a-f0-9]{64}$/i.test(value.lutId)) throw new Error(LUT_ERROR);
    result.lutId = value.lutId.toLowerCase();
    result.lutIntensity = clamp(value.lutIntensity, 0, 1, 1);
  }
  return result;
}

/** Validate before changing any pixels. Cube samples are red-fastest, then green, then blue. */
export async function validateColorLUT(lut) {
  if (!object(lut) || !Number.isInteger(lut.size) || lut.size < 2 || lut.size > 65) throw new Error(LUT_ERROR);
  const size = lut.size;
  const values = lut.values;
  if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== size ** 3 * 3) throw new Error(LUT_ERROR);
  const minimum = lut.domainMin === undefined ? [0, 0, 0] : lut.domainMin;
  const maximum = lut.domainMax === undefined ? [1, 1, 1] : lut.domainMax;
  if (!(Array.isArray(minimum) || ArrayBuffer.isView(minimum)) || minimum.length !== 3 ||
      !(Array.isArray(maximum) || ArrayBuffer.isView(maximum)) || maximum.length !== 3) throw new Error(LUT_ERROR);
  const min = [], range = [];
  for (let channel = 0; channel < 3; channel++) {
    const low = minimum[channel], high = maximum[channel], width = high - low;
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(width) || width <= 0) throw new Error(LUT_ERROR);
    min.push(low); range.push(width);
  }
  for (let index = 0; index < values.length; index++) {
    if (typeof values[index] !== 'number' || !Number.isFinite(values[index])) throw new Error(LUT_ERROR);
    if (index > 0 && index % 131072 === 0) await yieldToIPC();
  }
  return { size, values, min, range, domainMin: min, domainMax: Array.from(maximum) };
}

function curveValue(points, x) {
  if (!points) return x;
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  let low = 1, high = points.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (x <= points[middle][0]) high = middle; else low = middle + 1; }
  const a = points[low - 1], b = points[low];
  return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
}

async function composedCurves(curves, maximum) {
  if (!curves) return null;
  const tables = CHANNELS.map(() => new Float64Array(maximum + 1));
  let changed = false;
  for (let input = 0; input <= maximum; input++) {
    const x = input / maximum * 255;
    const master = curveValue(curves.rgb, x);
    for (let channel = 0; channel < 3; channel++) {
      const output = curveValue(curves[CHANNELS[channel]], master);
      tables[channel][input] = output / 255;
      if (Math.abs(output - x) > 1e-10) changed = true;
    }
    if (input > 0 && input % 16384 === 0) await yieldToIPC();
  }
  return changed ? tables : null;
}

function tableValue(table, x) {
  const lower = Math.floor(x), upper = Math.min(table.length - 1, lower + 1);
  return table[lower] + (table[upper] - table[lower]) * (x - lower);
}

function hslToRGB(h, saturation, lightness, out) {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lightness - c / 2;
  if (h < 60) { out[0] = c + m; out[1] = x + m; out[2] = m; }
  else if (h < 120) { out[0] = x + m; out[1] = c + m; out[2] = m; }
  else if (h < 180) { out[0] = m; out[1] = c + m; out[2] = x + m; }
  else if (h < 240) { out[0] = m; out[1] = x + m; out[2] = c + m; }
  else if (h < 300) { out[0] = x + m; out[1] = m; out[2] = c + m; }
  else { out[0] = c + m; out[1] = m; out[2] = x + m; }
}

function tint(hue) { const out = new Float64Array(3); hslToRGB(hue % 360, 1, 0.5, out); return out; }

function lookup(lut, r, g, b, out) {
  const size = lut.size, last = size - 1, values = lut.values;
  const x = unit((r - lut.min[0]) / lut.range[0]) * last;
  const y = unit((g - lut.min[1]) / lut.range[1]) * last;
  const z = unit((b - lut.min[2]) / lut.range[2]) * last;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(last, x0 + 1), y1 = Math.min(last, y0 + 1), z1 = Math.min(last, z0 + 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const ax = 1 - fx, ay = 1 - fy, az = 1 - fz;
  const p000 = ((z0 * size + y0) * size + x0) * 3;
  const p100 = ((z0 * size + y0) * size + x1) * 3;
  const p010 = ((z0 * size + y1) * size + x0) * 3;
  const p110 = ((z0 * size + y1) * size + x1) * 3;
  const p001 = ((z1 * size + y0) * size + x0) * 3;
  const p101 = ((z1 * size + y0) * size + x1) * 3;
  const p011 = ((z1 * size + y1) * size + x0) * 3;
  const p111 = ((z1 * size + y1) * size + x1) * 3;
  const w000 = ax * ay * az, w100 = fx * ay * az, w010 = ax * fy * az, w110 = fx * fy * az;
  const w001 = ax * ay * fz, w101 = fx * ay * fz, w011 = ax * fy * fz, w111 = fx * fy * fz;
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = values[p000 + channel] * w000 + values[p100 + channel] * w100 +
      values[p010 + channel] * w010 + values[p110 + channel] * w110 + values[p001 + channel] * w001 +
      values[p101 + channel] * w101 + values[p011 + channel] * w011 + values[p111 + channel] * w111;
  }
}

/** Mutates only an owned RGB/RGBA 8/16-bit output buffer. Alpha is never changed. */
export async function applyColorStyle(bitmap, adjustments = {}, lut = null) {
  const a = normalizeColorStyle(adjustments);
  if (!Object.keys(a).length) return bitmap;
  // Validate even at zero intensity: an unavailable preset asset must be reported.
  const cube = a.lutId ? await validateColorLUT(lut) : null;
  const maximum = pixelDepth(bitmap) === 'ushort' ? 65535 : 255;
  const tables = await composedCurves(a.toneCurves, maximum);
  const hslEntries = [];
  for (let index = 0; index < COLORS.length; index++) {
    const entry = a.hsl?.[COLORS[index]];
    if (entry) hslEntries.push({ center: CENTERS[index], ...entry });
  }
  const split = a.splitToning;
  if (!tables && !hslEntries.length && !split && !a.whites && !a.blacks && !a.grain && !(cube && a.lutIntensity)) return bitmap;
  const bytes = bitmap?.data ? pixelInput(bitmap) : null, channels = bitmap?.info?.channels;
  const width = bitmap?.info?.width, height = bitmap?.info?.height;
  if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray || bytes instanceof Uint16Array) || ![3, 4].includes(channels) ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width * height > 180_000_000 || bytes.length !== width * height * channels) throw new Error('Dimensions de photo non valides.');
  const scratch = new Float64Array(3);
  const shadow = split ? tint(split.shadowHue) : null, highlight = split ? tint(split.highlightHue) : null;
  const white = (a.whites || 0) / 100 * 0.22, black = (a.blacks || 0) / 100 * 0.22;
  const grain = (a.grain || 0) / 100 * 0.14;
  const useLUT = Boolean(cube && a.lutIntensity);
  const amount = a.lutIntensity ?? 0;
  const yieldBytes = channels * YIELD_PIXELS;
  for (let offset = 0; offset < bytes.length; offset += channels) {
    let r = bytes[offset] / maximum, g = bytes[offset + 1] / maximum, b = bytes[offset + 2] / maximum;
    if (white || black) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const lift = white * lum * lum + black * (1 - lum) * (1 - lum);
      r = unit(r + lift); g = unit(g + lift); b = unit(b + lift);
    }
    if (tables) {
      r = tableValue(tables[0], r * maximum); g = tableValue(tables[1], g * maximum); b = tableValue(tables[2], b * maximum);
    }
    if (hslEntries.length) {
      const high = Math.max(r, g, b), low = Math.min(r, g, b), delta = high - low;
      // A hue-family adjustment must not introduce a colour cast into gray pixels.
      if (delta > 1e-12) {
        const lightness = (high + low) / 2;
        let hue = high === r ? 60 * (((g - b) / delta) % 6) : high === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
        if (hue < 0) hue += 360;
        const saturation = delta / (1 - Math.abs(2 * lightness - 1));
        const chromaWeight = Math.min(1, saturation * 4);
        let dh = 0, ds = 0, dl = 0;
        for (const c of hslEntries) {
          const distance = Math.min(Math.abs(hue - c.center), 360 - Math.abs(hue - c.center));
          const weight = Math.max(0, 1 - distance / 50) * chromaWeight;
          dh += c.hue * 0.3 * weight; ds += c.saturation / 100 * weight; dl += c.luminance / 100 * weight;
        }
        hslToRGB((hue + dh + 360) % 360, unit(saturation + ds * (ds > 0 ? 1 - saturation : saturation)), unit(lightness + dl * 0.25), scratch);
        r = scratch[0]; g = scratch[1]; b = scratch[2];
      }
    }
    if (split) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const balance = split.balance / 200;
      // Positive balance extends the highlight colour into the midtones.
      const sw = unit(1 - lum - balance) ** 2 * split.shadowSaturation / 100 * 0.35;
      const hw = unit(lum + balance) ** 2 * split.highlightSaturation / 100 * 0.35;
      r += (shadow[0] - 0.5) * sw + (highlight[0] - 0.5) * hw;
      g += (shadow[1] - 0.5) * sw + (highlight[1] - 0.5) * hw;
      b += (shadow[2] - 0.5) * sw + (highlight[2] - 0.5) * hw;
    }
    if (grain) {
      let hash = Math.imul((offset / channels + 17) ^ 0x9e3779b9, 0x21f0aaad);
      hash = Math.imul(hash ^ (hash >>> 16), 0x735a2d97); hash ^= hash >>> 15;
      const noise = ((hash >>> 0) / 4294967295 - 0.5) * grain;
      r += noise; g += noise; b += noise;
    }
    if (useLUT) {
      lookup(cube, r, g, b, scratch);
      r += (scratch[0] - r) * amount; g += (scratch[1] - g) * amount; b += (scratch[2] - b) * amount;
    }
    bytes[offset] = Math.round(unit(r) * maximum); bytes[offset + 1] = Math.round(unit(g) * maximum); bytes[offset + 2] = Math.round(unit(b) * maximum);
    if ((offset + channels) % yieldBytes === 0) await yieldToIPC();
  }
  return bitmap;
}
