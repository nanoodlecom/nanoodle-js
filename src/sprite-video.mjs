// A small H.264 Baseline encoder for software-rendered pixel art. I_PCM
// preserves changed macroblocks; P_Skip cheaply repeats stationary areas.
// These are standard H.264 macroblock types. MP4CAT supplies the container.
import { MP4CAT } from "./mp4cat.mjs";

const GOP = 60;
const BLOCK_BYTES = 16 * 16 + 2 * 8 * 8;

class Bits {
  constructor() {
    this.buffer = new Uint8Array(128);
    this.size = 0;
    this.partial = 0;
    this.used = 0;
  }

  reserve(count) {
    if (this.size + count <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(this.buffer.length * 2, this.size + count));
    next.set(this.buffer.subarray(0, this.size));
    this.buffer = next;
  }

  bit(value) {
    this.partial = (this.partial << 1) | Number(value);
    if (++this.used === 8) this.align();
  }

  align() {
    if (!this.used) return;
    this.reserve(1);
    this.buffer[this.size++] = this.partial << (8 - this.used);
    this.partial = 0;
    this.used = 0;
  }

  uint(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bit((value >>> i) & 1);
  }

  ue(value) {
    const code = value + 1;
    const length = 32 - Math.clz32(code);
    this.uint(0, length - 1);
    this.uint(code, length);
  }

  bytes(bytes) {
    this.align();
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.size);
    this.size += bytes.length;
  }

  finish() {
    this.bit(1);
    this.align();
    return this.buffer.subarray(0, this.size);
  }
}

