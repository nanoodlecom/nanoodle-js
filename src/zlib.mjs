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

// The browser implementations, exported so tests can exercise them in Node
// (which also ships Compression/DecompressionStream) without hiding node:zlib.
export const streamZlib = {
  inflate: (b) => pipeThrough(b, new DecompressionStream("deflate")),
  deflate: (b) => pipeThrough(b, new CompressionStream("deflate")),
  gunzip: (b) => pipeThrough(b, new DecompressionStream("gzip")),
};
