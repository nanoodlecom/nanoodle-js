import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depthShiftFrame, depthShiftVideo, encodePngRgba, decodePng } from "../src/local-media.mjs";

// depthshift (Edge Styles S6): Depth-Slice Parallax. The pure frame
// function is the spec — bright (near) content travels the full shift,
// dark (far) counter-travels, mid-gray stays. Exact pixel assertions.

const run = promisify(execFile);
const img = (w, h, fn) => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y), o = (y * w + x) * 4;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
  }
  return { w, h, rgba };
};
const dotAt = (rgba, w, h) => {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (rgba[o] > 200 && rgba[o + 1] > 200 && rgba[o + 2] > 200) return { x, y };
  }
  return null;
};
const dot = img(16, 16, (x, y) => (x === 8 && y === 8 ? [255, 255, 255] : [0, 0, 0]));
const flat = (v) => img(16, 16, () => [v, v, v]);

test("near depth (white) moves content by exactly +shiftX", () => {
  const out = depthShiftFrame(dot, flat(255), 4, 0);
  assert.deepEqual(dotAt(out.rgba, 16, 16), { x: 12, y: 8 });
});

test("far depth (black) counter-moves by exactly -shiftX", () => {
  const out = depthShiftFrame(dot, flat(0), 4, 0);
  assert.deepEqual(dotAt(out.rgba, 16, 16), { x: 4, y: 8 });
});

test("mid-gray depth stays put; shiftY works the same way", () => {
  assert.deepEqual(dotAt(depthShiftFrame(dot, flat(128), 4, 0).rgba, 16, 16), { x: 8, y: 8 });
  assert.deepEqual(dotAt(depthShiftFrame(dot, flat(255), 0, 3).rgba, 16, 16), { x: 8, y: 11 });
});

test("depthShiftVideo muxes a looping mp4 with the requested frame count", async (t) => {
  const src = img(32, 32, (x) => (x < 16 ? [200, 40, 40] : [40, 40, 200]));
  const dep = img(32, 32, (x) => (x < 16 ? [0, 0, 0] : [255, 255, 255]));
  const url = async (im) => "data:image/png;base64," + Buffer.from(await encodePngRgba(im.w, im.h, im.rgba)).toString("base64");
  const video = await depthShiftVideo(await url(src), await url(dep), { frames: 8, shiftX: 6, fps: 8 });
  assert.match(video, /^data:video\/mp4;base64,/);
  const dir = await mkdtemp(join(tmpdir(), "ds-"));
  const p = join(dir, "o.mp4");
  await writeFile(p, Buffer.from(video.split(",")[1], "base64"));
  const { stdout } = await run("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", p]);
  assert.equal(+stdout.trim(), 8);
});

test("zero shift is an error, not a silent still video", async () => {
  const u = "data:image/png;base64," + Buffer.from(await encodePngRgba(4, 4, new Uint8ClampedArray(64).fill(255))).toString("base64");
  await assert.rejects(() => depthShiftVideo(u, u, { shiftX: 0, shiftY: 0 }), /non-zero shift/);
});
