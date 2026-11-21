import assert from "node:assert/strict";
import test from "node:test";
import { RUNNERS, Workflow } from "../src/browser.mjs";
import { deriveSettings } from "../src/io.mjs";
import { dataUrlBytes } from "../src/media.mjs";
import { MP4CAT } from "../src/mp4cat.mjs";
import { decodePngPixels } from "../src/png-decoder.mjs";
import { readStackApng } from "../src/sprite-sequence.mjs";
import { asymmetricMesh, splatFixture } from "./fixtures/sprite-stack.mjs";

const modelUrl = model => "data:model/gltf+json;base64," + Buffer.from(JSON.stringify(model)).toString("base64");
const slice = (model, fields) => RUNNERS["slice-3d"]({fields}, {model}, {});
const render = (sheet, fields) => RUNNERS["sprite-stack-render"]({fields}, {sheet}, {});
const track = url => MP4CAT.parseMp4(dataUrlBytes(url).bytes).tracks[0];
const lengthSeconds = t => t.samples.reduce((ticks, s) => ticks + s.dur, 0) / t.timescale;

function movingMesh() {
  const mesh = asymmetricMesh();
  const data = Buffer.from(new Float32Array([3, 4, 4, 5, 6, 8, 9, 6]).buffer);
  mesh.buffers.push({byteLength: data.length, uri: "data:application/octet-stream;base64," + data.toString("base64")});
  mesh.bufferViews.push({buffer: 1, byteLength: data.length});
  mesh.accessors.push(
    {bufferView: 1, componentType: 5126, count: 2, type: "SCALAR", min: [3], max: [4]},
    {bufferView: 1, byteOffset: 8, componentType: 5126, count: 2, type: "VEC3"},
  );
  mesh.animations = [{
    name: "Rise",
    samplers: [{input: 2, output: 3, interpolation: "LINEAR"}],
    channels: [{sampler: 0, target: {node: 0, path: "translation"}}],
  }];
  return mesh;
}

test("an animated slice and the original sheet wire produce a timed fixed-yaw H.264 clip", async () => {
  const workflow = Workflow.fromJSON({
    nodes: [
      { id: "m", type: "mupload", fields: { model: modelUrl(movingMesh()) } },
      { id: "s", type: "slice-3d", fields: { resolution: 16, slices: 8, frames: 4 } },
      { id: "r", type: "sprite-stack-render", fields: { yaw: 35, scale: 3 } },
    ],
    links: [
      { from: {node: "m", port: "model"}, to: {node: "s", port: "model"} },
      { from: {node: "s", port: "sheet"}, to: {node: "r", port: "sheet"} },
    ],
  });
  const { nodes } = await workflow.run();
  const { image, sheet, layout } = nodes.s.out;
  const { animation, bounds } = JSON.parse(layout);
  assert.deepEqual(animation, { clip: "Rise", frames: 4, duration: 1, times: [3, 3.25, 3.5, 3.75] });
  assert.deepEqual(bounds, { min: [2, 5, 5], max: [9, 12, 7] });
  const sequence = readStackApng(dataUrlBytes(sheet).bytes);
  assert.equal(sequence.length, 4);
  assert.deepEqual(sequence.delays, [0.25, 0.25, 0.25, 0.25]);
  // With independently fitted grids, root motion would disappear and every
  // translated atlas would have exactly the same pixels.
  const frames = await Promise.all([0, 1, 2, 3].map(async i => {
    const {rgba} = await decodePngPixels(sequence.png(i), { maxDim: 128, allowSpriteStrip: true });
    return Buffer.from(rgba).toString("base64");
  }));
  assert.equal(new Set(frames).size, 4);
  assert.equal(nodes.r.out.image, image);
  const fixed = track(nodes.r.out.video);
  assert.equal(fixed.samples.length, 4);
  assert.equal(lengthSeconds(fixed), 1);
  const turned = await render(sheet, {turntable: true, duration: 2, fps: 6, yawStart: 20, yawEnd: 140, scale: 1});
  const spin = track(turned.video);
  assert.equal(spin.samples.length, 12);
  assert.equal(lengthSeconds(spin), 2);
});

test("one pose retains ordinary PNG outputs, including a named clip's first key", async () => {
  const json = movingMesh();
  json.nodes[0].translation = [0, 0, 0];
  const model = modelUrl(json);
  const fields = { resolution: 16, slices: 8 };
  const rest = await slice(model, fields);
  const named = await slice(model, {...fields, clip: "Rise", frames: 1});
  const restLayout = JSON.parse(rest.layout), firstLayout = JSON.parse(named.layout);
  assert.equal(restLayout.animation, undefined);
  assert.equal(firstLayout.animation, undefined);
  assert.deepEqual(restLayout.bounds.min, [-2, 0, -1]);
  assert.deepEqual(firstLayout.bounds.min, [2, 5, 5]);
  assert.equal(readStackApng(dataUrlBytes(named.sheet).bytes), null);
  assert.equal((await render(named.sheet, {})).video, undefined);
  await assert.rejects(slice(model, {clip: "Missing"}), /Rise/);
  await assert.rejects(slice(modelUrl(asymmetricMesh()), {frames: 3}), /clip|animation/i);
  const splat = "data:application/octet-stream;base64," + splatFixture().toString("base64");
  await assert.rejects(slice(splat, {frames: 3}), /frames to 1/);
  await assert.rejects(slice(model, {frames: 65}), /64/);
});

test("Character selects high-resolution source color settings and honors explicit overrides", async () => {
  const model = modelUrl(asymmetricMesh());
  const character = await slice(model, {preset: "character"});
  const layout = JSON.parse(character.layout);
  assert.equal(layout.tileWidth, 128);
  assert.equal(layout.columns, 80);
  const fields = {resolution: 16, slices: 8, outline: false};
  const override = await slice(model, {preset: "character", ...fields});
  const explicit = await slice(model, {...fields, palette: 0});
  assert.deepEqual(override, explicit);
  const settings = deriveSettings({nodes: [{id: "s", type: "slice-3d", fields: {preset: "character", slices: 39}}], links: []});
  const byName = Object.fromEntries(settings.map(s => [s.field, s]));
  assert.equal(byName.resolution.def, "128");
  assert.equal(byName.slices.def, 39);
  assert.equal(byName.palette.def, "0");
  assert.equal(byName.frames.max, 64);
});
