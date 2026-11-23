import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, NanoClient, RunError } from "../src/index.mjs";
import { startMockServer, mockOpts, WAV_B64 } from "./harness/mock-server.mjs";

const llmWf = (srv, fields = {}) => Workflow.fromJSON({
  nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi", ...fields } }],
  links: [],
}, mockOpts(srv));

test("chat parse: content null → 'no text in response'; empty string is a billed-but-empty reply, not an error", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: null } }] } });
  await assert.rejects(llmWf(srv).run({}), /no text in response/);

  // dual-engine parity: the editor/play built-in parsers throw only on null — an empty string is
  // a real (billed) reply and must flow through, not poison dependents as a node error
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "" } }] } });
  const empty = await llmWf(srv).run({});
  assert.equal(empty.get("LLM"), "");
});

test("chat parse: array content joins its .text parts", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", {
    json: { choices: [{ message: { content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }, { type: "other" }] } }], cost: 0.001 },
  });
  const result = await llmWf(srv).run({});
  assert.equal(result.get("LLM"), "Hello world");
});

test("chat parse failure preserves the provider's reported cost and remaining balance", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "llm", fields: { model: "m", prompt: "hi" } }],
    links: [],
  }, {
    apiKey: "test-key",
    fetch: async () => new Response('{"choices":[', {
      headers: { "content-type": "application/json", "x-cost": "0.07", "x-remaining-balance": "3.45" },
    }),
  });
  await assert.rejects(wf.run({}), error => {
    assert.ok(error instanceof RunError);
    assert.equal(error.result.costUsd, 0.07);
    assert.equal(error.result.nodes.n1.costUsd, 0.07);
    assert.equal(error.result.costExact, true);
    assert.equal(error.result.remainingBalance, 3.45);
    return true;
  });
});

test("llm showThinking: message.reasoning rides in a thinking fence before the answer", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", {
    json: { choices: [{ message: { content: "42", reasoning: "six times seven" } }], cost: 0.001 },
  });
  const result = await llmWf(srv, { showThinking: "true" }).run({});
  assert.equal(result.get("LLM"), "```thinking\nsix times seven\n```\n\n42");

  // showThinking off → the trace is dropped
  srv.script("POST /api/v1/chat/completions", {
    json: { choices: [{ message: { content: "42", reasoning: "six times seven" } }], cost: 0.001 },
  });
  const plain = await llmWf(srv).run({});
  assert.equal(plain.get("LLM"), "42");
});

test("image parse: empty data list reports failure and retains the bill once", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", {
    json: { data: [], cost: 0.02, remainingBalance: 4 },
    headers: { "x-cost": "0.08", "x-remaining-balance": "3.45" },
  });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "image", fields: { model: "flux", prompt: "x" } }],
    links: [],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), error => {
    assert.ok(error instanceof RunError);
    assert.match(error.message, /no image in response/);
    assert.equal(error.result.costUsd, 0.02, "JSON cost takes precedence and is counted once");
    assert.equal(error.result.nodes.n1.costUsd, 0.02);
    assert.equal(error.result.costExact, true);
    assert.equal(error.result.remainingBalance, 3.45, "the balance header takes precedence");
    return true;
  });
});

for (const [kind, call] of [
  ["chat", (client, io) => client.chat([], "m", {}, io)],
  ["decide", (client, io) => client.decide({}, io)],
  ["image", (client, io) => client.image({ model: "m" }, io)],
  ["video", (client, io) => client.video("m", "hi", {}, undefined, io)],
  ["audio", (client, io) => client.audio("m", "hi", {}, io)],
  ["transcribe", (client, io) => client.transcribe("m", "data:audio/wav;base64," + WAV_B64, null, io)],
]) {
  test(`${kind} calls the cost callback once when successful HTTP carries invalid JSON`, async () => {
    const events = [];
    const parseError = new SyntaxError("provider response cut short");
    const client = new NanoClient({
      apiKey: "test-key",
      fetch: async () => ({
        ok: true,
        headers: new Headers({
          "content-type": "application/json", "x-nano-cost": "0.11", "x-remaining-balance": "4.5",
        }),
        json: () => Promise.reject(parseError),
      }),
    });
    await assert.rejects(call(client, { onCost: cost => events.push(cost) }), error => error === parseError);
    assert.deepEqual(events, [{ usd: 0.11, balance: 4.5 }]);
  });
}

test("Decide keeps usage cost and header balance precedence in a valid reply", async () => {
  const body = {
    answers: {}, usage: { cost: 0.02 }, cost: 0.03,
    x_nanogpt_pricing: { costUsd: 0.04 }, remainingBalance: 1,
  };
  const costs = [];
  const client = new NanoClient({
    fetch: async () => Response.json(body, { headers: { "x-cost": "0.05", "x-remaining-balance": "2" } }),
  });
  assert.deepEqual(await client.decide({}, { onCost: cost => costs.push(cost) }), body);
  assert.deepEqual(costs, [{ usd: 0.02, balance: 2 }]);
});

