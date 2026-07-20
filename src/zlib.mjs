/**
 * Env-adaptive zlib: node:zlib in Node (dynamic import, cached), Compression/
 * DecompressionStream in the browser. Everything is async because browsers have
 * no synchronous form — callers (PNG codec, share links) are async paths anyway.
 */

let _zlib; // undefined = untried, null = unavailable (browser)
async function nodeZlib() {
  if (_zlib === undefined) {
    try { _zlib = await import("node:zlib"); } catch { _zlib = null; }
  }
  return _zlib;
}

async function pipeThrough(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function inflate(bytes) {
  const z = await nodeZlib();
  if (z) return new Uint8Array(z.inflateSync(bytes));
  return streamZlib.inflate(bytes);
}

export async function deflate(bytes, { level = 9 } = {}) {
  const z = await nodeZlib();
  if (z) return new Uint8Array(z.deflateSync(bytes, { level }));
  return streamZlib.deflate(bytes); // level is a Node-only hint
}

export async function gunzip(bytes) {
  const z = await nodeZlib();
  if (z) return new Uint8Array(z.gunzipSync(bytes));
  return streamZlib.gunzip(bytes);
}

/** Offset of the deflate body inside a gzip member, or -1 when the header is not gzip. */
function gzipBodyStart(b) {
  if (b.length < 11 || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) return -1;
  const flg = b[3];
  let i = 10;
  if (flg & 4) { if (i + 2 > b.length) return -1; i += 2 + (b[i] | (b[i + 1] << 8)); } // FEXTRA
  if (flg & 8) { while (i < b.length && b[i] !== 0) i++; i++; }                        // FNAME
  if (flg & 16) { while (i < b.length && b[i] !== 0) i++; i++; }                       // FCOMMENT
  if (flg & 2) i += 2;                                                                 // FHCRC
  return i < b.length ? i : -1;
}

async function streamInflateRawPartial(body) {
  const chunks = [];
  try {
    const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } catch { /* keep whatever decompressed before the stream errored */ }
  } catch { return null; }
  let len = 0;
  for (const c of chunks) len += c.length;
  if (!len) return null;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * Best-effort gunzip for damaged members: inflates the raw deflate body and
 * ignores the CRC32/ISIZE trailer entirely, returning partial output on
 * truncation. null when nothing decompressible remains.
 */
export async function gunzipLax(bytes) {
  const start = gzipBodyStart(bytes);
  if (start < 0) return null;
  // The 8-byte trailer is junk to a raw-deflate decoder; dropping it up front
  // keeps strict stream implementations from erroring on trailing garbage.
  // (When the payload is truncated mid-body this trims real data — the
  // partial-output paths below still salvage everything before the cut.)
  const body = bytes.subarray(start, Math.max(start + 1, bytes.length - 8));
  const z = await nodeZlib();
  if (z) {
    try { return new Uint8Array(z.inflateRawSync(body, { finishFlush: z.constants.Z_SYNC_FLUSH })); }
    catch { return null; }
  }
  return streamInflateRawPartial(body);
}

// The browser implementations, exported so tests can exercise them in Node
// (which also ships Compression/DecompressionStream) without hiding node:zlib.
export const streamZlib = {
  inflate: (b) => pipeThrough(b, new DecompressionStream("deflate")),
  deflate: (b) => pipeThrough(b, new CompressionStream("deflate")),
  gunzip: (b) => pipeThrough(b, new DecompressionStream("gzip")),
  gunzipLax: (b) => {
    const start = gzipBodyStart(b);
    return start < 0 ? Promise.resolve(null) : streamInflateRawPartial(b.subarray(start, Math.max(start + 1, b.length - 8)));
  },
};
