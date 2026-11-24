import test from "node:test";
import assert from "node:assert/strict";
import { MediaRef, Workflow } from "../src/index.mjs";
import { RUNNERS } from "../src/nodes.mjs";

const model = "data:model/gltf-binary;base64,Z2xURg==";
const media = {
  image: { mime: "image/png", url: "data:image/png;base64,iVBORw0KGgo=" },
  video: { mime: "video/mp4", url: "data:video/mp4;base64,AAAAFGZ0eXBpc29t" },
};

function renderWorkflow(t, mode, withChoice = false) {
  // Substitute only the local renderer. Run the real scheduler, input wiring,
  // publication and output lookup without launching Chromium or ffmpeg.
  t.mock.method(RUNNERS, "render3d", async (node, input) => {
    assert.equal(input.model, model);
    const selected = node.fields.mode;
    return { [selected]: media[selected].url };
  });
  const nodes = [
    { id: "model", type: "mupload", fields: { model } },
    { id: "render", type: "render3d", name: "Rendered model", fields: { mode } },
  ];
  const links = [{ from: { node: "model", port: "model" }, to: { node: "render", port: "model" } }];
  if (withChoice) {
    nodes.push({ id: "mode", name: "Render format", type: "choice", fields: { options: "image\nvideo" } });
    links.push({ from: { node: "mode", port: "text" }, to: { node: "render", port: "mode" } });
  }
  return Workflow.fromJSON({ nodes, links });
}

function assertRender(result, port) {
  assert.deepEqual(result.nodes.render.out, { [port]: media[port].url });
  const value = result.get("Rendered model");
  assert(value instanceof MediaRef);
  assert.equal(value.url, media[port].url);
  assert.equal(value.mime, media[port].mime);
  assert.equal(result.get("render"), value);
}

test("Render 3D publishes the port selected by run settings", async t => {
  const workflow = renderWorkflow(t, "image");
  assert.equal(workflow.outputs[0].ports[0].name, "image");
  assertRender(await workflow.run({}, { settings: { "render.mode": "video" } }), "video");
  assert.equal(workflow.outputs[0].ports[0].name, "image");
  assertRender(await workflow.run(), "image");
});

test("Render 3D publishes the port selected by a Choice wire", async t => {
  const workflow = renderWorkflow(t, "video", true);
  assert.equal(workflow.outputs[0].ports[0].name, "video");
  assertRender(await workflow.run({ "Render format": "image" }), "image");
  assertRender(await workflow.run({ "Render format": "video" }), "video");
  assert.equal(workflow.outputs[0].ports[0].name, "video");
});