// H.264 7.4.1: escape start-code emulation even inside raw PCM. MP4 video
// samples carry a four-byte length; avcC stores the parameter sets separately.
function nal(header, rbsp, lengthPrefixed = false) {
  let extra = 0, zeros = 0;
  for (const b of rbsp) {
    if (zeros === 2 && b <= 3) { extra++; zeros = 0; }
    zeros = b === 0 ? zeros + 1 : 0;
  }
  const length = 1 + rbsp.length + extra;
  const out = new Uint8Array((lengthPrefixed ? 4 : 0) + length);
  let pos = lengthPrefixed ? 4 : 0;
  if (lengthPrefixed) new DataView(out.buffer).setUint32(0, length);
  out[pos++] = header;
  if (!extra) {
    out.set(rbsp, pos);
    return out;
  }
  zeros = 0;
  for (const b of rbsp) {
    if (zeros === 2 && b <= 3) { out[pos++] = 3; zeros = 0; }
    out[pos++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

// Annex A, Tables A-1/A-2: frame size in macroblocks, MB/s, baseline kb/s.
// Start at level 3, supported by conventional mobile and desktop AVC players.
function avcLevel(cols, rows, fps, kbps) {
  const levels = [
    [30, 1620, 40500, 10000], [31, 3600, 108000, 14000], [32, 5120, 216000, 20000],
    [40, 8192, 245760, 20000], [41, 8192, 245760, 50000], [42, 8704, 522240, 50000],
    [50, 22080, 589824, 135000], [51, 36864, 983040, 240000], [52, 36864, 2073600, 240000],
    [60, 139264, 4177920, 240000], [61, 139264, 8355840, 480000], [62, 139264, 16711680, 800000],
  ];
  const blocks = cols * rows;
  const level = levels.find(([, fs, mbps, br]) => blocks <= fs && Math.max(cols, rows) ** 2 <= 8 * fs &&
    blocks * fps <= mbps && kbps <= br);
  if (!level) throw new Error("Sprite video exceeds H.264 Baseline level limits.");
  return level[0];
}

function parameterSets(width, height, cols, rows, level) {
  const s = new Bits();
  s.bytes(Uint8Array.of(66, 0xc0, level));
  s.ue(0); s.ue(0); s.ue(2); s.ue(1); // SPS id, four frame_num bits, POC type 2, one reference
  s.bit(0); s.ue(cols - 1); s.ue(rows - 1);
  s.bit(1); s.bit(1);                 // progressive, direct_8x8_inference
  const right = (cols * 16 - width) / 2;
  const bottom = (rows * 16 - height) / 2;
  s.bit(!!(right || bottom));
  if (right || bottom) { s.ue(0); s.ue(right); s.ue(0); s.ue(bottom); }
  // Square pixels, limited-range BT.601 matrix applied to sRGB primaries
  // and transfer. Explicit metadata keeps large and small clips consistent.
  s.bit(1);                            // VUI present
  s.bit(1); s.uint(1, 8);              // 1:1 sample aspect ratio
  s.bit(0);                            // no overscan information
  s.bit(1); s.uint(5, 3); s.bit(0); s.bit(1);
  s.uint(1, 8); s.uint(13, 8); s.uint(6, 8);
  s.bit(1); s.ue(1); s.ue(1);          // centred 2x2 chroma samples
  s.uint(0, 5);                        // timing, NAL/VCL HRD, pic_struct, restrictions
  const p = new Bits();
  p.ue(0); p.ue(0); p.bit(0); p.bit(0); // CAVLC, one slice group
  p.ue(0); p.ue(0); p.ue(0);
  p.bit(0); p.uint(0, 2);             // weighted prediction
  p.ue(0); p.ue(0); p.ue(0);         // signed Exp-Golomb zero QP offsets
  p.bit(1); p.bit(0); p.bit(0);       // deblock control present
  return [nal(0x67, s.finish()), nal(0x68, p.finish())];
}

// BT.601 limited-range Y'CbCr. Composite onto black before subsampling;
// repeat the outermost pixel for partial right/bottom macroblocks. Store
// each block contiguously in H.264's Y, Cb, Cr order for direct I_PCM writes.
function packBlocks(frame, cols, rows, blocks) {
  const { data, width, height } = frame;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    const start = (by * cols + bx) * BLOCK_BYTES;
    let chroma = 0;
    for (let y = 0; y < 16; y += 2) for (let x = 0; x < 16; x += 2) {
      let red = 0, green = 0, blue = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = Math.min(by * 16 + y + dy, height - 1);
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(bx * 16 + x + dx, width - 1);
          const pixel = (sy * width + sx) * 4;
          const alpha = data[pixel + 3];
          let r = 0, g = 0, b = 0;
          if (alpha === 255) {
            r = data[pixel]; g = data[pixel + 1]; b = data[pixel + 2];
          } else if (alpha) {
            r = Math.floor((data[pixel] * alpha + 127) / 255);
            g = Math.floor((data[pixel + 1] * alpha + 127) / 255);
            b = Math.floor((data[pixel + 2] * alpha + 127) / 255);
          }
          blocks[start + (y + dy) * 16 + x + dx] = 16 + ((66 * r + 129 * g + 25 * b + 128) >> 8);
          red += r; green += g; blue += b;
        }
      }
      blocks[start + 256 + chroma] = 128 + ((-38 * red - 74 * green + 112 * blue + 512) >> 10);
      blocks[start + 320 + chroma] = 128 + ((112 * red - 94 * green - 18 * blue + 512) >> 10);
      chroma++;
    }
  }
}

// A flat block can use an Intra_16x16 directional prediction when its
// left or top neighbour is the same colour. No transform coefficients then
// need transmitting. Record a colour only when every sample matches.
function flatColor(words, offset) {
  const y = words[offset], cb = words[offset + 64], cr = words[offset + 80];
  if (y !== (y >>> 24) * 0x01010101 || cb !== (cb >>> 24) * 0x01010101 ||
      cr !== (cr >>> 24) * 0x01010101) return -1;
  for (let i = 1; i < 64; i++) if (words[offset + i] !== y) return -1;
  for (let i = 1; i < 16; i++) {
    if (words[offset + 64 + i] !== cb || words[offset + 80 + i] !== cr) return -1;
  }
  return ((y & 255) << 16) | ((cb & 255) << 8) | (cr & 255);
}

