import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Workflow } from "../src/index.mjs";
import { render3dSceneFields, render3dMedia, findChromium } from "../src/render3d.mjs";
import { decodePng } from "../src/local-media.mjs";

// render3d (Edge Styles S2): a local node that renders a GLB — camera,
// clip plane (slice-3D), explode over scene-graph parts. The render tests
// build a tiny two-cube GLB in-test (red cube + blue cube) and drive the
// real headless Chromium when one is discoverable; they skip elsewhere.

function twoCubeGlb() {
  const FACES = [
    { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
    { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
    { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
    { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
    { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  ];
  const pos = [], nor = [], idx = [];
  FACES.forEach((f, fi) => {
    for (const c of f.c) { pos.push(c[0] * 0.5, c[1] * 0.5, c[2] * 0.5); nor.push(...f.n); }
    const b = fi * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const posBuf = Buffer.from(new Float32Array(pos).buffer);
  const norBuf = Buffer.from(new Float32Array(nor).buffer);
  const idxBuf = Buffer.from(new Uint16Array(idx).buffer);
  const bin = Buffer.concat([posBuf, norBuf, idxBuf]);
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, translation: [-0.75, 0, 0], name: "cube_red" },
      { mesh: 1, translation: [0.75, 0, 0], name: "cube_blue" },
    ],
    meshes: [
      { name: "red", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] },
      { name: "blue", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 1 }] },
    ],
    materials: [
      { name: "red", pbrMetallicRoughness: { baseColorFactor: [1, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true },
      { name: "blue", pbrMetallicRoughness: { baseColorFactor: [0.1, 0.2, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length },
      { buffer: 0, byteOffset: posBuf.length, byteLength: norBuf.length },
      { buffer: 0, byteOffset: posBuf.length + norBuf.length, byteLength: idxBuf.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: "VEC3", min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };
  const jsonBuf = Buffer.from(JSON.stringify(gltf));
  const pad4 = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const j = pad4(jsonBuf, 0x20), b = pad4(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.write("JSON", 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.write("BIN\0", 4);
  return Buffer.concat([head, jh, j, bh, b]);
}

const GLB_DATA_URL = "data:model/gltf-binary;base64," + twoCubeGlb().toString("base64");

const graph = (fields) => ({
  nodes: [
    { id: "u", type: "mupload", fields: { model: GLB_DATA_URL } },
    { id: "r", type: "render3d", fields: { width: "320", height: "240", ...fields } },
  ],
  links: [{ id: "l1", from: { node: "u", port: "model" }, to: { node: "r", port: "model" } }],
});

async function pixels(dataUrl) {
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  const { w, h, rgba } = await decodePng(buf);
  return { width: w, height: h, data: rgba };
}
function countColor(png, pred) {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) if (pred(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
  return n;
}
// Lit PBR washes saturated albedos toward pastel; assert channel dominance.
const isRed = (r, g, b) => r > g + 40 && r > b + 40;
const isBlue = (r, g, b) => b > r + 30 && b > g + 15;

test("render3dSceneFields: strings map to typed scene fields", () => {
  const f = render3dSceneFields({ azimuth: "90", clipAxis: "y", clipPos: "0.5", isolate: "2", explode: "0.5" });
  assert.equal(f.azimuth, 90);
  assert.equal(f.clipAxis, "y");
  assert.equal(f.clipPos, 0.5);
  assert.equal(f.isolate, 2);
  assert.equal(f.explode, 0.5);
  const d = render3dSceneFields({});
  assert.equal(d.azimuth, 35);
  assert.ok(!("clipAxis" in d));
  assert.ok(!("isolate" in d));
  assert.equal(render3dSceneFields({ isolate: "largest" }).isolate, "largest");
  assert.equal(render3dSceneFields({ animClip: 0 }).animClip, 0);
});

test("render budgets are checked before obtaining the model", async () => {
  const opts = { fetch: () => assert.fail("an invalid render must not download a model") };
  const model = "https://example.invalid/model.glb";
  await assert.rejects(render3dMedia(model, { width: 2049 }, opts), /dimensions/);
  await assert.rejects(render3dMedia(model, { mode: "video", fps: 60, duration: 10 }, opts), /240 frames/);
  await assert.rejects(render3dMedia(model, { mode: "video", width: 319 }, opts), /even dimensions/);
});

test("Chromium rejects a model that references an unbundled asset", async (t) => {
  if (!(await findChromium())) { t.skip("no chromium discoverable"); return; }
  let requests = 0;
  const asset = createServer((_req, res) => { requests++; res.writeHead(404).end(); });
  await new Promise(resolve => asset.listen(0, "127.0.0.1", resolve));
  t.after(() => asset.close());
  const glb = twoCubeGlb();
  const model = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)));
  model.buffers[0].uri = `http://127.0.0.1:${asset.address().port}/model.bin`;
  const url = "data:model/gltf+json;base64," + Buffer.from(JSON.stringify(model)).toString("base64");
  await assert.rejects(render3dMedia(url), /self-contained model/);
  assert.equal(requests, 0);
});

test("render3d node: renders both parts; explode separates; clip cuts", async (t) => {
  if (!(await findChromium())) { t.skip("no chromium discoverable"); return; }
  const run = async (fields) => (await Workflow.fromJSON(graph(fields), { apiKey: "fixture" }).run({})).nodes.r.out;

  const plain = await pixels((await run({ azimuth: "0", elevation: "0" })).image);
  assert.equal(plain.width, 320);
  assert.equal(plain.height, 240);
  const red = countColor(plain, isRed), blue = countColor(plain, isBlue);
  assert.ok(red > 500, "red cube visible: " + red);
  assert.ok(blue > 500, "blue cube visible: " + blue);

  const exploded = await pixels((await run({ azimuth: "0", elevation: "0", explode: "1" })).image);
  const gap = countColor(exploded, isRed) + countColor(exploded, isBlue);
  assert.ok(gap < red + blue, "explode moves parts apart (perspective shrink): " + gap + " vs " + (red + blue));

  const clipped = await pixels((await run({ azimuth: "0", elevation: "0", clipAxis: "x", clipPos: "0" })).image);
  const afterClip = countColor(clipped, isRed) + countColor(clipped, isBlue);
  assert.ok(afterClip < (red + blue) * 0.75, "clip plane removes the +x half: " + afterClip + " vs " + (red + blue));

  const iso = await pixels((await run({ azimuth: "0", elevation: "0", isolate: "0" })).image);
  assert.ok(countColor(iso, isRed) > 500);
  assert.equal(countColor(iso, isBlue), 0);
});
