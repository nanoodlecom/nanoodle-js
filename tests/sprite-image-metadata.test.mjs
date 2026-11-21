import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { decodeSpriteBytes } from "../src/sprite-image.mjs";

const fixture = (name) => readFile(new URL("./fixtures/sprite-images/" + name, import.meta.url));

test("animated PNG uses its first animation frame on a transparent canvas", async () => {
  for (const [name, color] of [
    ["poster.apng", [0, 128, 0, 255]],
    ["first.apng", [255, 0, 0, 255]],
  ]) {
    const { width, height, data } = await decodeSpriteBytes(await fixture(name));
    assert.deepEqual([width, height], [16, 16]);
    assert.deepEqual([...data.slice(0, 4)], color);
  }
  for (const mode of [0, 1]) {
    const { width, height, data } = await decodeSpriteBytes(await fixture("offset-" + mode + ".apng"));
    assert.deepEqual([width, height], [4, 3]);
    for (let i = 0; i < width * height; i++) {
      const expected = i === 5 ? [11, 22, 33, 127] : [0, 0, 0, 0];
      const pixel = [...data.subarray(4 * i, 4 * i + 4)];
      if (expected[3]) assert.deepEqual(pixel, expected);
      else assert.equal(pixel[3], 0);
    }
  }
});

function tiff(tag, little) {
  const data = Buffer.alloc(26);
  const short = (offset, val) => (little ? data.writeUInt16LE(val, offset) : data.writeUInt16BE(val, offset));
  const long = (offset, val) => (little ? data.writeUInt32LE(val, offset) : data.writeUInt32BE(val, offset));
  short(0, little ? 0x4949 : 0x4d4d);
  short(2, 42);
  long(4, 8);
  short(8, 1);
  short(10, 0x112);
  short(12, 3);
  long(14, 1);
  short(18, tag);
  return data;
}
function tagImage(raw, tiff, jpeg) {
  if (jpeg) {
    const seg = Buffer.alloc(10);
    seg.writeUInt16BE(0xffe1);
    seg.writeUInt16BE(8 + tiff.length, 2);
    seg.write("Exif", 4);
    return Buffer.concat([raw.subarray(0, 2), seg, tiff, raw.subarray(2)]);
  }
  const head = Buffer.alloc(8),
    check = Buffer.alloc(4);
  head.writeUInt32BE(tiff.length);
  head.write("eXIf", 4);
  check.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), tiff])));
  return Buffer.concat([raw.subarray(0, 33), head, tiff, check, raw.subarray(33)]);
}

test("PNG and JPEG IFD0 orientation is applied for all eight transforms and byte orders", async () => {
  for (const [file, jpeg] of [
    ["baseline.jpg", true],
    ["palette-adam7.png", false],
  ]) {
    const raw = await fixture(file),
      source = await decodeSpriteBytes(raw);
    const { width: w, height: h } = source;
    for (let tag = 1; tag <= 8; tag++) {
      const dst = await decodeSpriteBytes(tagImage(raw, tiff(tag, tag % 2 === 0), jpeg));
      assert.deepEqual([dst.width, dst.height], tag >= 5 ? [h, w] : [w, h]);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const [dx, dy] = [
            [x, y],
            [w - 1 - x, y],
            [w - 1 - x, h - 1 - y],
            [x, h - 1 - y],
            [y, x],
            [h - 1 - y, x],
            [h - 1 - y, w - 1 - x],
            [y, w - 1 - x],
          ][tag - 1];
          const pixel = 4 * (y * w + x),
            transformed = 4 * (dy * dst.width + dx);
          assert.deepEqual(
            [...dst.data.subarray(transformed, transformed + 4)],
            [...source.data.subarray(pixel, pixel + 4)],
          );
        }
    }
    const malformed = tiff(6, true);
    malformed.writeUInt32LE(0x80000001, 4);
    assert.deepEqual(await decodeSpriteBytes(tagImage(raw, malformed, jpeg)), source);
  }
});