function encodeSlice(index, current, previous, cols) {
  const idr = index % GOP === 0;
  const s = new Bits();
  s.ue(0); s.ue(idr ? 2 : 0); s.ue(0); // first macroblock, I/P slice, PPS id
  s.uint((index % GOP) & 15, 4);
  if (idr) {
    s.ue(Math.floor(index / GOP) & 1);  // alternate idr_pic_id
    s.bit(0); s.bit(0);                // no_output_of_prior_pics, long_term_reference
  } else {
    s.bit(0); s.bit(0); s.bit(0);      // default reference list and sliding reference window
  }
  s.ue(0); s.ue(1);                    // zero QP delta, disabled deblocking (exact P_Skip)
  const curWords = new Uint32Array(current.buffer);
  const refWords = new Uint32Array(previous.buffer);
  const colors = new Int32Array(cols);
  const pcm = new Uint8Array(cols);
  let skipped = 0;
  for (let offset = 0, block = 0; offset < current.length; offset += BLOCK_BYTES, block++) {
    const x = block % cols;
    const hasLeft = x !== 0, hasTop = block >= cols;
    const color = flatColor(curWords, offset / 4);
    const matchLeft = color >= 0 && hasLeft && colors[x - 1] === color;
    const matchTop = color >= 0 && hasTop && colors[x] === color;
    colors[x] = color;
    if (!idr) {
      let word = offset / 4;
      const end = word + BLOCK_BYTES / 4;
      while (word < end && curWords[word] === refWords[word]) word++;
      if (word === end) { pcm[x] = 0; skipped++; continue; }
      s.ue(skipped);
      skipped = 0;
    }
    if (matchLeft || matchTop) {
      const horizontal = matchLeft;
      s.ue((idr ? 1 : 6) + Number(horizontal)); // zero AC/chroma, luma vertical or horizontal
      s.ue(horizontal ? 1 : 2);                 // chroma horizontal or vertical
      s.ue(0);                                 // no QP delta
      // A PCM neighbour contributes 16 to nC. With our only other modes
      // (skipped or zero residual), the CAVLC nC table is either 0 or >=8.
      if ((hasLeft && pcm[x - 1]) || (hasTop && pcm[x])) s.uint(3, 6);
      else s.bit(1);                           // coeff_token for zero luma DC coefficients
      pcm[x] = 0;
    } else {
      s.ue(idr ? 25 : 30);                    // I_PCM in the I/P mb_type tables
      s.bytes(current.subarray(offset, offset + BLOCK_BYTES));
      pcm[x] = 1;
    }
  }
  if (skipped) s.ue(skipped);
  return { bytes: nal(idr ? 0x65 : 0x41, s.finish(), true), sync: idr };
}

export async function encodeSpriteMp4(frames, duration) {
  if (!(Number.isFinite(duration) && duration > 0)) throw new Error("Invalid sprite video duration.");
  let width, height, cols, rows, current, previous;
  const samples = [];
  let totalBytes = 0;
  for await (const frame of frames) {
    if (!samples.length) {
      ({ width, height } = frame);
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 ||
          width > 65534 || height > 65534 || (width & 1) || (height & 1))
        throw new Error("Sprite video requires even pixel dimensions.");
      cols = Math.ceil(width / 16); rows = Math.ceil(height / 16);
      current = new Uint8Array(cols * rows * BLOCK_BYTES);
      previous = new Uint8Array(current.length);
    }
    if (frame.width !== width || frame.height !== height || frame.data.length !== width * height * 4)
      throw new Error("Sprite video frames have inconsistent dimensions.");
    packBlocks(frame, cols, rows, current);
    const sample = encodeSlice(samples.length, current, previous, cols);
    samples.push(sample);
    totalBytes += sample.bytes.length;
    // One 32-bit chunk offset per frame. Reject before accumulating further
    // samples; muxTracks also checks the final layout before allocating it.
    if (totalBytes + 40 > 0xffffffff) throw new Error("Sprite video exceeds the 32-bit MP4 size limit.");
    [current, previous] = [previous, current];
  }
  if (!samples.length) throw new Error("Sprite video needs at least one frame.");
  const level = avcLevel(cols, rows, samples.length / duration, totalBytes * 8 / duration / 1000);
  return MP4CAT.muxAvc(samples, width, height, duration, ...parameterSets(width, height, cols, rows, level));
}
