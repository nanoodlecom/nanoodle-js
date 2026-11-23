import test from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src/index.mjs";
import { unpackGlb } from "../src/gltf-scene.mjs";
import { render3dSceneFields, render3dMedia, findChromium } from "../src/render3d.mjs";
import { decodePng } from "../src/local-media.mjs";

// render3d (Edge Styles S2): a local node that renders a GLB — camera,
// clip plane (slice-3D), explode over scene-graph parts. The render tests
// build a tiny two-cube GLB in-test (red cube + blue cube) and drive the
// real headless Chromium when one is discoverable; they skip elsewhere.

function twoCubeGlb(images) {
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
  if (images) gltf.images = images;
  const jsonBuf = Buffer.from(JSON.stringify(gltf));
  const pad4 = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const j = pad4(jsonBuf, 0x20), b = pad4(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.write("JSON", 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(b.length, 0); bh.write("BIN\0", 4);
  return Buffer.concat([head, jh, j, bh, b]);
}

const GLB_BYTES = twoCubeGlb();
const GLB_DATA_URL = "data:model/gltf-binary;base64," + GLB_BYTES.toString("base64");
const gltfUrl = (json) => "data:model/gltf+json;base64," + Buffer.from(JSON.stringify(json)).toString("base64");

const graph = (fields, model = GLB_DATA_URL) => ({
  nodes: [
    { id: "u", type: "mupload", fields: { model } },
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

test("render3d selects the primary workflow output for the render mode", () => {
  assert.equal(Workflow.fromJSON(graph({})).outputs[0].ports[0].name, "image");
  assert.equal(Workflow.fromJSON(graph({ mode: "video" })).outputs[0].ports[0].name, "video");
});

test("render3d rejects external glTF buffers and GLB images before starting Chromium", async (t) => {
  const chrome = process.env.NANOODLE_CHROME;
  process.env.NANOODLE_CHROME = process.execPath;
  t.after(() => {
    if (chrome === undefined) delete process.env.NANOODLE_CHROME;
    else process.env.NANOODLE_CHROME = chrome;
  });

  const { json } = unpackGlb(GLB_BYTES);
  json.buffers[0].uri = "https://example.invalid/model.bin";
  await assert.rejects(render3dMedia(gltfUrl(json)), /self-contained model/);

  const glb = twoCubeGlb([{ uri: "texture.png" }]);
  const url = "data:model/gltf-binary;base64," + glb.toString("base64");
  await assert.rejects(render3dMedia(url), /self-contained model/);
});

test("render3d node: renders both parts; explode separates; clip cuts", async (t) => {
  if (!(await findChromium())) { t.skip("no chromium discoverable"); return; }
  const commands = [];
  const send = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, "send", function (data) {
    commands.push(JSON.parse(data));
    return send.call(this, data);
  });
  const run = async (fields, model) => (await Workflow.fromJSON(graph(fields, model), { apiKey: "fixture" }).run({}, {
    signal: AbortSignal.timeout(30_000),
  })).nodes.r.out;

  const plain = await pixels((await run({ azimuth: "0", elevation: "0" })).image);
  assert.equal(commands.some(command => command.method === "Target.createTarget"), false, "use Chromium's existing incognito page");
  const targets = commands.findIndex(command => command.method === "Target.getTargets");
  const attach = commands.findIndex(command => command.method === "Target.attachToTarget");
  const navigate = commands.findIndex(command => command.method === "Page.navigate");
  const probe = commands.findIndex(command => command.method === "Runtime.evaluate");
  assert.ok(targets >= 0 && targets < attach && attach < navigate && navigate < probe);
  assert.notEqual(commands[probe].params.awaitPromise, true, "a discarded document must not own the readiness wait");

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

  const { json, bin } = unpackGlb(GLB_BYTES);
  json.buffers[0].uri = "data:application/octet-stream;base64," + Buffer.from(bin).toString("base64");
  const iso = await pixels((await run({ azimuth: "0", elevation: "0", isolate: "0" }, gltfUrl(json))).image);
  assert.ok(countColor(iso, isRed) > 500);
  assert.equal(countColor(iso, isBlue), 0);
});
