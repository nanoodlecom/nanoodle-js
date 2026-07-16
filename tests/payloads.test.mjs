import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Workflow } from "../src/index.mjs";
import { startMockServer, mockOpts, PNG_B64, PNG_DATA_URL, WAV_DATA_URL } from "./harness/mock-server.mjs";

const fixture = (name) => fileURLToPath(new URL("./fixtures/" + name, import.meta.url));
const wfFromFixture = async (name, srv) => Workflow.load(fixture(name), mockOpts(srv));

test("llm vision + JSON format + reasoning effort: exact chat payload", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: '{"answer":"a dot"}' } }], x_nanogpt_pricing: { costUsd: 0.002 } } });

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
  assert.equal(result.get("LLM"), '{"answer":"a dot"}');
});

test("llm wired audio: input_audio part with base64 body (no data: prefix) + format", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "heard it" } }], cost: 0 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: WAV_DATA_URL } },
      { id: "n2", type: "llm", fields: { model: "gemini-audio", prompt: "what do you hear?" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  const result = await wf.run({});

  const { messages } = srv.requests[0].json;
  // empty system field → the spec default fills in (mirrors the play page's prefilled textarea)
  assert.deepEqual(messages[0], { role: "system", content: "You are a helpful, concise assistant." });
  const content = messages[1].content;
  assert.equal(content[0].text, "what do you hear?");
  assert.deepEqual(content[1], {
    type: "input_audio",
    input_audio: { data: WAV_DATA_URL.split(",")[1], format: "wav" },
  });
  // present-but-zero cost = known-free, kept exact
  assert.equal(result.costUsd, 0);
  assert.equal(result.costExact, true);
});

test("vision node: q + image_url message", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "a red square" } }], cost: 0.001 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "vision", fields: { model: "gpt-5o", q: "" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, mockOpts(srv));
  const result = await wf.run({});

  assert.deepEqual(srv.requests[0].json.messages, [{
    role: "user",
    content: [
      { type: "text", text: "Describe this image." }, // default question
      { type: "image_url", image_url: { url: PNG_DATA_URL } },
    ],
  }]);
  assert.equal(result.get("Vision"), "a red square");
});

test("edit multi-image: imageDataUrl ARRAY in port order + seed + size verbatim", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.03 } });

  const wf = await wfFromFixture("edit-multi.json", srv);
  await wf.run({});

  assert.deepEqual(srv.requests[0].json, {
    model: "nano-banana-2",
    size: "1k",
    n: 1,
    response_format: "b64_json",
    prompt: "blend both",
    imageDataUrl: ["data:image/png;base64,AAA1", "data:image/png;base64,AAA2"],
    seed: 42,
  });
});

test("edit single image: imageDataUrl is a STRING", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ url: "https://cdn.example/edited.png" }], cost: 0.02 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "edit", fields: { model: "nano-banana-2", prompt: "make it blue" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, mockOpts(srv));
  const result = await wf.run({});

  assert.equal(srv.requests[0].json.imageDataUrl, PNG_DATA_URL);
  assert.equal(srv.requests[0].json.size, "1024x1024"); // spec default when unset
  assert.equal(result.get("Edit").url, "https://cdn.example/edited.png"); // d.url branch
});

test("inpaint: source passes through; mask is composited onto black at source size", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 } });

  // 1×1 white opaque PNG (repaint-everywhere mask) — different from the 1×1 source only in color.
  const WHITE_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "inpaint", fields: { model: "flux-fill", image: PNG_DATA_URL, mask: WHITE_PNG } }],
    links: [],
  }, mockOpts(srv));
  await wf.run({ "What to paint in": "a hat" });

  const body = srv.requests[0].json;
  assert.equal(body.prompt, "a hat");
  assert.equal(body.imageDataUrl, PNG_DATA_URL);
  // mask is re-encoded as PNG after composite (not the raw input string)
  assert.match(body.maskDataUrl, /^data:image\/png;base64,/);
  assert.notEqual(body.maskDataUrl, WHITE_PNG);
});

