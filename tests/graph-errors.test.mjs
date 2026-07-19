import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Workflow, UnsupportedNodeError, RunError, materialize } from "../src/index.mjs";
import { startMockServer, mockOpts, chatJson, PNG_B64 } from "./harness/mock-server.mjs";

const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));
const noNet = { apiKey: "unused", quiet: true };

test("loader: legacy 'audio' type aliases to tts + inbound 'text' port migrates to 'prompt'", () => {
  const { nodes, links } = materialize({
    nodes: [
      { id: "n1", type: "text", fields: { text: "hi" } },
      { id: "n2", type: "audio", fields: { model: "tts-1" } }, // legacy save
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "text" } }],
  });
  assert.equal(nodes[1].type, "tts");
  assert.equal(links[0].to.port, "prompt");
});

test("loader: unknown node type is kept with a warning; links to missing nodes dropped; minimal {nodes} form accepted", () => {
  const { nodes, links, warnings } = materialize({
    nodes: [
      { id: "n1", type: "hologram", fields: {} },
      { id: "n2", type: "text", fields: { text: "x" } },
    ],
    links: [
      { id: "l1", from: { node: "n2", port: "text" }, to: { node: "nGone", port: "a" } },
      { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n1", port: "in" } },
    ],
  });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].unknown, true);
  assert.equal(links.length, 1); // l1 dropped (missing endpoint)
  assert.match(warnings[0], /unknown node type "hologram"/);
  assert.ok(materialize({ nodes: [] })); // minimal form
  assert.throws(() => materialize({ hello: 1 }), /not a nanoodle graph/);
});

test("unknown node type: load warns, run fails fast with UnsupportedNodeError", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "hologram", fields: {} }],
    links: [],
  }, noNet);
  assert.equal(wf.warnings.length, 1);
  await assert.rejects(wf.run({}), (e) => {
    assert.ok(e instanceof UnsupportedNodeError);
    assert.match(e.message, /unknown node type 'hologram'/);
    return true;
  });
});

test("local-media resize is executable (no longer UnsupportedNodeError); load does not warn", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("never reached"));

  // Real tiny PNG so resize can succeed offline; parallel llm lane is independent.
  const png = "data:image/png;base64," + PNG_B64;
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: png } },
      { id: "n2", type: "resize", name: "Shrink", fields: { mode: "fit", width: "16", height: "16" } },
      { id: "n3", type: "text", fields: { text: "a poem" } },
      { id: "n4", type: "llm", fields: { model: "m", prompt: "write it" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } },
      { id: "l2", from: { node: "n3", port: "text" }, to: { node: "n4", port: "prompt" } },
    ],
  }, mockOpts(srv));
  assert.ok(!wf.warnings.some((w) => /not supported by this library/i.test(w)));
  const result = await wf.run({});
  // resize lane produces an image; llm lane still hits the mock
  assert.ok(result.nodes.n2.status === "done" || result.nodes.n2.status === "error");
  if (result.nodes.n2.status === "done") {
    assert.match(result.nodes.n2.out.image, /^data:image\//);
  }
  // must not have been refused as UnsupportedNodeError — either done or a media/ffmpeg error
  assert.notEqual(result.nodes.n2.error && /browser app; not supported/i.test(result.nodes.n2.error), true);
});

test("cycle: run rejects naming the cyclic nodes", async () => {
  const wf = await Workflow.load(fixture("cycle.json"), noNet);
  await assert.rejects(wf.run({}), /cycle involving:.*n1.*n2/s);
});

test("401 maps to key-rejected error and never echoes the key", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { status: 401, body: "Unauthorized: bad token" });

  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }],
    links: [],
  }, mockOpts(srv, { apiKey: "sk-secret-key-do-not-leak" }));
  await assert.rejects(wf.run({}), (e) => {
    assert.match(e.message, /API key rejected \(HTTP 401\)/);
    assert.ok(!e.message.includes("sk-secret-key-do-not-leak"));
    assert.ok(!JSON.stringify(e.result.errors).includes("sk-secret-key-do-not-leak"));
    return true;
  });
});

test("402 / balance-body maps to out-of-funds error", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { status: 402, body: "payment required" });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }],
    links: [],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), /out of balance/);

  srv.script("POST /api/v1/chat/completions", { status: 400, body: '{"error":"Insufficient balance for this generation"}' });
  await assert.rejects(wf.run({}), /out of balance/);
});

test("500 maps to '<status>: <body first 160 chars>'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { status: 500, body: "boom ".repeat(100) });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }],
    links: [],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), (e) => {
    assert.match(e.result.errors[0].message, /^500: boom /);
    assert.ok(e.result.errors[0].message.length <= 170);
    return true;
  });
});

