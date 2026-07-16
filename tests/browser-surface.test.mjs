/**
 * Phase A replace-prep: media/workflow core must not top-level-import Node
 * builtins, and the browser entry must re-export the public surface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (name) => readFileSync(join(ROOT, "src", name), "utf8");

function topLevelNodeImports(code) {
  // Match static import … from "node:…" only (not dynamic import() or strings in comments after //)
  const hits = [];
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (/^import\s/.test(t) && /from\s+["']node:/.test(t)) hits.push(t);
  }
  return hits;
}

test("media.mjs has no top-level node: imports (browser-safe core)", () => {
  assert.deepEqual(topLevelNodeImports(src("media.mjs")), []);
});

test("workflow.mjs has no top-level node: imports", () => {
  assert.deepEqual(topLevelNodeImports(src("workflow.mjs")), []);
});

test("errors/graph/io/client/x402 have no top-level node: imports", () => {
  for (const f of ["errors.mjs", "graph.mjs", "io.mjs", "client.mjs", "x402.mjs", "mp4cat.mjs", "qr.mjs"]) {
    assert.deepEqual(topLevelNodeImports(src(f)), [], f);
  }
});

test("local-media/share/zlib/nodes have no top-level node: imports (Phase D: local graphs run in-browser)", () => {
  for (const f of ["local-media.mjs", "share.mjs", "zlib.mjs", "nodes.mjs"]) {
    assert.deepEqual(topLevelNodeImports(src(f)), [], f);
  }
});

test("browser zlib path (Compression/DecompressionStream) interoperates with node:zlib", async () => {
  const { streamZlib } = await import("../src/zlib.mjs");
  const { deflateSync, gzipSync } = await import("node:zlib");
  const raw = new Uint8Array(2048).map((_, i) => (i * 7) & 255);

  // browser-deflate → browser-inflate round trip
  assert.deepEqual([...await streamZlib.inflate(await streamZlib.deflate(raw))], [...raw]);
  // node-deflate → browser-inflate (what a browser sees decoding an editor-minted PNG/link)
  assert.deepEqual([...await streamZlib.inflate(new Uint8Array(deflateSync(raw)))], [...raw]);
  // node-gzip → browser-gunzip (share links are gzip)
  assert.deepEqual([...await streamZlib.gunzip(new Uint8Array(gzipSync(raw)))], [...raw]);
});

test("pure PNG codec round-trips without Buffer (browser pixels contract)", async () => {
  const { decodePng, encodePngRgba } = await import("../src/local-media.mjs");
  const w = 3, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = i * 40; rgba[i * 4 + 1] = 7; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255; }
  const png = await encodePngRgba(w, h, rgba);
  assert.ok(png instanceof Uint8Array);
  const back = await decodePng(png);
  assert.equal(back.w, w);
  assert.equal(back.h, h);
  assert.deepEqual([...back.rgba], [...rgba]);
});

test("nanoodle/browser entry imports and re-exports Workflow + pure helpers", async () => {
  const browser = await import("../src/browser.mjs");
  assert.equal(typeof browser.Workflow, "function");
  assert.equal(typeof browser.Workflow.fromJSON, "function");
  assert.equal(typeof browser.NanoClient, "function");
  assert.equal(typeof browser.materialize, "function");
  assert.equal(typeof browser.deriveInputs, "function");
  assert.equal(typeof browser.bytesToBase64, "function");
  assert.equal(typeof browser.base64ToBytes, "function");
  assert.equal(typeof browser.MediaRef, "function");
  // Node-only helpers intentionally omitted from the browser surface
  assert.equal(browser.mediaFromFile, undefined);
});

test("bytesToBase64 / base64ToBytes round-trip without relying on Buffer API shape", async () => {
  const { bytesToBase64, base64ToBytes, bytesToDataUrl, dataUrlBytes } = await import("../src/media.mjs");
  const raw = new Uint8Array([0, 1, 2, 255, 128, 64]);
  const b64 = bytesToBase64(raw);
  assert.equal(typeof b64, "string");
  assert.deepEqual([...base64ToBytes(b64)], [...raw]);

  const url = bytesToDataUrl(raw, "application/octet-stream");
  assert.match(url, /^data:application\/octet-stream;base64,/);
  assert.deepEqual([...dataUrlBytes(url).bytes], [...raw]);
});

test("Workflow.fromJSON works with explicit apiKey and no process.env dependency", async () => {
  const { Workflow } = await import("../src/browser.mjs");
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: "ok" } }], cost: 0 }),
      text: async () => "",
    };
  };
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "t1", type: "text", fields: { text: "hi" } },
      { id: "m1", type: "llm", fields: { model: "x" } },
    ],
    links: [{ id: "l1", from: { node: "t1", port: "text" }, to: { node: "m1", port: "prompt" } }],
  }, { apiKey: "test-key", fetch: fetchFn, quiet: true });

  const result = await wf.run({});
  assert.equal(result.get("LLM") || result.get("m1") || Object.values(result.outputs)[0], "ok");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chat\/completions/);
});
