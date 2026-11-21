// BMP files and classic ICO entries store the same device-independent bitmap.
// A BMP supplies the pixel offset in a file header. ICO follows its color table
// immediately with XOR pixels and a separate 1-bit transparency plane.
function valid(condition, reason) {
  if (!condition) throw new Error("Invalid BMP/ICO: " + reason);
}

function maskChannel(mask, depth) {
  if (!mask) return null;
  const shift = 31 - Math.clz32(mask & -mask);
  const max = mask >>> shift;
  valid((max & (max + 1)) === 0 && (depth === 32 || mask < 2 ** depth), "invalid color mask");
  return { shift, max };
}

function valueFor(word, field) {
  return Math.round(((((word >>> field.shift) & field.max) >>> 0) * 255) / field.max);
}

function writePalette(data, dst, palette, index) {
  const p = index * 3;
  valid(p + 2 < palette.length, "palette index out of range");
  data[dst] = palette[p];
  data[dst + 1] = palette[p + 1];
  data[dst + 2] = palette[p + 2];
  data[dst + 3] = 255;
}

function rlePixels(bytes, offset, width, height, depth, palette, data) {
  let x = 0,
    row = 0;
  while (offset + 2 <= bytes.length) {
    const count = bytes[offset++],
      code = bytes[offset++];
    if (!count) {
      if (code === 1) return offset;
      if (code === 0) {
        x = 0;
        row++;
        continue;
      }
      if (code === 2) {
        valid(offset + 2 <= bytes.length, "truncated RLE delta");
        x += bytes[offset++];
        row += bytes[offset++];
        valid(x <= width && row < height, "RLE delta out of bounds");
        continue;
      }
    }
    const length = count || code;
    valid(row < height && x + length <= width, "RLE run out of bounds");
    const packed = Math.ceil((length * depth) / 8);
    if (!count) valid(offset + ((packed + 1) & ~1) <= bytes.length, "truncated absolute RLE run");
    let dst = ((height - row - 1) * width + x) * 4;
    for (let n = 0; n < length; n++, dst += 4) {
      const value = count ? code : bytes[offset + (depth === 8 ? n : n >> 1)];
      const index = depth === 8 ? value : (value >> (n % 2 ? 0 : 4)) & 15;
      writePalette(data, dst, palette, index);
    }
    if (!count) offset += (packed + 1) & ~1;
    x += length;
  }
  throw new Error("Invalid BMP/ICO: missing RLE end marker");
}

