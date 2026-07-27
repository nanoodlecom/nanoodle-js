// Prompt length caps — the wired prompt nobody can shorten.
//
// Many image/video models reject an over-long prompt at NanoGPT's route (400 prompt_too_long). In a
// graph the prompt is WRITTEN by an upstream LLM, so a headless caller has nothing to shorten and no
// hint the limit exists. These pin the deal: trim to fit, always report it, learn a cap we didn't
// know — and never rewrite the graph's own prompts to avoid any of it. Everything runs against the
// mock server — no network, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, promptCap, fitPromptText, isPromptTooLong, promptCapFromError, PROMPT_CAPS } from "../src/index.mjs";
import { startMockServer, mockOpts } from "./harness/mock-server.mjs";

// text → LLM → Image(qwen-image-3, cap 800): the reported shape, minimally
const GRAPH = {
  nodes: [
    { id: "t1", type: "text", fields: { text: "Album: Neon Mirage" } },
    { id: "m1", type: "llm", fields: { model: "gpt-5o", system: "You are an art director.", prompt: "" } },
    { id: "i1", type: "image", fields: { model: "qwen-image-3", prompt: "", size: "1024x1024" } },
  ],
  links: [
    { id: "l1", from: { node: "t1", port: "text" }, to: { node: "m1", port: "prompt" } },
    { id: "l2", from: { node: "m1", port: "text" }, to: { node: "i1", port: "prompt" } },
  ],
};
const clone = (g) => JSON.parse(JSON.stringify(g));
const IMG_OK = { json: { data: [{ b64_json: "iVBORw0KGgo=" }], cost: 0.075 } };

test("promptCap: probe table for image/video, catalog metadata for audio, never for chat", () => {
  assert.equal(promptCap({ type: "image", fields: { model: "qwen-image-3" } }), 800);
  assert.equal(promptCap({ type: "edit", fields: { model: "step-image-edit-2" } }), 512);
  assert.equal(promptCap({ type: "tvideo", fields: { model: "minimax-hailuo-02" } }), 2000);
  // an uncapped (or never-probed) model stays unconstrained — the library's permissive-gate rule
  assert.equal(promptCap({ type: "image", fields: { model: "flux-kontext" } }), null);
  // an LLM's own limit is tokens, and it is never the node being fitted
  assert.equal(promptCap({ type: "llm", fields: { model: "gpt-5o" } }), null);
  // audio caps ARE catalog metadata upstream, so they're read live and never listed in the table
  assert.equal(PROMPT_CAPS.audio, undefined);
  const catalog = { audio: [{ id: "tts-1", supported_parameters: { max_chars: 4096 } }] };
  assert.equal(promptCap({ type: "tts", fields: { model: "tts-1" } }, { catalog }), 4096);
  assert.equal(promptCap({ type: "tts", fields: { model: "tts-1" } }), null, "no catalog → no cap, never a guess");
  // a learned cap beats the baked table: the table is a snapshot, a live 400 is today
  const learned = new Map([["image:qwen-image-3", 640]]);
  assert.equal(promptCap({ type: "image", fields: { model: "qwen-image-3" } }, { learned }), 640);
});

test("the graph's own prompts reach the model exactly as written", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "a neon city" } }] } });
  srv.script("POST /v1/images/generations", IMG_OK);

  await Workflow.fromJSON(clone(GRAPH), mockOpts(srv)).run({});

  const msgs = srv.requests[0].json.messages;
  assert.equal(msgs[0].content, "You are an art director.",
    "the LLM's system prompt is untouched — no length directive is injected on the author's behalf");
  assert.equal(msgs.length, 2, "and nothing extra is appended to the conversation either");
});

test("a downstream cap never leaks upstream, however tight it is", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "a neon city" } }] } });
  srv.script("POST /v1/images/generations", IMG_OK);

  const g = clone(GRAPH);
  g.nodes[2].fields.model = "step-image-edit-2";   // the tightest cap in the table (512)
  await Workflow.fromJSON(g, mockOpts(srv)).run({});
  assert.equal(srv.requests[0].json.messages[0].content, "You are an art director.");
  assert.ok(!/512|characters/.test(JSON.stringify(srv.requests[0].json)),
    "the cap is nowhere in the chat request — it is applied to the image call, and nowhere else");
});

