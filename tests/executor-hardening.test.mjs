/**
 * Executor hardening for local media (PR follow-up):
 * wiredFramesFloor, timeout/abort, local-only size, custom fetch, pure WAV clamp.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  Workflow, mediaFromFile, MEDIA_INLINE_MAX, coerceMediaInput,
  wiredFramesFloor, deriveSettings,
} from "../src/index.mjs";
import { encodeWavMono, trimAudioToWav } from "../src/local-media.mjs";
import { bytesToDataUrl } from "../src/media.mjs";
import { startMockServer } from "./harness/mock-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => join(here, "fixtures", "media", name);
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

/* ---------- wiredFramesFloor ---------- */

test("wiredFramesFloor: highest outbound frameK", () => {
  const graph = {
    links: [
      { from: { node: "f", port: "frame1" }, to: { node: "a", port: "image" } },
      { from: { node: "f", port: "frame3" }, to: { node: "b", port: "image" } },
      { from: { node: "x", port: "frame9" }, to: { node: "c", port: "image" } },
    ],
  };
  assert.equal(wiredFramesFloor(graph, "f"), 3);
  assert.equal(wiredFramesFloor(graph, "x"), 9);
  assert.equal(wiredFramesFloor(graph, "none"), 1);
});

test("vframes: frames=1 with frame3 wired still emits frame3 (no starve)", async (t) => {
  // Must return: t.skip() only marks the test; it does not abort the body.
  if (!hasFfmpeg) return t.skip("ffmpeg not on PATH");
  const vid = await mediaFromFile(media("clipA.mp4"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "v", type: "vupload", fields: {} },
      { id: "f", type: "vframes", fields: { frames: "1", dir: "start", gap: "0.1" } },
      { id: "r", type: "resize", name: "Out", fields: { mode: "fit", width: "32", height: "32" } },
    ],
    links: [
      { from: { node: "v", port: "video" }, to: { node: "f", port: "video" } },
      { from: { node: "f", port: "frame3" }, to: { node: "r", port: "image" } },
    ],
  }, { apiKey: null });
  const result = await wf.run({ Video: vid });
  assert.ok(result.nodes.f.out.frame1);
  assert.ok(result.nodes.f.out.frame2);
  assert.ok(result.nodes.f.out.frame3);
  assert.equal(result.nodes.r.status, "done");
  assert.match(result.get("Out").url, /^data:image\//);
});

test("vframes counts supplied by wires honor outbound frames and the extraction interval", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg not on PATH");
  const vid = await mediaFromFile(media("clipA.mp4"));
  for (const [mode, selection] of [
    ["legacy gap", { gap: "0.04" }],
    ["stride and range", { stride: "2", startSec: "0.04", endSec: "0.64" }],
  ]) {
    await t.test(mode, async () => {
      const wf = Workflow.fromJSON({
        nodes: [
          { id: "v", type: "vupload", fields: {} },
          { id: "count", type: "text", fields: { text: "1" } },
          { id: "f", type: "vframes", fields: { frames: "1", dir: "start", ...selection } },
          { id: "r", type: "resize", name: "Out", fields: { mode: "fit", width: "32", height: "32" } },
        ],
        links: [
          { from: { node: "v", port: "video" }, to: { node: "f", port: "video" } },
          { from: { node: "count", port: "text" }, to: { node: "f", port: "frames" } },
          { from: { node: "f", port: "frame3" }, to: { node: "r", port: "image" } },
        ],
      }, { apiKey: null, fetch: () => assert.fail("unexpected network request") });
      for (const [requested, emitted] of [["1", 3], ["5", 5]]) {
        const result = await wf.run({ Video: vid, "count.text": requested });
        assert.equal(Object.keys(result.nodes.f.out).length, emitted);
        assert.equal(result.nodes.r.status, "done");
        assert.match(result.get("Out").url, /^data:image\//);
      }
      if (selection.stride) {
        await assert.rejects(wf.run({ Video: vid }, { settings: { "f.endSec": 0.13 } }), error => {
          // Two samples fit from 0.04 to 0.13 at stride 2. The floor cannot expand that interval.
          assert.deepEqual(Object.keys(error.result.nodes.f.out), ["frame1", "frame2"]);
          assert.equal(error.result.nodes.r.error, "no image input");
          return true;
        });
      }
      assert.equal(wf.graph.nodes.find(node => node.id === "f").fields.frames, "1");
    });
  }
});

test("deriveSettings: vframes frames min rises to wired floor", () => {
  const graph = {
    nodes: [{ id: "f", type: "vframes", fields: { frames: "1" } }],
    links: [
      { from: { node: "f", port: "frame3" }, to: { node: "r", port: "image" } },
    ],
  };
  const settings = deriveSettings(graph);
  const frames = settings.find((s) => s.field === "frames");
  assert.ok(frames);
  assert.equal(frames.min, 3);
});

