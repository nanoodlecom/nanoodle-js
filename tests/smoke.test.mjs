import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Workflow, MediaRef } from "../src/index.mjs";
import { startMockServer, mockOpts, PNG_B64 } from "./harness/mock-server.mjs";

const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));

test("smoke: starter graph — load, derive IO, run with overridden Text, exact payloads", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());

  const LLM_TEXT = "A cozy neon-lit ramen shop glowing through heavy rain, cinematic, warm lantern light.";
  srv.script("POST /api/v1/chat/completions", {
    json: {
      choices: [{ message: { content: LLM_TEXT } }],
      x_nanogpt_pricing: { costUsd: 0.0012, remainingBalance: 4.9 },
    },
  });
  srv.script("POST /v1/images/generations", {
    headers: { "x-remaining-balance": "4.85" },
    json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 },
  });

  const wf = await Workflow.load(fixture("starter-graph.json"), mockOpts(srv));

  // ---- derived inputs: n1.text ("Text") + n2.system (optional); n2.prompt and n3.prompt are wired → hidden
  assert.deepEqual(
    wf.inputs.map((i) => ({ key: i.key, nodeId: i.nodeId, field: i.field, kind: i.kind, optional: i.optional })),
    [
      { key: "Text", nodeId: "n1", field: "text", kind: "textarea", optional: false },
      { key: "System prompt", nodeId: "n2", field: "system", kind: "textarea", optional: true },
    ]);
  assert.equal(wf.inputs[0].def, "a cozy ramen shop on a rainy night"); // prefilled from the graph

  // ---- derived outputs: the image node is the only sink
  assert.deepEqual(wf.outputs, [
    { key: "Image", nodeId: "n3", type: "image", ports: [{ name: "image", type: "image" }] },
  ]);

  // ---- derived settings include the models
  const settingKeys = wf.settings.map((s) => s.key);
  assert.ok(settingKeys.includes("n2.model"));
  assert.ok(settingKeys.includes("n3.model"));
  assert.ok(settingKeys.includes("n3.size"));
  assert.ok(!settingKeys.includes("n3.prompt")); // image has no prompt setting; prompt is IO

  // ---- run with an overridden Text input
  const events = [];
  const result = await wf.run({ Text: "a moonlit koi pond" }, { onProgress: (e) => events.push(e) });

  // ---- request payloads match SPEC-engine exactly
  assert.equal(srv.requests.length, 2);
  const [chatReq, imgReq] = srv.requests;

  assert.equal(chatReq.path, "/api/v1/chat/completions");
  assert.equal(chatReq.headers.authorization, "Bearer test-key");
  assert.equal(chatReq.headers["x-api-key"], "test-key");
  assert.equal(chatReq.headers["content-type"], "application/json");
  assert.deepEqual(chatReq.json, {
    model: "zai-org/glm-5.2",
    messages: [
      {
        role: "system",
        content: "You write image prompts. Turn the idea into one vivid, detailed image prompt — scene, lighting, mood, style. Reply with the prompt only.",
      },
      { role: "user", content: "a moonlit koi pond" },
    ],
    temperature: 0.8,
  });
  assert.ok(!("stream" in chatReq.json)); // engine is non-streaming

  assert.equal(imgReq.path, "/v1/images/generations"); // NOT /api/v1
  assert.equal(imgReq.headers.authorization, "Bearer test-key");
  assert.equal(imgReq.headers["x-api-key"], "test-key");
  assert.deepEqual(imgReq.json, {
    model: "nano-banana-2-fast",
    size: "1k",
    n: 1,
    response_format: "b64_json",
    prompt: LLM_TEXT,
  });

  // ---- result values
  const img = result.get("Image");
  assert.ok(img instanceof MediaRef);
  assert.equal(img.url, "data:image/png;base64," + PNG_B64); // b64 sniffed as PNG
  assert.equal(img.mime, "image/png");
  assert.equal(String(result.outputs.n3), img.url); // also keyed by node id
  const bytes = await img.bytes();
  assert.equal(bytes[0], 0x89); // PNG magic

  // ---- per-node records + cost accounting
  assert.equal(result.nodes.n1.status, "done");
  assert.equal(result.nodes.n2.status, "done");
  assert.equal(result.nodes.n2.out.text, LLM_TEXT);
  assert.equal(result.nodes.n3.status, "done");
  assert.ok(Math.abs(result.costUsd - 0.0212) < 1e-9);
  assert.equal(result.costExact, true);
  assert.equal(result.remainingBalance, 4.85); // header wins, freshest value
  assert.deepEqual(result.errors, []);

  // ---- progress events fired in order for the chain
  const started = events.filter((e) => e.type === "node-start").map((e) => e.nodeId);
  assert.deepEqual(started, ["n1", "n2", "n3"]);
  assert.equal(events.filter((e) => e.type === "node-done").length, 3);
});

test("smoke: bare scalar input resolves to the single required input", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "ok" } }], cost: 0.001 } });
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.01 } });

  const wf = await Workflow.load(fixture("starter-graph.json"), mockOpts(srv));
  await wf.run("just a scalar");
  assert.equal(srv.requests[0].json.messages[1].content, "just a scalar");
});
