import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, NanoClient } from "../src/index.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

// Layer-decomposition models (e.g. bytedance/seedream/v5/flash/layerize) return
// one data item per layer, each carrying layer metadata. Edit nodes used to
// keep only the first item and drop the metadata in the client's response map —
// a graph asking for editable layers received the base plate alone. These
// tests pin the fix: every returned image surfaces, metadata survives aligned.

const L0 = { z_index: 0, name: null, description: null, bounding_box: null };
const L1 = { z_index: 1, name: "dark background", description: "The dark backdrop.", bounding_box: { absolute: [0, 0, 720, 1304], normalized: [0, 0, 1000, 906] } };
const L2 = { z_index: 2, name: "marble bust", description: "The bust cutout.", bounding_box: { absolute: [78, 100, 646, 1300], normalized: [108, 69, 897, 903] } };
const LAYER_BODY = {
  data: [
    { url: "https://cdn.example/layer-0.png", layer: L0 },
    { url: "https://cdn.example/layer-1.png", layer: L1 },
    { url: "https://cdn.example/layer-2.png", layer: L2 },
  ],
};

const editGraph = (model) => ({
  nodes: [
    { id: "up", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "ed", type: "edit", name: "Layerize", fields: { model, prompt: "Separate into layers" } },
  ],
  links: [{ id: "l1", from: { node: "up", port: "image" }, to: { node: "ed", port: "image" } }],
});

test("client image(items): urls + aligned layers; without items the shape is unchanged", async () => {
  const fetch = async () => new Response(JSON.stringify(LAYER_BODY), { status: 200, headers: { "content-type": "application/json" } });
  const client = new NanoClient({ apiKey: "fixture", fetch });
  const detailed = await client.image({ prompt: "x", model: "m", multi: true, items: true });
  assert.deepEqual(detailed.urls, ["https://cdn.example/layer-0.png", "https://cdn.example/layer-1.png", "https://cdn.example/layer-2.png"]);
  assert.deepEqual(detailed.layers, [L0, L1, L2]);
  assert.deepEqual(await client.image({ prompt: "x", model: "m", multi: true }), detailed.urls);
  assert.equal(await client.image({ prompt: "x", model: "m" }), detailed.urls[0]);
});

test("edit node: a layerize response surfaces every layer + metadata", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: LAYER_BODY });
  const wf = Workflow.fromJSON(editGraph("bytedance/seedream/v5/flash/layerize"), mockOpts(srv));
  const result = await wf.run({});
  const out = result.nodes.ed.out;
  assert.equal(out.image, "https://cdn.example/layer-0.png"); // the first — the standing contract
  assert.deepEqual(out.images, ["https://cdn.example/layer-0.png", "https://cdn.example/layer-1.png", "https://cdn.example/layer-2.png"]);
  assert.deepEqual(out.layers, [L0, L1, L2]);
});

test("edit node: a variant batch (no layer metadata) surfaces all images, no layers output", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", {
    json: { data: [0, 1, 2, 3].map((i) => ({ url: `https://cdn.example/variant-${i}.png` })) },
  });
  const wf = Workflow.fromJSON(editGraph("midjourney/text-to-image"), mockOpts(srv));
  const result = await wf.run({});
  const out = result.nodes.ed.out;
  assert.equal(out.image, "https://cdn.example/variant-0.png");
  assert.equal(out.images.length, 4);
  assert.ok(!("layers" in out));
});

test("edit node: partial metadata stays index-aligned with nulls", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", {
    json: { data: [{ url: "https://cdn.example/a.png" }, { url: "https://cdn.example/b.png", layer: L2 }] },
  });
  const wf = Workflow.fromJSON(editGraph("bytedance/seedream/v5/flash/layerize"), mockOpts(srv));
  const result = await wf.run({});
  assert.deepEqual(result.nodes.ed.out.layers, [null, L2]);
});
