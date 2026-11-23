import test from "node:test";
import assert from "node:assert/strict";
import {
  Workflow, MediaRef, materialize, estimateGraphCost, graphModelKinds,
  deriveInputs, deriveOutputs, deriveSettings, NODE_TYPES,
} from "../src/index.mjs";
import { model3dStatusUrl } from "../src/client.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

const g = (...nodes) => ({ nodes, links: [] });

test("loader accepts cleanvoice, model3d, mupload, and endpoint", () => {
  const { warnings, nodes } = materialize({
    nodes: [
      { id: "a", type: "cleanvoice", fields: { url: "https://cdn.example/in.mp3" } },
      { id: "b", type: "model3d", fields: { prompt: "a cup" } },
      { id: "c", type: "mupload", fields: { model: "https://cdn.example/a.glb" } },
      { id: "d", type: "endpoint", fields: { url: "http://127.0.0.1:8787/v1/chat/completions", prompt: "hi" } },
    ],
    links: [],
  });
  assert.equal(warnings.length, 0);
  assert.deepEqual(nodes.map((n) => n.type), ["cleanvoice", "model3d", "mupload", "endpoint"]);
  for (const type of ["cleanvoice", "model3d", "mupload", "endpoint"]) {
    assert.ok(NODE_TYPES[type], type);
    assert.ok(NODE_TYPES[type].outputs.length, type + " outputs");
  }
});

test("derive IO: 3D file, endpoint mode port, clean voice settings", () => {
  const graph = materialize({
    nodes: [
      { id: "u", type: "mupload", fields: {} },
      { id: "e", type: "endpoint", fields: { mode: "image", prompt: "a cat" } },
      { id: "c", type: "cleanvoice", fields: {} },
      { id: "d", type: "model3d", fields: { prompt: "" } },
    ],
    links: [],
  });
  const inputs = deriveInputs(graph);
  assert.ok(inputs.some((i) => i.nodeId === "u" && i.field === "model" && i.kind === "model3d"));
  assert.ok(inputs.some((i) => i.nodeId === "d" && i.field === "prompt" && i.optional));
  const ep = deriveOutputs(graph).find((o) => o.nodeId === "e");
  assert.deepEqual(ep.ports, [{ name: "image", type: "image" }]);
  const settings = deriveSettings(graph);
  assert.ok(settings.some((s) => s.nodeId === "c" && s.field === "url"));
  assert.ok(settings.some((s) => s.nodeId === "e" && s.field === "mode"));
  assert.ok(settings.some((s) => s.nodeId === "d" && s.field === "model"));
});

test("model3dStatusUrl requires a 3D payload", () => {
  assert.equal(model3dStatusUrl({
    data: { output: { kind: "3d", format: "glb", model_url: "https://cdn.example/cup.glb" } },
  }), "https://cdn.example/cup.glb");
  assert.equal(model3dStatusUrl({
    data: { output: { format: "glb", videoUrls: ["https://cdn.example/from-list.glb"] } },
  }), "https://cdn.example/from-list.glb");
  assert.equal(model3dStatusUrl({
    data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/clip.mp4" } } },
  }), "");
});

test("cleanvoice: data URL is refused before any request", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "a", type: "aupload", fields: { audio: PNG_DATA_URL } },
      { id: "c", type: "cleanvoice", fields: {} },
    ],
    links: [{ id: "l", from: { node: "a", port: "audio" }, to: { node: "c", port: "audio" } }],
  }, mockOpts(srv));
  await assert.rejects(() => wf.run({}), /hosted file|public https/i);
  assert.equal(srv.requests.length, 0);
});

test("cleanvoice: posts the public URL, polls /api/tts/status, default model", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { runId: "cv1", cost: 0.121 } });
  srv.script("GET /api/tts/status", { json: { status: "completed", audioUrl: "https://cdn.example/clean.mp3" } });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "c", type: "cleanvoice", fields: { url: "https://cdn.example/interview.mp4" } }],
    links: [],
  }, mockOpts(srv));
  const result = await wf.run({});
  const body = srv.of("POST /api/v1/audio/speech")[0].json;
  assert.equal(body.model, "elevenlabs/audio-isolation");
  assert.equal(body.audio, "https://cdn.example/interview.mp4");
  assert.equal(body.duration, 60); // no media element in Node → quote a minute
  assert.equal(srv.of("GET /api/tts/status")[0].query.runId, "cv1");
  assert.equal(result.get("Clean voice").url, "https://cdn.example/clean.mp3");
  assert.equal(result.costUsd, 0.121);
});

