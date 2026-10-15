import sharp from 'sharp';

const pipelineDepth = new WeakMap();

export function pixelDepth(image) {
  return image?.info?.depth === 'ushort' || image?.data instanceof Uint16Array ? 'ushort' : 'uchar';
}

/** Sharp infers raw input depth from its TypedArray, not from raw.depth. */
export function pixelInput(image) {
  if (pixelDepth(image) !== 'ushort' || image.data instanceof Uint16Array) return image.data;
  const data = image.data;
  if (data.byteOffset % 2 === 0) return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const aligned = Uint8Array.from(data);
  return new Uint16Array(aligned.buffer);
}

export function pixelShape(image) {
  return { width: image.info.width, height: image.info.height, channels: image.info.channels };
}

export function fromPixels(image) {
  const depth = pixelDepth(image);
  const grayscale = image.info.channels < 3;
  const pipeline = sharp(pixelInput(image), { raw: pixelShape(image) })
    .pipelineColourspace(grayscale ? (depth === 'ushort' ? 'grey16' : 'b-w') : (depth === 'ushort' ? 'rgb16' : 'srgb'));
  pipelineDepth.set(pipeline, depth);
  return pipeline;
}

/** Materialise a processing step at its original precision, including alpha. */
export async function materializePixels(pipeline, { depth = pipelineDepth.get(pipeline) ?? 'uchar', alpha = true } = {}) {
  if (alpha) pipeline = pipeline.ensureAlpha();
  return pipeline.toColourspace(depth === 'ushort' ? 'rgb16' : 'srgb')
    .raw({ depth }).toBuffer({ resolveWithObject: true });
}

export async function alphaPixels(alpha8, width, height, depth) {
  if (depth !== 'ushort') return { data: alpha8, info: { width, height, channels: 1, depth: 'uchar' } };
  return sharp(alpha8, { raw: { width, height, channels: 1 } }).toColourspace('grey16')
    .raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
}
