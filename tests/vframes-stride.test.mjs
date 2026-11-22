import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractVideoFrames, encodePngRgba, decodePng } from "../src/local-media.mjs";
import { MAX_FRAMES } from "../src/graph.mjs";

// vframes stride/range (Edge Styles S5) — the spec's recorded
// conformance case: a 24-frame 24 fps video whose frame k is a solid
// red of value k*10; extraction must return the exact source indices.

const run = promisify(execFile);

async function indexedVideo() {
  const dir = await mkdtemp(join(tmpdir(), "vf-"));
  for (let k = 0; k < 24; k++) {
    const rgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = k * 10; rgba[i + 3] = 255; }
    await writeFile(join(dir, "f" + String(k).padStart(2, "0") + ".png"), await encodePngRgba(16, 16, rgba));
  }
  const mp4 = join(dir, "v.mp4");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "24", "-i", join(dir, "f%02d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-qp", "0", mp4]);
  return "data:video/mp4;base64," + (await readFile(mp4)).toString("base64");
}

async function redOf(dataUrl) {
  const dir = await mkdtemp(join(tmpdir(), "vf1-"));
  const jpg = join(dir, "f.jpg");
  await writeFile(jpg, Buffer.from(dataUrl.split(",")[1], "base64"));
  const png = join(dir, "f.png");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", jpg, png]);
  const img = await decodePng(await readFile(png));
  return img.rgba[(8 * img.w + 8) * 4];
}
const nearIdx = (red) => Math.round(red / 10);

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
