/**
 * Mesh-processing 3D models (Hyper3D Rigging): the model3d node takes an
 * existing model on its `model` wire (from mupload or another model3d node)
 * and sends it as the `model_url` parameter. Generation models ignore the
 * wire. The catalog entry's input_modalities decide: "3d" means mesh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

const RIG = {
  id: "hyper3d/rigging",
  architecture: { modality: "3d+image->3d", input_modalities: ["3d", "image"] },
};
const GEN = {
  id: "tripo3d/v2.5",
  architecture: { modality: "image->3d", input_modalities: ["image"] },
};
const CATALOG = { model3d: [RIG, GEN] };
const DONE_3D = {
  json: {
    data: {
      status: "COMPLETED",
      output: { kind: "3d", format: "glb", model_url: "https://cdn.example/rigged.glb" },
    },
  },
};

const one = (srv, nodes, links, extra) =>
  Workflow.fromJSON({ nodes, links: links || [] }, mockOpts(srv, extra));

test("rigging: mupload mesh wire is sent as model_url; rig params ride modelOpts", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "rig1", cost: 0.2 } });
  srv.script("GET /api/video/status", DONE_3D);

  const nodes = [
    { id: "u", type: "mupload", fields: { model: "https://cdn.example/hero.glb" } },
    {
      id: "r", type: "model3d",
      fields: { model: "hyper3d/rigging", modelOpts: { bone_template: "human", geometry_file_format: "glb" } },
    },
  ];
  const links = [{ id: "l1", from: { node: "u", port: "model" }, to: { node: "r", port: "model" } }];
  const res = await one(srv, nodes, links, { catalog: CATALOG }).run({});
  const body = srv.of("POST /api/generate-video")[0].json;
  assert.equal(body.model, "hyper3d/rigging");
  assert.equal(body.model_url, "https://cdn.example/hero.glb");
  assert.equal(body.bone_template, "human");
  assert.equal(body.geometry_file_format, "glb");
  assert.equal(body.prompt, undefined, "mesh models omit the prompt");
  assert.equal(res.outputs.r.url, "https://cdn.example/rigged.glb");
});

test("rigging: a model3d -> model3d chain rigs the generated mesh", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  // one script() call per route with an array — a second call replaces the queue
  srv.script("POST /api/generate-video", [
    { json: { runId: "gen1", cost: 0.3 } },
    { json: { runId: "rig1", cost: 0.2 } },
  ]);
  srv.script("GET /api/video/status", [
    { json: { data: { status: "COMPLETED", output: { kind: "3d", format: "glb", model_url: "https://cdn.example/statue.glb" } } } },
    DONE_3D,
  ]);

  const nodes = [
    { id: "p", type: "text", fields: { text: "a knight" } },
    { id: "g", type: "model3d", fields: { model: "tripo3d/v2.5" } },
    { id: "u", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "r", type: "model3d", fields: { model: "hyper3d/rigging" } },
  ];
  const links = [
    { id: "l1", from: { node: "u", port: "image" }, to: { node: "g", port: "image" } },
    { id: "l2", from: { node: "g", port: "model" }, to: { node: "r", port: "model" } },
  ];
  const res = await one(srv, nodes, links, { catalog: CATALOG }).run({});
  const rigBody = srv.of("POST /api/generate-video")[1].json;
  assert.equal(rigBody.model_url, "https://cdn.example/statue.glb");
  assert.equal(res.outputs.r.url, "https://cdn.example/rigged.glb");
});

test("rigging: no mesh wired fails before any request", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const nodes = [{ id: "r", type: "model3d", fields: { model: "hyper3d/rigging" } }];
  await assert.rejects(one(srv, nodes, [], { catalog: CATALOG }).run({}), /Connect a model first/);
  assert.equal(srv.requests.length, 0);
});

test("generation model: a model wire is ignored, never sent as model_url", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "gen1", cost: 0.3 } });
  srv.script("GET /api/video/status", DONE_3D);
  const nodes = [
    { id: "u", type: "mupload", fields: { model: "https://cdn.example/hero.glb" } },
    { id: "p", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "g", type: "model3d", fields: { model: "tripo3d/v2.5" } },
  ];
  const links = [
    { id: "l1", from: { node: "u", port: "model" }, to: { node: "g", port: "model" } },
    { id: "l2", from: { node: "p", port: "image" }, to: { node: "g", port: "image" } },
  ];
  await one(srv, nodes, links, { catalog: CATALOG }).run({});
  const body = srv.of("POST /api/generate-video")[0].json;
  assert.equal(body.model_url, undefined);
  assert.ok(body.imageDataUrl, "image still sent for the generation model");
});
