import test from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

// model3d multi-view (Edge Styles S4): image2… wires are ordered views
// for models whose catalog declares an images/image_urls array (Tripo
// line: `images`, 2–4, "use instead of image_url"; Hyper3D: image_urls).
// The array replaces the single imageDataUrl; below the model's minimum
// or on single-image models the extra wires are ignored with a note.
// Live-verified on tripo3d/v2.5 (run vid_mwr7echc1ac47d48a885): a body
// carrying only `images: [front, side]` completed, and the GLB's
// geometry consumed BOTH views — a red disc (front) × blue slab (side)
// pair reconstructed as a disc-profile × slab-profile solid, rendered
// and inspected locally. Caveat: the texture comes almost entirely
// from the first view; the extra views shape the geometry.

const one = (srv, nodes, links, extra) => Workflow.fromJSON({ nodes, links: links || [] }, mockOpts(srv, extra));
const DONE_3D = { json: { data: { status: "COMPLETED", output: { kind: "3d", format: "glb", model_url: "https://cdn.example/m.glb" } } } };

const tripoCatalog = {
  model3d: [{
    id: "tripo3d/v2.5",
    architecture: { input_modalities: ["image", "text"] },
    supported_parameters: { parameters: { images: { type: "array", minItems: 2, maxItems: 4 } } },
  }],
};
const singleCatalog = {
  model3d: [{
    id: "tripo3d/v2.5",
    architecture: { input_modalities: ["image", "text"] },
    supported_parameters: { parameters: {} },
  }],
};

function graph(viewCount) {
  const nodes = [{ id: "m", type: "model3d", fields: { model: "tripo3d/v2.5", prompt: "" } }];
  const links = [];
  for (let i = 1; i <= viewCount; i++) {
    nodes.push({ id: "u" + i, type: "upload", fields: { image: PNG_DATA_URL } });
    links.push({ id: "l" + i, from: { node: "u" + i, port: "image" }, to: { node: "m", port: i === 1 ? "image" : "image" + i } });
  }
  return { nodes, links };
}

async function runViews(t, viewCount, catalog) {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_x", cost: 0 } });
  srv.script("GET /api/video/status", [DONE_3D]);
  const { nodes, links } = graph(viewCount);
  const notes = [];
  await one(srv, nodes, links, { catalog }).run({}, { onProgress: (e) => { if (e.type === "node-progress") notes.push(e.message); } });
  return { body: srv.of("POST /api/generate-video")[0].json, notes };
}

test("two views ride the declared images array instead of imageDataUrl", async (t) => {
  const { body } = await runViews(t, 2, tripoCatalog);
  assert.deepEqual(body.images, [PNG_DATA_URL, PNG_DATA_URL]);
  assert.equal(body.imageDataUrl, undefined);
});

test("five views clamp to the declared max of 4, with a drop note", async (t) => {
  const { body, notes } = await runViews(t, 5, tripoCatalog);
  assert.equal(body.images.length, 4);
  assert.ok(notes.some((m) => /dropped 1 view image/.test(m)), notes.join(" | "));
});

test("single-image model: extra views ignored with a note, primary rides imageDataUrl", async (t) => {
  const { body, notes } = await runViews(t, 3, singleCatalog);
  assert.equal(body.images, undefined);
  assert.equal(body.imageDataUrl, PNG_DATA_URL);
  assert.ok(notes.some((m) => /extra view image\(s\) ignored/.test(m)), notes.join(" | "));
});

test("one view only: the ordinary single-image path, no array", async (t) => {
  const { body } = await runViews(t, 1, tripoCatalog);
  assert.equal(body.images, undefined);
  assert.equal(body.imageDataUrl, PNG_DATA_URL);
});
