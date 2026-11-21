import test from "node:test";
import assert from "node:assert/strict";
import { triangleModel, gaussianModel } from "../src/sprite-model.mjs";
import { slicePixels } from "../src/sprite-slices.mjs";
import { materialize, RUNNERS, Workflow } from "../src/browser.mjs";
import { MP4CAT } from "../src/mp4cat.mjs";
import { dataUrlBytes } from "../src/media.mjs";
import { asymmetricMesh, splatFixture } from "./fixtures/sprite-stack.mjs";

const opts = { size: 16, layers: 8, axis: "auto", outline: false, palette: 0 };
const mesh = () => triangleModel(Buffer.from(JSON.stringify(asymmetricMesh())));
function colors(slice, layer) {
  const tile = slice.height,
    out = [];
  for (let row = 0; row < tile; row++)
    for (let x = 0; x < tile; x++) {
      const p = (row * slice.width + layer * tile + x) * 4;
      if (slice.rgba[p + 3]) out.push([...slice.rgba.subarray(p, p + 4)]);
    }
  return out;
}
test("translated mesh has broad red ground at left, smaller blue roof at right and transparent margins", async () => {
  const model = await mesh(),
    slice = slicePixels(model, opts);
  assert.deepEqual(slice.layout.bounds, { min: [2, 5, 5], max: [6, 9, 7] });
  assert.equal(slice.layout.upAxis, "y");
  assert.deepEqual([slice.width, slice.height], [128, 16]);
  const ground = colors(slice, 0),
    roof = colors(slice, 7);
  assert.ok(ground.length > roof.length * 4 && roof.length > 0);
  assert.ok(ground.every((c) => c.join() === "255,0,0,255"));
  assert.ok(roof.every((c) => c.join() === "0,0,255,255"));
  assert.ok(ground.length < 16 * 16 && slice.rgba[3] === 0);
  const x = slicePixels(model, { ...opts, axis: "x" }),
    z = slicePixels(model, { ...opts, axis: "z" });
  assert.notDeepEqual(slice.rgba, x.rgba);
  assert.notDeepEqual(x.rgba, z.rgba);
  assert.equal(colors(z, 7).length, 0); // Z occupies only half the isotropic cube.
});
test("outline stays inside each tile and quantization uses supplied palette", async () => {
  const model = await mesh(),
    base = slicePixels(model, opts),
    outlined = slicePixels(model, { ...opts, outline: true });
  for (let layer = 0; layer < 8; layer++) {
    assert.ok(colors(outlined, layer).length > colors(base, layer).length);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const alpha = (slice, xx, yy) => slice.rgba[(yy * slice.width + layer * 16 + xx) * 4 + 3];
        if (!alpha(outlined, x, y) || alpha(base, x, y)) continue;
        assert.ok(
          [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ].some(([xx, yy]) => xx >= 0 && xx < 16 && yy >= 0 && yy < 16 && alpha(base, xx, yy)),
        );
      }
  }
  const palette = { data: Uint8Array.from([6, 55, 96, 255, 255, 255, 255, 0]) };
  assert.ok(
    colors(slicePixels(model, { ...opts, palette: 16 }, palette), 0).every((c) => c.join() === "6,55,96,255"),
  );
  assert.deepEqual(slicePixels(model, opts, palette).rgba, base.rgba);
});
test("Gaussian PLY has translucent oriented footprints across layers in both encodings", () => {
  for (const binary of [false, true]) {
    const model = gaussianModel(splatFixture(binary)),
      slice = slicePixels(model, opts);
    assert.equal(slice.layout.upAxis, "z");
    assert.ok(model.splats[0].extent[0] > model.splats[0].extent[1] * 2);
    assert.ok(model.splats[1].extent[1] > model.splats[1].extent[0] * 2);
    const ground = colors(slice, 0),
      roof = colors(slice, 7);
    assert.ok(ground.some((c) => c[0] > 200 && c[3] < 255));
    assert.ok(roof.some((c) => c[2] > 200 && c[3] < 255));
    assert.notDeepEqual(slice.rgba, slicePixels(model, { ...opts, axis: "y" }).rgba);
  }
});
test("unsupported encodings produce specific errors before rasterization", async () => {
  const json = asymmetricMesh(),
    read = () => triangleModel(Buffer.from(JSON.stringify(json)));
  json.meshes[0].primitives[0].mode = 0;
  await assert.rejects(read, /point-cloud preview/);
  json.extensionsRequired = ["KHR_draco_mesh_compression"];
  await assert.rejects(read, /KHR_draco_mesh_compression/);
  delete json.extensionsRequired;
  json.buffers[0].uri = "scene.bin";
  await assert.rejects(read, /self-contained/);
  assert.throws(
    () => gaussianModel(Buffer.from(splatFixture().toString().replace("opacity", "density"))),
    /opacity logit/,
  );
  assert.throws(
    () => gaussianModel(Buffer.from(splatFixture().toString().replace("ascii", "binary_big_endian"))),
    /little-endian/,
  );
});
test("saved graphs retain ports and settings and render in Node", async () => {
  const graph = {
    nodes: [
      { id: "m", type: "mupload", fields: {} },
      { id: "s", type: "slice-3d", fields: { upAxis: "x" } },
      { id: "r", type: "sprite-stack-render", fields: { yaw: 63 } },
    ],
    links: [
      { id: "l1", from: { node: "m", port: "model" }, to: { node: "s", port: "model" } },
      { id: "l2", from: { node: "s", port: "sheet" }, to: { node: "r", port: "sheet" } },
    ],
  };
  const saved = materialize(JSON.parse(JSON.stringify(graph)));
  assert.deepEqual(saved.warnings, []);
  assert.deepEqual(saved.links, graph.links);
  assert.equal(saved.nodes[1].fields.upAxis, "x");
  for (const [mime, bytes] of [
    ["model/gltf+json", Buffer.from(JSON.stringify(asymmetricMesh()))],
    ["application/octet-stream", splatFixture(true)],
  ]) {
    const input = { model: "data:" + mime + ";base64," + bytes.toString("base64") };
    const sliced = await RUNNERS["slice-3d"](saved.nodes[1], input, {});
    assert.equal(JSON.parse(sliced.layout).upAxis, "x");
    assert.match(sliced.sheet, /^data:image\/png;base64,/);
    const render = await RUNNERS["sprite-stack-render"](saved.nodes[2], { sheet: sliced.sheet }, {});
    assert.match(render.image, /^data:image\/png;base64,/);
    assert.equal(render.video, undefined);
    assert.notEqual(sliced.image, render.image);
  }
});

