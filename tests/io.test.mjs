import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, chatJson, PNG_B64 } from "./harness/mock-server.mjs";

const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));
const noNet = { apiKey: "unused", quiet: true };

test("input key resolution: custom name, nodeId.field, bare nodeId, label — case-insensitive", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.01 } });

  const wf = await Workflow.load(fixture("starter-graph.json"), mockOpts(srv));
  // all five spellings hit n1.text (keys are trimmed + case-insensitive)
  for (const [i, key] of ["Text", "text", "n1.text", "N1", "  text  "].entries()) {
    srv.requests.length = 0;
    await wf.run({ [key]: "marker-" + i });
    assert.equal(srv.requests[0].json.messages[1].content, "marker-" + i, key);
  }
});

test("custom node name resolves its single required input (PR #138 naming)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("arr matey"));

  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", name: "Story idea", fields: { model: "m1" } }],
    links: [],
  }, mockOpts(srv));
  assert.equal(wf.inputs.find((i) => i.field === "prompt").key, "Story idea");
  await wf.run({ "story idea": "a dragon library" });
  assert.equal(srv.requests[0].json.messages[1].content, "a dragon library");
});

test("unknown input key errors listing available inputs; ambiguous label errors listing candidates", async () => {
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "llm", name: "A", fields: { model: "m" } },
      { id: "n2", type: "llm", name: "B", fields: { model: "m" } },
    ],
    links: [],
  }, noNet);
  await assert.rejects(wf.run({ bogus: "x" }), (e) => {
    assert.equal(e.name, "NanoodleError");
    assert.match(e.message, /unknown input "bogus"/);
    assert.match(e.message, /"A"/);
    assert.match(e.message, /"B"/);
    return true;
  });
  // "Prompt" label matches both llm prompts → ambiguous
  await assert.rejects(wf.run({ prompt: "x" }), /ambiguous.*n1\.prompt.*n2\.prompt/s);
  // a bare scalar with two required inputs is refused too
  await assert.rejects(wf.run("x"), /exactly one required input/);
});

test("wired field can't be supplied as an input (clear error)", async () => {
  const wf = await Workflow.load(fixture("starter-graph.json"), noNet);
  await assert.rejects(wf.run({ "n2.prompt": "x" }), /wired from another node/);
});

test("missing required input with no default errors upfront, before any node runs", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "image", fields: { model: "flux", prompt: "" } }],
    links: [],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), /missing required input "Image prompt" \(n1\.prompt\)/);
  assert.equal(srv.requests.length, 0);
});

test("no API key + network nodes → upfront error; local-only graph runs keyless", async () => {
  const net = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }],
    links: [],
  }, { apiKey: undefined, quiet: true });
  net.client.apiKey = undefined; // defeat any ambient NANOGPT_API_KEY
  await assert.rejects(net.run({}), /no API key/);

  const local = await Workflow.load(fixture("join-choice.json"), { apiKey: undefined, quiet: true });
  local.client.apiKey = undefined;
  const result = await local.run({});
  assert.equal(result.get("Combined"), "blue\na bike"); // literal \n separator → newline
});

test("choice input: valid value flows, invalid errors listing options", async () => {
  const wf = await Workflow.load(fixture("join-choice.json"), noNet);
  const choice = wf.inputs.find((i) => i.kind === "choice");
  assert.deepEqual(choice.options, ["red", "blue", "green"]);
  const result = await wf.run({ Choice: "green" });
  assert.equal(result.get("Combined"), "green\na bike");
  await assert.rejects(wf.run({ Choice: "purple" }), /not one of the choices \(red, blue, green\)/);
});

test("settings override applies; wired setting refused; unknown setting lists keys", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.01 } });

  const wf = await Workflow.load(fixture("starter-graph.json"), mockOpts(srv));
  await wf.run({}, { settings: { "n3.model": "flux-pro", "n3.size": "2048x2048", "n2.maxTokens": 99 } });
  const imgReq = srv.of("POST /v1/images/generations")[0];
  assert.equal(imgReq.json.model, "flux-pro");
  assert.equal(imgReq.json.size, "2048x2048");
  assert.equal(srv.of("POST /api/v1/chat/completions")[0].json.max_tokens, 99);

  await assert.rejects(wf.run({}, { settings: { "n3.prompt": "sneaky" } }), /wired from another node and can't be overridden/);
  await assert.rejects(wf.run({}, { settings: { nope: 1 } }), /unknown setting "nope".*n3\.model/s);
});

test("duplicate sink display names get ' 2' suffixes; node-id keys always work", async () => {
  const wf = await Workflow.load(fixture("duplicate-names.json"), noNet);
  assert.deepEqual(wf.outputs.map((o) => o.key), ["Out", "Out 2", "Text"]);
  const result = await wf.run({ "n1.text": "uno", "n2.text": "dos", "n3.text": "tres" });
  assert.equal(result.get("Out"), "uno");
  assert.equal(result.get("Out 2"), "dos");
  assert.equal(result.get("Text"), "tres");
  assert.equal(result.get("n2"), "dos");
});

