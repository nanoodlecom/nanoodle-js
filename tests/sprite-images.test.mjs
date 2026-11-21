import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeSpriteBytes } from "../src/sprite-image.mjs";

const fixture = (name) => readFile(new URL("./fixtures/sprite-images/" + name, import.meta.url));
const paletteColor = (i) => [(19 + 79 * i) % 256, (144 + 10 * i) % 256, (204 - 46 * i) % 256];

test("indexed Adam7 PNG unfilters packed rows and preserves palette alpha", async () => {
  const { width, height, data } = await decodeSpriteBytes(await fixture("palette-adam7.png"));
  assert.deepEqual([width, height], [23, 17]);
  const alpha = [0, 80, 233, 255];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = (x + 2 * y) % 4,
        dst = 4 * (y * width + x);
      assert.deepEqual([...data.subarray(dst, dst + 4)], [...paletteColor(index), alpha[index]]);
    }
});

test("16-bit grayscale transparency compares the original sample", async () => {
  const { data } = await decodeSpriteBytes(await fixture("gray16.png"));
  assert.deepEqual([...data], [0, 0, 0, 255, 18, 18, 18, 0, 136, 136, 136, 255, 255, 255, 255, 255]);
});

test("progressive and sequential JPEG reconstruct identical chroma-subsampled pixels", async () => {
  const read = async (name) => decodeSpriteBytes(await fixture(name));
  const a = await read("baseline.jpg"),
    b = await read("progressive.jpg");
  assert.deepEqual(a, b);
  assert.deepEqual([a.width, a.height], [23, 17]);
  // RGB reference decoded by libjpeg-turbo. Different conforming IDCT
  // implementations can round channel values a few levels apart.
  const expected = await fixture("baseline.rgb");
  for (let pixel = 0; pixel < a.width * a.height; pixel++) {
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(expected[3 * pixel + c] - a.data[4 * pixel + c]) <= 4);
    }
    assert.equal(a.data[4 * pixel + 3], 255);
  }
});

test("interlaced and animated GIF use the first composited frame", async () => {
  for (const name of ["interlaced.gif", "animation.gif"]) {
    const { width, height, data } = await decodeSpriteBytes(await fixture(name));
    assert.deepEqual([width, height], [23, 17]);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (x + 2 * y) % 4,
          dst = 4 * (y * width + x);
        assert.deepEqual(
          [...data.subarray(dst, dst + 4)],
          i === 2 ? [0, 0, 0, 0] : [...paletteColor(i), 255],
        );
      }
  }
});

test("truncated JPEG, GIF, and PNG files fail during native decode", async () => {
  for (const name of ["baseline.jpg", "palette-adam7.png", "interlaced.gif"]) {
    const input = await fixture(name);
    await assert.rejects(
      decodeSpriteBytes(input.subarray(0, Math.floor(input.length / 2))),
      /Invalid (JPEG|GIF|PNG)/,
    );
  }
});

test("AVIF alpha and subsampled chroma match the reference through a transparency boundary", async () => {
  const image = await decodeSpriteBytes(await fixture("chroma-alpha.avif"));
  const reference = await decodeSpriteBytes(await fixture("chroma-alpha-reference.png"));
  assert.deepEqual([image.width, image.height], [35, 29]);
  assert.equal(image.data.length, reference.data.length);
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3];
    assert.equal(alpha, reference.data[i + 3]);
    for (let c = 0; c < 3; c++) {
      const visibleDelta = Math.abs(image.data[i + c] - reference.data[i + c]) * alpha / 255;
      assert.ok(visibleDelta <= 2, "visible color differs at byte " + (i + c));
    }
  }
});

test("AVIF handles opaque and translucent 4:4:4 and 4:2:0 images at odd dimensions", async () => {
  for (const [name, w, h, samples] of [
    ["alpha.avif", 16, 16, [[0, 0, [10, 181, 45, 255]], [15, 15, [0, 0, 0, 0]]]],
    ["odd-444.avif", 37, 41, [[0, 0, [249, 44, 56, 247]], [4, 5, [29, 139, 243, 47]], [36, 40, [70, 255, 222, 202]]]],
  ]) {
    const { width, height, data } = await decodeSpriteBytes(await fixture(name));
    assert.deepEqual([width, height], [w, h]);
    for (const [x, y, expected] of samples) {
      const pixel = data.subarray(4 * (width * y + x), 4 * (width * y + x + 1));
      assert.equal(pixel[3], expected[3]);
      if (pixel[3]) assert.ok(expected.slice(0, 3).every((v, i) => Math.abs(v - pixel[i]) <= 2));
    }
  }
});
