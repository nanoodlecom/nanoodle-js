import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { MP4CAT } from "../src/mp4cat.mjs";
import { encodeSpriteMp4 } from "../src/sprite-video.mjs";

function flatFrame(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
}

test("H.264 turntable skips stationary blocks and keeps exact fractional frame timing", async () => {
  const flat = flatFrame(66, 50, [200, 100, 30, 128]);
  const samples = Array(65).fill(flat);
  const mp4 = await encodeSpriteMp4(samples, 65 / 24);
  const [track] = MP4CAT.parseMp4(mp4).tracks;
  assert.deepEqual([track.width, track.height], [66, 50]);
  assert.deepEqual(track.samples.flatMap((s, i) => s.sync ? [i] : []), [0, 60]);
  assert.ok(track.samples[0].size < 650, "flat neighbours should use spatial prediction");
  assert.ok(track.samples[1].size < 16, "a stationary P picture should use a single skip run");
  assert.equal(track.samples.reduce((sum, s) => sum + s.dur, 0), Math.round(65 / 24 * track.timescale));
  await assert.rejects(encodeSpriteMp4([], 1), /at least one frame/);
  await assert.rejects(encodeSpriteMp4([flat, flatFrame(16, 16, [0, 0, 0, 0])], 1), /inconsistent/);
});

test("long pose delays fit the MP4 media duration", async () => {
  const frame = flatFrame(16, 16, [96, 32, 8, 255]);
  const duration = 2 * 65535;
  const mp4 = await encodeSpriteMp4([frame, frame], duration);
  const [track] = MP4CAT.parseMp4(mp4).tracks;
  const ticks = track.samples.reduce((sum, sample) => sum + sample.dur, 0);
  assert.ok(ticks <= 0xffffffff);
  assert.equal(ticks / track.timescale, duration);
});

test("independent AVC decoder reconstructs P_Skip, PCM, directional prediction and cropped edges", async (t) => {
  // FFmpeg is only the independent test oracle. Encoding always uses our own codec.
  if (process.permission && !process.permission.has("child")) return t.skip("external decoder disabled");
  if (spawnSync("ffmpeg", ["-version"]).error) return t.skip("no independent AVC decoder on PATH");
  const width = 38, height = 36, count = 65, frames = [], expected = [];
  for (let i = 0; i < count; i++) {
    const frame = flatFrame(width, height, [0, 0, 0, 0]);
    // Even 2x2 boundaries yield known limited-range BT.601 red or black.
    // Move horizontally and cover the cropped right/bottom outer macroblocks.
    const redStart = (i % 10) * 2;
    for (let y = 4; y < height; y++) for (let x = redStart; x < Math.min(width, redStart + 20); x++) {
      frame.data.set([255, 0, 0, 255], (y * width + x) * 4);
    }
    frames.push(frame);
    const plane = Buffer.alloc(width * height * 3 / 2);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const red = y >= 4 && x >= redStart && x < redStart + 20;
      plane[y * width + x] = red ? 82 : 16;
      if (x % 2 === 0 && y % 2 === 0) {
        const index = y / 2 * width / 2 + x / 2;
        plane[width * height + index] = red ? 90 : 128;
        plane[width * height * 5 / 4 + index] = red ? 240 : 128;
      }
    }
    expected.push(plane);
  }
  const mp4 = await encodeSpriteMp4(frames, count / 24);
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-threads", "1",
    "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"], { input: mp4, maxBuffer: 2 ** 20 });
  assert.equal(decoded.status, 0, decoded.stderr?.toString());
  assert.deepEqual(decoded.stdout, Buffer.concat(expected));
});