test("a prompt that still overflows is fitted at a sentence boundary — and reported", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  // an LLM that ignores the budget entirely (they do overshoot; this one does it wildly)
  const runaway = "A neon city at night. " + "Rain slicks the street. ".repeat(60);
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: runaway } }] } });
  srv.script("POST /v1/images/generations", IMG_OK);

  const events = [];
  await Workflow.fromJSON(clone(GRAPH), mockOpts(srv)).run({}, { onProgress: (e) => events.push(e) });

  const sent = srv.requests[1].json.prompt;
  assert.ok(sent.length <= 800, `sent ${sent.length} chars, cap is 800`);
  assert.ok(sent.endsWith("."), "the cut lands on a sentence boundary, not mid-thought");
  assert.ok(sent.length >= 560, "a boundary cut never throws away more than the overflow did");

  const trim = events.find((e) => e.type === "prompt-trimmed");
  assert.ok(trim, "a trimmed prompt is announced — a shorter prompt than the graph produced is never silent");
  assert.equal(trim.nodeId, "i1");
  assert.equal(trim.cap, 800);
  assert.equal(trim.from, runaway.length);
});

test("a prompt that fits is sent verbatim, and nothing is announced", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "a neon city at 3am" } }] } });
  srv.script("POST /v1/images/generations", IMG_OK);

  const events = [];
  await Workflow.fromJSON(clone(GRAPH), mockOpts(srv)).run({}, { onProgress: (e) => events.push(e) });
  assert.equal(srv.requests[1].json.prompt, "a neon city at 3am");
  assert.equal(events.find((e) => e.type === "prompt-trimmed"), undefined);
});

test("fitPromptText: boundaries, fallbacks, and the one case where a hard cut is right", () => {
  const s = "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten.";
  const cut = fitPromptText(s, 30);
  assert.ok(cut.length <= 30 && cut.endsWith("."));
  assert.equal(fitPromptText("short", 100), "short", "already inside the cap → untouched");
  const words = fitPromptText("aa ".repeat(100), 50);
  assert.ok(words.length <= 50 && !/\s$/.test(words), "no sentence end → word boundary, never mid-word");
  assert.equal(fitPromptText("x".repeat(500), 100).length, 100, "one unbroken token → hard cut is the last resort");
});

test("an unknown model's cap is learned from the live 400, and the message says so", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "a neon city" } }] } });
  // a model NOT in the table — exactly the case the table can't cover (new, or never probed)
  srv.script("POST /v1/images/generations", {
    status: 400,
    json: { error: "Your prompt is too long for Brand New Model. Please shorten it to 640 characters or less (current: 900 characters).", code: "prompt_too_long" },
  });

  const g = clone(GRAPH);
  g.nodes[2].fields.model = "brand-new-model";
  const wf = Workflow.fromJSON(g, mockOpts(srv));
  const failed = await wf.run({}).then(() => null, (e) => e);

  assert.ok(failed, "an unfixable-looking 400 still fails the run — nothing is swallowed");
  assert.match(failed.message, /running again should succeed/, "the error tells the caller what to do next");
  assert.match(failed.result.errors[0].message, /640 characters or less/, "…without hiding what the API actually said");
  assert.equal(wf._promptCaps.get("image:brand-new-model"), 640, "the cap is banked for the retry");

  // second run: the same Workflow now trims to the learned 640 before sending, without being told again
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "A neon city. ".repeat(80) } }] } });
  srv.script("POST /v1/images/generations", IMG_OK);
  srv.requests.length = 0;
  const events = [];
  await wf.run({}, { onProgress: (e) => events.push(e) });
  assert.ok(srv.requests[1].json.prompt.length <= 640, "the learned cap is applied on the retry, not rediscovered");
  assert.equal(events.find((e) => e.type === "prompt-trimmed").cap, 640);
});

test("all three live error shapes parse, and 'current: N' is never mistaken for the cap", () => {
  const shapes = [
    ['{"error":"Your prompt is too long for Qwen Image 3. Please shorten it to 800 characters or less (current: 831 characters).","code":"prompt_too_long"}', 800],
    ['{"error":{"message":"Your prompt is too long for Step Image Edit 2. Please shorten it to 512 characters or less (current: 5999 characters).","code":"prompt_too_long"}}', 512],
    ['{"error":"Prompt is too long. Please keep it under 3000 characters."}', 3000],
  ];
  for (const [body, want] of shapes) {
    assert.ok(isPromptTooLong(body), body.slice(0, 60));
    assert.equal(promptCapFromError(body), want);
  }
  // learning the "current" length would grow the limit with every failure — the model would never
  // be prevented, only re-broken
  assert.notEqual(promptCapFromError(shapes[1][0]), 5999);
  assert.equal(promptCapFromError('{"error":"Invalid image input."}'), null);
  assert.equal(isPromptTooLong('{"error":"Invalid image input."}'), false);
});