for (const kind of ["video", "audio"]) {
  test(`${kind} preserves an accepted job and its accounting when the submit body settles after Stop`, async () => {
    const ac = new AbortController();
    const body = { runId: "paid-job", cost: 0.05, paymentSource: "balance", isApiRequest: true };
    const events = [];
    const client = new NanoClient({
      apiKey: "test-key",
      fetch: async (_url, init) => {
        assert.equal(init.method, "POST", "stopped work must not start polling");
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json", "x-remaining-balance": "4.2" }),
          json: async () => {
            ac.abort(new Error("stopped during submit"));
            return body;
          },
        };
      },
    });
    const io = { signal: ac.signal, onCost: cost => events.push(cost), onRunId: job => events.push(job) };
    const run = kind === "video" ? client.video("m", "hi", {}, undefined, io) : client.audio("m", "hi", {}, io);
    await assert.rejects(run, /stopped during submit/);
    assert.deepEqual(events, [{ usd: 0.05, balance: 4.2 }, kind === "video" ? body.runId : body]);
  });
}

test("transcribe parse priority: transcription → text → data.transcription/text", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wf = () => Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "data:audio/wav;base64," + WAV_B64 } },
      { id: "n2", type: "transcribe", fields: { model: "whisper-large-v3" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));

  srv.script("POST /api/v1/audio/transcriptions", { json: { transcription: "first", text: "shadowed", cost: 0.001 } });
  assert.equal((await wf().run({})).get("Transcribe"), "first");

  srv.script("POST /api/v1/audio/transcriptions", { json: { data: { text: "nested" }, cost: 0.001 } });
  assert.equal((await wf().run({})).get("Transcribe"), "nested");

  srv.script("POST /api/v1/audio/transcriptions", { json: { language: "en" } });
  await assert.rejects(wf().run({}), /no transcription in response/);
});

test("binary audio with a concrete content-type keeps it (no format pin)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wavBytes = Buffer.from(WAV_B64, "base64");
  srv.script("POST /api/v1/audio/speech", {
    headers: { "content-type": "audio/wav", "x-cost": "0.004" },
    body: wavBytes,
  });
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "tts", fields: { model: "kokoro-82m", prompt: "hello" } }],
    links: [],
  }, mockOpts(srv));
  const result = await wf.run({});
  const audio = result.get("Speech");
  assert.equal(audio.mime, "audio/wav"); // server's own type wins over the mp3 default pin
  assert.deepEqual(Buffer.from(await audio.bytes()), wavBytes);
});

test("transcribe with an https source: media download carries NO auth headers, then multipart upload", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const wavBytes = Buffer.from(WAV_B64, "base64");
  srv.script("GET /media/clip.mp3", { headers: { "content-type": "audio/mpeg" }, body: wavBytes });
  srv.script("POST /api/v1/audio/transcriptions", { json: { text: "spoken words", cost: 0.001 } });

  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: srv.url + "/media/clip.mp3" } },
      { id: "n2", type: "transcribe", fields: { model: "whisper-large-v3" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  const result = await wf.run({});

  const dl = srv.of("GET /media/clip.mp3")[0];
  assert.equal(dl.headers.authorization, undefined); // never leak the key to a media CDN
  assert.equal(dl.headers["x-api-key"], undefined);
  const up = srv.of("POST /api/v1/audio/transcriptions")[0];
  assert.equal(up.headers.authorization, "Bearer test-key"); // API upload IS authed
  assert.match(up.raw.toString("latin1"), /name="file"; filename="audio\.mpeg"/); // ext from the download's content-type
  assert.equal(result.get("Transcribe"), "spoken words");
});

test("transcribe local guard: clips over ~3.5MB refused before any request", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  const bigB64 = Buffer.alloc(3.7 * 1024 * 1024).toString("base64");
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "aupload", fields: { audio: "data:audio/wav;base64," + bigB64 } },
      { id: "n2", type: "transcribe", fields: { model: "whisper-large-v3" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "audio" }, to: { node: "n2", port: "audio" } }],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), /too big to transcribe directly/);
  assert.equal(srv.requests.length, 0);
});

test("checkBalance helper: POST {} with both auth headers → usd_balance", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/check-balance", { json: { usd_balance: 12.34 } });

  const client = new NanoClient({ apiKey: "test-key", baseUrl: srv.url });
  const j = await client.checkBalance();
  assert.equal(j.usd_balance, 12.34);
  const req = srv.requests[0];
  assert.deepEqual(req.json, {});
  assert.equal(req.headers.authorization, "Bearer test-key");
  assert.equal(req.headers["x-api-key"], "test-key");
});
