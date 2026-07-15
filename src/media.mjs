import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { NanoodleError } from "./errors.mjs";

/** NanoGPT's edge rejects request bodies over ~4.5 MB; media rides inline as base64 (no upload endpoint). */
export const MEDIA_INLINE_MAX = 4.4 * 1024 * 1024;

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
  return "data:" + (mime || sniffMime(u8)) + ";base64," + Buffer.from(u8).toString("base64");
}

/** Decode a data: URL into { bytes, mime }. */
export function dataUrlBytes(url) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) throw new NanoodleError("not a data: URL");
  const head = url.slice(5, comma);
  const mime = (head.split(";")[0] || "application/octet-stream") || "application/octet-stream";
  const body = url.slice(comma + 1);
  const bytes = /;base64$/i.test(head) || /;base64;/i.test(head + ";")
    ? new Uint8Array(Buffer.from(body, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(body), "utf8"));
  return { bytes, mime };
}

/**
 * A media output value: a data: or https URL plus lazy byte access.
 * String-coerces to the URL so it drops into templates / JSON naturally.
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

  /** Write the media bytes to `path`; resolves to the path. */
  async save(path) {
    await writeFile(path, await this.bytes());
    return path;
  }
}

/**
 * Read a local file as a media input value: `{ data, mime }`.
 * MIME comes from the extension, else magic-byte sniffing.
 */
export async function mediaFromFile(path, mime) {
  const data = await readFile(path);
  return { data: new Uint8Array(data), mime: mime || EXT_MIME[extname(path).toLowerCase()] || sniffMime(data) };
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
  else if (value && typeof value === "object" && value.data != null) {
    const data = typeof value.data === "string" ? new Uint8Array(Buffer.from(value.data, "base64")) : new Uint8Array(value.data);
    url = bytesToDataUrl(data, value.mime);
  } else {
    throw new NanoodleError(what + ": unsupported media value (" + typeof value + ")");
  }
  if (enforceInlineMax) assertInlineMediaSize(url, what);
  return url;
}