test("vframes source wires use canonical frame numbers within the extraction limit", async () => {
  const graph = (port) => ({
    nodes: [
      { id: "f", type: "vframes", fields: { frames: "1" } },
      { id: "r", type: "resize", fields: {} },
    ],
    links: [{ from: { node: "f", port }, to: { node: "r", port: "image" } }],
  });
  const options = { apiKey: null, quiet: true };
  const valid = Workflow.fromJSON(graph("frame48"), options);
  assert.deepEqual(valid.warnings, []);
  assert.equal(valid.settings.find(s => s.key === "f.frames").min, 48);
  for (const port of ["frame0", "frame01", "frame49"]) {
    const invalid = Workflow.fromJSON(graph(port), options);
    assert.equal(invalid.warnings.length, 1);
    await assert.rejects(invalid.run(), { code: "invalid-source-port" });
  }
});

/* ---------- timeout / abort ---------- */

test("timeoutMs aborts a pending local-media download", { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const url = "https://example.test/video.mp4";
  const started = Promise.withResolvers();
  const fetch = (requested, { signal }) => {
    assert.equal(requested, url);
    started.resolve();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "v", type: "vupload", fields: { video: url } },
      { id: "f", type: "vframes", name: "F", fields: { frames: "6", gap: "0.3", dir: "start" } },
    ],
    links: [{ from: { node: "v", port: "video" }, to: { node: "f", port: "video" } }],
  }, { apiKey: null, fetch });
  const rejection = assert.rejects(wf.run({}, { timeoutMs: 80 }), /run timed out after 80ms/);
  await Promise.race([started.promise, rejection.then(() => assert.fail("Media download never started"))]);
  t.mock.timers.tick(80);
  await rejection;
});

test("AbortSignal cancels local-media run", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg not on PATH");
  const dir = await mkdtemp(join(tmpdir(), "nn-hard2-"));
  const long = join(dir, "long.mp4");
  const gen = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "4", long,
  ], { stdio: "ignore" });
  if (gen.status !== 0) return t.skip("could not generate test video");
  const vid = await mediaFromFile(long);
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "v", type: "vupload", fields: {} },
      { id: "f", type: "vframes", name: "F", fields: { frames: "6", gap: "0.3", dir: "start" } },
    ],
    links: [{ from: { node: "v", port: "video" }, to: { node: "f", port: "video" } }],
  }, { apiKey: null });
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("user cancel")), 40);
  await assert.rejects(
    () => wf.run({ Video: vid }, { signal: ac.signal }),
    /cancel|aborted|timed out/i);
});

/* ---------- MEDIA_INLINE_MAX: local-only vs network ---------- */

test("local-only graph accepts oversized data: media input", async () => {
  // synthetic ~5 MB data URL (over MEDIA_INLINE_MAX string length)
  const raw = new Uint8Array(Math.floor(MEDIA_INLINE_MAX * 0.8));
  raw[0] = 0x89; raw[1] = 0x50; raw[2] = 0x4e; raw[3] = 0x47; // not a real PNG; upload only stores URL
  // actually upload needs valid image for resize — use big opaque payload as video upload fields only
  const bigUrl = "data:video/mp4;base64," + Buffer.alloc(Math.floor(MEDIA_INLINE_MAX * 0.8), 1).toString("base64");
  assert.ok(bigUrl.length > MEDIA_INLINE_MAX);

  // coerce alone with enforceInlineMax true still refuses
  assert.throws(() => coerceMediaInput(bigUrl, "x"), /too large to send inline/);
  // local-only: coerce with enforce false
  assert.equal(coerceMediaInput(bigUrl, "x", { enforceInlineMax: false }), bigUrl);

  // Workflow local-only: vupload + no network — should accept at coerce time
  // (run will fail later on invalid media in ffmpeg — we only care coerce doesn't throw)
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "v", type: "vupload", fields: {} },
      { id: "t", type: "text", name: "Note", fields: { text: "ok" } },
    ],
    links: [],
  }, { apiKey: null });
  // two sinks; supply Video even if unused by text — only vupload is input
  // text has no required input. Video is required for vupload if it's an input node with empty field.
  // vupload with empty image/video surfaces as required input.
  await assert.doesNotReject(() => wf.run({ Video: bigUrl }));
});

test("network graph still refuses oversized audio inputs before any spend", async () => {
  // Keep the preflight guard on a raw audio input that goes directly to a provider.
  const bigUrl = "data:audio/wav;base64," + "A".repeat(Math.floor(MEDIA_INLINE_MAX));
  assert.ok(bigUrl.length > MEDIA_INLINE_MAX);
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "u", type: "aupload", fields: {} },
      { id: "s", type: "transcribe", fields: { model: "m" } },
    ],
    links: [
      { from: { node: "u", port: "audio" }, to: { node: "s", port: "audio" } },
    ],
  }, { apiKey: "k", baseUrl: "http://127.0.0.1:1", fetch: () => assert.fail("unexpected provider request") });
  await assert.rejects(() => wf.run({ Audio: bigUrl }), /too large to send inline/);
});

