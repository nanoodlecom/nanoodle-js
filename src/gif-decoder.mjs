// Decode the first GIF image onto its logical screen. The palette node and
// sprite renderer each consume a single bitmap, including for animated inputs.
function check(ok, detail) {
  if (!ok) throw new Error("Invalid GIF: " + detail);
}

function decodeIndices(input, minBits, count) {
  check(minBits >= 2 && minBits <= 8, "LZW code size");
  const clear = 1 << minBits,
    end = clear + 1;
  const prefix = new Uint16Array(4096),
    suffix = new Uint8Array(4096);
  const reverse = new Uint8Array(4097);
  const indices = new Uint8Array(count);
  let next = end + 1,
    width = minBits + 1,
    last = -1;
  let first = 0,
    at = 0,
    p = 0,
    bits = 0,
    available = 0;
  for (;;) {
    while (available < width) {
      check(p < input.length, "truncated LZW stream");
      bits |= input[p++] << available;
      available += 8;
    }
    const code = bits & ((1 << width) - 1);
    bits >>>= width;
    available -= width;
    if (code === end) break;
    if (code === clear) {
      next = end + 1;
      width = minBits + 1;
      last = -1;
      continue;
    }
    check(code < next || (code === next && last >= 0), "unknown LZW code");
    let n = 0,
      symbol = code;
    if (symbol === next) {
      reverse[n++] = first;
      symbol = last;
    }
    while (symbol >= end + 1) {
      reverse[n++] = suffix[symbol];
      symbol = prefix[symbol]; // prefix entries always refer to earlier codes
    }
    check(symbol < clear && at + n + 1 <= count, "LZW pixel count");
    first = symbol;
    indices[at++] = symbol;
    while (n) indices[at++] = reverse[--n];
    if (last >= 0 && next < 4096) {
      prefix[next] = last;
      suffix[next] = first;
      if (++next === 1 << width && width < 12) width++;
    }
    last = code;
  }
  check(at === count, "incomplete frame");
  return indices;
}

export function decodeGif(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = String.fromCharCode(...bytes.subarray(0, 6));
  check((version === "GIF87a" || version === "GIF89a") && bytes.length >= 13, "header");
  const width = view.getUint16(6, true),
    height = view.getUint16(8, true);
  check(
    width > 0 && height > 0 && width <= (height <= 128 ? 16384 : 8192) && height <= 8192,
    "screen dimensions",
  );
  let pos = 13;
  function palette(flags) {
    if (!(flags & 128)) return null;
    const size = 3 << ((flags & 7) + 1);
    check(size <= bytes.length - pos, "truncated color table");
    pos += size;
    return bytes.subarray(pos - size, pos);
  }
  function blocks(collect) {
    const parts = [];
    let length = 0;
    for (;;) {
      check(pos < bytes.length, "truncated sub-blocks");
      const size = bytes[pos++];
      if (!size) break;
      check(size <= bytes.length - pos, "truncated sub-block");
      if (collect) {
        parts.push(bytes.subarray(pos, pos + size));
        length += size;
      }
      pos += size;
    }
    if (!collect) return;
    const data = new Uint8Array(length);
    let written = 0;
    for (const part of parts) {
      data.set(part, written);
      written += part.length;
    }
    return data;
  }
  const global = palette(bytes[10]),
    bg = bytes[11];
  let transparent = -1;
  while (pos < bytes.length) {
    const tag = bytes[pos++];
    if (tag === 0x21) {
      const label = bytes[pos++];
      if (label === 0xf9) {
        check(
          bytes[pos] === 4 && pos + 6 <= bytes.length && bytes[pos + 5] === 0,
          "graphic control extension",
        );
        transparent = bytes[pos + 1] & 1 ? bytes[pos + 4] : -1;
        pos += 6;
      } else {
        blocks(false);
        if (label === 1) transparent = -1; // plain text consumed the control extension
      }
      continue;
    }
    check(tag === 0x2c && pos + 9 <= bytes.length, "missing first image");
    const left = view.getUint16(pos, true),
      top = view.getUint16(pos + 2, true);
    const w = view.getUint16(pos + 4, true),
      h = view.getUint16(pos + 6, true);
    const flags = bytes[pos + 8];
    pos += 9;
    check(w && h && left + w <= width && top + h <= height, "image dimensions");
    const colors = palette(flags) || global;
    check(colors, "missing color table");
    const minBits = bytes[pos++];
    const indices = decodeIndices(blocks(true), minBits, w * h);
    const data = new Uint8ClampedArray(width * height * 4);
    if (transparent < 0 && global && bg * 3 + 2 < global.length && (w !== width || h !== height)) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = global[3 * bg];
        data[i + 1] = global[3 * bg + 1];
        data[i + 2] = global[3 * bg + 2];
        data[i + 3] = 255;
      }
    }
    const passes =
      flags & 64
        ? [
            [0, 8],
            [4, 8],
            [2, 4],
            [1, 2],
          ]
        : [[0, 1]];
    let src = 0;
    for (const [start, step] of passes) {
      for (let y = start; y < h; y += step) {
        let dst = ((top + y) * width + left) * 4;
        for (let x = 0; x < w; x++, dst += 4) {
          const v = indices[src++];
          if (v === transparent) continue;
          check(v * 3 + 2 < colors.length, "palette index");
          data[dst] = colors[3 * v];
          data[dst + 1] = colors[3 * v + 1];
          data[dst + 2] = colors[3 * v + 2];
          data[dst + 3] = 255;
        }
      }
    }
    return { width, height, data };
  }
  throw new Error("Invalid GIF: no image");
}