test("cleanvoice: an explicit model id is sent", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/audio/speech", { json: { url: "https://cdn.example/v.mp3", cost: 0.02 } });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "c", type: "cleanvoice", fields: { model: "veed/clean-audio", url: "https://cdn.example/in.wav" } }],
    links: [],
  }, mockOpts(srv));
  await wf.run({});
  assert.equal(srv.of("POST /api/v1/audio/speech")[0].json.model, "veed/clean-audio");
});

test("model3d: image-only default omits an empty prompt and reads model_url", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "m1", cost: 0.4 } });
  srv.script("GET /api/video/status", { json: {
    data: { status: "COMPLETED", output: { kind: "3d", format: "glb", model_url: "https://cdn.example/cup.glb" } },
  } });
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "u", type: "upload", fields: { image: "https://cdn.example/photo.png" } },
      { id: "d", type: "model3d", fields: {} },
    ],
    links: [{ id: "l", from: { node: "u", port: "image" }, to: { node: "d", port: "image" } }],
  }, mockOpts(srv));
  const result = await wf.run({});
  const body = srv.of("POST /api/generate-video")[0].json;
  assert.equal(body.model, "tripo3d/v2.5");
  assert.equal(body.imageDataUrl, "https://cdn.example/photo.png");
  assert.equal("prompt" in body, false);
  assert.equal(result.get("3D model").url, "https://cdn.example/cup.glb");
  assert.equal(result.costUsd, 0.4);
});

test("model3d: text+image catalog sends the prompt; a video-shaped status is not a model", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/generate-video", { json: { runId: "m2", cost: 0.5 } });
  srv.script("GET /api/video/status", { json: {
    data: { status: "COMPLETED", output: { video: { url: "https://cdn.example/not-a-model.mp4" } } },
  } });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "d", type: "model3d", fields: { model: "wavespeed-ai/hunyuan-3d-v3.1-rapid", prompt: "ceramic cup" } }],
    links: [],
  }, {
    ...mockOpts(srv),
    catalog: { model3d: [{ id: "wavespeed-ai/hunyuan-3d-v3.1-rapid", architecture: { input_modalities: ["text", "image"] } }] },
  });
  await assert.rejects(() => wf.run({}), /no model url/);
  const body = srv.of("POST /api/generate-video")[0].json;
  assert.equal(body.prompt, "ceramic cup");
  assert.equal(body.model, "wavespeed-ai/hunyuan-3d-v3.1-rapid");
});

test("model3d: image-only model refuses a prompt with no photo", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = Workflow.fromJSON({
    nodes: [{ id: "d", type: "model3d", fields: { model: "tripo3d/v2.5", prompt: "a cup" } }],
    links: [],
  }, mockOpts(srv));
  await assert.rejects(() => wf.run({}), /Connect an image/);
  assert.equal(srv.requests.length, 0);
});

test("mupload returns the stored glb", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "m", type: "mupload", fields: { model: "https://cdn.example/mesh.glb" } }],
    links: [],
  }, { apiKey: "test-key", quiet: true });
  const result = await wf.run({});
  assert.equal(result.get("3D input").url, "https://cdn.example/mesh.glb");
});

test("endpoint: POSTs the graph URL, never the NanoGPT key", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/chat/completions", { json: { choices: [{ message: { content: "pong" } }] } });
  const wf = Workflow.fromJSON({
    nodes: [{
      id: "e", type: "endpoint",
      fields: { url: srv.url + "/v1/chat/completions", mode: "chat", prompt: "ping", auth: "sekrit" },
    }],
    links: [],
  }, { quiet: true }); // no API key — this graph does not call NanoGPT
  const result = await wf.run({});
  assert.equal(srv.requests.length, 1);
  const req = srv.requests[0];
  assert.equal(req.path, "/v1/chat/completions");
  assert.equal(req.json.messages[0].content, "ping");
  assert.equal(req.json.model, "local");
  assert.equal(req.headers.authorization, "Bearer sekrit");
  assert.equal(req.headers["x-api-key"], undefined);
  assert.equal(result.get("Custom endpoint"), "pong");
});

