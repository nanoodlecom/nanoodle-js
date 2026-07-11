import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, chatJson, PNG_B64, PNG_DATA_URL } from "./harness/mock-server.mjs";

const noNet = { apiKey: "unused", quiet: true };
const one = (srv, node, extra) => Workflow.fromJSON({ nodes: [node], links: [] }, mockOpts(srv, extra));

/* ---------------- LoRA params ride image + video payloads ---------------- */

test("image LoRA: fields.loras → lora_url/lora_strength on the image payload", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  await one(srv, {
    id: "n1", type: "image",
    fields: { model: "hidream-i1-lora", prompt: "cat", loras: [{ url: "https://host.example/style.safetensors", strength: "0.8" }] },
  }).run({});
  const body = srv.requests[0].json;
  assert.equal(body.lora_url, "https://host.example/style.safetensors");
  assert.equal(body.lora_strength, 0.8);
});

test("image LoRA: legacy loraUrl/loraStrength fields still ride", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  await one(srv, {
    id: "n1", type: "image",
    fields: { model: "flux-lora", prompt: "cat", loraUrl: "https://host.example/one.safetensors", loraStrength: "0.5" },
  }).run({});
  assert.equal(srv.requests[0].json.lora_url, "https://host.example/one.safetensors");
  assert.equal(srv.requests[0].json.lora_strength, 0.5);
});

test("image LoRA: numbered-slot family (flux-2 *lora) emits lora_url_N/lora_scale_N, missing strength → 1", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  await one(srv, {
    id: "n1", type: "image",
    fields: {
      model: "flux-2-dev-lora", prompt: "cat",
      loras: [
        { url: "https://host.example/a.safetensors", strength: "0.7" },
        { url: "https://host.example/b.safetensors", strength: "" },
      ],
    },
  }).run({});
  const body = srv.requests[0].json;
  assert.equal(body.lora_url_1, "https://host.example/a.safetensors");
  assert.equal(body.lora_scale_1, 0.7);
  assert.equal(body.lora_url_2, "https://host.example/b.safetensors");
  assert.equal(body.lora_scale_2, 1);
});

test("video LoRA: LTX tvideo carries lora_url_1 in the generate-video body", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "v1", cost: 0.4 } });
  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/v.mp4" } } });

  await one(srv, {
    id: "n1", type: "tvideo",
    fields: { model: "ltx-2-fast", prompt: "a dog", loras: [{ url: "https://host.example/motion.safetensors", strength: "0.9" }] },
  }).run({});
  const body = srv.of("POST /api/generate-video")[0].json;
  assert.equal(body.lora_url_1, "https://host.example/motion.safetensors");
  assert.equal(body.lora_scale_1, 0.9);
});

test("LoRA on a non-LoRA model is dropped (matches the app's capability gate)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  await one(srv, {
    id: "n1", type: "image",
    fields: { model: "nano-banana-2", prompt: "cat", loras: [{ url: "https://host.example/style.safetensors", strength: "0.8" }] },
  }).run({});
  const body = srv.requests[0].json;
  for (const k of Object.keys(body)) assert.ok(!/lora/i.test(k), "unexpected lora key: " + k);
});

test("LoRA CivitAI link / HF repo id refused BEFORE any network call", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const mk = (url) => one(srv, {
    id: "n1", type: "image", fields: { model: "flux-lora", prompt: "x", loras: [{ url, strength: "1" }] },
  });
  await assert.rejects(mk("https://civitai.com/models/123").run({}), /CivitAI links can't be fetched directly/);
  await assert.rejects(mk("someuser/some-repo").run({}), /HuggingFace repo id/);
  assert.equal(srv.requests.length, 0);
});

/* ---------------- inpaint: unwired image + mask both derive ---------------- */

test("inpaint with nothing wired derives image AND mask; run supplies both, payload carries both", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  const wf = one(srv, { id: "n1", type: "inpaint", fields: { model: "flux-fill" } });
  assert.deepEqual(wf.inputs.map((i) => i.field), ["prompt", "image", "mask"]);

  await wf.run({ "What to paint in": "a hat", "n1.image": PNG_DATA_URL, "n1.mask": PNG_DATA_URL });
  const body = srv.requests[0].json;
  assert.equal(body.imageDataUrl, PNG_DATA_URL);
  assert.equal(body.maskDataUrl, PNG_DATA_URL);
});

test("inpaint missing mask errors upfront (missing required input) — upstream lanes never spend", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = one(srv, { id: "n1", type: "inpaint", fields: { model: "flux-fill" } });
  await assert.rejects(wf.run({ "What to paint in": "a hat", "n1.image": PNG_DATA_URL }), /missing required input.*mask/i);
  assert.equal(srv.requests.length, 0);
});

/* ---------------- music/remix extraJson song-count clamp ---------------- */

test("music: extraJson song-count keys are stripped (bill-one-surface-one), other keys ride", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/a.mp3", cost: 0.1 } });

  await one(srv, {
    id: "n1", type: "music",
    fields: { model: "suno-v5", prompt: "lofi", extraJson: '{"number_of_songs":4,"n":3,"generation_count":2,"style_weight":0.6}' },
  }).run({});
  const body = srv.requests[0].json;
  assert.equal(body.style_weight, 0.6);
  for (const k of ["number_of_songs", "n", "num_songs", "song_count", "generation_count"]) {
    assert.ok(!(k in body), "song-count key leaked: " + k);
  }
});

test("remix: extraJson song-count keys are stripped too", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/c.mp3", cost: 0.1 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "https://cdn.example/src.mp3" } },
      { id: "n2", type: "remix", fields: { model: "ace-step-cover", prompt: "jazz it", extraJson: '{"num_songs":2}' } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await wf.run({});
  assert.ok(!("num_songs" in srv.requests[0].json));
});