test("saved turntables feed Combine as timed H.264 tracks without a media subprocess", async () => {
  const fields = { turntable: true, duration: 0.5, fps: 8 };
  const link = (from, out, to, input) => ({ from: { node: from, port: out }, to: { node: to, port: input } });
  const workflow = Workflow.fromJSON({
    nodes: [
      { id: "source", type: "mupload", fields: { model: "data:model/ply;base64," + splatFixture().toString("base64") } },
      { id: "slice", type: "slice-3d", fields: { resolution: 16, slices: 8 } },
      { id: "first", type: "sprite-stack-render", fields: { ...fields, yawEnd: 180 } },
      { id: "second", type: "sprite-stack-render", fields: { ...fields, yawStart: 180 } },
      { id: "joined", type: "combine", fields: {} },
    ],
    links: [
      link("source", "model", "slice", "model"), link("slice", "sheet", "first", "sheet"),
      link("slice", "sheet", "second", "sheet"), link("first", "video", "joined", "vid1"),
      link("second", "video", "joined", "vid2"),
    ],
  });
  const { nodes } = await workflow.run();
  for (const [id, count] of [["first", 4], ["second", 4], ["joined", 8]]) {
    const { bytes, mime } = dataUrlBytes(nodes[id].out.video);
    const [track] = MP4CAT.parseMp4(bytes).tracks;
    assert.equal(mime, "video/mp4");
    assert.equal(track.kind, "video");
    assert.ok(track.codecCfg, "the MP4 carries its H.264 decoder configuration");
    assert.equal(track.samples.length, count);
    assert.equal(track.samples.reduce((ticks, sample) => ticks + sample.dur, 0) / track.timescale, count / 8);
  }
});