test("endpoint: a wired Choice path joins onto the typed host", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /echo", { json: { choices: [{ message: { content: "echoed" } }] } });
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "ch", type: "choice", fields: { options: "/echo", selected: "/echo" } },
      { id: "e", type: "endpoint", fields: { url: srv.url + "/v1/chat/completions", prompt: "hi" } },
    ],
    links: [{ id: "l", from: { node: "ch", port: "text" }, to: { node: "e", port: "url" } }],
  }, { quiet: true });
  const result = await wf.run({});
  assert.equal(srv.requests[0].path, "/echo");
  assert.equal(result.get("Custom endpoint"), "echoed");
});

test("endpoint sink publishes the port chosen by a wired mode on each run", async () => {
  const fixtures = {
    chat: { port: "text", value: "", json: { choices: [{ message: { content: "" } }] } },
    video: { port: "video", value: "https://cdn.example/movie.mp4", json: { url: "https://cdn.example/movie.mp4" } },
    image: { port: "image", value: "https://cdn.example/picture.png", json: { data: [{ url: "https://cdn.example/picture.png" }, { url: "https://cdn.example/second.png" }] } },
    audio: { port: "audio", value: "data:audio/wav;base64,AAEC", binary: Uint8Array.of(0, 1, 2) },
    json: { port: "text", value: "/api/generate-video/content?job=not-media", json: { text: "/api/generate-video/content?job=not-media" } },
  };
  let fixture, requests = 0;
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "choice", name: "Route", type: "choice", fields: { options: Object.keys(fixtures).join("\n") } },
      { id: "e", name: "Result", type: "endpoint", fields: { url: "https://custom.example/endpoint", mode: "chat", prompt: "hi" } },
    ],
    links: [{ id: "route", from: { node: "choice", port: "text" }, to: { node: "e", port: "mode" } }],
  }, { fetch: async (url, { method }) => {
    assert.equal(url, "https://custom.example/endpoint");
    assert.equal(method, "POST");
    requests++;
    if (fixture.binary) return new Response(fixture.binary, { headers: { "content-type": "audio/wav" } });
    return Response.json(fixture.json);
  } });
  for (const [mode, expected] of Object.entries(fixtures)) {
    fixture = expected;
    const result = await wf.run({ Route: mode });
    const value = result.get("Result");
    assert.equal(result.get("e"), value);
    assert.equal(result.nodes.e.out[expected.port], expected.value);
    if (expected.port === "text") assert.equal(value, expected.value);
    else {
      assert(value instanceof MediaRef, `${mode} should use a MediaRef`);
      assert.equal(value.url, expected.value);
    }
    if (mode === "image") assert.deepEqual(result.nodes.e.out.images, expected.json.data.map(item => item.url));
    if (mode === "audio") assert.deepEqual(await value.bytes(), expected.binary);
  }
  assert.equal(requests, Object.keys(fixtures).length);
  assert.deepEqual(wf.outputs[0].ports, [{ name: "text", type: "text" }]);
});

test("endpoint sink uses a wired route prefix ahead of the authored mode and publishes provider media", async () => {
  const content = "https://nano-gpt.com/api/generate-video/content?job=fixture";
  const media = "https://cdn.example/movie.mp4";
  const requests = [];
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "choice", type: "choice", fields: { options: "video: /movie?format=mp4" } },
      { id: "e", name: "Result", type: "endpoint", fields: { url: "https://custom.example/chat", mode: "chat", prompt: "hi" } },
    ],
    links: [{ id: "route", from: { node: "choice", port: "text" }, to: { node: "e", port: "url" } }],
  }, { apiKey: "fixture", fetch: async (url, { method, body, headers }) => {
    requests.push([method, url]);
    if (url === "https://custom.example/movie?format=mp4") {
      assert.deepEqual(JSON.parse(body), { model: "local", prompt: "hi" });
      assert.equal(headers.Authorization, undefined);
      return Response.json({ url: "/api/generate-video/content?job=fixture" });
    }
    assert.equal(url, content);
    return Response.redirect(media, 302);
  } });
  const result = await wf.run();
  assert.deepEqual(requests, [["POST", "https://custom.example/movie?format=mp4"], ["GET", content]]);
  assert(result.get("Result") instanceof MediaRef);
  assert.equal(result.get("Result").url, media);
  assert.deepEqual(result.nodes.e.out, { video: media });
});