test("image variations: n rides the request; all urls returned; b64 mime sniffed", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const JPEG_B64 = "/9j/fakejpegbody";
  srv.script("POST /v1/images/generations", { json: { data: [{ b64_json: JPEG_B64 }, { b64_json: PNG_B64 }], cost: 0.04 } });

  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "image", fields: { model: "flux-dev", prompt: "two cats", variations: "2" } }],
    links: [],
  }, mockOpts(srv));
  const result = await wf.run({});

  assert.equal(srv.requests[0].json.n, 2);
  assert.equal(result.nodes.n1.out.images.length, 2);
  assert.ok(result.nodes.n1.out.images[0].startsWith("data:image/jpeg;base64,")); // JPEG magic sniffed
  assert.ok(result.nodes.n1.out.images[1].startsWith("data:image/png;base64,"));
});

test("draw: chat payload without response_format; images parsed from message.images", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", {
    json: {
      choices: [{ message: { content: "here you go", images: [{ image_url: { url: "data:image/png;base64,DRAWN" } }] } }],
      x_nanogpt_pricing: { cost: 0.01 },
    },
  });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "draw", fields: { model: "gemini-3-pro-image-preview", prompt: "add a moon", system: "" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "img1" } }],
  }, mockOpts(srv));
  const result = await wf.run({});

  const body = srv.requests[0].json;
  assert.ok(!("response_format" in body));
  assert.deepEqual(body.messages[0].content[1], { type: "image_url", image_url: { url: PNG_DATA_URL } });
  assert.equal(result.get("Draw").url, "data:image/png;base64,DRAWN");
  assert.equal(result.nodes.n2.out.text, "here you go"); // secondary port exposed on the node record
});

test("tvideo: submit payload + poll loop pending→completed + reference images", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_1", cost: 0.25, remainingBalance: 3.0 } });
  srv.script("GET /api/video/status", [
    { json: { status: "PENDING" } },
    { json: { data: { status: "IN_PROGRESS" } } },
    { json: { data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/fox.mp4" } } } } },
  ]);

  const wf = await wfFromFixture("video-poll.json", srv);
  const polls = [];
  const result = await wf.run({}, { onProgress: (e) => { if (e.type === "poll") polls.push(e.status); } });

  const submit = srv.requests[0];
  assert.deepEqual(submit.json, {
    model: "veo-3.1-fast",
    prompt: "a fox running through snow",
    duration: "5",
    aspect_ratio: "16:9", // aspect field rides under the standard wire name
    resolution: "720p",
    seed: 7, // fields.modelOpts merged
  });
  const pollReqs = srv.of("GET /api/video/status");
  assert.equal(pollReqs.length, 3);
  assert.equal(pollReqs[0].query.requestId, "vid_1");
  assert.deepEqual(polls, ["PENDING", "IN_PROGRESS", "COMPLETED"]);
  assert.equal(result.get("Text→Video").url, "https://cdn.example/fox.mp4");
  assert.equal(result.costUsd, 0.25);
});

test("tvideo wired refs → reference_images array", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { id: "vid_2", cost: 0.2 } }); // j.id fallback
  srv.script("GET /api/video/status", { json: { status: "SUCCEEDED", output: { url: "https://cdn.example/v.mp4" } } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: "data:image/png;base64,REF1" } },
      { id: "n2", type: "upload", fields: { image: "data:image/png;base64,REF2" } },
      { id: "n3", type: "tvideo", fields: { model: "seedance-2.0", prompt: "morph" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "image" }, to: { node: "n3", port: "ref1" } },
      { id: "l2", from: { node: "n2", port: "image" }, to: { node: "n3", port: "ref2" } },
    ],
  }, mockOpts(srv));
  await wf.run({});

  assert.deepEqual(srv.requests[0].json.reference_images, ["data:image/png;base64,REF1", "data:image/png;base64,REF2"]);
});

