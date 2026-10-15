import { pixelDepth, pixelInput } from './image-pixels.mjs';

const bounded = value => Number.isFinite(value) ? Math.max(-0.5, Math.min(0.5, value)) : 0;

/**
 * Projective keystone correction on the existing canvas, before cropping.
 * In centered normalized coordinates the forward homography is
 *     [u, v, 1] -> [u, v, 1 + p*u + q*v].
 * Its inverse maps every destination pixel back to the original image. The
 * 0.75 scale keeps both forward and inverse denominators >= 0.25 for all
 * allowed controls. Straight lines therefore stay straight, without folds.
 *
 * Interpolation uses premultiplied alpha and the original ushort samples;
 * there is no intermediate 8-bit image. Pixels outside the source are clear.
 * Only one destination bitmap is allocated, and long operations yield.
 */
export async function applyPerspective(image, horizontal = 0, vertical = 0) {
  const p = bounded(horizontal) * 0.75, q = bounded(vertical) * 0.75;
  if (!p && !q) return image;
  const { width, height, channels } = image.info;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width * height > 180_000_000 || ![3, 4].includes(channels)) throw new Error('Dimensions de photo non prises en charge.');
  const source = pixelInput(image), depth = pixelDepth(image);
  if (source.length !== width * height * channels) throw new Error('Données de photo incomplètes.');
  const maximum = depth === 'ushort' ? 65535 : 255;
  const output = depth === 'ushort' ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
  const dx = 2 / width, dy = 2 / height;
  let pixel = 0, offset = 0;
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) * dy - 1, denominatorY = 1 - q * ny;
    for (let x = 0; x < width; x++, pixel++, offset += 4) {
      const nx = (x + 0.5) * dx - 1, inverse = 1 / (denominatorY - p * nx);
      const sx = (nx * inverse + 1) * width / 2 - 0.5;
      const sy = (ny * inverse + 1) * height / 2 - 0.5;
      const left = Math.floor(sx), top = Math.floor(sy), fx = sx - left, fy = sy - top;
      let red = 0, green = 0, blue = 0, alpha = 0;
      // Samples beyond the image have zero alpha. Weighting colours by alpha
      // prevents hidden RGB in transparent input pixels from making fringes.
      if (left >= -1 && left < width && top >= -1 && top < height) {
        for (let row = 0; row < 2; row++) {
          const sampleY = top + row;
          if (sampleY < 0 || sampleY >= height) continue;
          const rowWeight = row ? fy : 1 - fy;
          for (let column = 0; column < 2; column++) {
            const sampleX = left + column;
            if (sampleX < 0 || sampleX >= width) continue;
            const index = (sampleY * width + sampleX) * channels;
            const weight = rowWeight * (column ? fx : 1 - fx);
            const weightedAlpha = weight * (channels === 4 ? source[index + 3] : maximum);
            alpha += weightedAlpha;
            red += source[index] * weightedAlpha;
            green += source[index + 1] * weightedAlpha;
            blue += source[index + 2] * weightedAlpha;
          }
        }
        if (alpha > 0) {
          output[offset] = Math.round(Math.max(0, Math.min(maximum, red / alpha)));
          output[offset + 1] = Math.round(Math.max(0, Math.min(maximum, green / alpha)));
          output[offset + 2] = Math.round(Math.max(0, Math.min(maximum, blue / alpha)));
          output[offset + 3] = Math.round(Math.min(maximum, alpha));
        }
      }
      if ((pixel + 1) % 32768 === 0) await new Promise(resolveYield => setImmediate(resolveYield));
    }
  }
  return { data: output, info: { ...image.info, width, height, channels: 4, depth, size: output.byteLength, premultiplied: false } };
}
