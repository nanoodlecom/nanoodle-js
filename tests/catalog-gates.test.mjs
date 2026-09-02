/**
 * Opt-in catalog gates (replace-prep): with { catalog } the engine applies the
 * same payload gates play RUNTIME_JS does; without it (or for a model absent
 * from it) nothing changes — permissive by design so offline exports keep
 * their behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, chatJson, PNG_B64, PNG_DATA_URL, WAV_DATA_URL } from "./harness/mock-server.mjs";

const one = (srv, nodes, links, extra) => Workflow.fromJSON({ nodes, links: links || [] }, mockOpts(srv, extra));

test("llm audio_input gate: KNOWN text-only model drops the input_audio part; absent model keeps it", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));
  srv.script("POST /api/v1/chat/completions", chatJson("ok"));

  const nodes = [
    { id: "a1", type: "aupload", fields: { audio: WAV_DATA_URL } },
    { id: "m1", type: "llm", fields: { model: "text-only", prompt: "listen", system: "" } },
  ];
  const links = [{ id: "l1", from: { node: "a1", port: "audio" }, to: { node: "m1", port: "audio" } }];

  const catalog = { chat: [{ id: "text-only", capabilities: {} }] };
  await one(srv, nodes, links, { catalog }).run({});
  const content1 = srv.requests[0].json.messages.at(-1).content;
  assert.equal(typeof content1, "string", "audio part dropped → plain string prompt");

  // same graph, no catalog → permissive, part rides
  await one(srv, nodes, links).run({});
  const content2 = srv.requests[1].json.messages.at(-1).content;
  assert.equal(content2.at(-1).type, "input_audio");
});

test("llm structured_output gate: response_format stripped only for a KNOWN-incapable model", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  for (let i = 0; i < 3; i++) srv.script("POST /api/v1/chat/completions", chatJson("{}"));

  const nodes = [{ id: "m1", type: "llm", fields: { model: "m", prompt: "hi", system: "", format: "JSON" } }];
  await one(srv, nodes, null, { catalog: { chat: [{ id: "m", capabilities: {} }] } }).run({});
  assert.equal(srv.requests[0].json.response_format, undefined);

  await one(srv, nodes, null, { catalog: { chat: [{ id: "m", capabilities: { structured_output: true } }] } }).run({});
  assert.deepEqual(srv.requests[1].json.response_format, { type: "json_object" });

  await one(srv, nodes, null).run({}); // no catalog → knob kept
  assert.deepEqual(srv.requests[2].json.response_format, { type: "json_object" });
});

test("image variations clamp: catalog item present clamps to max_output_images (silent item → 1)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const imgs = (n) => ({ json: { data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })), cost: 0 } });
  srv.script("POST /v1/images/generations", imgs(2));
  srv.script("POST /v1/images/generations", imgs(1));
  srv.script("POST /v1/images/generations", imgs(4));

  const nodes = [{ id: "i1", type: "image", fields: { model: "m", prompt: "cat", variations: "4" } }];
  await one(srv, nodes, null, { catalog: { image: [{ id: "m", supported_parameters: { max_output_images: 2 } }] } }).run({});
  assert.equal(srv.requests[0].json.n, 2);

  await one(srv, nodes, null, { catalog: { image: [{ id: "m", supported_parameters: {} }] } }).run({});
  assert.equal(srv.requests[1].json.n, 1, "item present but silent → conservative 1");

  await one(srv, nodes, null).run({}); // absent catalog → unclamped
  assert.equal(srv.requests[2].json.n, 4);
});

test("edit ref cap: surplus wired images dropped to max_input_images (with a node-progress note)", async (t) => {
  const srv = await startMockServer();
  t.after(() => t.diagnostic("done") ?? srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0 } });

  const nodes = [
    { id: "u1", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "u2", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "u3", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "e1", type: "edit", fields: { model: "m", prompt: "merge" } },
  ];
  const links = [
    { id: "l1", from: { node: "u1", port: "image" }, to: { node: "e1", port: "image" } },
    { id: "l2", from: { node: "u2", port: "image" }, to: { node: "e1", port: "image2" } },
    { id: "l3", from: { node: "u3", port: "image" }, to: { node: "e1", port: "image3" } },
  ];
  const notes = [];
  await one(srv, nodes, links, { catalog: { image: [{ id: "m", supported_parameters: { max_input_images: 2 } }] } })
    .run({}, { onProgress: (e) => { if (e.type === "node-progress") notes.push(e.message); } });
  const sent = srv.requests[0].json.imageDataUrl;
  assert.ok(Array.isArray(sent) && sent.length === 2, "3 refs capped to 2");
  assert.ok(notes.some((m) => /dropped 1 image/.test(m)), "progress note emitted");
});

test("music/remix duration + tts voice gate on catalog supported_parameters", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const audioUrl = { json: { audioUrl: "https://cdn.example/a.mp3", cost: 0 } };
  for (let i = 0; i < 4; i++) srv.script("POST /api/v1/audio/speech", audioUrl);

  // music: model in catalog without a duration range → duration dropped
  const music = [
    { id: "t1", type: "text", fields: { text: "jazz" } },
    { id: "m1", type: "music", fields: { model: "songer", duration: "60" } },
  ];
  const mLinks = [{ id: "l1", from: { node: "t1", port: "text" }, to: { node: "m1", port: "prompt" } }];
  await one(srv, music, mLinks, { catalog: { audio: [{ id: "songer", supported_parameters: {} }] } }).run({});
  assert.equal(srv.requests[0].json.duration, undefined);

  // …and with an advertised range it rides
  await one(srv, music, mLinks, { catalog: { audio: [{ id: "songer", supported_parameters: { min_duration: 10, max_duration: 120 } }] } }).run({});
  assert.equal(srv.requests[1].json.duration, 60);

  // tts: voice dropped when the model advertises no voices
  const tts = [
    { id: "t1", type: "text", fields: { text: "hello" } },
    { id: "s1", type: "tts", fields: { model: "speaker", voice: "nova" } },
  ];
  const tLinks = [{ id: "l1", from: { node: "t1", port: "text" }, to: { node: "s1", port: "prompt" } }];
  await one(srv, tts, tLinks, { catalog: { audio: [{ id: "speaker", supported_parameters: {} }] } }).run({});
  assert.equal(srv.requests[2].json.voice, undefined);
  await one(srv, tts, tLinks, { catalog: { audio: [{ id: "speaker", supported_parameters: { voices: ["nova"] } }] } }).run({});
  assert.equal(srv.requests[3].json.voice, "nova");
});

test("video refs: catalog resolves the model's real wire key + cap; a known no-ref model ignores wires", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const done = { json: { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } } } } };
  for (let i = 0; i < 3; i++) srv.script("POST /api/generate-video", { json: { runId: "vid_" + i, cost: 0 } });
  srv.script("GET /api/video/status", [done, done, done]);

  const nodes = [
    { id: "u1", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "u2", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "v1", type: "tvideo", fields: { model: "luma-like", prompt: "morph" } },
  ];
  const links = [
    { id: "l1", from: { node: "u1", port: "image" }, to: { node: "v1", port: "ref1" } },
    { id: "l2", from: { node: "u2", port: "image" }, to: { node: "v1", port: "ref2" } },
  ];

  // model declares reference_image_urls with max 1 → refs ride that key, clamped, with a note
  const notes = [];
  const catalog = { video: [{ id: "luma-like", supported_parameters: { parameters: {
    reference_image_urls: { max: 1 },
  } } }] };
  await one(srv, nodes, links, { catalog }).run({}, { onProgress: (e) => { if (e.type === "node-progress") notes.push(e.message); } });
  const b1 = srv.of("POST /api/generate-video")[0].json;
  assert.deepEqual(b1.reference_image_urls, [PNG_DATA_URL], "2 refs capped to the declared max of 1");
  assert.equal(b1.reference_images, undefined, "hardcoded spelling never sent when the model names another");
  assert.ok(notes.some((m) => /dropped 1 reference image/.test(m)), "over-cap drop note emitted");

  // model KNOWN to take no refs → wires ignored (degraded render, never a bad param), with a note
  const notes2 = [];
  await one(srv, nodes, links, { catalog: { video: [{ id: "luma-like", supported_parameters: { parameters: {} } }] } })
    .run({}, { onProgress: (e) => { if (e.type === "node-progress") notes2.push(e.message); } });
  const b2 = srv.of("POST /api/generate-video")[1].json;
  assert.equal(b2.reference_images, undefined);
  assert.equal(b2.reference_image_urls, undefined);
  assert.ok(notes2.some((m) => /reference image\(s\) ignored/.test(m)), "ignored note emitted");

  // vedit honors ref wires the same way (no catalog → most-common spelling, refMaxFor cap)
  const vnodes = [
    { id: "u1", type: "upload", fields: { image: PNG_DATA_URL } },
    { id: "w1", type: "vupload", fields: { video: "data:video/mp4;base64,AAAA" } },
    { id: "v1", type: "vedit", fields: { model: "seedance-2.0-edit", prompt: "restyle" } },
  ];
  const vlinks = [
    { id: "l1", from: { node: "w1", port: "video" }, to: { node: "v1", port: "video" } },
    { id: "l2", from: { node: "u1", port: "image" }, to: { node: "v1", port: "ref1" } },
  ];
  await one(srv, vnodes, vlinks).run({});
  const b3 = srv.of("POST /api/generate-video")[2].json;
  assert.deepEqual(b3.reference_images, [PNG_DATA_URL], "vedit forwards wired refs");
});

test("video refs: pricing evidence stands in for the missing param (minimax-h3), cap 9 by family", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const done = { json: { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } } } } };
  for (let i = 0; i < 3; i++) srv.script("POST /api/generate-video", { json: { runId: "vid_" + i, cost: 0 } });
  srv.script("GET /api/video/status", [done, done, done]);

  // Six wired refs: h3 takes 9 (6-9 bill extra), so none are dropped.
  const nodes = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: "u" + i, type: "upload", fields: { image: PNG_DATA_URL } })),
    { id: "v1", type: "tvideo", fields: { model: "minimax-h3", prompt: "two subjects" } },
  ];
  const links = Array.from({ length: 6 }, (_, i) => ({ id: "l" + i, from: { node: "u" + i, port: "image" }, to: { node: "v1", port: "ref" + (i + 1) } }));

  // day-one h3 catalog entry: duration/aspect only, refs visible ONLY in pricing
  const h3 = { id: "minimax-h3", supported_parameters: { parameters: { duration: {}, aspect_ratio: {} } },
    pricing: { output_per_second: 0.13, included_reference_images: 5, extra_reference_image: 0.04 } };
  const notes = [];
  await one(srv, nodes, links, { catalog: { video: [h3] } })
    .run({}, { onProgress: (e) => { if (e.type === "node-progress") notes.push(e.message); } });
  const b1 = srv.of("POST /api/generate-video")[0].json;
  assert.equal(b1.reference_images.length, 6, "pricing evidence opens the ref port; family cap 9 keeps all 6");
  assert.equal(notes.some((m) => /ignored|dropped/.test(m)), false, "nothing dropped, nothing ignored");

  // pricing evidence with no family entry → the included count is the cap
  const other = { id: "someone-else-v1", supported_parameters: { parameters: { duration: {} } },
    pricing: { output_per_second: 0.1, included_reference_images: 2 } };
  await one(srv, nodes.map((n) => n.id === "v1" ? { ...n, fields: { ...n.fields, model: "someone-else-v1" } } : n), links, { catalog: { video: [other] } }).run({});
  assert.equal(srv.of("POST /api/generate-video")[1].json.reference_images.length, 2);

  // no param key AND no ref pricing → still "no refs" (an ignored-but-sent array is charged)
  const plain = { id: "plain-v1", supported_parameters: { parameters: { duration: {} } }, pricing: { output_per_second: 0.1 } };
  await one(srv, nodes.map((n) => n.id === "v1" ? { ...n, fields: { ...n.fields, model: "plain-v1" } } : n), links, { catalog: { video: [plain] } }).run({});
  assert.equal(srv.of("POST /api/generate-video")[2].json.reference_images, undefined);
});

test("video dims: catalog wire-name mapping (orientation/seconds) + default backfill", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const done = { json: { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } } } } };
  srv.script("POST /api/generate-video", { json: { runId: "vid_a", cost: 0 } });
  srv.script("POST /api/generate-video", { json: { runId: "vid_b", cost: 0 } });
  srv.script("GET /api/video/status", [done, done]);

  const nodes = [
    { id: "t1", type: "text", fields: { text: "waves" } },
    { id: "v1", type: "tvideo", fields: { model: "sora-like", aspect: "9:16", duration: "" } },
  ];
  const links = [{ id: "l1", from: { node: "t1", port: "text" }, to: { node: "v1", port: "prompt" } }];
  const catalog = { video: [{ id: "sora-like", supported_parameters: { parameters: {
    orientation: { options: [], default: "landscape" },
    seconds: { options: [], default: "8" },
  } } }] };
  await one(srv, nodes, links, { catalog }).run({});
  const b1 = srv.of("POST /api/generate-video")[0].json;
  assert.equal(b1.orientation, "9:16", "aspect rides the model's wire name");
  assert.equal(b1.seconds, "8", "blank duration backfills the catalog default under the model's name");
  assert.equal(b1.aspect_ratio, undefined);
  assert.equal(b1.duration, undefined);

  await one(srv, nodes, links).run({}); // no catalog → standard names, no backfill
  const b2 = srv.of("POST /api/generate-video")[1].json;
  assert.equal(b2.aspect_ratio, "9:16");
  assert.equal(b2.duration, undefined);
});

test("video dims: leftover Omni v1.1 resolution omitted on v1; listed 4k still posts", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const done = { json: { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/v.mp4" } } } } };
  for (let i = 0; i < 5; i++) srv.script("POST /api/generate-video", { json: { runId: "vid_omni_" + i, cost: 0 } });
  srv.script("GET /api/video/status", [done, done, done, done, done]);

  const omniV1 = { id: "google/gemini-omni-flash", supported_parameters: { parameters: {
    duration: { type: "select", default: "8", options: [{ value: "8" }] },
    aspect_ratio: { type: "select", default: "16:9", options: [{ value: "16:9" }, { value: "9:16" }] },
  } } };
  const omni11 = { id: "google/gemini-omni-flash/v1.1", supported_parameters: { parameters: {
    duration: { type: "select", default: "8", options: [{ value: "8" }] },
    resolution: { type: "select", default: "720p", options: [{ value: "720p" }, { value: "4k" }] },
    aspect_ratio: { type: "select", default: "16:9", options: [{ value: "16:9" }, { value: "9:16" }] },
  } } };
  const catalog = { video: [omniV1, omni11] };
  const fields = { prompt: "turntable", duration: "8", aspect: "16:9", resolution: "4k" };
  const tvideo = (model) => [{ id: "v1", type: "tvideo", fields: { ...fields, model } }];

  await one(srv, tvideo("google/gemini-omni-flash"), [], { catalog }).run({});
  const v1 = srv.of("POST /api/generate-video")[0].json;
  assert.equal(v1.resolution, undefined, "leftover 4k from Omni 1.1 must not POST on v1");
  assert.equal(v1.aspect_ratio, "16:9");
  assert.equal(v1.duration, "8");

  await one(srv, tvideo("google/gemini-omni-flash/v1.1"), [], { catalog }).run({});
  const v11 = srv.of("POST /api/generate-video")[1].json;
  assert.equal(v11.resolution, "4k", "listed Omni 1.1 4k still posts");

  await one(srv, [{ id: "s1", type: "vupload", fields: { video: "https://cdn.example/src.mp4" } },
    { id: "v1", type: "vedit", fields: { model: "google/gemini-omni-flash", ...fields } }],
    [{ id: "l1", from: { node: "s1", port: "video" }, to: { node: "v1", port: "video" } }],
    { catalog }).run({});
  const ved = srv.of("POST /api/generate-video")[2].json;
  assert.equal(ved.resolution, undefined, "vedit omits leftover resolution when the catalog does not list it");

  // no catalog → send-everything fallback (offline export)
  await one(srv, tvideo("google/gemini-omni-flash")).run({});
  const offline = srv.of("POST /api/generate-video")[3].json;
  assert.equal(offline.resolution, "4k", "absent catalog keeps leftover resolution");

  // model absent from a populated catalog is also permissive
  await one(srv, tvideo("unknown-video-model"), [], { catalog }).run({});
  const miss = srv.of("POST /api/generate-video")[4].json;
  assert.equal(miss.resolution, "4k", "uncatalogued model keeps leftover resolution");
});
