import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVideoFrames, encodePngRgba, decodePng } from "../src/local-media.mjs";
import { MAX_FRAMES } from "../src/graph.mjs";

// vframes stride/range (Edge Styles S5) — the spec's recorded
// conformance case: a 24-frame 24 fps video whose frame k is a solid
// red of value k*10; extraction must return the exact source indices.

const run = promisify(execFile);

async function indexedVideo({ variable = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vf-"));
  try {
    for (let k = 0; k < 24; k++) {
      const rgba = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < rgba.length; i += 4) { rgba[i] = k * 10; rgba[i + 3] = 255; }
      await writeFile(join(dir, "f" + String(k).padStart(2, "0") + ".png"), await encodePngRgba(16, 16, rgba));
    }
    const mp4 = join(dir, "v.mp4");
    const timestamps = variable ? ["-vf", "setpts='if(lt(N,4),N*4,16+(N-4)*13)'", "-fps_mode", "vfr"] : [];
    await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", variable ? "100" : "24", "-i", join(dir, "f%02d.png"),
      ...timestamps, "-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-q:v", "1", mp4]);
    return "data:video/mp4;base64," + (await readFile(mp4)).toString("base64");
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function redOf(dataUrl) {
  const dir = await mkdtemp(join(tmpdir(), "vf1-"));
  try {
    const jpg = join(dir, "f.jpg");
    await writeFile(jpg, Buffer.from(dataUrl.split(",")[1], "base64"));
    const png = join(dir, "f.png");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", jpg, png]);
    const img = await decodePng(await readFile(png));
    return img.rgba[(8 * img.w + 8) * 4];
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const nearIdx = (red) => Math.round(red / 10);
const indices = async (output) => {
  const result = [];
  for (const frame of Object.values(output)) result.push(nearIdx(await redOf(frame)));
  return result;
};

test("the frame cap is 48 now", () => {
  assert.equal(MAX_FRAMES, 48);
});

test("stride 3 from start returns source frames 0, 3, 6, 9", async () => {
  const v = await indexedVideo();
  const out = await extractVideoFrames(v, { count: 4, stride: 3, dir: "start" });
  const idx = [];
  for (let i = 1; i <= 4; i++) idx.push(nearIdx(await redOf(out["frame" + i])));
  assert.deepEqual(idx, [0, 3, 6, 9]);
});

test("stride 2 with a range start at 0.5s returns frames 12, 14, 16", async () => {
  const v = await indexedVideo();
  const out = await extractVideoFrames(v, { count: 3, stride: 2, dir: "start", startSec: 0.5 });
  const idx = [];
  for (let i = 1; i <= 3; i++) idx.push(nearIdx(await redOf(out["frame" + i])));
  assert.deepEqual(idx, [12, 14, 16]);
});

test("counts above the old cap of 12 extract in full", async () => {
  const v = await indexedVideo();
  const out = await extractVideoFrames(v, { count: 20, gap: 0.04, dir: "start" });
  assert.equal(Object.keys(out).length, 20);
});

test("off-grid bounds stop in-range in either direction without padding", async () => {
  const v = await indexedVideo();
  const options = { count: 8, stride: 2, startSec: 0.071, endSec: 0.21 };
  assert.deepEqual(await indices(await extractVideoFrames(v, { ...options, dir: "start" })), [2, 4]);
  assert.deepEqual(await indices(await extractVideoFrames(v, { ...options, dir: "end" })), [5, 3]);
  assert.deepEqual(await indices(await extractVideoFrames(v, { count: 3, stride: 1, dir: "end" })), [23, 22, 21]);
  await assert.rejects(extractVideoFrames(v, { startSec: 0.02, endSec: 0.03 }), /no video frames/);
  await assert.rejects(extractVideoFrames(v, { startSec: 0.8, endSec: 0.2 }), /endSec/);
});

test("VFR stride and gap use the presentation timestamps in both directions", async () => {
  const v = await indexedVideo({ variable: true });
  // Actual PTS are 0, .04, .08, .12, .16, .29, .42, .55, ...
  const range = { count: 8, startSec: 0.071, endSec: 0.43 };
  assert.deepEqual(await indices(await extractVideoFrames(v, { ...range, stride: 2, dir: "start" })), [2, 4, 6]);
  assert.deepEqual(await indices(await extractVideoFrames(v, { ...range, stride: 2, dir: "end" })), [6, 4, 2]);
  assert.deepEqual(await indices(await extractVideoFrames(v, { ...range, gap: 0.1, dir: "start" })), [2, 5, 6]);
  assert.deepEqual(await indices(await extractVideoFrames(v, { ...range, gap: 0.1, dir: "end" })), [6, 5, 4]);
});
