import test from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src/index.mjs";
import { compositePlan, compositeImages, decodePng, encodePngRgba } from "../src/local-media.mjs";

// composite (Edge Styles S3): lay 2+ images into one — contact sheets,
// view boards, before/after stacks. Pure PNG path.

async function solidPng(w, h, [r, g, b, a]) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  const bytes = await encodePngRgba(w, h, rgba);
  return "data:image/png;base64," + Buffer.from(bytes).toString("base64");
}
const RED = await solidPng(40, 20, [230, 30, 30, 255]);
const BLUE = await solidPng(20, 20, [30, 60, 230, 255]);

async function decoded(dataUrl) {
  const { w, h, rgba } = await decodePng(Buffer.from(dataUrl.split(",")[1], "base64"));
  return { w, h, rgba };
}
function px(img, x, y) {
  const o = (y * img.w + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
}

test("compositePlan: over stacks at shared width, row at shared height, grid cells", () => {
  const sizes = [{ w: 40, h: 20 }, { w: 20, h: 20 }];
  const over = compositePlan(sizes, "over", 0);
  assert.equal(over.width, 40);
  assert.equal(over.height, 60); // 20 + (20 scaled to w40 → h40)
  assert.deepEqual(over.placements[1], { x: 0, y: 20, w: 40, h: 40 });
  const row = compositePlan(sizes, "row", 4);
  assert.equal(row.height, 20);
  assert.equal(row.width, 40 + 4 + 20);
  const grid = compositePlan(sizes, "grid", 4);
  assert.equal(grid.width, 84); // 2 cols × 40 + gap
  assert.equal(grid.height, 20);
  assert.equal(grid.placements[1].x, 44 + 10); // centered in its 40-wide cell
});

test("compositeImages: over stacks red above blue; grid places side by side", async () => {
  const over = await decoded(await compositeImages([RED, BLUE], { layout: "over" }, {}));
  assert.equal(over.w, 40);
  assert.equal(over.h, 60);
  assert.deepEqual(px(over, 20, 10), [230, 30, 30, 255]);
  assert.deepEqual(px(over, 20, 40), [30, 60, 230, 255]);

  const grid = await decoded(await compositeImages([RED, BLUE], { layout: "grid", gap: 4, background: "dark" }, {}));
  assert.equal(grid.w, 84);
  assert.equal(grid.h, 20);
  assert.deepEqual(px(grid, 20, 10), [230, 30, 30, 255]);
  assert.deepEqual(px(grid, 64, 10), [30, 60, 230, 255]);
  assert.deepEqual(px(grid, 42, 10), [24, 26, 32, 255]); // gap shows background
});

test("composite node: wires image + image2 in port order", async () => {
  const graph = {
    nodes: [
      { id: "a", type: "upload", fields: { image: RED } },
      { id: "b", type: "upload", fields: { image: BLUE } },
      { id: "c", type: "composite", fields: { layout: "row" } },
    ],
    links: [
      { id: "l1", from: { node: "a", port: "image" }, to: { node: "c", port: "image" } },
      { id: "l2", from: { node: "b", port: "image" }, to: { node: "c", port: "image2" } },
    ],
  };
  const res = await Workflow.fromJSON(graph, { apiKey: "fixture" }).run({});
  const out = await decoded(res.nodes.c.out.image);
  assert.equal(out.h, 20);
  assert.equal(out.w, 60);
  assert.deepEqual(px(out, 10, 10), [230, 30, 30, 255]);
  assert.deepEqual(px(out, 50, 10), [30, 60, 230, 255]);
});

test("composite node: a single wired image is a clear error", async () => {
  const graph = {
    nodes: [
      { id: "a", type: "upload", fields: { image: RED } },
      { id: "c", type: "composite", fields: {} },
    ],
    links: [{ id: "l1", from: { node: "a", port: "image" }, to: { node: "c", port: "image" } }],
  };
  await assert.rejects(
    () => Workflow.fromJSON(graph, { apiKey: "fixture" }).run({}),
    /at least two/);
});
