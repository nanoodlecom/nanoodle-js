import test from "node:test";
import assert from "node:assert/strict";
import { NanoClient } from "../src/client.mjs";
import { estimateGraphCost, Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, chatJson } from "./harness/mock-server.mjs";

// D1 ruling (2026-11-18): maxTokens is NOT sent by default and IS honored
// when a node explicitly sets it — default-off, opt-in per use, identical
// across the JS SDK, the Python executor, the editor, and MCP. These tests
// pin both directions so any side drifting either way fails loudly.

for (const model of ["google/gemini-4-carbon", "google/gemini-4-argon", "fixture-other"]) {
  test(`chat forwards only the canonical opt-in budget: ${model}`, async () => {
    const bodies = [];
    const client = new NanoClient({ apiKey: "fixture", fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }});
    // No opt-in → no token budget of any spelling reaches the body.
    await client.chat([], model, {});
    await client.chat([], model, { max_completion_tokens: 1536, max_output_tokens: 1536, maxTokens: 1536 });
    for (const body of bodies) {
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxTokens"]) {
        assert.equal(field in body, false, field);
      }
    }
    // The canonical opt-in is forwarded exactly.
    await client.chat([], model, { max_tokens: 1536 });
    assert.equal(bodies[2].max_tokens, 1536);
  });
}

const llmGraph = (maxTokens) => {
  const fields = { model: "fixture", prompt: "hi" };
  if (maxTokens !== undefined) fields.maxTokens = maxTokens;
  return { nodes: [{ id: "n", type: "llm", fields }], links: [] };
};

test("graph run: no maxTokens set → no max_tokens on the wire", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  const wf = Workflow.fromJSON(llmGraph(undefined), mockOpts(srv));
  await wf.run({});
  assert.equal("max_tokens" in srv.of("POST /api/v1/chat/completions")[0].json, false);
});

test("graph run: maxTokens set → sent exactly (string, number, float)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  for (const [given, sent] of [["1536", 1536], [2048, 2048], ["99.9", 99]]) {
    srv.requests.length = 0;
    const wf = Workflow.fromJSON(llmGraph(given), mockOpts(srv));
    await wf.run({});
    assert.equal(srv.of("POST /api/v1/chat/completions")[0].json.max_tokens, sent, `maxTokens=${given}`);
  }
});

test("graph run: non-numeric maxTokens degrades gracefully — nothing sent", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  const wf = Workflow.fromJSON(llmGraph("lots"), mockOpts(srv));
  await wf.run({});
  assert.equal("max_tokens" in srv.of("POST /api/v1/chat/completions")[0].json, false);
});

test("estimate prices an explicit cap at the cap; settings expose the opt-in", () => {
  const catalog = { chat: [{ id: "fixture", pricing: { prompt: 2, completion: 10 } }] };
  const capped = estimateGraphCost(llmGraph("1536"), catalog);
  const uncapped = estimateGraphCost(llmGraph(undefined), catalog);
  assert(capped.usd > uncapped.usd, "cap 1536 prices above the 500-token default estimate");
  assert(Math.abs((capped.usd - uncapped.usd) - (1536 - 500) * 10 / 1e6) < 1e-9);
  // the stored field survives a load untouched, and the setting is listed
  const workflow = Workflow.fromJSON(llmGraph("1536"), { apiKey: "fixture" });
  assert(workflow.settings.some((s) => s.field === "maxTokens"));
  assert.equal(llmGraph("1536").nodes[0].fields.maxTokens, "1536");
});