test("endpoint output metadata recognizes an authored route prefix and the run honors settings", async () => {
  const wf = Workflow.fromJSON(g({
    id: "e", name: "Result", type: "endpoint",
    fields: { mode: "chat", url: "audio | https://custom.example/audio", prompt: "hi" },
  }), { fetch: async (url) => {
    assert.equal(url, "https://custom.example/json");
    return Response.json({ text: "settings override" });
  } });
  assert.deepEqual(wf.outputs[0].ports, [{ name: "audio", type: "audio" }]);
  const result = await wf.run({}, { settings: { "e.url": "https://custom.example/json", "e.mode": "json" } });
  assert.equal(result.get("Result"), "settings override");
  assert.deepEqual(wf.outputs[0].ports, [{ name: "audio", type: "audio" }]);
});

test("video estimate: an untouched audio switch bills the catalog default", () => {
  const pricing = {
    text_to_video_with_audio_per_second: 0.2,
    text_image_without_audio_per_second: 0.1,
    default_duration: 5,
  };
  const audioOn = {
    parameters: { generate_audio: { type: "boolean", default: true } },
    defaults: { generate_audio: true },
  };
  const audioOff = {
    parameters: { generate_audio: { type: "boolean", default: false } },
    defaults: { generate_audio: false },
  };
  const cats = (sp) => ({ video: [{ id: "veo", pricing, supported_parameters: sp }] });
  const node = (modelOpts) => g({ id: "1", type: "tvideo", fields: { model: "veo", ...(modelOpts ? { modelOpts } : {}) } });

  assert.equal(estimateGraphCost(node(), cats(audioOn)).usd, 1);          // 0.2 × 5 — default on
  assert.equal(estimateGraphCost(node({ generate_audio: false }), cats(audioOn)).usd, 0.5); // explicit off
  assert.equal(estimateGraphCost(node({ generate_audio: true }), cats(audioOff)).usd, 1);   // explicit on
  assert.equal(estimateGraphCost(node(), cats(audioOff)).usd, 0.5);       // default off
  assert.equal(estimateGraphCost(node(), { video: [{ id: "veo", pricing }] }).usd, 0.5); // no descriptor → off
});

test("cleanvoice and model3d estimates, including a blank model id", () => {
  const catalogs = {
    audio: [
      { id: "elevenlabs/audio-isolation", pricing: { per_second: 0.121 / 60 } },
      { id: "veed/clean-audio", pricing: { per_billing_interval: 0.01375, billing_interval_seconds: 60 } },
    ],
    model3d: [
      { id: "tripo3d/v2.5", pricing: { per_run: 0.4 } },
      { id: "span", pricing: { per_run: 0.2, per_run_by_variant: { low: 0.2, high: 0.9 } } },
    ],
  };
  const wired = estimateGraphCost({
    nodes: [
      { id: "v", type: "tvideo", fields: { duration: "90" } },
      { id: "c", type: "cleanvoice", fields: { model: "elevenlabs/audio-isolation" } },
    ],
    links: [{ id: "l", from: { node: "v", port: "video" }, to: { node: "c", port: "video" } }],
  }, catalogs);
  assert.equal(Math.round(wired.usd * 1000) / 1000, Math.round((0.121 / 60) * 90 * 1000) / 1000);

  const blank = estimateGraphCost(g({ id: "c", type: "cleanvoice", fields: {} }), catalogs);
  assert.equal(Math.round(blank.usd * 10000) / 10000, Math.round((0.121 / 60) * 30 * 10000) / 10000);

  const veed = estimateGraphCost(g({ id: "c", type: "cleanvoice", fields: { model: "veed/clean-audio" } }), catalogs);
  assert.equal(veed.usd, 0.01375); // 30s → one started minute

  const flat = estimateGraphCost(g({ id: "d", type: "model3d", fields: {} }), catalogs);
  assert.equal(flat.usd, 0.4);
  assert.equal(flat.exact, true);

  const span = estimateGraphCost(g({ id: "d", type: "model3d", fields: { model: "span" } }), catalogs);
  assert.equal(span.usd, 0.2);
  assert.equal(span.exact, false);

  assert.ok(graphModelKinds(g({ id: "c", type: "cleanvoice", fields: {} })).has("audio"));
  assert.ok(graphModelKinds(g({ id: "d", type: "model3d", fields: {} })).has("model3d"));
});
