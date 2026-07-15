/**
 * Local media nodes (resize / vframes / combine / soundtrack / trim / extractaudio).
 *
 * Pure-JS path (MP4CAT remux, PCM-WAV trim, PNG resize) runs without ffmpeg — same
 * algorithms as nanoodle/ play.html. ffmpeg is the heavy fallback for everything else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Workflow, mediaFromFile, MediaRef } from "../src/index.mjs";
import {
  resizePlan, encodeWavMono, concatVideos, resizeCropImage, trimAudioToWav, MP4CAT,
} from "../src/local-media.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => join(here, "fixtures", "media", name);
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function skipWithoutFfmpeg(t) {
  // Must return: t.skip() only marks the test; it does not abort the body
  // (Node 20/22 then report exit 1 with fail=0 if the body later throws).
  if (!hasFfmpeg) return t.skip("ffmpeg not on PATH");
  return false;
}

async function asDataUrl(path, mime) {
  const buf = await readFile(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/* ---------- resizePlan pure unit (no ffmpeg) ---------- */

test("resizePlan: fit never upscales and preserves aspect", () => {
  const p = resizePlan(200, 100, "fit", 100, 100);
  assert.equal(p.cw, 100);
  assert.equal(p.ch, 50);
  assert.equal(p.dw, 100);
  assert.equal(p.dh, 50);
});

test("resizePlan: exact stretches to box", () => {
  const p = resizePlan(200, 100, "exact", 50, 50);
  assert.equal(p.cw, 50);
  assert.equal(p.ch, 50);
  assert.equal(p.dw, 50);
  assert.equal(p.dh, 50);
});

test("resizePlan: fill covers and centers", () => {
  const p = resizePlan(200, 100, "fill", 50, 50);
  assert.equal(p.cw, 50);
  assert.equal(p.ch, 50);
  assert.ok(p.dw >= 50 && p.dh >= 50);
});

test("resizePlan: missing both dims → null", () => {
  assert.equal(resizePlan(10, 10, "fit", 0, 0), null);
});

/* ---------- pure helpers (no ffmpeg) ---------- */

test("encodeWavMono: writes a valid PCM16 mono WAV header", () => {
  const samples = new Float32Array(160); // 10 ms @ 16 kHz
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 10);
  const wav = encodeWavMono(samples, 16000);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  assert.equal(wav.length, 44 + samples.length * 2);
});

test("MP4CAT: matching fixtures remux without ffmpeg", async () => {
  const A = new Uint8Array(await readFile(media("clipA.mp4")));
  const B = new Uint8Array(await readFile(media("clipB.mp4")));
  assert.equal(MP4CAT.isMp4(A), true);
  assert.equal(MP4CAT.mp4ParamsMatch([A, B]), true);
  const out = MP4CAT.concatMp4([A, B], { dedup: false });
  assert.equal(MP4CAT.isMp4(out), true);
  assert.ok(out.length > A.length);
});

/* ---------- resize (pure PNG path — no ffmpeg) ---------- */

test("resize: fit shrinks a PNG and returns image MediaRef", async () => {
  const png = await asDataUrl(media("nn-red.png"), "image/png");
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: png } },
      { id: "n2", type: "resize", fields: { mode: "fit", width: "32", height: "32" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, { apiKey: null });
  const result = await wf.run({});
  const out = result.get("Resize / crop");
  assert.ok(out instanceof MediaRef);
  assert.match(out.url, /^data:image\/png/);
  const bytes = await out.bytes();
  assert.ok(bytes.length > 20);
  // pure path: 64×48 fit into 32×32 → 32×24
  assert.equal(bytes[0], 0x89);
});

test("resizeCropImage pure: fit never needs ffmpeg for PNG", async () => {
  const png = await asDataUrl(media("nn-red.png"), "image/png");
  const out = await resizeCropImage(png, "fit", 32, 32);
  assert.match(out, /^data:image\/png;base64,/);
});

test("resize: missing width+height errors clearly", async () => {
  const png = await asDataUrl(media("nn-red.png"), "image/png");
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: png } },
      { id: "n2", type: "resize", fields: { mode: "fit" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, { apiKey: null });
  await assert.rejects(wf.run({}), /width or height/i);
});

/* ---------- trim (pure PCM-WAV path — no ffmpeg) ---------- */

