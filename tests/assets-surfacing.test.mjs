import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, NanoClient } from "../src/index.mjs";
import { parseStatusAssets, assetOutputs } from "../src/client.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

// Edge Styles S1 — labeled-assets surfacing. Completed jobs return companion
// assets next to the primary output (MoGe-3: depth / normals / mask / point
// cloud beside the GLB; LTX AlphaGen: alpha matte + ProRes cutout beside the
// video). Executors used to keep only the primary URL and drop the rest.
// Fixtures below are trimmed copies of REAL 2026-11-21 NanoGPT payloads
// (Edge Styles Lab probes: moge3, alphagen, convert).

const MOGE = {
  json: {
    data: {
      status: "COMPLETED",
      output: {
        kind: "3d",
        format: "glb",
        model_url: "https://v3b.fal.media/files/b/0ab36d09/GLB_mesh.glb",
        model3d_assets: [
          { label: "Textured GLB", filename: "mesh.glb", url: "https://v3b.fal.media/files/b/0ab36d09/GLB_mesh.glb", contentType: "model/gltf-binary" },
          { label: "Colored point cloud PLY", filename: "pointcloud.ply", url: "https://v3b.fal.media/files/b/0ab36d09/PC_pointcloud.ply", contentType: "application/octet-stream" },
          { label: "Colorized depth map PNG", filename: "depth.png", url: "https://v3b.fal.media/files/b/0ab36d09/DEPTH.png", contentType: "image/png" },
          { label: "Surface normals PNG", filename: "normals.png", url: "https://v3b.fal.media/files/b/0ab36d09/NORMALS.png", contentType: "image/png" },
          { label: "Validity mask PNG", filename: "mask.png", url: "https://v3b.fal.media/files/b/0ab36d09/MASK.png", contentType: "image/png" },
        ],
      },
    },
  },
};

const ALPHAGEN = {
  json: {
    data: {
      status: "COMPLETED",
      output: {
        video: { url: "https://nano-gpt.com/v1/media/content?rid=abc" },
        processing_assets: [
          { label: "Alpha matte MP4", filename: "matte.mp4", url: "https://v3b.fal.media/files/b/0ab36d6e/MATTE_matte.mp4", contentType: "video/mp4" },
          { label: "Straight-alpha ProRes 4444 MOV", filename: "cutout.mov", url: "https://v3b.fal.media/files/b/0ab36d6e/CUT_cutout.mov", contentType: "video/quicktime" },
        ],
      },
    },
  },
};

const CONVERT = {
  json: {
    data: {
      status: "COMPLETED",
      output: {
        kind: "3d",
        format: "fbx",
        model_url: "https://cdn.example/converted.fbx",
        model3d_assets: [
          { label: "FBX", filename: "converted.fbx", url: "https://cdn.example/converted.fbx", contentType: "application/octet-stream" },
        ],
      },
    },
  },
};

const PLAIN_3D = {
  json: { data: { status: "COMPLETED", output: { kind: "3d", format: "glb", model_url: "https://cdn.example/plain.glb" } } },
};

const CATALOG = {
  model3d: [
    { id: "microsoft/moge-3", architecture: { modality: "image->3d", input_modalities: ["image"] } },
    { id: "tripo3d/convert", architecture: { modality: "3d->3d", input_modalities: ["3d"] } },
  ],
};

test("parseStatusAssets: normalizes labels, urls and kinds; empty when absent", () => {
  const assets = parseStatusAssets(MOGE.json);
  assert.equal(assets.length, 5);
  assert.deepEqual(assets.map((a) => a.kind), ["model3d", "model3d", "image", "image", "image"]);
  assert.equal(assets[1].label, "Colored point cloud PLY");
  assert.deepEqual(parseStatusAssets(PLAIN_3D.json), []);
  assert.deepEqual(parseStatusAssets({}), []);
});

test("assetOutputs: MoGe roles land; the primary never duplicates as model2", () => {
  const primary = "https://v3b.fal.media/files/b/0ab36d09/GLB_mesh.glb";
  const out = assetOutputs(parseStatusAssets(MOGE.json), primary, "model3d");
  assert.equal(out.depth, "https://v3b.fal.media/files/b/0ab36d09/DEPTH.png");
  assert.equal(out.normals, "https://v3b.fal.media/files/b/0ab36d09/NORMALS.png");
  assert.equal(out.mask, "https://v3b.fal.media/files/b/0ab36d09/MASK.png");
  assert.equal(out.points, "https://v3b.fal.media/files/b/0ab36d09/PC_pointcloud.ply");
  assert.ok(!("model2" in out));
  assert.equal(JSON.parse(out.assets).length, 5);
});

