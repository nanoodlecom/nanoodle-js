/**
 * Local media ops that the browser runs with canvas / Web Audio / MediaRecorder / MP4CAT.
 *
 * Strategy (mirrors nanoodle/ play.html + index.html):
 *   1. Pure-JS path first — same algorithms the app uses when it can avoid re-encode
 *      (MP4CAT remux for matching mp4s, PCM-WAV trim, PNG canvas-equivalent resize).
 *   2. ffmpeg/ffprobe on PATH when pure JS can't handle the format (mismatched combine,
 *      JPEG resize, video frame grab, soundtrack mux, non-WAV audio, …). Soft dependency
 *      — not an npm package.
 *
 * Eventually the pure path is meant to cover everything the browser does and replace the
 * ffmpeg "custom executor" path; until then ffmpeg remains the heavy fallback.
 *
 * Outputs are data: URLs so they plug into the existing MediaRef / network-inline pipeline.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { NanoodleError } from "./errors.mjs";
import { bytesToDataUrl, dataUrlBytes, sniffMime, MEDIA_INLINE_MAX } from "./media.mjs";
import { MP4CAT } from "./mp4cat.mjs";

const MAX_FRAMES = 12;
/** Refuse pure PNG decode above this edge (memory guard; canvas-class bound). */
const MAX_IMAGE_DIM = 8192;
/** Refuse pure WAV decode above this many interleaved samples (~17 min mono @ 48 kHz). */
const MAX_WAV_SAMPLES = 50_000_000;
const PROC_STDOUT_MAX = 32 * 1024 * 1024;

/* ---------- process helpers ------------------------------------------------ */

function abortError(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error) return r;
  return new NanoodleError(r != null ? String(r) : "run aborted", { code: "aborted" });
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal);
}

function runProc(bin, args, { timeoutMs = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError(signal));
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const to = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new NanoodleError(`${bin} timed out after ${timeoutMs}ms`, { code: "timeout" })));
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(() => reject(abortError(signal)));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => {
      if (stdout.length < PROC_STDOUT_MAX) {
        stdout = Buffer.concat([stdout, d.length + stdout.length > PROC_STDOUT_MAX
          ? d.subarray(0, PROC_STDOUT_MAX - stdout.length) : d]);
      }
    });
    child.stderr.on("data", (d) => {
      // keep a trailing window for error messages
      stderr = Buffer.concat([stderr, d]);
      if (stderr.length > 64 * 1024) stderr = stderr.subarray(stderr.length - 64 * 1024);
    });
    child.on("error", (e) => {
      if (e && e.code === "ENOENT") {
        finish(() => reject(new NanoodleError(
          `local media nodes need ffmpeg on PATH (not found: ${bin}). ` +
          "Install ffmpeg, or run this graph in the nanoodle browser app.")));
      } else finish(() => reject(e));
    });
    child.on("close", (code) => {
      if (code === 0) finish(() => resolve({ stdout, stderr: stderr.toString("utf8") }));
      else finish(() => reject(new NanoodleError(
        `${bin} failed (exit ${code}): ${(stderr.toString("utf8") || "").trim().slice(-400) || "no stderr"}`)));
    });
  });
}