test("trim: slices wav to mono data:audio/wav", async () => {
  const wav = await mediaFromFile(media("nn-tone.wav"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: {} },
      { id: "n2", type: "trim", fields: { start: "0", length: "0.25" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, { apiKey: null });
  const result = await wf.run({ Audio: wav });
  const out = result.get("Trim audio");
  assert.ok(out instanceof MediaRef);
  assert.match(out.mime || out.url, /wav|audio/i);
  const bytes = await out.bytes();
  assert.ok(bytes.length < 32078); // shorter than full 1s fixture
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
});

test("trimAudioToWav pure: no ffmpeg for PCM WAV", async () => {
  const wav = await asDataUrl(media("nn-tone.wav"), "audio/wav");
  const out = await trimAudioToWav(wav, 0, 0.25, 16000);
  assert.match(out, /^data:audio\/wav/);
});

test("trim: start past end is a clear error", async () => {
  const wav = await mediaFromFile(media("nn-tone.wav"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: {} },
      { id: "n2", type: "trim", fields: { start: "99", length: "1" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, { apiKey: null });
  await assert.rejects(wf.run({ Audio: wav }), /past the end/i);
});

/* ---------- extractaudio ---------- */

test("extractaudio: pulls audio track from mp4 → wav", async (t) => {
  if (skipWithoutFfmpeg(t)) return;
  const vid = await mediaFromFile(media("clipA.mp4"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "vupload", fields: {} },
      { id: "n2", type: "extractaudio", fields: { start: "0" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "video" }, to: { node: "n2", port: "video" } }],
  }, { apiKey: null });
  const result = await wf.run({ Video: vid });
  const out = result.get("Extract audio");
  assert.ok(out instanceof MediaRef);
  const bytes = await out.bytes();
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
});

/* ---------- vframes ---------- */

test("vframes: extracts N jpeg frames from video", async (t) => {
  if (skipWithoutFfmpeg(t)) return;
  const vid = await mediaFromFile(media("clipA.mp4"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "vupload", fields: {} },
      { id: "n2", type: "vframes", name: "Frames", fields: { frames: "2", gap: "0.2", dir: "start" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "video" }, to: { node: "n2", port: "video" } }],
  }, { apiKey: null });
  const result = await wf.run({ Video: vid });
  // sink primary is frame1
  const f1 = result.get("Frames");
  assert.ok(f1 instanceof MediaRef);
  assert.match(f1.url, /^data:image\//);
  // full out map still has frame2
  assert.ok(result.nodes.n2.out.frame2);
  assert.match(result.nodes.n2.out.frame2, /^data:image\//);
});

/* ---------- combine (pure MP4CAT path — no ffmpeg for matching mp4s) ---------- */

test("combine: concatenates two clips into one video", async () => {
  const a = await mediaFromFile(media("clipA.mp4"));
  const b = await mediaFromFile(media("clipB.mp4"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "vupload", name: "A", fields: {} },
      { id: "n2", type: "vupload", name: "B", fields: {} },
      { id: "n3", type: "combine", fields: { dedup: "false" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "video" }, to: { node: "n3", port: "clip1" } },
      { id: "l2", from: { node: "n2", port: "video" }, to: { node: "n3", port: "clip2" } },
    ],
  }, { apiKey: null });
  const result = await wf.run({ A: a, B: b });
  const out = result.get("Combine videos");
  assert.ok(out instanceof MediaRef);
  const bytes = await out.bytes();
  assert.ok(bytes.length > 1000);
  assert.equal(MP4CAT.isMp4(bytes), true);
});

test("concatVideos pure: matching mp4s remux without ffmpeg", async () => {
  const a = await asDataUrl(media("clipA.mp4"), "video/mp4");
  const b = await asDataUrl(media("clipB.mp4"), "video/mp4");
  const out = await concatVideos([a, b], false);
  assert.match(out, /^data:video\/mp4/);
});

test("combine: fewer than two clips errors", async () => {
  const a = await mediaFromFile(media("clipA.mp4"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "vupload", fields: {} },
      { id: "n2", type: "combine", fields: {} },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "video" }, to: { node: "n2", port: "clip1" } },
    ],
  }, { apiKey: null });
  await assert.rejects(wf.run({ Video: a }), /at least two clips/i);
});

/* ---------- soundtrack ---------- */

test("soundtrack: muxes wav onto video", async (t) => {
  if (skipWithoutFfmpeg(t)) return;
  const vid = await mediaFromFile(media("clipA.mp4"));
  const wav = await mediaFromFile(media("nn-tone.wav"));
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "vupload", fields: {} },
      { id: "n2", type: "aupload", fields: {} },
      { id: "n3", type: "soundtrack", fields: { loop: "false" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "video" }, to: { node: "n3", port: "video" } },
      { id: "l2", from: { node: "n2", port: "audio" }, to: { node: "n3", port: "audio" } },
    ],
  }, { apiKey: null });
  const result = await wf.run({ Video: vid, Audio: wav });
  const out = result.get("Soundtrack");
  assert.ok(out instanceof MediaRef);
  const bytes = await out.bytes();
  assert.ok(bytes.length > 500);
});

/* ---------- no longer unsupported ---------- */

test("materialize no longer warns on resize/vframes/combine/…", async () => {
  const { materialize } = await import("../src/graph.mjs");
  const { warnings } = materialize({
    nodes: [
      { id: "n1", type: "resize", fields: {} },
      { id: "n2", type: "vframes", fields: {} },
      { id: "n3", type: "combine", fields: {} },
      { id: "n4", type: "soundtrack", fields: {} },
      { id: "n5", type: "trim", fields: {} },
      { id: "n6", type: "extractaudio", fields: {} },
    ],
    links: [],
  });
  assert.equal(warnings.length, 0);
});
