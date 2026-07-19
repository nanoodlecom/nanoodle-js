import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, MEDIA_INLINE_MAX } from "../src/index.mjs";
import { RUNNERS } from "../src/nodes.mjs";
import { startMockServer, mockOpts, PNG_B64, PNG_DATA_URL } from "./harness/mock-server.mjs";

const noNet = { apiKey: "unused", quiet: true };
const one = (srv, node) => Workflow.fromJSON({ nodes: [node], links: [] }, mockOpts(srv));

test("missing model → 'pick a model first', zero network calls", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = one(srv, { id: "n1", type: "llm", fields: { prompt: "hi" } });
  await assert.rejects(wf.run({}), /pick a model first \(node n1\)/);
  assert.equal(srv.requests.length, 0);
});

test("empty upload/aupload/vupload nodes error clearly when a wire pulls on them", async () => {
  for (const [type, re] of [["upload", /no image/], ["aupload", /no audio/], ["vupload", /no video/]]) {
    const wf = Workflow.fromJSON({ nodes: [{ id: "n1", type, fields: {} }], links: [] }, noNet);
    // the empty media field surfaces as a required input first — the honest upfront error
    await assert.rejects(wf.run({}), /missing required input|no /);
    await assert.rejects(RUNNERS[type]({ id: "n1", type, fields: {} }), re); // runner guard itself
  }
});

test("choice: invalid selected falls back to the FIRST option (runner + derived default)", async () => {
  // stale selected value not in the options list
  const out = await RUNNERS.choice({ id: "n1", type: "choice", fields: { options: "red\nblue", selected: "gone" } });
  assert.equal(out.text, "red");
  // empty selected at the workflow level: the derived default mirrors the play page's <select>
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "choice", fields: { options: "red\nblue\ngreen", selected: "" } }],
    links: [],
  }, noNet);
  assert.equal(wf.inputs[0].def, "red");
  const result = await wf.run({});
  assert.equal(result.get("Choice"), "red");
});

test("choice with no options errors 'no options'", async () => {
  await assert.rejects(RUNNERS.choice({ id: "n1", type: "choice", fields: { options: "" } }), /no options/);
});

test("join: default separator is a single space; empty sides are dropped", async () => {
  const mk = (aText, bText, sep) => Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: aText } },
      { id: "n2", type: "text", fields: { text: bText } },
      { id: "n3", type: "join", fields: sep === undefined ? {} : { sep } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n3", port: "a" } },
      { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "b" } },
    ],
  }, noNet);
  assert.equal((await mk("left", "right").run({})).get("Join"), "left right");
  assert.equal((await mk("a", "b", " | ").run({})).get("Join"), "a | b");
  // an unwired side is simply dropped — no dangling separator
  const half = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "solo" } },
      { id: "n2", type: "join", fields: {} },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "a" } }],
  }, noNet);
  assert.equal((await half.run({})).get("Join"), "solo");
});

test("invalid extraJson refuses before any network call", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = one(srv, { id: "n1", type: "music", fields: { model: "suno-v5", prompt: "lofi", extraJson: "{nope" } });
  await assert.rejects(wf.run({}), /invalid JSON/);
  assert.equal(srv.requests.length, 0);
});

test("custom-civitai: AIR rides the payload; missing AIR errors before spend", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  await one(srv, { id: "n1", type: "image", fields: { model: "custom-civitai", prompt: "x", customCivitaiAir: "civitai:123@456" } }).run({});
  assert.equal(srv.requests[0].json.customCivitaiAir, "civitai:123@456");

  srv.requests.length = 0;
  await one(srv, { id: "n1", type: "image", fields: { model: "custom-civitai", prompt: "x", customCivitaiAir: "persona:376130@2456367", negativePrompt: " lowres, blurry " } }).run({});
  assert.equal(srv.requests[0].json.negative_prompt, "lowres, blurry");
  assert.equal(srv.requests[0].json.negativePrompt, undefined);

  srv.requests.length = 0;
  await one(srv, { id: "n1", type: "image", fields: { model: "custom-civitai", prompt: "x", customCivitaiAir: "runware:101@1", negativePrompt: "lowres" } }).run({});
  assert.equal(srv.requests[0].json.negative_prompt, undefined, "FLUX-family AIRs must not carry a negative prompt");

  srv.requests.length = 0;
  const bad = one(srv, { id: "n1", type: "image", fields: { model: "custom-civitai", prompt: "x" } });
  await assert.rejects(bad.run({}), /select a CivitAI model/);
  assert.equal(srv.requests.length, 0);
});

