import test from "node:test";
import assert from "node:assert/strict";
import { NanoClient } from "../src/client.mjs";
import { estimateGraphCost, Workflow } from "../src/index.mjs";

for (const model of ["google/gemini-4-carbon", "google/gemini-4-argon", "fixture-other"]) {
  test(`chat ignores removed token budgets: ${model}`, async () => {
    const client = new NanoClient({ apiKey: "fixture", fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxTokens"]) {
        assert.equal(field in body, false, field);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }});
    for (const value of [undefined, "", 1, 1536, 32768, 1000000]) {
      await client.chat([], model, { max_tokens: value, max_completion_tokens: value, max_output_tokens: value, maxTokens: value });
    }
  });
}

test("legacy graph token budget stays stored but does not affect estimate or settings", () => {
  const node = { id: "n", type: "llm", fields: { model: "fixture", maxTokens: "1536" } };
  const graph = { nodes: [node], links: [] };
  const catalog = { chat: [{ id: "fixture", pricing: { prompt: 2, completion: 10 } }] };
  const uncapped = structuredClone(graph); delete uncapped.nodes[0].fields.maxTokens;
  assert.deepEqual(estimateGraphCost(graph, catalog), estimateGraphCost(uncapped, catalog));
  const workflow = Workflow.fromJSON(graph, { apiKey: "fixture" });
  assert(!workflow.settings.some(s => s.field === "maxTokens"));
  assert.equal(graph.nodes[0].fields.maxTokens, "1536");
});