function isMissingFfmpeg(err) {
  return err instanceof NanoodleError && /need ffmpeg on PATH/i.test(err.message || "");
}

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-media-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** data:/https URL (or raw string MediaRef url) → bytes. */
async function urlBytes(url, fetchFn) {
  if (url == null) throw new NanoodleError("no media input");
  const u = typeof url === "object" && url.url != null ? url.url : String(url);
  if (/^data:/i.test(u)) return dataUrlBytes(u).bytes;
  if (/^https?:/i.test(u)) {
    const fetchImpl = fetchFn || globalThis.fetch;
    if (!fetchImpl) throw new NanoodleError("can't download media: no fetch available");
    const r = await fetchImpl(u);
    if (!r.ok) throw new NanoodleError(`couldn't download media (${r.status}): ${u.slice(0, 120)}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  throw new NanoodleError("media must be a data: or http(s) URL");
}

async function writeInput(dir, name, url, fetchFn) {
  const bytes = await urlBytes(url, fetchFn);
  // preserve a sensible extension so ffmpeg picks the demuxer
  let ext = ".bin";
  if (/^data:/i.test(String(typeof url === "object" ? url.url : url))) {
    const mime = sniffMime(bytes);
    ext = mime.includes("png") ? ".png"
      : mime.includes("jpeg") ? ".jpg"
      : mime.includes("webp") ? ".webp"
      : mime.includes("gif") ? ".gif"
      : mime.includes("wav") ? ".wav"
      : mime.includes("mpeg") || mime.includes("mp3") ? ".mp3"
      : mime.includes("mp4") ? ".mp4"
      : mime.includes("webm") ? ".webm"
      : ".bin";
  } else {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(typeof url === "object" ? url.url : url));
    if (m) ext = "." + m[1].toLowerCase();
  }
  const path = join(dir, name + ext);
  await writeFile(path, bytes);
  return path;
}

function dataUrlFromFile(path, mimeHint) {
  return readFile(path).then((buf) => {
    const u8 = new Uint8Array(buf);
    const mime = mimeHint || sniffMime(u8);
    return bytesToDataUrl(u8, mime);
  });
}

function dataUrlFromBytes(bytes, mime) {
  return bytesToDataUrl(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mime);
}

/* ---------- resizePlan (verbatim from index.html / play.html) -------------- */

/** @returns {{ cw, ch, dx, dy, dw, dh }|null} */
export function resizePlan(sw, sh, mode, tw, th) {
  if (!(tw > 0) && !(th > 0)) return null;
  if (mode === "fit") {
    let scale;
    if (tw > 0 && th > 0) scale = Math.min(tw / sw, th / sh);
    else if (tw > 0) scale = tw / sw;
    else scale = th / sh;
    if (scale > 1) scale = 1; // never upscale
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    return { cw: w, ch: h, dx: 0, dy: 0, dw: w, dh: h };
  }
  const bw = tw > 0 ? tw : Math.max(1, Math.round(th * sw / sh));
  const bh = th > 0 ? th : Math.max(1, Math.round(tw * sh / sw));
  if (mode === "exact") return { cw: bw, ch: bh, dx: 0, dy: 0, dw: bw, dh: bh };
  // fill & crop: cover, centered
  const scale = Math.max(bw / sw, bh / sh);
  const dw = sw * scale, dh = sh * scale;
  return { cw: bw, ch: bh, dx: (bw - dw) / 2, dy: (bh - dh) / 2, dw, dh };
}

/* ---------- pure PNG (canvas-equivalent resize for PNG sources) ------------ */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type, data) {
  const typeB = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Decode 8-bit RGB/RGBA/gray/gray+alpha PNG → { w, h, rgba:Uint8ClampedArray }. */
function decodePng(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50) {
    throw new NanoodleError("couldn't read that image to resize");
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new NanoodleError("couldn't read that image to resize");

  let w = 0, h = 0, bitDepth = 8, colorType = 2;
  const idats = [];
  let p = 8;
  while (p + 8 <= u8.length) {
    // >>> 0: PNG chunk lengths are unsigned; JS << is signed 32-bit
    const len = ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
    if (p + 12 + len > u8.length) throw new NanoodleError("couldn't read that image to resize");
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    const data = u8.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === "IHDR") {
      w = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      h = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new NanoodleError("couldn't read that image to resize"); // compressed/filter/interlace
      }
    } else if (type === "IDAT") {
      idats.push(Buffer.from(data));
    } else if (type === "IEND") break;
  }
  if (!(w > 0) || !(h > 0) || bitDepth !== 8) {
    throw new NanoodleError("couldn't read that image to resize");
  }
  if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
    throw new NanoodleError(
      `image is too large to resize in-process (${w}×${h}; max ${MAX_IMAGE_DIM}px) — use smaller source dimensions`);
  }
  // colorType: 0 gray, 2 RGB, 4 gray+A, 6 RGBA (no palette)
  if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) {
    throw new NanoodleError("couldn't read that image to resize");
  }
  const cpp = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const raw = inflateSync(Buffer.concat(idats));
  const stride = w * cpp;
  const expected = h * (1 + stride);
  if (raw.length < expected) throw new NanoodleError("couldn't read that image to resize");

  const unfiltered = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ftype = raw[y * (1 + stride)];
    const row = raw.subarray(y * (1 + stride) + 1, y * (1 + stride) + 1 + stride);
    const dest = unfiltered.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? unfiltered.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const left = x >= cpp ? dest[x - cpp] : 0;
      const up = prev ? prev[x] : 0;
      const upLeft = prev && x >= cpp ? prev[x - cpp] : 0;
      let v = row[x];
      if (ftype === 1) v = (v + left) & 255; // Sub
      else if (ftype === 2) v = (v + up) & 255; // Up
      else if (ftype === 3) v = (v + ((left + up) >> 1)) & 255; // Average
      else if (ftype === 4) { // Paeth
        const p0 = left + up - upLeft;
        const pa = Math.abs(p0 - left), pb = Math.abs(p0 - up), pc = Math.abs(p0 - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        v = (v + pr) & 255;
      } else if (ftype !== 0) {
        throw new NanoodleError("couldn't read that image to resize");
      }
      dest[x] = v;
    }
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, px = 0; i < w * h; i++, px += cpp) {
    const o = i * 4;
    if (colorType === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = unfiltered[px];
      rgba[o + 3] = 255;
    } else if (colorType === 2) {
      rgba[o] = unfiltered[px]; rgba[o + 1] = unfiltered[px + 1]; rgba[o + 2] = unfiltered[px + 2];
      rgba[o + 3] = 255;
    } else if (colorType === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = unfiltered[px];
      rgba[o + 3] = unfiltered[px + 1];
    } else {
      rgba[o] = unfiltered[px]; rgba[o + 1] = unfiltered[px + 1];
      rgba[o + 2] = unfiltered[px + 2]; rgba[o + 3] = unfiltered[px + 3];
    }
  }
  return { w, h, rgba };
}

function encodePngRgba(w, h, rgba) {
  // Filter type 0 (None) per row — simple, correct.
  const stride = w * 4;
  const raw = Buffer.alloc(h * (1 + stride));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + stride)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (1 + stride) + 1);
  }
  const compressed = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Bilinear sample of source RGBA at floating pixel coords (canvas-like smoothing). */
function sampleBilinear(src, sw, sh, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
  const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
  const out = new Uint8ClampedArray(4);
  for (let c = 0; c < 4; c++) {
    const v =
      src[i00 + c] * (1 - fx) * (1 - fy) +
      src[i10 + c] * fx * (1 - fy) +
      src[i01 + c] * (1 - fx) * fy +
      src[i11 + c] * fx * fy;
    out[c] = Math.round(v);
  }
  return out;
}

/**
 * Pure resize matching canvas drawImage(img, dx, dy, dw, dh) onto cw×ch.
 * PNG only (JPEG needs ffmpeg). Output always PNG (preserves alpha like browser PNG path).
 */
function resizeCropPngPure(bytes, mode, tw, th) {
  const { w: sw, h: sh, rgba } = decodePng(bytes);
  const p = resizePlan(sw, sh, mode, tw, th);
  if (!p) throw new NanoodleError("set a width or height to resize to");
  // Canvas default: transparent black outside the draw rect.
  const out = new Uint8ClampedArray(p.cw * p.ch * 4);
  for (let y = 0; y < p.ch; y++) {
    for (let x = 0; x < p.cw; x++) {
      // Inverse of drawImage(img, dx, dy, dw, dh): dest pixel → continuous source coords.
      const u = (x + 0.5 - p.dx) / p.dw * sw - 0.5;
      const v = (y + 0.5 - p.dy) / p.dh * sh - 0.5;
      if (u < -0.5 || v < -0.5 || u > sw - 0.5 || v > sh - 0.5) continue;
      const sx = Math.max(0, Math.min(sw - 1, u));
      const sy = Math.max(0, Math.min(sh - 1, v));
      const pix = sampleBilinear(rgba, sw, sh, sx, sy);
      const o = (y * p.cw + x) * 4;
      out[o] = pix[0]; out[o + 1] = pix[1]; out[o + 2] = pix[2]; out[o + 3] = pix[3];
    }
  }
  return encodePngRgba(p.cw, p.ch, out);
}

/* ---------- pure WAV (encodeWavMono + PCM trim — from play.html) ----------- */

/** encodeWavMono from play.html — Float32 mono samples → PCM16 WAV bytes. */
export function encodeWavMono(samples, sampleRate) {
  const n = samples.length, dataLen = n * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); ws(8, "WAVE");
  ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(ab);
}

/** Parse PCM WAV → { sampleRate, channels, samples: Float32Array interleaved }. */
function parsePcmWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 44) throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
  }
  let sampleRate = 0, channels = 0, bits = 0, dataOff = -1, dataLen = 0;
  let p = 12;
  while (p + 8 <= u8.length) {
    const id = ascii(p, 4);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === "fmt ") {
      const format = dv.getUint16(body, true);
      if (format !== 1 && format !== 3) {
        throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
      }
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      // store format in bits high for float32: mark via bits===32 && format===3
      if (format === 3) bits = -32; // float32 sentinel
    } else if (id === "data") {
      dataOff = body;
      // clamp claimed size to bytes actually present (truncated / lying headers)
      dataLen = Math.min(size, Math.max(0, u8.length - body));
      break;
    }
    p = body + size + (size & 1); // word-align
  }
  if (dataOff < 0 || !(sampleRate > 0) || !(channels > 0)) {
    throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
  }
  let samples;
  if (bits === 16) {
    const n = Math.floor(dataLen / 2);
    if (n > MAX_WAV_SAMPLES) {
      throw new NanoodleError("audio is too long to trim in-process — use a shorter clip");
    }
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = dv.getInt16(dataOff + i * 2, true) / 0x8000;
  } else if (bits === 8) {
    const n = dataLen;
    if (n > MAX_WAV_SAMPLES) {
      throw new NanoodleError("audio is too long to trim in-process — use a shorter clip");
    }
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = (u8[dataOff + i] - 128) / 128;
  } else if (bits === -32) {
    const n = Math.floor(dataLen / 4);
    if (n > MAX_WAV_SAMPLES) {
      throw new NanoodleError("audio is too long to trim in-process — use a shorter clip");
    }
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = dv.getFloat32(dataOff + i * 4, true);
  } else if (bits === 32) {
    const n = Math.floor(dataLen / 4);
    if (n > MAX_WAV_SAMPLES) {
      throw new NanoodleError("audio is too long to trim in-process — use a shorter clip");
    }
    samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = dv.getInt32(dataOff + i * 4, true) / 0x80000000;
  } else {
    throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
  }
  return { sampleRate, channels, samples };
}

function downmixMono(samples, channels) {
  if (channels === 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += samples[i * channels + c];
    out[i] = s / channels;
  }
  return out;
}

/** Linear resample mono Float32 to target rate (OfflineAudioContext stand-in). */
function resampleMono(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const f = x - i0;
    out[i] = samples[i0] * (1 - f) + samples[i1] * f;
  }
  return out;
}

/**
 * Pure PCM-WAV trim — same slice semantics as play.html trimAudioToWavUrl.
 * wholeIfBlank: extractaudio path (blank length → rest of clip).
 */
function trimPcmWavPure(bytes, start, len, rate, { wholeIfBlank = false } = {}) {
  const { sampleRate, channels, samples } = parsePcmWav(bytes);
  let mono = downmixMono(samples, channels);
  const dur = mono.length / sampleRate;
  const s0 = start || 0;
  if (s0 >= dur) {
    throw new NanoodleError(
      `the start point (${Math.round(s0 * 10) / 10}s) is past the end of this clip, which is only ${dur.toFixed(1)}s long — pick an earlier start`);
  }
  const s = Math.max(0, Math.min(s0, Math.max(0, dur - 0.05)));
  let take;
  if (wholeIfBlank && !(len > 0)) take = Math.max(0.05, dur - s);
  else {
    const L = Number.isFinite(Number(len)) && Number(len) > 0 ? Number(len) : 30;
    take = Math.max(0.05, Math.min(L, dur - s));
  }
  const i0 = Math.floor(s * sampleRate);
  const n = Math.max(1, Math.floor(take * sampleRate));
  const sliced = mono.subarray(i0, Math.min(mono.length, i0 + n));
  const targetRate = rate || 16000;
  const out = resampleMono(sliced, sampleRate, targetRate);
  return encodeWavMono(out, targetRate);
}

/* ---------- resize (pure PNG → ffmpeg) ------------------------------------- */

/**
 * Resize/crop an image URL. mode: fit | fill | exact.
 * Pure path: PNG via zlib (canvas-equivalent geometry). JPEG/WebP/… → ffmpeg.
 * Browser keeps PNG for PNG sources (alpha); others → JPEG q≈0.92 (ffmpeg -q:v 2).
 */
export async function resizeCropImage(url, mode, tw, th, { fetch: fetchFn, signal } = {}) {
  throwIfAborted(signal);
  const w = Math.max(0, parseInt(tw, 10) || 0);
  const h = Math.max(0, parseInt(th, 10) || 0);
  if (!w && !h) throw new NanoodleError("set a width or height to resize to");
  const m = mode || "fit";

  const bytes = await urlBytes(url, fetchFn);
  throwIfAborted(signal);
  const mime = sniffMime(bytes);

  if (mime === "image/png") {
    try {
      const out = resizeCropPngPure(bytes, m, w, h);
      const dataUrl = dataUrlFromBytes(out, "image/png");
      if (dataUrl.length > MEDIA_INLINE_MAX) {
        throw new NanoodleError("resized image is still over the ~4 MB inline limit — pick smaller dimensions");
      }
      return dataUrl;
    } catch (e) {
      // rethrow user-facing limits; only fall through for "couldn't read" / exotic PNG
      if (e instanceof NanoodleError) {
        if (/width or height|inline limit|too large to resize/i.test(e.message || "")) throw e;
        if (!/couldn't read that image/i.test(e.message || "")) throw e;
      } else {
        throw e; // unexpected (OOM etc.) — don't mask with ffmpeg
      }
      // exotic PNG → try ffmpeg
    }
  }

  return resizeCropImageFfmpeg(url, m, w, h, { fetch: fetchFn, signal });
}

async function resizeCropImageFfmpeg(url, m, w, h, { fetch: fetchFn, signal } = {}) {
  return withTemp(async (dir) => {
    throwIfAborted(signal);
    const inPath = await writeInput(dir, "in", url, fetchFn);
    const probe = await runProc("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", inPath,
    ], { signal });
    const dims = String(probe.stdout).trim().split("x").map(Number);
    const sw = dims[0], sh = dims[1];
    if (!(sw > 0) || !(sh > 0)) throw new NanoodleError("couldn't read that image to resize");
    const p = resizePlan(sw, sh, m, w, h);
    if (!p) throw new NanoodleError("set a width or height to resize to");

    const srcUrl = typeof url === "object" && url.url != null ? url.url : String(url);
    const wantPng = /^data:image\/png/i.test(srcUrl) || /\.png$/i.test(inPath);
    const outPath = join(dir, wantPng ? "out.png" : "out.jpg");

    let vf;
    if (m === "fit" || m === "exact") {
      vf = `scale=${p.cw}:${p.ch}`;
    } else {
      vf = `scale=${p.cw}:${p.ch}:force_original_aspect_ratio=increase,crop=${p.cw}:${p.ch}`;
    }

    const args = ["-y", "-i", inPath, "-vf", vf];
    if (wantPng) args.push("-frames:v", "1", outPath);
    else args.push("-frames:v", "1", "-q:v", "2", outPath);
    await runProc("ffmpeg", args, { signal });

    const out = await dataUrlFromFile(outPath, wantPng ? "image/png" : "image/jpeg");
    if (out.length > MEDIA_INLINE_MAX) {
      throw new NanoodleError("resized image is still over the ~4 MB inline limit — pick smaller dimensions");
    }
    return out;
  });
}

/* ---------- audio trim / extract (pure WAV → ffmpeg) ----------------------- */

/**
 * Decode audio (or demux audio from video), slice [start, start+len], mono at `rate` Hz → data:audio/wav.
 * Pure path for PCM WAV (encodeWavMono + slice, same defaults as play.html).
 * len<=0 means "to end" for extract; for trim browser default length is 30 when blank.
 */
export async function trimAudioToWav(url, start, len, rate = 16000, { fetch: fetchFn, wholeIfBlank = false, signal } = {}) {
  throwIfAborted(signal);
  const bytes = await urlBytes(url, fetchFn);
  throwIfAborted(signal);
  const mime = sniffMime(bytes);

  if (mime === "audio/wav") {
    try {
      const wav = trimPcmWavPure(bytes, start, len, rate, { wholeIfBlank });
      return dataUrlFromBytes(wav, "audio/wav");
    } catch (e) {
      // past-end / too-long are final; only "unsupported format" falls through to ffmpeg
      if (e instanceof NanoodleError) {
        if (/past the end|too long to trim/i.test(e.message || "")) throw e;
        if (!/unsupported format/i.test(e.message || "")) throw e;
      } else {
        throw e;
      }
      // non-PCM or exotic WAV → ffmpeg
    }
  }

  return trimAudioToWavFfmpeg(url, start, len, rate, { fetch: fetchFn, wholeIfBlank, signal });
}

async function trimAudioToWavFfmpeg(url, start, len, rate = 16000, { fetch: fetchFn, wholeIfBlank = false, signal } = {}) {
  return withTemp(async (dir) => {
    throwIfAborted(signal);
    const inPath = await writeInput(dir, "in", url, fetchFn);
    const outPath = join(dir, "out.wav");
    const s = Math.max(0, Number(start) || 0);

    let dur = null;
    try {
      const pr = await runProc("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inPath,
      ], { signal });
      dur = parseFloat(String(pr.stdout).trim());
    } catch (e) {
      if (e instanceof NanoodleError && (e.code === "aborted" || e.code === "timeout" || /timed out|aborted/i.test(e.message || ""))) throw e;
      if (signal && signal.aborted) throw abortError(signal);
      /* some containers lack duration; ffmpeg -t still works */
    }

    if (dur != null && isFinite(dur) && s >= dur) {
      throw new NanoodleError(
        `the start point (${Math.round(s * 10) / 10}s) is past the end of this clip, which is only ${dur.toFixed(1)}s long — pick an earlier start`);
    }

    let take;
    if (wholeIfBlank && !(len > 0)) {
      take = dur != null && isFinite(dur) ? Math.max(0.05, dur - s) : null;
    } else {
      const L = Number.isFinite(Number(len)) && Number(len) > 0 ? Number(len) : 30;
      take = dur != null && isFinite(dur) ? Math.max(0.05, Math.min(L, dur - s)) : L;
    }

    const args = ["-y", "-ss", String(s), "-i", inPath];
    if (take != null) args.push("-t", String(take));
    args.push("-vn", "-ac", "1", "-ar", String(rate || 16000), "-f", "wav", outPath);
    try {
      await runProc("ffmpeg", args, { signal });
    } catch (e) {
      if (e instanceof NanoodleError && (e.code === "aborted" || e.code === "timeout")) throw e;
      const msg = e.message || "";
      if (/does not contain any stream|Output file does not contain|no audio/i.test(msg)
        || /Stream map|matches no streams/i.test(msg)) {
        throw new NanoodleError("this video is silent — generated videos usually have no audio track to extract");
      }
      if (/Invalid data|could not find codec/i.test(msg)) {
        throw new NanoodleError("couldn't decode that audio for trimming (unsupported format?)");
      }
      throw e;
    }
    return dataUrlFromFile(outPath, "audio/wav");
  });
}

export async function extractAudioToWav(url, start, len, rate = 16000, opts = {}) {
  return trimAudioToWav(url, start, len, rate, { ...opts, wholeIfBlank: true });
}

/* ---------- vframes (ffmpeg — needs a video decoder) ----------------------- */

export async function extractVideoFrames(url, { count = 1, gap = 0.5, dir = "end", fetch: fetchFn, onProgress, signal } = {}) {
  throwIfAborted(signal);
  const n = Math.max(1, Math.min(MAX_FRAMES, parseInt(count, 10) || 1));
  const stepSec = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 0.5;
  const fromEnd = (dir || "end") === "end";
  const EPS = 0.04;

  return withTemp(async (dir) => {
    const inPath = await writeInput(dir, "in", url, fetchFn);
    throwIfAborted(signal);
    const pr = await runProc("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inPath,
    ], { signal });
    const dur = parseFloat(String(pr.stdout).trim());
    if (!isFinite(dur) || dur <= 0) throw new NanoodleError("video has no readable duration");

    const out = {};
    for (let i = 0; i < n; i++) {
      throwIfAborted(signal);
      if (onProgress) onProgress(`extracting frame ${i + 1}/${n}…`);
      let t = fromEnd ? (dur - EPS - i * stepSec) : (i * stepSec);
      t = Math.max(0, Math.min(Math.max(0, dur - EPS), t));
      const framePath = join(dir, `f${i + 1}.jpg`);
      await runProc("ffmpeg", [
        "-y", "-ss", String(t), "-i", inPath, "-frames:v", "1", "-q:v", "2", framePath,
      ], { signal });
      out["frame" + (i + 1)] = await dataUrlFromFile(framePath, "image/jpeg");
    }
    return out;
  });
}

/* ---------- combine videos (MP4CAT pure → ffmpeg) -------------------------- */

/**
 * Concatenate clips in order — same dispatcher shape as play.html concatVideos:
 *   1. When every clip is mp4 with matching codec params → MP4CAT lossless remux
 *      (dedup is ignored on remux, as in the browser — dropping the first sample
 *      would kill the keyframe).
 *   2. Else re-encode via ffmpeg (browser falls back to MediaRecorder).
 */
export async function concatVideos(urls, dedup = true, { fetch: fetchFn, onProgress, signal } = {}) {
  if (!urls || urls.length < 2) throw new NanoodleError("wire at least two clips to combine");
  throwIfAborted(signal);

  // Pure path: load all bytes, try MP4CAT (exact browser primary path)
  try {
    const bufs = [];
    for (let i = 0; i < urls.length; i++) {
      throwIfAborted(signal);
      if (onProgress) onProgress(`loading clip ${i + 1}/${urls.length}…`);
      bufs.push(await urlBytes(urls[i], fetchFn));
    }
    if (bufs.every((b) => MP4CAT.isMp4(b)) && MP4CAT.mp4ParamsMatch(bufs)) {
      if (onProgress) onProgress("combining…");
      // Browser remux never applies dedup (would drop a keyframe).
      const out = MP4CAT.concatMp4(bufs, { dedup: false });
      return dataUrlFromBytes(out, "video/mp4");
    }
  } catch (e) {
    if (e && (e.code === "aborted" || e.code === "timeout")) throw e;
    if (e instanceof NanoodleError) {
      if (/wire at least two|no media|download media|aborted|timed out/i.test(e.message || "")) throw e;
      throw e; // other deliberate errors (not remux glitches)
    }
    // MP4CAT throws plain Error on parse issues → fall through to ffmpeg
  }

  return concatVideosFfmpeg(urls, dedup, { fetch: fetchFn, onProgress, signal });
}

async function concatVideosFfmpeg(urls, dedup = true, { fetch: fetchFn, onProgress, signal } = {}) {
  return withTemp(async (dir) => {
    const paths = [];
    for (let i = 0; i < urls.length; i++) {
      throwIfAborted(signal);
      if (onProgress) onProgress(`loading clip ${i + 1}/${urls.length}…`);
      paths.push(await writeInput(dir, `c${i}`, urls[i], fetchFn));
    }

    // When dedup: trim ~1/30s from the start of clips 2..N (approximate seam-frame drop —
    // MediaRecorder path equivalent; pure remux path above never drops frames).
    const prepared = [];
    for (let i = 0; i < paths.length; i++) {
      throwIfAborted(signal);
      if (dedup && i > 0) {
        const trimmed = join(dir, `t${i}.mp4`);
        await runProc("ffmpeg", [
          "-y", "-ss", "0.033", "-i", paths[i],
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
          "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", trimmed,
        ], { signal });
        prepared.push(trimmed);
      } else {
        prepared.push(paths[i]);
      }
    }

    const listPath = join(dir, "list.txt");
    const listBody = prepared.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await writeFile(listPath, listBody);

    const outPath = join(dir, "out.mp4");
    if (onProgress) onProgress("combining…");
    try {
      await runProc("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outPath,
      ], { signal });
    } catch (e) {
      if (e instanceof NanoodleError && (e.code === "aborted" || e.code === "timeout" || /aborted|timed out/i.test(e.message || ""))) throw e;
      await runProc("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outPath,
      ], { signal });
    }
    return dataUrlFromFile(outPath, "video/mp4");
  });
}

/* ---------- soundtrack mux (ffmpeg — no pure AAC encoder yet) -------------- */

/**
 * Replace video audio with the given track. loop=true loops audio to fill video length.
 * Browser re-records via MediaRecorder; headless uses ffmpeg. (Pure mp4 audio-track
 * replace is a future pure-path candidate once we can encode AAC without ffmpeg.)
 */
export async function muxSoundtrack(videoUrl, audioUrl, loop = false, { fetch: fetchFn, onProgress, signal } = {}) {
  return withTemp(async (dir) => {
    throwIfAborted(signal);
    if (onProgress) onProgress("adding soundtrack…");
    const vPath = await writeInput(dir, "v", videoUrl, fetchFn);
    const aPath = await writeInput(dir, "a", audioUrl, fetchFn);
    const outPath = join(dir, "out.mp4");

    let vdur = null;
    try {
      const pr = await runProc("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", vPath,
      ], { signal });
      vdur = parseFloat(String(pr.stdout).trim());
    } catch (e) {
      if (e instanceof NanoodleError && (e.code === "aborted" || e.code === "timeout" || /timed out|aborted/i.test(e.message || ""))) throw e;
      if (signal && signal.aborted) throw abortError(signal);
      /* optional */
    }

    const args = ["-y", "-i", vPath];
    if (loop) args.push("-stream_loop", "-1");
    args.push("-i", aPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k");
    if (loop && vdur != null && isFinite(vdur)) args.push("-t", String(vdur));
    else args.push("-shortest");
    args.push("-movflags", "+faststart", outPath);

    try {
      await runProc("ffmpeg", args, { signal });
    } catch (e) {
      if (isMissingFfmpeg(e)) throw e;
      if (e instanceof NanoodleError && (e.code === "aborted" || e.code === "timeout" || /aborted|timed out/i.test(e.message || ""))) throw e;
      const args2 = ["-y", "-i", vPath];
      if (loop) args2.push("-stream_loop", "-1");
      args2.push("-i", aPath, "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "128k");
      if (loop && vdur != null && isFinite(vdur)) args2.push("-t", String(vdur));
      else args2.push("-shortest");
      args2.push("-movflags", "+faststart", outPath);
      await runProc("ffmpeg", args2, { signal });
    }
    return dataUrlFromFile(outPath, "video/mp4");
  });
}

export { MAX_FRAMES, MAX_IMAGE_DIM, MP4CAT };
