// PNG scanlines share their filtering and sample reconstruction across Adam7
// passes. The atlas can be wider than an ordinary texture (128 x 128 tiles).
import { inflate } from "./zlib.mjs";
import { NanoodleError } from "./errors.mjs";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function check(condition, detail) {
  if (!condition) throw new NanoodleError("Invalid PNG: " + detail);
}

function unfilter(row, prev, step, mode) {
  check(mode <= 4, "unknown scanline filter");
  if (!mode) return;
  for (let x = 0; x < row.length; x++) {
    const a = x >= step ? row[x - step] : 0;
    const b = prev ? prev[x] : 0;
    if (mode === 1) row[x] += a;
    else if (mode === 2) row[x] += b;
    else if (mode === 3) row[x] += (a + b) >> 1;
    else {
      const c = prev && x >= step ? prev[x - step] : 0;
      const da = Math.abs(b - c),
        db = Math.abs(a - c),
        dc = Math.abs(a + b - 2 * c);
      row[x] += da <= db && da <= dc ? a : db <= dc ? b : c;
    }
  }
}

function sample(row, n, depth) {
  if (depth === 8) return row[n];
  if (depth === 16) return row[2 * n] * 256 + row[2 * n + 1];
  const bit = n * depth;
  return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

export async function decodePngPixels(bytes, { maxDim, allowSpriteStrip, firstAnimationFrame = false }) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  check(
    SIGNATURE.every((v, i) => u[i] === v),
    "signature",
  );
  const view = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let w,
    h,
    depth,
    type,
    interlace,
    palette,
    trns,
    ended = false,
    compressedSize = 0;
  let animated = false,
    sawIdat = false,
    controlCount = 0,
    firstFrame;
  const chunks = [];
  for (let p = 8; p + 12 <= u.length; ) {
    const length = view.getUint32(p),
      start = p + 8;
    check(start + length + 4 <= u.length, "truncated chunk");
    const name = String.fromCharCode(...u.subarray(p + 4, start));
    const data = u.subarray(start, start + length);
    check(name === "IHDR" || w, "missing header");
    if (name === "IHDR") {
      check(p === 8 && length === 13, "header");
      w = view.getUint32(start);
      h = view.getUint32(start + 4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
      const maxWidth = allowSpriteStrip && h <= 128 ? 16384 : maxDim;
      check(w > 0 && h > 0, "empty dimensions");
      if (w > maxWidth || h > maxDim)
        throw new NanoodleError(
          `image is too large to resize in-process (${w}×${h}; max ${maxDim}px) — use smaller source dimensions`,
        );
      check(DEPTHS[type]?.includes(depth) && !data[10] && !data[11] && interlace <= 1, "header encoding");
    } else if (name === "PLTE") {
      check(!sawIdat && length > 0 && length <= 768 && length % 3 === 0, "palette");
      palette = data;
    } else if (name === "tRNS") {
      check(
        !sawIdat &&
          ((type === 3 && palette && length <= palette.length / 3) ||
            (type === 0 && length === 2) ||
            (type === 2 && length === 6)),
        "transparency",
      );
      trns = data;
    } else if (firstAnimationFrame && name === "acTL") {
      check(!sawIdat && !animated && length === 8 && view.getUint32(start), "animation control");
      animated = true;
    } else if (animated && name === "fcTL") {
      check(length === 26, "animation frame control");
      if (++controlCount === 1) {
        const width = view.getUint32(start + 4),
          height = view.getUint32(start + 8);
        const x = view.getUint32(start + 12),
          y = view.getUint32(start + 16);
        check(
          width && height && x + width <= w && y + height <= h && data[24] <= 2 && data[25] <= 1,
          "animation frame bounds or operation",
        );
        check(sawIdat || (width === w && height === h && !x && !y), "animated IDAT dimensions");
        firstFrame = { width, height, x, y, poster: sawIdat, over: data[25] === 1 };
        // With fcTL after IDAT, IDAT is a separate poster outside the animation.
        if (sawIdat) {
          chunks.length = 0;
          compressedSize = 0;
        }
      }
    } else if (animated && name === "fdAT") {
      check(firstFrame && sawIdat && length >= 4, "animation frame data");
      if (controlCount === 1 && firstFrame.poster) {
        chunks.push(data.subarray(4));
        compressedSize += length - 4;
      }
    } else if (name === "IDAT") {
      check(!firstFrame?.poster, "IDAT after animation frame data");
      sawIdat = true;
      compressedSize += length;
      chunks.push(data);
    } else if (name === "IEND") {
      check(length === 0, "end chunk");
      ended = true;
      break;
    } else check((u[p + 4] & 32) !== 0, "unsupported critical chunk " + name);
    p = start + length + 4;
  }
  check(ended && chunks.length && (type !== 3 || palette), "missing image data or palette");
  const frame = firstFrame || { width: w, height: h, x: 0, y: 0 };
  const channels = CHANNELS[type],
    bpp = channels * depth;
  const passes = [];
  let expected = 0;
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const cols = Math.ceil((frame.width - x0) / dx),
      rows = Math.ceil((frame.height - y0) / dy);
    if (cols <= 0 || rows <= 0) continue;
    const stride = Math.ceil((cols * bpp) / 8);
    passes.push({ x0, y0, dx, dy, cols, rows, stride });
    expected += rows * (stride + 1);
  }
  let compressed = chunks[0];
  if (chunks.length > 1) {
    compressed = new Uint8Array(compressedSize);
    let at = 0;
    for (const chunk of chunks) {
      compressed.set(chunk, at);
      at += chunk.length;
    }
  }
  const raw = await inflate(compressed, expected);
  check(raw.length === expected, "unexpected decompressed length");
  const rgba = new Uint8ClampedArray(w * h * 4);
  const max = (1 << depth) - 1;
  const uint8 = depth === 8 ? (v) => v : (v) => Math.round((v * 255) / max);
  const key = [];
  if (trns && type !== 3) {
    for (let i = 0; i < trns.length; i += 2) key.push(trns[i] * 256 + trns[i + 1]);
  }
  let p = 0;
  for (const { x0, y0, dx, dy, cols, rows, stride } of passes) {
    let prev;
    for (let y = 0; y < rows; y++) {
      const filter = raw[p++];
      const row = raw.subarray(p, p + stride);
      p += stride;
      unfilter(row, prev, Math.ceil(bpp / 8), filter);
      prev = row;
      let dst = ((frame.y + y0 + y * dy) * w + frame.x + x0) * 4;
      if (type === 6 && depth === 8 && dx === 1) {
        rgba.set(row, dst);
        continue;
      }
      for (let col = 0, n = 0; col < cols; col++, n += channels, dst += dx * 4) {
        const first = sample(row, n, depth);
        if (type === 3) {
          check(3 * first + 2 < palette.length, "palette index");
          rgba[dst] = palette[3 * first];
          rgba[dst + 1] = palette[3 * first + 1];
          rgba[dst + 2] = palette[3 * first + 2];
          rgba[dst + 3] = trns?.[first] ?? 255;
        } else if (type === 0 || type === 4) {
          rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = uint8(first);
          rgba[dst + 3] = type === 4 ? uint8(sample(row, n + 1, depth)) : first === key[0] ? 0 : 255;
        } else {
          const g = sample(row, n + 1, depth),
            b = sample(row, n + 2, depth);
          rgba[dst] = uint8(first);
          rgba[dst + 1] = uint8(g);
          rgba[dst + 2] = uint8(b);
          rgba[dst + 3] =
            type === 6
              ? uint8(sample(row, n + 3, depth))
              : first === key[0] && g === key[1] && b === key[2]
                ? 0
                : 255;
        }
      }
    }
  }
  // The first animation frame blends onto transparent black. Only fully
  // transparent samples differ between SOURCE and OVER on an empty canvas.
  if (frame.over)
    for (let y = frame.y; y < frame.y + frame.height; y++) {
      for (let x = frame.x; x < frame.x + frame.width; x++) {
        const dst = (y * w + x) * 4;
        if (!rgba[dst + 3]) rgba.fill(0, dst, dst + 3);
      }
    }
  return { w, h, rgba };
}