test("tts: non-default speed + instructions ride; music non-default response_format rides", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/a.mp3", cost: 0.01 } });

  await one(srv, { id: "n1", type: "tts", fields: { model: "gpt-4o-mini-tts", prompt: "hi", voice: "alloy", speed: "1.5", instructions: "whisper it" } }).run({});
  assert.deepEqual(srv.requests[0].json, {
    model: "gpt-4o-mini-tts", input: "hi", voice: "alloy", speed: 1.5, instructions: "whisper it",
  });

  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/b.wav", cost: 0.01 } });
  await one(srv, { id: "n1", type: "music", fields: { model: "suno-v5", prompt: "lofi", response_format: "wav" } }).run({});
  assert.deepEqual(srv.of("POST /api/v1/audio/speech")[1].json, { model: "suno-v5", input: "lofi", response_format: "wav" });
});

test("remix: hosted https source rides as-is in body.audio", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/cover.mp3", cost: 0.1 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "https://cdn.example/src.mp3" } },
      { id: "n2", type: "remix", fields: { model: "ace-step-cover", prompt: "jazz it" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await wf.run({});
  assert.equal(srv.requests[0].json.audio, "https://cdn.example/src.mp3");
});

test("llm wired mp3 audio maps to input_audio format 'mp3'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "ok" } }], cost: 0.001 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "data:audio/mpeg;base64,QUJD" } },
      { id: "n2", type: "llm", fields: { model: "gemini-audio", prompt: "listen", system: "" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await wf.run({});
  const part = srv.requests[0].json.messages.at(-1).content[1];
  assert.deepEqual(part, { type: "input_audio", input_audio: { data: "QUJD", format: "mp3" } });
});

test("lipsync: hosted https audio rides as audioUrl (not audioDataUrl)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v1", cost: 0.4 } });
  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/t.mp4" } } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "aupload", fields: { audio: "https://cdn.example/voice.mp3" } },
      { id: "n3", type: "lipsync", fields: { model: "sonic-avatar" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "image" }, to: { node: "n3", port: "image" } },
      { id: "l2", from: { node: "n2", port: "audio" }, to: { node: "n3", port: "audio" } },
    ],
  }, mockOpts(srv));
  await wf.run({});
  const body = srv.of("POST /api/generate-video")[0].json;
  assert.equal(body.audioUrl, "https://cdn.example/voice.mp3");
  assert.ok(!("audioDataUrl" in body));
});

test("missing media wires: ivideo/vedit/vision/remix/transcribe each name what's absent", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const cases = [
    [{ id: "n1", type: "ivideo", fields: { model: "m", prompt: "p" } }, /no image input/],
    [{ id: "n1", type: "vedit", fields: { model: "m", prompt: "p" } }, /no video input/],
    [{ id: "n1", type: "vision", fields: { model: "m" } }, /no image input/],
    [{ id: "n1", type: "remix", fields: { model: "m", prompt: "p" } }, /no audio/],
    [{ id: "n1", type: "transcribe", fields: { model: "m" } }, /no audio input/],
  ];
  for (const [node, re] of cases) {
    await assert.rejects(one(srv, node).run({}), re, node.type);
  }
  assert.equal(srv.requests.length, 0);
});

test("edit: prompt required unless the model is an upscaler (then omitted from the body)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  const mk = (model) => Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "edit", fields: { model, prompt: "" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, mockOpts(srv));

  await assert.rejects(mk("nano-banana-2").run({}), /no edit instruction/);
  assert.equal(srv.requests.length, 0);

  await mk("clarity-upscaler").run({}); // upscalers just enlarge — no instruction needed
  assert.ok(!("prompt" in srv.requests[0].json));
});

test("oversize JSON body (~4.4MB) refused locally with a clear error, zero requests", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = one(srv, { id: "n1", type: "llm", fields: { model: "m", prompt: "x".repeat(MEDIA_INLINE_MAX + 64) } });
  await assert.rejects(wf.run({}), /too large/);
  assert.equal(srv.requests.length, 0);
});
