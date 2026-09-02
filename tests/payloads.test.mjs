import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Workflow } from "../src/index.mjs";
import { encodeWavMono } from "../src/local-media.mjs";
import { startMockServer, mockOpts, PNG_B64, PNG_DATA_URL, WAV_DATA_URL } from "./harness/mock-server.mjs";

const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));
const wfFromFixture = async (name, srv) => Workflow.load(fixture(name), mockOpts(srv));

test("llm vision + JSON format + reasoning effort: exact chat payload", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: '{\"answer\":\"a dot\"}' } }], x_nanogpt_pricing: { costUsd: 0.002 } } });

  const wf = await wfFromFixture("llm-vision.json", srv);
  const result = await wf.run({});

  const req = srv.requests[0];
  assert.deepEqual(req.json, {
    model: "gpt-5o",
    messages: [
      { role: "system", content: "Answer briefly." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this picture?" },
          { type: "image_url", image_url: { url: PNG_DATA_URL } }, // wired image verbatim
        ],
      },
    ],
    temperature: 0.8,
    max_tokens: 50,
    response_format: { type: "json_object" },
    reasoning_effort: "low",
  });
  assert.equal(result.get("LLM"), '{\"answer\":\"a dot\"}');
});