/* ---------------- custom-civitai AIR normalization ---------------- */

test("custom-civitai: bare 123@456 and civitai.com URLs normalize; malformed AIR refused pre-spend", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  const mk = (air) => one(srv, { id: "n1", type: "image", fields: { model: "custom-civitai", prompt: "x", customCivitaiAir: air } });

  await mk("123@456").run({});
  assert.equal(srv.requests[0].json.customCivitaiAir, "civitai:123@456");

  await mk("https://civitai.com/models/777?modelVersionId=888").run({});
  assert.equal(srv.requests[1].json.customCivitaiAir, "civitai:777@888");

  srv.requests.length = 0;
  await assert.rejects(mk("totally-not-an-air").run({}), /AIR must look like/);
  assert.equal(srv.requests.length, 0);
});

/* ---------------- RunResult.get prototype hardening ---------------- */

test("result.get('toString'/'constructor') throws the unknown-output error, not a prototype member", async () => {
  const wf = Workflow.fromJSON({ nodes: [{ id: "n1", type: "text", fields: { text: "hi" } }], links: [] }, noNet);
  const result = await wf.run({});
  for (const key of ["toString", "constructor", "hasOwnProperty"]) {
    assert.throws(() => result.get(key), /no output "..*" — available outputs/, key);
  }
  assert.equal(result.get("Text"), "hi");
});

/* ---------------- explicit empty optional input ---------------- */

test("run({'System prompt': ''}) sends NO system message (default only backfills unsupplied keys)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));

  const graph = { nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi", system: "" } }], links: [] };

  await Workflow.fromJSON(graph, mockOpts(srv)).run({ "System prompt": "" });
  assert.deepEqual(srv.requests[0].json.messages.map((m) => m.role), ["user"]);

  // unsupplied → the spec default still applies
  await Workflow.fromJSON(graph, mockOpts(srv)).run({});
  const msgs = srv.requests[1].json.messages;
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user"]);
  assert.equal(msgs[0].content, "You are a helpful, concise assistant.");
});

/* ---------------- https audio into an llm audio port ---------------- */

test("hosted https audio wired into llm is downloaded and inlined as base64, never sent as a URL string", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // "ID3" magic
  srv.script("GET /media/song.mp3", { headers: { "content-type": "audio/mpeg" }, body: mp3 });
  srv.script("POST /api/v1/chat/completions", chatJson("heard it"));

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: srv.url + "/media/song.mp3" } },
      { id: "n2", type: "llm", fields: { model: "gemini-audio", prompt: "listen", system: "" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await wf.run({});
  const part = srv.of("POST /api/v1/chat/completions")[0].json.messages.at(-1).content[1];
  assert.equal(part.type, "input_audio");
  assert.equal(part.input_audio.format, "mp3");
  assert.equal(part.input_audio.data, mp3.toString("base64")); // real bytes, not the URL
});

/* ---------------- API key never in object repr ---------------- */

test("util.inspect of Workflow/NanoClient never contains the API key (but auth headers still sent)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));

  const wf = Workflow.fromJSON({ nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }], links: [] }, mockOpts(srv));
  assert.ok(!inspect(wf, { depth: 10 }).includes("test-key"));
  assert.ok(!inspect(wf.client, { depth: 10 }).includes("test-key"));
  assert.ok(!JSON.stringify(wf.client).includes("test-key"));

  await wf.run({});
  assert.equal(srv.requests[0].headers["authorization"], "Bearer test-key"); // the key still works
});

/* ---------------- undefined upstream value must not clobber a typed field ---------------- */

test("link from a nonexistent source port leaves the typed field intact (app applies only v != null)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "ignored" } },
      { id: "n2", type: "llm", fields: { model: "m", prompt: "typed prompt", system: "" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "bogus" }, to: { node: "n2", port: "prompt" } }],
  }, mockOpts(srv));
  await wf.run({});
  assert.equal(srv.requests[0].json.messages.at(-1).content, "typed prompt");
});

/* ---------------- non-string settings coerced ---------------- */

test("numeric/boolean settings values are coerced to strings (join sep 5 doesn't crash the runner)", async () => {
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "text", fields: { text: "a" } },
      { id: "n2", type: "text", fields: { text: "b" } },
      { id: "n3", type: "join", fields: {} },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "text" }, to: { node: "n3", port: "a" } },
      { id: "l2", from: { node: "n2", port: "text" }, to: { node: "n3", port: "b" } },
    ],
  }, noNet);
  const result = await wf.run({}, { settings: { "n3.sep": 5 } });
  assert.equal(result.get("Join"), "a5b");
  await assert.rejects(wf.run({}, { settings: { "n3.sep": { nested: true } } }), /expects a scalar/);
});

/* ---------------- CLI: flag with a missing value ---------------- */

test("CLI: '--input' with no value prints a usage error naming the flag (no TypeError)", async () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle.mjs");
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  const graphPath = join(dir, "g.json");
  await writeFile(graphPath, JSON.stringify({ nodes: [{ id: "n1", type: "text", fields: { text: "hi" } }], links: [] }));
  for (const flag of ["--input", "--set", "--out", "--key", "--env-file", "--timeout"]) {
    const r = spawnSync(process.execPath, [bin, "run", graphPath, flag], { encoding: "utf8" });
    assert.equal(r.status, 1, flag);
    assert.match(r.stderr, new RegExp(flag + " expects a value"), flag);
    assert.ok(!/Cannot read properties/.test(r.stderr), flag);
  }
});
