import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaRef, NanoClient, NanoodleError, RunError, Workflow, estimateGraphCost } from "../src/index.mjs";
import { resizeCropImage } from "../src/local-media.mjs";
import { PNG_B64 } from "./harness/mock-server.mjs";

const cdn = "https://cdn.example/clip.mp4?signature=secret#private";
const terminated = () => new TypeError("terminated " + cdn);
const brokenBody = () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => { throw terminated(); } });

test("large media save retries an interrupted HTTP body from scratch", async (t) => {
  const payload = Buffer.alloc(6 * 1024 * 1024, 7);
  let gets = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "content-type": "video/mp4", "content-length": payload.length });
    if (++gets === 1) {
      res.write(payload.subarray(0, 65536));
      setTimeout(() => res.destroy(), 10);
    } else res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "clip.mp4");
  const ref = new MediaRef(`http://127.0.0.1:${server.address().port}/clip`);
  assert.equal(await ref.save(path), path);
  assert.deepEqual(await readFile(path), payload);
  assert.equal(gets, 2);
  assert.equal(ref.mime, "video/mp4");
});

test("exhausted body failures are bounded, redacted NanoodleErrors; save preserves an existing file", async (t) => {
  let gets = 0;
  const ref = new MediaRef(cdn, { fetch: async () => { gets++; return brokenBody(); } });
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-download-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "keep.mp4");
  await writeFile(path, "keep");
  await assert.rejects(ref.save(path), (e) => {
    assert.ok(e instanceof NanoodleError);
    assert.match(e.message, /couldn't download media/);
    assert.match(e.message, /cdn\.example\/clip\.mp4/);
    assert.doesNotMatch(String(e.stack), /signature|secret|private/);
    return true;
  });
  assert.equal(gets, 3);
  assert.equal(await readFile(path, "utf8"), "keep");
});

test("media connection failures retry, HTTP rejections and aborts do not", async () => {
  let gets = 0;
  const ref = new MediaRef(cdn, { fetch: async () => {
    if (++gets < 3) throw terminated();
    return new Response("ok", { headers: { "content-type": "video/mp4" } });
  } });
  assert.equal(new TextDecoder().decode(await ref.bytes()), "ok");
  assert.equal(gets, 3);
  for (const failure of [new Response("denied", { status: 403 }), new DOMException("stop", "AbortError")]) {
    gets = 0;
    const ref = new MediaRef(cdn, { fetch: async () => {
      gets++;
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    await assert.rejects(ref.bytes(), failure instanceof Error ? (e) => e === failure : /\(403\)/);
    assert.equal(gets, 1);
  }
});

test("inline, transcription, and local media downloads recover without repeating a paid POST", async () => {
  for (const mode of ["inline", "transcribe", "local"]) {
    let gets = 0, posts = 0;
    const fetch = async (url, init = {}) => {
      if (init.method === "POST") {
        posts++;
        return Response.json({ text: "heard" });
      }
      assert.equal(init.headers, undefined);
      if (++gets === 1) return brokenBody();
      return new Response(Buffer.from(PNG_B64, "base64"), { headers: { "content-type": "image/png" } });
    };
    const client = new NanoClient({ apiKey: "test", fetch });
    if (mode === "inline") assert.match(await client.fetchMediaDataUrl(cdn), /^data:image\/png;base64,/);
    if (mode === "transcribe") assert.equal(await client.transcribe("test", cdn), "heard");
    if (mode === "local") assert.match(await resizeCropImage(cdn, "fit", 1, 1, { fetch }), /^data:image\/png;base64,/);
    assert.equal(gets, 2, mode);
    assert.equal(posts, mode === "transcribe" ? 1 : 0, mode);
  }
});

test("cancellation during a media body read or retry delay stops further GETs", async () => {
  for (const duringBody of [true, false]) {
    const ac = new AbortController();
    const reason = new DOMException("stop", "AbortError");
    let gets = 0;
    const client = new NanoClient({ apiKey: "test", fetch: async (_url, init) => {
      gets++;
      assert.equal(init.signal, ac.signal);
      if (!duringBody) {
        setTimeout(() => ac.abort(reason), 10);
        throw terminated();
      }
      return { ok: true, arrayBuffer: async () => {
        ac.abort(reason);
        throw terminated();
      } };
    } });
    await assert.rejects(client.fetchMediaDataUrl(cdn, { signal: ac.signal }), (e) => e === reason);
    assert.equal(gets, 1);
    await assert.rejects(client.fetchMediaDataUrl(cdn, { signal: ac.signal }), (e) => e === reason);
    assert.equal(gets, 1, "already-aborted calls do not fetch");
  }
});

function jobWorkflow(status = "COMPLETED") {
  const fetch = async (url, init = {}) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.model === "voice") return Response.json({ id: "audio-job", cost: 0.1 });
      return Response.json({ runId: "video-job", cost: 0.2 });
    }
    if (String(url).includes("/tts/status")) return Response.json({ status: "completed", url: cdn });
    return Response.json({ status, output: { url: cdn }, error: "provider failed" });
  };
  return Workflow.fromJSON({ nodes: [
    { id: "v", type: "tvideo", fields: { model: "video", prompt: "fox" } },
    { id: "a", type: "tts", fields: { model: "voice", prompt: "hello" } },
    { id: "local", type: "text", fields: { text: "hi" } },
  ], links: [] }, { fetch, apiKey: "test", quiet: true, pollIntervals: { video: 1, audio: 1 } });
}