function dib(bytes, pixelOffset, icon) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => view.getUint16(p, true);
  const u32 = (p) => view.getUint32(p, true);
  const s32 = (p) => view.getInt32(p, true);
  valid(bytes.length >= 12, "truncated bitmap header");
  const header = u32(0);
  const core = header === 12;
  const os2 = core || header === 16 || header === 64;
  valid(
    [12, 16, 40, 52, 56, 64, 108, 124].includes(header) && header <= bytes.length,
    "unsupported bitmap header",
  );
  const width = core ? u16(4) : s32(4);
  const storedHeight = core ? u16(6) : s32(8);
  const planes = u16(core ? 8 : 12),
    depth = u16(core ? 10 : 14);
  const topDown = storedHeight < 0;
  const height = Math.abs(storedHeight) / (icon ? 2 : 1);
  valid(planes === 1 && [1, 2, 4, 8, 16, 24, 32].includes(depth), "pixel format");
  valid(
    width > 0 &&
      height > 0 &&
      Number.isInteger(height) &&
      height <= 8192 &&
      width <= (height <= 128 ? 16384 : 8192),
    "bitmap dimensions",
  );
  if (icon) valid(width === icon.width && height === icon.height, "icon dimensions disagree");
  const compression = header >= 20 ? u32(16) : 0;
  const bitfields = compression === 3 || compression === 6;
  const rle = compression === 1 || compression === 2;
  valid(
    compression === 0 ||
      (bitfields && !os2 && (depth === 16 || depth === 32)) ||
      (rle && !topDown && ((depth === 8 && compression === 1) || (depth === 4 && compression === 2))),
    "compression",
  );

  let offset = header;
  let masks = depth === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0xff0000, 0xff00, 0xff, 0];
  if (bitfields) {
    const count = compression === 6 || header >= 56 ? 4 : 3;
    valid(
      40 + 4 * count <= bytes.length && (header === 40 || 40 + 4 * count <= header),
      "truncated bitfields",
    );
    masks = [u32(40), u32(44), u32(48), count === 4 ? u32(52) : 0];
    if (header === 40) offset += 4 * count;
    valid(masks[0] && masks[1] && masks[2], "missing RGB mask");
  } else if (!os2 && header >= 56 && depth >= 16) {
    masks[3] = (u32(52) & (depth === 32 ? 0xffffffff : 2 ** depth - 1)) >>> 0;
  }
  if (icon && depth === 32 && !bitfields && !masks[3]) masks[3] = 0xff000000;
  let fields;
  if (depth === 16 || depth === 32 || masks[3]) {
    let used = 0;
    for (const mask of masks) {
      valid(!(used & mask), "overlapping color masks");
      used |= mask;
    }
    fields = masks.map((mask) => maskChannel(mask, depth));
  }
  const usedColors = header >= 36 ? u32(32) : 0;
  const paletteSize = depth <= 8 ? usedColors || 2 ** depth : usedColors;
  const entrySize = core ? 3 : 4;
  valid(
    (depth > 8 || paletteSize <= 2 ** depth) && offset + paletteSize * entrySize <= bytes.length,
    "truncated palette",
  );
  let palette;
  if (depth <= 8) {
    palette = new Uint8Array(paletteSize * 3);
    for (let n = 0; n < paletteSize; n++) {
      const b = offset + n * entrySize;
      palette[n * 3] = bytes[b + 2];
      palette[n * 3 + 1] = bytes[b + 1];
      palette[n * 3 + 2] = bytes[b];
    }
  }
  offset += paletteSize * entrySize;
  if (!icon) {
    valid(pixelOffset >= offset && pixelOffset <= bytes.length, "invalid pixel offset");
    offset = pixelOffset;
  }
  const stride = 4 * Math.ceil((width * depth) / 32);
  valid(rle || offset + height * stride <= bytes.length, "truncated pixel rows");
  const data = new Uint8ClampedArray(width * height * 4);
  let populatedAlpha = false;
  if (rle) {
    // Delta moves and short rows leave opaque black pixels in browser BMPs.
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    offset = rlePixels(bytes, offset, width, height, depth, palette, data);
  } else {
    for (let y = 0; y < height; y++, offset += stride) {
      let dst = (topDown ? y : height - 1 - y) * width * 4;
      for (let x = 0; x < width; x++, dst += 4) {
        if (depth <= 8) {
          const bit = x * depth;
          const index = (bytes[offset + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
          writePalette(data, dst, palette, index);
        } else if (depth === 24 || (depth === 32 && !bitfields && !masks[3])) {
          const p = offset + x * (depth / 8);
          data[dst] = bytes[p + 2];
          data[dst + 1] = bytes[p + 1];
          data[dst + 2] = bytes[p];
          data[dst + 3] = 255;
        } else {
          const word = depth === 16 ? u16(offset + x * 2) : u32(offset + x * 4);
          data[dst] = valueFor(word, fields[0]);
          data[dst + 1] = valueFor(word, fields[1]);
          data[dst + 2] = valueFor(word, fields[2]);
          data[dst + 3] = fields[3] ? valueFor(word, fields[3]) : 255;
          if (fields[3] && data[dst + 3]) populatedAlpha = true;
        }
      }
    }
  }
  // A populated 32-bit icon alpha channel supersedes the legacy AND mask.
  if (icon && !populatedAlpha) {
    const maskStride = 4 * Math.ceil(width / 32);
    valid(offset + maskStride * height <= bytes.length, "truncated icon transparency mask");
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const mask = bytes[offset + y * maskStride + (x >> 3)] & (128 >> (x & 7));
        const dst = ((topDown ? y : height - 1 - y) * width + x) * 4;
        if (mask) data.fill(0, dst, dst + 4);
        else data[dst + 3] = 255;
      }
  }
  return { width, height, data };
}

export function decodeBitmap(bytes) {
  valid(bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77, "invalid BMP file header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dib(bytes.subarray(14), view.getUint32(10, true) - 14, null);
}

export async function decodeIcon(bytes, decodePng) {
  valid(bytes.length >= 6, "truncated icon header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  const kind = view.getUint16(2, true);
  valid(
    view.getUint16(0, true) === 0 && (kind === 1 || kind === 2) && count && 6 + count * 16 <= bytes.length,
    "invalid icon directory",
  );
  let best;
  for (let n = 0, p = 6; n < count; n++, p += 16) {
    const width = bytes[p] || 256,
      height = bytes[p + 1] || 256;
    const depth = (kind === 1 && view.getUint16(p + 6, true)) || Math.ceil(Math.log2(bytes[p + 2] || 256));
    const size = view.getUint32(p + 8, true),
      offset = view.getUint32(p + 12, true);
    valid(offset >= 6 + count * 16 && size && offset + size <= bytes.length, "icon entry out of bounds");
    if (!best || width * height > best.area || (width * height === best.area && depth > best.depth)) {
      best = { width, height, depth, area: width * height, offset, size };
    }
  }
  const image = bytes.subarray(best.offset, best.offset + best.size);
  if (image[0] === 137 && image[1] === 80) {
    const rgba = await decodePng(image);
    valid(rgba.width === best.width && rgba.height === best.height, "icon PNG dimensions disagree");
    return rgba;
  }
  return dib(image, 0, best);
}
