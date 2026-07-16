import { NanoodleError } from "./errors.mjs";

/** NanoGPT's edge rejects request bodies over ~4.5 MB; media rides inline as base64 (no upload endpoint). */
export const MEDIA_INLINE_MAX = 4.4 * 1024 * 1024;

/* ---------- base64 (browser + Node; no hard Buffer dependency) ------------ */

/** @param {Uint8Array|ArrayBuffer|number[]} bytes */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
  // chunked to avoid call-stack / arg limits on large media
  const CH = 0x8000;
  let bin = "";
  for (let i = 0; i < u8.length; i += CH) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** @param {string} b64 @returns {Uint8Array} */
export function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sniff an image's format from its base64 magic bytes (mirrors the nanoodle app runtime). */
export function b64ImageMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("R0lG")) return "image/gif";
  if (b64.startsWith("UklG")) return "image/webp";
  return "image/png";
}

const EXT_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg",
  ".aac": "audio/aac", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".txt": "text/plain", ".json": "application/json",
};

const MIME_EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac",
  "audio/flac": "flac", "audio/mp4": "m4a",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "text/plain": "txt", "application/json": "json",
};

/** Best-effort file extension for a MIME type (used by the CLI --out saver). */
export function extForMime(mime) {
  return MIME_EXT[String(mime || "").split(";")[0].trim().toLowerCase()] || "bin";
}

/** Extension → MIME (for mediaFromFile and friends). */
export function mimeFromExt(ext) {
  return EXT_MIME[String(ext || "").toLowerCase()] || null;
}

/** Sniff a MIME type from magic bytes of common media containers. */
export function sniffMime(bytes) {
  const b = bytes;
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, "PNG")) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && b.length >= 12 && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && b.length >= 12 && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "fLaC")) return "audio/flac";
  if (b.length >= 12 && ascii(4, "ftyp")) return "video/mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return "application/octet-stream";
}

/** Encode bytes as a data: URL, sniffing the MIME when not given. */
export function bytesToDataUrl(bytes, mime) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return "data:" + (mime || sniffMime(u8)) + ";base64," + bytesToBase64(u8);
}

/** Decode a data: URL into { bytes, mime }. */
export function dataUrlBytes(url) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) throw new NanoodleError("not a data: URL");
  const head = url.slice(5, comma);
  const mime = (head.split(";")[0] || "application/octet-stream") || "application/octet-stream";
  const body = url.slice(comma + 1);
  const bytes = /;base64$/i.test(head) || /;base64;/i.test(head + ";")
    ? base64ToBytes(body)
    : new TextEncoder().encode(decodeURIComponent(body));
  return { bytes, mime };
}

/**
 * A media output value: a data: or https URL plus lazy byte access.
 * String-coerces to the URL so it drops into templates / JSON naturally.
 *
 * `.save(path)` is Node-only (dynamic `node:fs`); browsers should use `.bytes()` + download.
 */
export class MediaRef {
  /**
   * @param {string} url data: or http(s) URL
   * @param {{ mime?: string, fetch?: typeof fetch }} [opts]
   */
  constructor(url, opts = {}) {
    this.url = url;
    this._mime = opts.mime || null;
    this._fetch = opts.fetch || globalThis.fetch;
    if (!this._mime && url.startsWith("data:")) {
      const head = url.slice(5, url.indexOf(","));
      this._mime = head.split(";")[0] || null;
    }
  }

  get mime() { return this._mime; }

  toString() { return this.url; }
  toJSON() { return this.url; }

  /** @returns {Promise<Uint8Array>} the raw media bytes (decodes data:, fetches http(s)). */
  async bytes() {
    if (this.url.startsWith("data:")) return dataUrlBytes(this.url).bytes;
    const r = await this._fetch(this.url);
    if (!r.ok) throw new NanoodleError("couldn't download media (" + r.status + "): " + this.url);
    if (!this._mime) {
      const ct = r.headers && r.headers.get && r.headers.get("content-type");
      if (ct) this._mime = ct.split(";")[0].trim();
    }
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Write the media bytes to `path` (Node only); resolves to the path. */
  async save(path) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, await this.bytes());
    return path;
  }
}

/**
 * Read a local file as a media input value: `{ data, mime }` (Node only).
 * MIME comes from the extension, else magic-byte sniffing.
 */
export async function mediaFromFile(path, mime) {
  const { readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  const data = await readFile(path);
  const u8 = new Uint8Array(data);
  return { data: u8, mime: mime || mimeFromExt(extname(path)) || sniffMime(u8) };
}

/**
 * Refuse a data: URL that exceeds NanoGPT's inline body cap.
 * Used at network send sites and when coercing inputs for graphs that call NanoGPT.
 * Local-only graphs (resize/combine/vframes/…) skip this — they never POST media.
 */
export function assertInlineMediaSize(url, what = "media") {
  if (typeof url === "string" && url.startsWith("data:") && url.length > MEDIA_INLINE_MAX) {
    throw new NanoodleError(
      what + ": media is too large to send inline (~4 MB max). nanoodle sends media as base64 in the request body " +
      "(NanoGPT has no upload endpoint) — use a smaller file.");
  }
}

/**
 * Coerce a user-supplied media input into a URL string (data: or http(s)).
 * Accepts: data:/https URL strings, MediaRef, Uint8Array/Buffer, { data, mime }.
 *
 * @param {*} value
 * @param {string} what label for errors
 * @param {{ enforceInlineMax?: boolean }} [opts] when true (default), refuse data: URLs
 *   over MEDIA_INLINE_MAX. Pass false for local-only workflows that never hit NanoGPT.
 */
export function coerceMediaInput(value, what, opts = {}) {
  const enforceInlineMax = opts.enforceInlineMax !== false;
  let url;
  if (value instanceof MediaRef) url = value.url;
  else if (typeof value === "string") {
    if (/^data:/i.test(value) || /^https?:/i.test(value)) url = value;
    else {
      throw new NanoodleError(
        what + ": expected a data: URL, an http(s) URL, bytes, or mediaFromFile(path) — got a plain string. " +
        "For a local file use mediaFromFile(\"" + value.slice(0, 60) + "\").");
    }
  } else if (value instanceof Uint8Array) url = bytesToDataUrl(value);
  else if (typeof Buffer !== "undefined" && Buffer.isBuffer && Buffer.isBuffer(value)) {
    url = bytesToDataUrl(new Uint8Array(value));
  } else if (value && typeof value === "object" && value.data != null) {
    const data = typeof value.data === "string"
      ? base64ToBytes(value.data)
      : new Uint8Array(value.data);
    url = bytesToDataUrl(data, value.mime);
  } else {
    throw new NanoodleError(what + ": unsupported media value (" + typeof value + ")");
  }
  if (enforceInlineMax) assertInlineMediaSize(url, what);
  return url;
}
