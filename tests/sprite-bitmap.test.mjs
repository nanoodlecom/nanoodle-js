import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeSpriteBytes } from "../src/sprite-image.mjs";

function bitmapInfo(width, height, depth, { header = 40, compression = 0, palette = [], masks = [], rows }) {
  const info = Buffer.alloc(header);
  info.writeUInt32LE(header);
  info.writeInt32LE(width, 4);
  info.writeInt32LE(height, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(depth, 14);
  info.writeUInt32LE(compression, 16);
  info.writeUInt32LE(palette.length, 32);
  const maskBytes = Buffer.alloc(4 * masks.length);
  masks.forEach((m, i) => maskBytes.writeUInt32LE(m, i * 4));
  if (header > 40) maskBytes.copy(info, 40);
  const colors = Buffer.from(palette.flatMap(([r, g, b]) => [b, g, r, 0]));
  const head = Buffer.concat([info, header === 40 ? maskBytes : Buffer.alloc(0), colors]);
  return { dib: Buffer.concat([head, Buffer.from(rows)]), offset: head.length };
}

function bmp({ dib, offset }) {
  const head = Buffer.alloc(14);
  head.write("BM");
  head.writeUInt32LE(head.length + dib.length, 2);
  head.writeUInt32LE(head.length + offset, 10);
  return Buffer.concat([head, dib]);
}

function icon(...entries) {
  const directory = Buffer.alloc(6 + 16 * entries.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(entries.length, 4);
  let pos = directory.length;
  entries.forEach(([width, height, depth, raw], i) => {
    const p = 6 + 16 * i;
    directory[p] = width & 255;
    directory[p + 1] = height & 255;
    directory.writeUInt16LE(1, p + 4);
    directory.writeUInt16LE(depth, p + 6);
    directory.writeUInt32LE(raw.length, p + 8);
    directory.writeUInt32LE(pos, p + 12);
    pos += raw.length;
  });
  return Buffer.concat([directory, ...entries.map((e) => e[3])]);
}

test("BMP honors row padding and positive or negative height", async () => {
  const top = [3, 2, 1, 23, 22, 21, 253, 252];
  const bottom = [6, 5, 4, 26, 25, 24, 99, 98];
  const expected = [1, 2, 3, 255, 21, 22, 23, 255, 4, 5, 6, 255, 24, 25, 26, 255];
  for (const [height, rows] of [
    [2, [...bottom, ...top]],
    [-2, [...top, ...bottom]],
  ]) {
    const img = await decodeSpriteBytes(bmp(bitmapInfo(2, height, 24, { rows })));
    assert.deepEqual([img.width, img.height], [2, 2]);
    assert.deepEqual([...img.data], expected);
  }
});

test("OS/2 core BMP uses three-byte palette entries and MSB-first packed pixels", async () => {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(12);
  head.writeUInt16LE(3, 4);
  head.writeUInt16LE(1, 6);
  head.writeUInt16LE(1, 8);
  head.writeUInt16LE(1, 10);
  const bytes = bmp({
    dib: Buffer.concat([head, Buffer.from([3, 2, 1, 9, 8, 7, 0xa0, 0, 0, 0])]),
    offset: 18,
  });
  const { data } = await decodeSpriteBytes(bytes);
  assert.deepEqual([...data], [7, 8, 9, 255, 1, 2, 3, 255, 7, 8, 9, 255]);
});

test("BMP decodes RGB565 and an explicit alpha channel", async () => {
  const rgb565 = bitmapInfo(2, 1, 16, {
    compression: 3,
    masks: [0xf800, 0x7e0, 0x1f],
    rows: [0, 248, 224, 7],
  });
  assert.deepEqual([...(await decodeSpriteBytes(bmp(rgb565))).data], [255, 0, 0, 255, 0, 255, 0, 255]);
  const v4 = bitmapInfo(1, 1, 32, {
    header: 108,
    compression: 3,
    masks: [0xff, 0xff00, 0xff0000, 0xff000000],
    rows: [1, 2, 3, 4],
  });
  assert.deepEqual([...(await decodeSpriteBytes(bmp(v4))).data], [1, 2, 3, 4]);
  const rgbx = bitmapInfo(1, 1, 32, { rows: [3, 2, 1, 17] });
  assert.deepEqual([...(await decodeSpriteBytes(bmp(rgbx))).data], [1, 2, 3, 255]);
});

test("BMP supports encoded and word-padded absolute RLE8/RLE4 runs", async () => {
  const palette = [
    [0, 0, 0],
    [1, 11, 21],
    [2, 12, 22],
    [3, 13, 23],
  ];
  for (const [depth, compression, rows] of [
    [8, 1, [2, 1, 0, 3, 2, 3, 1, 0, 0, 0, 5, 2, 0, 1]],
    [4, 2, [2, 0x11, 0, 3, 0x23, 0x10, 0, 0, 5, 0x22, 0, 1]],
  ]) {
    const { data } = await decodeSpriteBytes(bmp(bitmapInfo(5, 2, depth, { compression, palette, rows })));
    const expected = [2, 2, 2, 2, 2, 1, 1, 2, 3, 1].flatMap((i) => [...palette[i], 255]);
    assert.deepEqual([...data], expected);
  }
});

test("DIB icons prefer populated BGRA or use the AND plane with legacy XOR pixels", async () => {
  for (const [alpha, expected] of [
    [127, [1, 2, 3, 127, 4, 5, 6, 0]],
    [0, [0, 0, 0, 0, 4, 5, 6, 255]],
  ]) {
    const { dib } = bitmapInfo(2, 2, 32, { rows: [3, 2, 1, alpha, 6, 5, 4, 0, 0x80, 0, 0, 0] });
    const img = await decodeSpriteBytes(icon([2, 1, 32, dib]));
    assert.deepEqual([img.width, img.height], [2, 1]);
    assert.deepEqual([...img.data], expected);
  }
});

test("ICO chooses largest area, then greatest bit depth, including embedded PNG", async () => {
  const png = await readFile(new URL("./fixtures/sprite-images/gray16.png", import.meta.url));
  const small = bitmapInfo(1, 2, 32, { rows: [0, 0, 255, 255] }).dib;
  const wide = bitmapInfo(4, 2, 24, { rows: new Uint8Array(16) }).dib;
  const actual = await decodeSpriteBytes(icon([1, 1, 32, small], [4, 1, 24, wide], [4, 1, 32, png]));
  assert.deepEqual(actual, await decodeSpriteBytes(png));
});

test("invalid bitmap offsets and truncated icon mask fail before pixel reads", async () => {
  const broken = bmp(bitmapInfo(1, 1, 24, { rows: [1, 2, 3, 0] }));
  broken.writeUInt32LE(1, 10);
  await assert.rejects(decodeSpriteBytes(broken), /pixel offset/);
  const truncated = bitmapInfo(1, 2, 24, { rows: [3, 2, 1, 0] }).dib;
  await assert.rejects(decodeSpriteBytes(icon([1, 1, 24, truncated])), /transparency mask/);
});

test("CUR directory fields are hot spots, and its DIB uses the same mask rules", async () => {
  const { dib } = bitmapInfo(2, 2, 24, { rows: [3, 2, 1, 6, 5, 4, 0, 0, 128, 0, 0, 0] });
  const cursor = icon([2, 1, 24, dib]);
  cursor.writeUInt16LE(2, 2);
  cursor.writeUInt16LE(1, 10);
  cursor.writeUInt16LE(0, 12);
  const { data } = await decodeSpriteBytes(cursor);
  assert.deepEqual([...data], [0, 0, 0, 0, 4, 5, 6, 255]);
});

test("RLE leaves skipped pixels opaque black regardless of palette zero", async () => {
  const { data } = await decodeSpriteBytes(
    bmp(
      bitmapInfo(2, 1, 8, {
        compression: 1,
        palette: [
          [0, 0, 255],
          [255, 127, 0],
        ],
        rows: [0, 2, 1, 0, 1, 1, 0, 1],
      }),
    ),
  );
  assert.deepEqual([...data], [0, 0, 0, 255, 255, 127, 0, 255]);
});