test("oversized audio is accepted when all uses go through local Trim first", async () => {
  const sampleRate = 48000;
  const wav = encodeWavMono(new Float32Array(40 * sampleRate), sampleRate);
  const audio = bytesToDataUrl(wav, "audio/wav");
  assert.ok(audio.length > MEDIA_INLINE_MAX);
  const wire = (from, to) => ({ from: { node: from, port: "audio" }, to: { node: to, port: "audio" } });
  const graph = {
    nodes: [
      { id: "source", type: "aupload" },
      { id: "clip", type: "trim", fields: { start: "0", length: "1" } },
      { id: "asr", type: "transcribe", fields: { model: "fixture-asr" } },
    ],
    links: [wire("source", "clip"), wire("clip", "asr")],
  };
  const uploads = [];
  const options = {
    apiKey: "offline",
    baseUrl: "http://127.0.0.1:1",
    async fetch(url, { body }) {
      assert.equal(url, "http://127.0.0.1:1/api/v1/audio/transcriptions");
      uploads.push(body.get("file").size);
      return Response.json({ text: "short audio", cost: 0 });
    },
  };
  const result = await Workflow.fromJSON(graph, options).run({ Audio: audio });
  assert.equal(result.get("asr"), "short audio");
  assert.deepEqual(uploads, [32044]);

  graph.nodes.push({ id: "direct", type: "transcribe", fields: { model: "fixture-asr" } });
  graph.links.push(wire("source", "direct"));
  await assert.rejects(Workflow.fromJSON(graph, options).run({ Audio: audio }), /too large to send inline/);
  assert.deepEqual(uploads, [32044]);
});

/* ---------- pure WAV truncated header clamp ---------- */

test("trim pure: truncated WAV data chunk does not throw RangeError", async () => {
  const sr = 16000, actual = 80;
  const dataLen = actual * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + dataLen, true); ws(8, "WAVE");
  ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, 999999 * 2, true); // lie about size
  for (let i = 0; i < actual; i++) dv.setInt16(44 + i * 2, 1000, true);
  const url = bytesToDataUrl(new Uint8Array(ab), "audio/wav");
  const out = await trimAudioToWav(url, 0, 0.005, 16000);
  assert.match(out, /^data:audio\/wav/);
});

test("Trim reads a hosted AAC once when falling back to FFmpeg", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg not on PATH");
  const aac = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "0.3", "-c:a", "aac", "-f", "adts", "pipe:1",
  ]);
  assert.equal(aac.status, 0, aac.stderr?.toString());
  const server = await startMockServer();
  t.after(() => server.close());
  const url = server.url + "/once.aac";
  server.script("GET /once.aac", [
    { headers: { "content-type": "audio/aac" }, body: aac.stdout },
    { status: 410, body: "URL already used" },
  ]);

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "source", type: "aupload", fields: { audio: url } },
      { id: "trim", type: "trim", fields: { start: "0.05", length: "0.15" } },
    ],
    links: [{ from: { node: "source", port: "audio" }, to: { node: "trim", port: "audio" } }],
  }, {
    apiKey: null, baseUrl: server.url,
    fetch(target, options) {
      assert.equal(String(target), url);
      return globalThis.fetch(target, options);
    },
  });
  const result = await wf.run();
  assert.match(result.get("trim").url, /^data:audio\/wav;base64,/);
  assert.deepEqual(server.requests.map(request => request.method + " " + request.path), ["GET /once.aac"]);
});

/* ---------- custom fetch reaches local media ---------- */

test("custom fetch is used for https media in local resize", async () => {
  const png = await readFile(media("nn-red.png"));
  let hits = 0;
  const fetchFn = async (url) => {
    hits++;
    assert.match(url, /^https:\/\/example\.test\//);
    return {
      ok: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  };
  const { resizeCropImage } = await import("../src/local-media.mjs");
  const out = await resizeCropImage("https://example.test/red.png", "fit", 16, 16, { fetch: fetchFn });
  assert.match(out, /^data:image\/png/);
  assert.ok(hits >= 1);
});

test("Workflow opts.fetch is passed into local media runners", async () => {
  const png = await readFile(media("nn-red.png"));
  let hits = 0;
  const fetchFn = async (url) => {
    hits++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      text: async () => "",
      json: async () => ({}),
    };
  };
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "u", type: "upload", fields: { image: "https://example.test/a.png" } },
      { id: "r", type: "resize", name: "Out", fields: { mode: "fit", width: "16", height: "16" } },
    ],
    links: [
      { from: { node: "u", port: "image" }, to: { node: "r", port: "image" } },
    ],
  }, { apiKey: null, fetch: fetchFn });
  const result = await wf.run({});
  assert.match(result.get("Out").url, /^data:image\/png/);
  assert.ok(hits >= 1, "custom fetch should be used for https image");
});