test("ivideo: source → imageDataUrl, wired endframe → last_image", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_3", cost: 0.3 } });
  srv.script("GET /api/video/status", { json: { data: { status: "COMPLETED", output: { url: "https://cdn.example/anim.mp4" } } } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: "data:image/png;base64,SRC" } },
      { id: "n2", type: "upload", fields: { image: "data:image/png;base64,END" } },
      { id: "n3", type: "ivideo", fields: { model: "kling-2.5", prompt: "zoom out", duration: "5", aspect: "9:16" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "image" }, to: { node: "n3", port: "image" } },
      { id: "l2", from: { node: "n2", port: "image" }, to: { node: "n3", port: "endframe" } },
    ],
  }, mockOpts(srv));
  await wf.run({});

  const body = srv.requests[0].json;
  assert.equal(body.imageDataUrl, "data:image/png;base64,SRC");
  assert.equal(body.last_image, "data:image/png;base64,END");
  assert.equal(body.aspect_ratio, "9:16");
});

test("vedit: https source rides as videoUrl, data: as videoDataUrl", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_4", cost: 0.1 } });
  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/edit.mp4" } } });

  const mk = (videoUrl) => Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "vupload", fields: { video: videoUrl } },
      { id: "n2", type: "vedit", fields: { model: "runway-v2v", prompt: "make it night" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "video" }, to: { node: "n2", port: "video" } }],
  }, mockOpts(srv));

  await mk("https://cdn.example/src.mp4").run({});
  assert.equal(srv.requests[0].json.videoUrl, "https://cdn.example/src.mp4");
  assert.ok(!("videoDataUrl" in srv.requests[0].json));

  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/edit.mp4" } } });
  await mk("data:video/mp4;base64,VID").run({});
  const second = srv.of("POST /api/generate-video")[1];
  assert.equal(second.json.videoDataUrl, "data:video/mp4;base64,VID");
  assert.ok(!("videoUrl" in second.json));
});

test("lipsync: image + local audio → imageDataUrl + audioDataUrl", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_5", cost: 0.4 } });
  srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { video: { url: "https://cdn.example/talk.mp4" } } } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "n2", type: "aupload", fields: { audio: WAV_DATA_URL } },
      { id: "n3", type: "lipsync", fields: { model: "sonic-avatar", prompt: "" } },
    ],
    links: [
      { id: "l1", from: { node: "n1", port: "image" }, to: { node: "n3", port: "image" } },
      { id: "l2", from: { node: "n2", port: "audio" }, to: { node: "n3", port: "audio" } },
    ],
  }, mockOpts(srv));
  await wf.run({});

  const body = srv.requests[0].json;
  assert.equal(body.imageDataUrl, PNG_DATA_URL);
  assert.equal(body.audioDataUrl, WAV_DATA_URL);
  assert.ok(!("audioUrl" in body));
});

test("video FAILED status raises with the server error", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_6", cost: 0.2 } });
  srv.script("GET /api/video/status", { json: { data: { status: "FAILED", error: "nsfw content detected" } } });

  const wf = await wfFromFixture("video-poll.json", srv);
  await assert.rejects(wf.run({}), (e) => {
    assert.equal(e.name, "RunError");
    assert.match(e.message, /video failed: nsfw content detected/);
    assert.equal(e.result.nodes.n1.status, "error");
    return true;
  });
});

test("video poll timeout raises after timeouts.video", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "vid_7", cost: 0.2 } });
  srv.script("GET /api/video/status", { json: { status: "PENDING" } });

  const wf = await wfFromFixture("video-poll.json", srv);
  wf.client.timeouts.video = 60; // three ~10ms polls then give up
  await assert.rejects(wf.run({}), /video timed out/);
});

