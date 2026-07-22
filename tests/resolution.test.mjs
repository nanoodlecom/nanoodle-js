import test from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, chatJson, PNG_B64, PNG_DATA_URL } from "./harness/mock-server.mjs";

const noNet = { apiKey: "unused", quiet: true };

test("Workflow.fromJSON accepts a raw JSON string (the downloaded save's exact bytes)", () => {
  const wf = Workflow.fromJSON(JSON.stringify({
    v: 1,
    nodes: [{ id: "n1", type: "text", x: 0, y: 0, fields: { text: "hi" } }],
    links: [], nid: 2, lid: 1, view: { panX: 0, panY: 0, scale: 1 },
  }), noNet);
  assert.equal(wf.inputs[0].key, "Text");
});

test("inpaint input derivation: nothing wired → prompt + image + mask (the app's brush widget captures both)", () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "inpaint", fields: { model: "flux-fill" } }],
    links: [],
  }, noNet);
  assert.deepEqual(wf.inputs.map((i) => [i.field, i.label]), [
    ["prompt", "What to paint in"],
    ["image", "Image — the picture to repaint"],
    ["mask", "Mask (white = repaint)"],
  ]);
});

test("inpaint input derivation: image wired → a mask upload surfaces instead", () => {
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "inpaint", fields: { model: "flux-fill" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, noNet);
  assert.deepEqual(wf.inputs.filter((i) => i.nodeId === "n2").map((i) => [i.field, i.label]), [
    ["prompt", "What to paint in"],
    ["mask", "Mask (white = repaint)"],
  ]);
});

test("inpaint input derivation: image AND mask wired → only the prompt remains", () => {
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n3", type: "inpaint", fields: { model: "flux-fill" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "image" }, to: { node: "n3", port: "image" } },
      { id: "l2", from: { node: "n2", port: "image" }, to: { node: "n3", port: "mask" } },
    ],
  }, noNet);
  assert.deepEqual(wf.inputs.filter((i) => i.nodeId === "n3").map((i) => i.field), ["prompt"]);
});

test("custom name on a node with SEVERAL required inputs is ambiguous, listing candidates", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "inpaint", name: "Fix it", fields: { model: "flux-fill" } }],
    links: [],
  }, noNet);
  // two required inputs → the name labels neither, but still addresses the node…
  await assert.rejects(wf.run({ "Fix it": "a hat" }), /ambiguous.*n1\.prompt.*n1\.image/s);
});

test("bare nodeId with several inputs on the node is ambiguous too", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m" } }],
    links: [],
  }, noNet);
  await assert.rejects(wf.run({ n1: "x" }), /ambiguous.*n1\.prompt.*n1\.system/s);
});

test("bare FIELD name resolves when unique across inputs (llm 'system')", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("aye"));

  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }],
    links: [],
  }, mockOpts(srv));
  await wf.run({ system: "Be a pirate." });
  assert.equal(srv.requests[0].json.messages[0].content, "Be a pirate.");
});

test("settings resolve via customName.field, Title.field, and bare unique field", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.01 } });

  const graph = {
    nodes: [{ id: "n1", type: "image", name: "Poster", fields: { model: "flux", prompt: "x" } }],
    links: [],
  };
  const wf = Workflow.fromJSON(graph, mockOpts(srv));
  await wf.run({}, { settings: { "Poster.model": "flux-pro", size: "2048x2048" } }); // custom name + bare field
  assert.equal(srv.requests[0].json.model, "flux-pro");
  assert.equal(srv.requests[0].json.size, "2048x2048");

  srv.requests.length = 0;
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.01 } });
  const unnamed = Workflow.fromJSON({ ...graph, nodes: [{ ...graph.nodes[0], name: undefined }] }, mockOpts(srv));
  await unnamed.run({}, { settings: { "Image.model": "sdxl" } }); // type Title works when unnamed
  assert.equal(srv.requests[0].json.model, "sdxl");
});

test("bare setting field shared by two nodes is ambiguous, listing both keys", async () => {
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "image", fields: { model: "a", prompt: "x" } },
      { id: "n2", type: "image", fields: { model: "b", prompt: "y" } },
    ],
    links: [],
  }, noNet);
  await assert.rejects(wf.run({}, { settings: { size: "1k" } }), /ambiguous.*n1\.size.*n2\.size/s);
});

test("settings expose defs (graph value over spec default) and select options", () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "tvideo", fields: { model: "veo", prompt: "x", duration: "10" } }],
    links: [],
  }, noNet);
  const by = (f) => wf.settings.find((s) => s.nodeId === "n1" && s.field === f);
  assert.equal(by("duration").def, "10"); // graph value wins
  assert.equal(by("aspect").def, "16:9"); // spec default
  assert.deepEqual(by("aspect").options, ["16:9", "9:16", "1:1", "4:3", "3:4"]);
  assert.equal(by("model").kind, "model");
});

test("diamond graph: deps run before dependents, sink last", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("branch"));

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "seed" } },
      { id: "n2", type: "llm", name: "Left", fields: { model: "m" } },
      { id: "n3", type: "llm", name: "Right", fields: { model: "m" } },
      { id: "n4", type: "join", fields: {} },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
      { id: "l2", from: { node: "n1", port: "text" }, to: { node: "n3", port: "prompt" } },
      { id: "l3", from: { node: "n2", port: "text" }, to: { node: "n4", port: "a" } },
      { id: "l4", from: { node: "n3", port: "text" }, to: { node: "n4", port: "b" } },
    ],
  }, mockOpts(srv));

  const starts = [];
  const result = await wf.run({}, { onProgress: (e) => { if (e.type === "node-start") starts.push(e.nodeId); } });
  assert.equal(starts[0], "n1");
  assert.equal(starts.at(-1), "n4");
  assert.equal(new Set(starts.slice(1, 3)).size, 2); // both branches ran
  assert.equal(result.get("Join"), "branch branch");
});

test("result.get with an unknown key throws listing the available outputs", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "text", name: "Greeting", fields: { text: "hello" } }],
    links: [],
  }, noNet);
  const result = await wf.run({});
  assert.equal(result.get("greeting"), "hello"); // case-insensitive lookup
  assert.throws(() => result.get("nope"), /no output "nope".*"Greeting"/s);
});
