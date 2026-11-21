// Camera orientation is tag 0x0112 in TIFF IFD0 (a single SHORT). An invalid
// optional metadata block leaves the decoded image in its stored orientation.
function orientation(tiff) {
  if (tiff.length < 8) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) return 1;
  const start = view.getUint32(4, little);
  if (start < 8 || start + 2 > tiff.length) return 1;
  const count = view.getUint16(start, little);
  if (start + 2 + count * 12 > tiff.length) return 1;
  for (let i = 0, p = start + 2; i < count; i++, p += 12) {
    if (view.getUint16(p, little) !== 0x0112) continue;
    if (view.getUint16(p + 2, little) !== 3 || view.getUint32(p + 4, little) !== 1) return 1;
    const n = view.getUint16(p + 8, little);
    return n >= 1 && n <= 8 ? n : 1;
  }
  return 1;
}

export function pngOrientation(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let p = 8; p + 12 <= bytes.length; ) {
    const size = view.getUint32(p);
    if (p + size + 12 > bytes.length) break;
    const tag = view.getUint32(p + 4);
    if (tag === 0x65584966) return orientation(bytes.subarray(p + 8, p + 8 + size)); // eXIf
    if (tag === 0x49454e44) break;
    p += size + 12;
  }
  return 1;
}

export function orientImage(image, tag) {
  if (tag === 1) return image;
  const { width: w, height: h, data } = image;
  const transpose = tag >= 5;
  const width = transpose ? h : w,
    height = transpose ? w : h;
  const output = new Uint8ClampedArray(data.length);
  const to = new Uint32Array(output.buffer);
  const from = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  // Destination position of source (0,0) and the increments for source x/y.
  // Multiplying the row count by dy places each source row in its destination.
  const steps = [
    null,
    null,
    [w - 1, -1, w],
    [w * h - 1, -1, -w],
    [(h - 1) * w, 1, -w],
    [0, h, 1],
    [h - 1, h, -1],
    [w * h - 1, -h, -1],
    [(w - 1) * h, -h, 1],
  ];
  const [origin, dx, dy] = steps[tag];
  let pos = 0;
  for (let y = 0; y < h; y++) {
    let dst = origin + y * dy;
    for (let x = 0; x < w; x++, dst += dx) to[dst] = from[pos++];
  }
  return { width, height, data: output };
}