test("RunError carries partial results: independent lane succeeds, failed lane recorded", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  let call = 0;
  srv.script("POST /api/v1/chat/completions", (req) => {
    call++;
    return req.json.model === "good-model"
      ? { json: { choices: [{ message: { content: "fine" } }], cost: 0.001 } }
      : { status: 500, body: "model exploded" };
  });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "seed" } },
      { id: "n2", type: "llm", name: "Good", fields: { model: "good-model" } },
      { id: "n3", type: "llm", name: "Bad", fields: { model: "bad-model" } },
      { id: "n4", type: "llm", name: "Downstream", fields: { model: "good-model" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
      { id: "l2", from: { node: "n1", port: "text" }, to: { node: "n3", port: "prompt" } },
      { id: "l3", from: { node: "n3", port: "text" }, to: { node: "n4", port: "prompt" } },
    ],
  }, mockOpts(srv));

  await assert.rejects(wf.run({}), (e) => {
    assert.ok(e instanceof RunError);
    const r = e.result;
    assert.equal(r.nodes.n2.status, "done");
    assert.equal(r.get("Good"), "fine");             // partial result survives
    assert.equal(r.nodes.n3.status, "error");
    assert.equal(r.nodes.n4.status, "error");
    assert.match(r.nodes.n4.error, /upstream failed: Bad/);
    assert.match(e.message, /run failed —/);
    assert.equal(r.costUsd, 0.001);
    assert.equal(r.errors.length, 2);
    return true;
  });
  assert.equal(call, 2); // Downstream never submitted
});

test("RunError names the root cause, not just the sink's upstream neighbor", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", (req) =>
    req.json.model === "bad-model"
      ? { status: 500, body: "model exploded" }
      : { json: { choices: [{ message: { content: "fine" } }], cost: 0.001 } });

  // Bad → Mid → Sink: the sink only sees "upstream failed: Mid" — the message must dig deeper
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "seed" } },
      { id: "n2", type: "llm", name: "Bad", fields: { model: "bad-model" } },
      { id: "n3", type: "llm", name: "Mid", fields: { model: "good-model" } },
      { id: "n4", type: "llm", name: "Sink", fields: { model: "good-model" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
      { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "prompt" } },
      { id: "l3", from: { node: "n3", port: "text" }, to: { node: "n4", port: "prompt" } },
    ],
  }, mockOpts(srv));

  await assert.rejects(wf.run({}), (e) => {
    assert.match(e.result.nodes.n4.error, /upstream failed: Mid/);
    assert.match(e.message, /"Sink": upstream failed: Mid/);
    assert.match(e.message, /root cause — "Bad": 500: model exploded/);
    return true;
  });
});

test("comment nodes never run and never surface as IO", async () => {
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "hello" } },
      { id: "n2", type: "comment", fields: { text: "authors note" } },
    ],
    links: [],
  }, noNet);
  assert.deepEqual(wf.inputs.map((i) => i.nodeId), ["n1"]);
  assert.deepEqual(wf.outputs.map((o) => o.nodeId), ["n1"]);
  const result = await wf.run({});
  assert.equal(result.nodes.n2.status, "skipped");
});

test("concurrency: sibling lanes hit the server at the same time", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  let inFlight = 0, maxInFlight = 0;
  srv.script("POST /api/v1/chat/completions", async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 60));
    inFlight--;
    return { json: { choices: [{ message: { content: "ok" } }], cost: 0.001 } };
  });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "seed" } },
      { id: "n2", type: "llm", name: "A", fields: { model: "m" } },
      { id: "n3", type: "llm", name: "B", fields: { model: "m" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } },
      { id: "l2", from: { node: "n1", port: "text" }, to: { node: "n3", port: "prompt" } },
    ],
  }, mockOpts(srv));
  await wf.run({});
  assert.equal(maxInFlight, 2);
});

test("run timeoutMs aborts in-flight work and rejects", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_slow", cost: 0.1 } });
  srv.script("GET /api/video/status", { json: { status: "PENDING" } });

  const wf = await Workflow.load(fixture("video-poll.json"), mockOpts(srv));
  await assert.rejects(wf.run({}, { timeoutMs: 80 }), (e) => {
    assert.ok(e instanceof RunError);
    assert.match(e.result.nodes.n1.error, /timed out after 80ms/);
    return true;
  });
});

test("cost unknown on one call → costExact false but total keeps known costs", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "no price info" } }] } });
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  const wf = await Workflow.load(fixture("starter-graph.json"), mockOpts(srv));
  const result = await wf.run({});
  assert.equal(result.costUsd, 0.02);
  assert.equal(result.costExact, false);
});
