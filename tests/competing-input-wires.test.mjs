import assert from "node:assert/strict";
import test from "node:test";
import { Workflow } from "../src/index.mjs";
import { PNG_DATA_URL } from "./harness/mock-server.mjs";

const wire = (id, from, output, to, input) => ({
  id, from: { node: from, port: output }, to: { node: to, port: input },
});
const text = (id, value = id) => ({ id, type: "text", fields: { text: value } });
const request = { id: "request", type: "llm", fields: { model: "fixture-chat", prompt: "stored fallback" } };
const decision = answer => Response.json({
  answers: { answer: { type: "noul", noul: answer } },
  usage: { cost: 0.001 },
});
const chat = () => Response.json({ choices: [{ message: { content: "done" } }], cost: 0.001 });
const workflow = (nodes, links, fetch) => Workflow.fromJSON({ nodes, links }, {
  apiKey: "offline-fixture", quiet: true, fetch,
});
const noRequest = () => assert.fail("unexpected provider request");

test("competing static sources are preserved for inspection and rejected in either wire order", async () => {
  const nodes = [text("source", "first input"), text("other", "second input"), request];
  const first = wire("left", "source", "text", "request", "prompt");
  const second = wire("right", "other", "text", "request", "prompt");
  const warning = "input request.prompt has competing wires from other.text, source.text. Leave one active wire for this input.";
  for (const links of [[first, second], [second, first]]) {
    const wf = workflow(nodes, links, noRequest);
    assert.deepEqual(wf.graph.links, links);
    assert.deepEqual(wf.warnings, [warning]);
    const progress = [];
    await assert.rejects(wf.run({}, { onProgress: event => progress.push(event) }), {
      code: "competing-input-wires", message: warning,
    });
    assert.deepEqual(progress, []);
  }

  const calls = [];
  const repeated = workflow(nodes, [first, { ...first, id: "repeat" }], async (_, options) => {
    calls.push(JSON.parse(options.body).messages.at(-1).content);
    return chat();
  });
  assert.deepEqual(repeated.warnings, []);
  await repeated.run();
  assert.deepEqual(calls, ["first input"]);
});

test("the legacy Speech text handle and prompt share a destination after migration", async () => {
  const wf = workflow([
    text("source"), text("other"), { id: "speech", type: "audio", fields: { model: "tts-fixture" } },
  ], [
    wire("legacy", "source", "text", "speech", "text"),
    wire("prompt", "other", "text", "speech", "prompt"),
  ], noRequest);
  assert.deepEqual(wf.graph.links.map(link => link.to.port), ["prompt", "prompt"]);
  assert.match(wf.warnings[0], /input speech\.prompt has competing wires from other\.text, source\.text/);
  await assert.rejects(wf.run(), { code: "competing-input-wires" });
});

test("literal dynamic slots still supply distinct values even when one has a legacy spelling", async () => {
  const nodes = [
    { id: "a", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "b", type: "upload", fields: { image: PNG_DATA_URL } },
    request,
  ];
  const wf = workflow(nodes, [
    wire("bare", "a", "image", "request", "img"),
    wire("numbered", "b", "image", "request", "img1"),
  ], async (_, options) => {
    const parts = JSON.parse(options.body).messages.at(-1).content;
    assert.deepEqual(parts.map(part => part.type), ["text", "image_url", "image_url"]);
    return chat();
  });
  assert.deepEqual(wf.warnings, []);
  assert.equal((await wf.run()).get("LLM"), "done");
});

test("mutually exclusive branch paths can converge on the same input", async () => {
  const router = { id: "router", type: "decide-branch", fields: { model: "decider", question: "Yes or no?" } };
  const nodes = [router, text("yesPath"), text("noPath"), request];
  let answer, sent;
  const wf = workflow(nodes, [
    wire("yes", "router", "yes", "yesPath", "text"),
    wire("no", "router", "no", "noPath", "text"),
    wire("yes-value", "yesPath", "text", "request", "prompt"),
    wire("no-value", "noPath", "text", "request", "prompt"),
  ], async (url, options) => {
    if (new URL(url).pathname === "/api/v1/decisions") return decision(answer);
    sent.push(JSON.parse(options.body).messages.at(-1).content);
    return chat();
  });
  assert.deepEqual(wf.warnings, []);
  for (const [pick, value] of [[1, "yes"], [0, "no"]]) {
    answer = pick;
    sent = [];
    assert.equal((await wf.run()).get("LLM"), "done");
    assert.deepEqual(sent, [value]);
  }
});

