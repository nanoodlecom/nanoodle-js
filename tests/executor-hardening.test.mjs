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
import { trimAudioToWav } from "../src/local-media.mjs";
import { bytesToDataUrl } from "../src/media.mjs";

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
  // Image inputs are deferred to the consuming node (fitImage downscales them —
  // see inline-image-fit.test.mjs); audio/video can't be shrunk that way, so the
  // early load-time guard stays for them.
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
  }, { apiKey: "k" });
  await assert.rejects(() => wf.run({ Audio: bigUrl }), /too large to send inline/);
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