test("duplicate input keys get ' 2' suffixes and stay addressable", async () => {
  // n1/n2 are custom-named "Out" (single required input → the name IS the key); n3 keeps the label
  const wf = await Workflow.load(fixture("duplicate-names.json"), noNet);
  assert.deepEqual(wf.inputs.map((i) => i.key), ["Out", "Out 2", "Text"]);
  const result = await wf.run({ Out: "a", "Out 2": "b", Text: "c" });
  assert.equal(result.get("n2"), "b");
  assert.equal(result.get("n3"), "c");
});

test("field override: wire into llm 'system' beats the typed field", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("arr"));

  const wf = await Workflow.load(fixture("field-override.json"), mockOpts(srv));
  // wired system disappears from the inputs list
  assert.deepEqual(wf.inputs.map((i) => `${i.nodeId}.${i.field}`), ["n1.text", "n2.prompt"]);
  await wf.run({ Answer: "how are you?" }); // custom name → single required input
  assert.deepEqual(srv.requests[0].json.messages[0], {
    role: "system",
    content: "You are a pirate. Answer in pirate speak.",
  });
  assert.equal(srv.requests[0].json.messages[1].content, "how are you?");
});

test("optional inputs: system override via its own key", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.01 } });

  const wf = await Workflow.load(fixture("starter-graph.json"), mockOpts(srv));
  await wf.run({ Text: "x", "System prompt": "Be terse." });
  assert.equal(srv.requests[0].json.messages[0].content, "Be terse.");
});

test("size and duration settings ship the app's option lists (play.html SIZES/DURATIONS)", () => {
  // cross-language parity: PY used to invent size values ("512x512", "1k"...) and
  // JS omitted the lists entirely — both now match the app verbatim, incl. "auto"
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "image", fields: { model: "m", prompt: "p" } },
      { id: "n2", type: "edit", fields: { model: "m" } },
      { id: "n3", type: "inpaint", fields: { model: "m" } },
      { id: "n4", type: "tvideo", fields: { model: "m", prompt: "p" } },
      { id: "n5", type: "ivideo", fields: { model: "m" } },
    ],
  }, noNet);
  const SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
  for (const nid of ["n1", "n2", "n3"]) {
    const size = wf.settings.find((s) => s.nodeId === nid && s.field === "size");
    assert.deepEqual(size.options, SIZES, nid + ".size");
  }
  for (const nid of ["n4", "n5"]) {
    const duration = wf.settings.find((s) => s.nodeId === nid && s.field === "duration");
    assert.deepEqual(duration.options, ["5", "10"], nid + ".duration");
  }
});

test("author-marked optional input (fields.optional): derived, skippable, keeps custom-name key", async () => {
  // join is local-only, so the whole graph runs without a network mock
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: {} },
      { id: "n2", type: "text", name: "Extra notes", fields: { optional: true } },
      { id: "n3", type: "join", fields: { sep: "+" } },
    ],
    links: [
      { from: { node: "n1", port: "text" }, to: { node: "n3", port: "text1" } },
      { from: { node: "n2", port: "text" }, to: { node: "n3", port: "text2" } },
    ],
  }, noNet);
  const extra = wf.inputs.find((i) => i.nodeId === "n2");
  assert.equal(extra.optional, true);
  assert.equal(extra.key, "Extra notes");        // single optional input still takes the node's name
  assert.equal(wf.inputs.find((i) => i.nodeId === "n1").optional, false);
  const result = await wf.run({ Text: "hi" });   // optional input omitted → runs, empty value
  assert.equal(result.nodes.n2.out.text, "");
  assert.equal(result.nodes.n2.status, "done");
});

test("optional upload: omitted media yields empty output instead of failing; required still errors", async () => {
  const graph = (optional) => ({
    nodes: [{ id: "u1", type: "upload", name: "Style reference", fields: optional ? { optional: true } : {} }],
    links: [],
  });
  const wf = Workflow.fromJSON(graph(true), noNet);
  assert.equal(wf.inputs[0].optional, true);
  assert.equal(wf.inputs[0].key, "Style reference");
  const result = await wf.run({});
  assert.equal(result.nodes.u1.status, "done");
  assert.equal(result.nodes.u1.out.image, "");
  const req = Workflow.fromJSON(graph(false), noNet);
  await assert.rejects(req.run({}), /missing required input "Style reference"/);
});

test("fields.optional tolerates the string form a checkbox round-trip might save", () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "text", fields: { optional: "true" } }],
    links: [],
  }, noNet);
  assert.equal(wf.inputs[0].optional, true);
});