test("conditional convergence rejects two active values before the consuming request", async () => {
  const router = { id: "router", type: "decide-branch", fields: { model: "decider", question: "Yes or no?" } };
  const nodes = [router, text("always"), text("yesPath"), request];
  let answer = 0;
  const submitted = [];
  const wf = workflow(nodes, [
    wire("yes-path", "router", "yes", "yesPath", "text"),
    wire("route-yes", "router", "yes", "request", "system"),
    wire("route-no", "router", "no", "request", "system"),
    wire("always-prompt", "always", "text", "request", "prompt"),
    wire("yes-prompt", "yesPath", "text", "request", "prompt"),
  ], async (url, options) => {
    if (new URL(url).pathname === "/api/v1/decisions") return decision(answer);
    submitted.push(JSON.parse(options.body).messages.at(-1).content);
    return chat();
  });
  assert.deepEqual(wf.warnings, []);
  await wf.run();
  assert.deepEqual(submitted, ["always"]);
  answer = 1;
  await assert.rejects(wf.run(), error => {
    assert.equal(error.result.nodes.request.status, "error");
    assert.equal(error.result.errors[0].code, "competing-input-wires");
    assert.match(error.message, /input request\.prompt has competing wires from always\.text, yesPath\.text/);
    return true;
  });
  assert.deepEqual(submitted, ["always"]);
});

test("a closed legacy Decide gate still skips a consumer with potential competing wires", async () => {
  const router = {
    id: "router", type: "decide", fields: { model: "decider", mode: "yesno", gate: true, question: "Yes or no?" },
  };
  let answer = 0;
  const wf = workflow([router, text("always"), request], [
    wire("gated", "router", "text", "request", "prompt"),
    wire("always", "always", "text", "request", "prompt"),
  ], async url => {
    assert.equal(new URL(url).pathname, "/api/v1/decisions");
    return decision(answer);
  });
  assert.deepEqual(wf.warnings, []);
  assert.equal((await wf.run()).nodes.request.gatedBy, "router");
  answer = 1;
  await assert.rejects(wf.run(), /input request\.prompt has competing wires from always\.text, router\.text/);
});

test("a failed source configured to skip does not compete with a successful source", async () => {
  const skippable = {
    id: "skippable", type: "llm", fields: { model: "fixture-chat", prompt: "try this", onError: "skip" },
  };
  const join = { id: "join", type: "join", fields: {} };
  let skip = true;
  const wf = workflow([skippable, text("other"), join], [
    wire("local", "other", "text", "join", "a"),
    wire("skippable", "skippable", "text", "join", "a"),
  ], async () => skip ? new Response("failed", { status: 400 }) : chat());
  assert.deepEqual(wf.warnings, []);
  const result = await wf.run();
  assert.equal(result.nodes.skippable.status, "skipped");
  assert.equal(result.get("Join"), "other");
  skip = false;
  await assert.rejects(wf.run(), /input join\.a has competing wires from other\.text, skippable\.text/);
});

test("an output omitted by the selected Endpoint mode does not shadow an active value", async () => {
  const endpoint = {
    id: "source", type: "endpoint", fields: { url: "https://offline.invalid/process", mode: "image", prompt: "A square" },
  };
  const join = { id: "join", type: "join", fields: {} };
  const wf = workflow([endpoint, text("other"), join], [
    wire("local", "other", "text", "join", "a"),
    wire("conditional-output", "source", "text", "join", "a"),
  ], async url => {
    assert.equal(new URL(url).hostname, "offline.invalid");
    return Response.json({ data: [{ url: "https://cdn.example/square.png" }] });
  });
  assert.deepEqual(wf.warnings, []);
  assert.equal((await wf.run()).get("Join"), "other");
});