test("assetOutputs: AlphaGen matte + cutout; matte wins the 'alpha matte' label", () => {
  const out = assetOutputs(parseStatusAssets(ALPHAGEN.json), "https://nano-gpt.com/v1/media/content?rid=abc", "video");
  assert.equal(out.matte, "https://v3b.fal.media/files/b/0ab36d6e/MATTE_matte.mp4");
  assert.equal(out.cutout, "https://v3b.fal.media/files/b/0ab36d6e/CUT_cutout.mov");
  assert.equal(JSON.parse(out.assets).length, 2);
  assert.deepEqual(assetOutputs([], "x", "video"), {});
});

test("model3d node: a MoGe payload surfaces depth/normals/mask/points + assets", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "moge1", cost: 0.03 } });
  srv.script("GET /api/video/status", MOGE);
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "up", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "m", type: "model3d", fields: { model: "microsoft/moge-3" } },
    ],
    links: [{ id: "l1", from: { node: "up", port: "image" }, to: { node: "m", port: "image" } }],
  }, mockOpts(srv, { catalog: CATALOG }));
  const res = await wf.run({});
  const out = res.nodes.m.out;
  assert.equal(out.model, "https://v3b.fal.media/files/b/0ab36d09/GLB_mesh.glb");
  assert.equal(out.depth, "https://v3b.fal.media/files/b/0ab36d09/DEPTH.png");
  assert.equal(out.normals, "https://v3b.fal.media/files/b/0ab36d09/NORMALS.png");
  assert.equal(out.mask, "https://v3b.fal.media/files/b/0ab36d09/MASK.png");
  assert.equal(out.points, "https://v3b.fal.media/files/b/0ab36d09/PC_pointcloud.ply");
  assert.equal(JSON.parse(out.assets).length, 5);
});

test("vedit node: an AlphaGen payload surfaces matte + cutout + assets", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "ag1", cost: 0.52 } });
  srv.script("GET /api/video/status", ALPHAGEN);
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "v", type: "vupload", fields: { video: "https://cdn.example/in.mp4" } },
      { id: "e", type: "vedit", fields: { model: "lightricks/ltx-2.5/alpha-gen", prompt: "extract alpha" } },
    ],
    links: [{ id: "l1", from: { node: "v", port: "video" }, to: { node: "e", port: "video" } }],
  }, mockOpts(srv));
  const res = await wf.run({});
  const out = res.nodes.e.out;
  assert.equal(out.video, "https://nano-gpt.com/v1/media/content?rid=abc");
  assert.equal(out.matte, "https://v3b.fal.media/files/b/0ab36d6e/MATTE_matte.mp4");
  assert.equal(out.cutout, "https://v3b.fal.media/files/b/0ab36d6e/CUT_cutout.mov");
});

test("model3d node: a single-asset payload (convert) adds assets JSON but no role ports", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "cv1", cost: 0.06 } });
  srv.script("GET /api/video/status", CONVERT);
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "u", type: "mupload", fields: { model: "https://cdn.example/in.glb" } },
      { id: "m", type: "model3d", fields: { model: "tripo3d/convert" } },
    ],
    links: [{ id: "l1", from: { node: "u", port: "model" }, to: { node: "m", port: "model" } }],
  }, mockOpts(srv, { catalog: CATALOG }));
  const res = await wf.run({});
  const out = res.nodes.m.out;
  assert.equal(out.model, "https://cdn.example/converted.fbx");
  assert.equal(JSON.parse(out.assets).length, 1);
  for (const p of ["depth", "normals", "mask", "points", "model2"]) assert.ok(!(p in out), p);
});

test("model3d node: a payload with no assets array gains no new ports", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "pl1", cost: 0.1 } });
  srv.script("GET /api/video/status", PLAIN_3D);
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "up", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "m", type: "model3d", fields: { model: "microsoft/moge-3" } },
    ],
    links: [{ id: "l1", from: { node: "up", port: "image" }, to: { node: "m", port: "image" } }],
  }, mockOpts(srv, { catalog: CATALOG }));
  const res = await wf.run({});
  assert.deepEqual(Object.keys(res.nodes.m.out), ["model"]);
});

test("client video(): the string contract is unchanged unless wantAssets is set", async () => {
  const fetch = async (url) => {
    if (String(url).includes("generate-video")) return new Response(JSON.stringify({ runId: "x1" }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(MOGE.json), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new NanoClient({ apiKey: "fixture", fetch, pollIntervals: { video: 1, model3d: 1 } });
  const plain = await client.video("microsoft/moge-3", "", { mediaKind: "model3d" }, "https://cdn.example/in.png");
  assert.equal(plain, "https://v3b.fal.media/files/b/0ab36d09/GLB_mesh.glb");
  const rich = await client.video("microsoft/moge-3", "", { mediaKind: "model3d", wantAssets: true }, "https://cdn.example/in.png");
  assert.equal(rich.url, plain);
  assert.equal(rich.assets.length, 5);
});