test("tts binary: payload params, mime pinned from format, x-cost header cost", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const mp3Bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
  srv.script("POST /api/v1/audio/speech", {
    headers: { "content-type": "application/octet-stream", "x-cost": "0.005", "x-remaining-balance": "3.2" },
    body: mp3Bytes,
  });

  const wf = await wfFromFixture("tts-binary.json", srv);
  const result = await wf.run({});

  assert.deepEqual(srv.requests[0].json, {
    model: "kokoro-82m",
    input: "hello world",
    voice: "af_bella",
    // speed 1 omitted (default), instructions empty omitted, response_format mp3 default omitted
  });
  const audio = result.get("Speech");
  assert.equal(audio.mime, "audio/mpeg"); // pinned from requested mp3 format over octet-stream
  assert.deepEqual([...(await audio.bytes())], [...mp3Bytes]);
  assert.equal(result.costUsd, 0.005); // header fallback
  assert.equal(result.remainingBalance, 3.2);
  assert.equal(result.costExact, true);
});

test("music async: JSON runId → tts/status poll with refund params; extraJson merged", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", {
    json: { runId: "aud_1", cost: 0.1, paymentSource: "balance", isApiRequest: true, remainingBalance: 2.5 },
  });
  srv.script("GET /api/tts/status", [
    { json: { status: "pending", queuePosition: 2 } },
    { json: { status: "completed", audioUrl: "https://cdn.example/track.mp3" } },
  ]);

  const wf = await wfFromFixture("music-poll.json", srv);
  const result = await wf.run({});

  assert.deepEqual(srv.requests[0].json, {
    model: "suno-v5",
    input: "lofi beat for studying",
    instrumental: true,
    duration: 30,
    seed: 11,
    style_weight: 0.6, // extraJson merged verbatim last
  });
  const poll = srv.of("GET /api/tts/status")[0];
  assert.deepEqual(poll.query, {
    runId: "aud_1",
    model: "suno-v5",
    cost: "0.1",
    paymentSource: "balance",
    isApiRequest: "true",
  });
  assert.equal(result.get("Music").url, "https://cdn.example/track.mp3");
  assert.equal(result.costUsd, 0.1);
});

test("music JSON direct url branch (no poll)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/song.mp3", cost: 0.08 } });

  const wf = await wfFromFixture("music-poll.json", srv);
  const result = await wf.run({});
  assert.equal(srv.of("GET /api/tts/status").length, 0);
  assert.equal(result.get("Music").url, "https://cdn.example/song.mp3");
});

test("audio poll failure status raises 'audio failed'", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "aud_2", cost: 0.1 } });
  srv.script("GET /api/tts/status", { json: { status: "content_policy_violation", error: "lyrics rejected" } });

  const wf = await wfFromFixture("music-poll.json", srv);
  await assert.rejects(wf.run({}), /audio failed: lyrics rejected/);
});

test("remix: source audio param (data: inlined, https as-is) + lyrics/duration", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/cover.mp3", cost: 0.12 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: WAV_DATA_URL } },
      { id: "n2", type: "remix", fields: { model: "ace-step-cover", prompt: "make it jazz", lyrics: "la la", duration: "20" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await wf.run({});

  assert.deepEqual(srv.requests[0].json, {
    model: "ace-step-cover",
    input: "make it jazz",
    lyrics: "la la",
    duration: 20,
    audio: WAV_DATA_URL,
  });
});

test("transcribe: multipart with field name 'file' + model + language; text parsed; metadata cost", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/transcriptions", { json: { text: "hello there", metadata: { cost: 0.001 } } });

  const wf = await wfFromFixture("transcribe.json", srv);
  const result = await wf.run({});

  const req = srv.requests[0];
  assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(req.headers["x-api-key"], "test-key");
  const body = req.raw.toString("latin1");
  assert.match(body, /name="file"; filename="audio\.wav"/); // the audio field MUST be "file"
  assert.match(body, /name="model"[\s\S]*?whisper-large-v3/);
  assert.match(body, /name="language"[\s\S]*?en/);
  assert.equal(result.get("Transcribe"), "hello there");
  assert.equal(result.costUsd, 0.001);
});
