// Original Bayer fixture with no embedded JPEG; generated from standard DNG tags.
export function syntheticBayerDNG(width = 1024, height = 64) {
  const ascii = text => Buffer.from(text + '\0');
  const shorts = values => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
  const longs = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; };
  const rationals = values => { const b = Buffer.alloc(values.length * 8); values.forEach(([n, d], i) => { b.writeInt32LE(n, i * 8); b.writeInt32LE(d, i * 8 + 4); }); return b; };
  const entries = [];
  const add = (tag, type, bytes, count) => entries.push({ tag, type, bytes, count });
  const short = (tag, ...values) => add(tag, 3, shorts(values), values.length);
  const long = (tag, ...values) => add(tag, 4, longs(values), values.length);
  const string = (tag, text) => { const b = ascii(text); add(tag, 2, b, b.length); };
  long(254, 0); long(256, width); long(257, height); short(258, 16); short(259, 1);
  short(262, 32803); string(271, 'Atelier Photo'); string(272, 'Synthetic Bayer Gradient');
  long(273, 0); short(274, 1); short(277, 1); long(278, height); long(279, width * height * 2);
  short(284, 1); short(33421, 2, 2); add(33422, 1, Buffer.from([0, 1, 1, 2]), 4);
  add(50706, 1, Buffer.from([1, 4, 0, 0]), 4); add(50707, 1, Buffer.from([1, 1, 0, 0]), 4);
  string(50708, 'Atelier Photo Synthetic RAW16 Test'); add(50710, 1, Buffer.from([0, 1, 2]), 3);
  short(50711, 1); long(50714, 0); long(50717, 65535);
  add(50721, 10, rationals([[1, 1], [0, 1], [0, 1], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1], [1, 1]]), 9);
  add(50728, 5, rationals([[1, 1], [1, 1], [1, 1]]), 3); short(50778, 21);
  entries.sort((a, b) => a.tag - b.tag);
  const tableSize = 2 + entries.length * 12 + 4;
  let end = 8 + tableSize;
  for (const entry of entries) {
    if (entry.bytes.length > 4) { entry.offset = end; end += entry.bytes.length + entry.bytes.length % 2; }
  }
  const pixelOffset = end;
  entries.find(entry => entry.tag === 273).bytes.writeUInt32LE(pixelOffset, 0);
  const result = Buffer.alloc(pixelOffset + width * height * 2);
  result.write('II', 0); result.writeUInt16LE(42, 2); result.writeUInt32LE(8, 4);
  result.writeUInt16LE(entries.length, 8);
  entries.forEach((entry, index) => {
    const offset = 10 + index * 12;
    result.writeUInt16LE(entry.tag, offset); result.writeUInt16LE(entry.type, offset + 2);
    result.writeUInt32LE(entry.count, offset + 4);
    if (entry.offset) { result.writeUInt32LE(entry.offset, offset + 8); entry.bytes.copy(result, entry.offset); }
    else entry.bytes.copy(result, offset + 8);
  });
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const value = Math.round(2000 + x / (width - 1) * 48000 + y * 7);
    result.writeUInt16LE(value, pixelOffset + (y * width + x) * 2);
  }
  return result;
}
