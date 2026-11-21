import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { catBytes, decodePng, encodePngRgba, pngChunk } from "../src/local-media.mjs";
import { readStackApng, writeStackApng } from "../src/sprite-sequence.mjs";

// Independent zlib-built APNG. Each of its three poses uses two data chunks.
const fixture = await readFile(new URL("./fixtures/sprite-images/stack-animation.apng", import.meta.url));

function editChunks(fn) {
  const out = [fixture.subarray(0, 8)];
  for (let at = 8, index = 0; at < fixture.length; index++) {
    const length = fixture.readUInt32BE(at);
    const type = fixture.toString("ascii", at + 4, at + 8);
    const bytes = Buffer.from(fixture.subarray(at + 8, at + 8 + length));
    const edited = fn(type, bytes, index);
    if (edited) out.push(...edited);
    else out.push(pngChunk(type, bytes));
    at += length + 12;
  }
  return catBytes(out);
}

test("marked APNG indexes multi-chunk poses as independently decodable stills", async () => {
  const stack = readStackApng(fixture);
  assert.deepEqual([stack.width, stack.height, stack.length, stack.duration], [128, 16, 3, 0.375]);
  assert.deepEqual(stack.delays, [0.125, 0.125, 0.125]);
  for (let i = 0; i < stack.length; i++) {
    const png = stack.png(i);
    assert.equal(readStackApng(png), null);
    const { rgba } = await decodePng(png, true);
    const offset = 4 * (7 * stack.width + 6);
    const color = [0, 0, 0, 255];
    color[i] = 255;
    assert.deepEqual([...rgba.slice(offset, offset + 4)], color);
  }
  for (const index of [-1, 0.5, 3]) assert.throws(() => stack.png(index), /pose index/);
});

test("untagged images including ordinary APNG use the existing still image path", () => {
  assert.equal(readStackApng(editChunks((t) => (t === "nsTA" ? [] : undefined))), null);
  assert.equal(readStackApng(Buffer.from("RIFF")), null);
});

test("reader validates CRC, order, sequence numbers, uniform timing, limits and frame bounds", () => {
  const broken = Buffer.from(fixture);
  broken[29] ^= 1; // IHDR CRC, before marker.
  assert.throws(() => readStackApng(broken), /CRC/);
  const mutations = [
    (t, b) => {
      if (t === "nsTA") b[0]++;
    },
    (t, b) => {
      if (t === "nsTA") return [pngChunk(t, b), pngChunk(t, b)];
    },
    (t, b) => {
      if (t === "acTL") b.writeUInt32BE(65, 0);
    },
    (t, b) => {
      if (t === "acTL") b.writeUInt32BE(1, 4);
    },
    (t, b) => {
      if (t === "IHDR") b.writeUInt32BE(129, 0);
    },
    (t, b) => {
      if (t === "fcTL") b.writeUInt32BE(1, 12);
    },
    (t, b) => {
      if (t === "fcTL") b[25] = 1;
    },
    (t, b) => {
      if (t === "fcTL" && b.readUInt32BE(0) !== 0) b.writeUInt16BE(7501, 20);
    },
    (t, b) => {
      if (t === "fcTL") b.writeUInt16BE(0, 22);
    },
    (t, b) => {
      if (t === "fdAT") b.writeUInt32BE(1234, 0);
    },
    (t, b) => {
      if (t === "IDAT") return [pngChunk("IDAT", new Uint8Array(75_000))];
    },
    (t) => {
      if (t === "fdAT") return [];
    },
    (t) => {
      if (t === "acTL") return [];
    },
    (t) => {
      if (t === "IEND") return [];
    },
  ];
  for (const mutation of mutations)
    assert.throws(() => readStackApng(editChunks(mutation)), /Invalid sprite stack PNG/);
  assert.throws(() => readStackApng(fixture.subarray(0, 45)), /truncated/);
  assert.throws(() => readStackApng(catBytes([fixture, Uint8Array.of(1)])), /trailing/);
});

test("writer accepts streaming poses and preserves pixels and fractional timing", async () => {
  const original = readStackApng(fixture);
  async function* poses() {
    for (let i = 0; i < original.length; i++) yield original.png(i);
  }
  for (const [delay, expected] of [
    [1 / 24, 1 / 24],
    [100.25, 65_463 / 653],
    [0.000001, 1 / 60_000],
  ]) {
    const bytes = await writeStackApng(original.length, delay, poses());
    const result = readStackApng(bytes);
    assert.equal(result.duration, expected * original.length);
    assert.equal(result.delays[0], expected);
    for (let i = 0; i < original.length; i++) {
      assert.deepEqual(await decodePng(result.png(i)), await decodePng(original.png(i)));
    }
  }
});

test("writer enforces duration, exact frame count, bounds and matching strip dimensions", async () => {
  const frame = readStackApng(fixture).png(0);
  for (const n of [0, 1, 65]) await assert.rejects(writeStackApng(n, 0.1, [frame]), /2 to 64/);
  for (const delay of [NaN, Infinity, 0, -1, 65_536]) {
    await assert.rejects(writeStackApng(2, delay, [frame, frame]), /duration/);
  }
  await assert.rejects(writeStackApng(2, 0.1, [frame]), /count mismatch/);
  await assert.rejects(writeStackApng(2, 0.1, [frame, frame, frame]), /unexpected pose/);
  const offSize = await encodePngRgba(144, 16, new Uint8Array(144 * 16 * 4));
  await assert.rejects(writeStackApng(2, 0.1, [frame, offSize]), /same dimensions/);
});