test("run results and immediate progress retain per-node video/audio job IDs", async () => {
  const events = [];
  const result = await jobWorkflow().run({}, { onProgress: (e) => events.push(e) });
  assert.equal(result.nodes.v.runId, "video-job");
  assert.equal(result.nodes.a.runId, "audio-job");
  assert.equal(result.nodes.local.runId, null);
  assert.deepEqual(events.filter((e) => e.type === "node-run-id").map((e) => [e.nodeId, e.runId]).sort(),
    [["a", "audio-job"], ["v", "video-job"]]);
  for (const id of ["v", "a"]) {
    assert.ok(events.findIndex((e) => e.type === "node-run-id" && e.nodeId === id) <
      events.findIndex((e) => e.type === "poll" && e.nodeId === id));
  }
});

test("provider job IDs survive failure in RunError.result", async () => {
  await assert.rejects(jobWorkflow("FAILED").run({}), (e) => {
    assert.ok(e instanceof RunError);
    assert.equal(e.result.nodes.v.runId, "video-job");
    assert.equal(e.result.nodes.a.runId, "audio-job");
    return true;
  });
});

test("job ID is retained when polling times out; late callbacks cannot change it", async () => {
  const wf = jobWorkflow("PENDING");
  wf.client.timeouts.video = 15;
  await assert.rejects(wf.run({}), (e) => {
    assert.equal(e.result.nodes.v.runId, "video-job");
    assert.match(e.result.nodes.v.error, /timed out/);
    return true;
  });

  let finishSubmit;
  const fetch = async () => new Promise((resolve) => { finishSubmit = resolve; });
  const late = Workflow.fromJSON({ nodes: [{ id: "v", type: "tvideo", fields: {
    model: "video", prompt: "fox", timeoutMs: 15,
  } }], links: [] }, { fetch, apiKey: "test", quiet: true });
  const events = [];
  let partial;
  await assert.rejects(late.run({}, { onProgress: (e) => events.push(e) }), (e) => {
    partial = e.result;
    assert.equal(partial.nodes.v.runId, null);
    return true;
  });
  const n = events.length;
  finishSubmit(Response.json({ runId: "too-late" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(partial.nodes.v.runId, null);
  assert.equal(events.length, n);
});

test("per-second video prices round fractional duration up across catalog shapes", () => {
  const shapes = [
    { per_second_by_resolution: { "720p": 0.085 } },
    { standard_prices_per_second: { "720p": 0.085 } },
    { per_second_by_mode: { text_to_video: 0.085 } },
    { per_second_with_audio: 0.085 },
    { per_second_without_audio: 0.085 },
    { base_price_per_second: 0.085 },
    { per_second: 0.085 },
    { output_per_second: 0.085 },
    { raw: { pricesPerSecond: { "720p": 0.085 } } },
    { output_per_second: 1, lora: { text_or_image_per_second: { "720p": 0.085 }, min_duration: 3, max_duration: 15 } },
  ];
  for (const pricing of shapes) {
    for (const [duration, seconds] of [[0.1, pricing.lora ? 3 : 1], [5.01, 6], [6.001, 7], [7, 7]]) {
      const graph = { nodes: [{ id: "v", type: "tvideo", fields: {
        model: "v", duration, resolution: "720p", loraUrl: "https://cdn.example/lora", modelOpts: { generate_audio: true },
      } }], links: [] };
      const result = estimateGraphCost(graph, { video: [{ id: "v", pricing }] });
      assert.ok(Math.abs(result.usd - 0.085 * seconds) < 1e-12, JSON.stringify({ pricing, duration, usd: result.usd }));
    }
  }
});

test("audio per-second billing rounds after duration clamping; flat/frame prices keep their units", () => {
  const estimate = (type, pricing, duration, supported_parameters) => estimateGraphCost({
    nodes: [{ id: "n", type, fields: { model: "m", duration } }], links: [],
  }, { [type === "music" ? "audio" : "video"]: [{ id: "m", pricing, supported_parameters }] }).usd;
  assert.ok(Math.abs(estimate("music", { per_second: 0.085 }, 6.001, { min_duration: 1, max_duration: 30 }) - 0.595) < 1e-12);
  assert.equal(estimate("music", { per_second: 0.1 }, 35.1, { min_duration: 1, max_duration: 30 }), 3);
  assert.equal(estimate("tvideo", { per_video: 0.43 }, 6.001), 0.43);
  assert.equal(estimate("tvideo", { per_frame_unit: 0.01, frames_per_unit: 1 }, 0.5), 0.15);
  assert.equal(estimate("tvideo", { base_price: 0.2, base_duration: 5, per_extra_second: 0.1 }, 5.01), 0.2 + 0.1);
  assert.equal(estimate("tvideo", { per_duration: { "5.5": 0.43 } }, 5.5), 0.43);
  assert.equal(estimate("music", { per_billing_interval: 1, billing_interval_seconds: 60 }, 60.1,
    { min_duration: 1, max_duration: 300 }), 2);
});
