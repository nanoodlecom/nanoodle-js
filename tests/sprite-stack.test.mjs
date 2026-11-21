import test from "node:test";
import assert from "node:assert/strict";
import { triangleModel, gaussianModel } from "../src/sprite-model.mjs";
import { slicePixels } from "../src/sprite-slices.mjs";
import { materialize, RUNNERS } from "../src/browser.mjs";
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
test("saved graphs retain ports and settings and reject rendering outside a browser", async () => {
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
  await assert.rejects(() => RUNNERS["slice-3d"](saved.nodes[1], { model: "data:," }), /requires a browser/);
});
