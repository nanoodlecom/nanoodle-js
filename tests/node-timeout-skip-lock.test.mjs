/**
 * Per-node fields.timeoutMs, fields.onError:"skip" and fields.locked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, RunError, deriveInputs, materialize } from "../src/index.mjs";

/** Fake NanoGPT chat: model "fail" → 400, "hang" → waits for abort, else echoes the prompt. */
function fakeFetch(seen = []) {
  return async (url, init = {}) => {
    const u = String(url);
    if (!u.includes("/chat/completions")) return new Response("not found", { status: 404 });
    const body = JSON.parse(init.body);
    seen.push(body);
    if (body.model === "fail") return new Response('{"error":"bad request"}', { status: 400 });
    if (body.model === "hang") {
      return new Promise((_, reject) => {
        const s = init.signal;
        if (s) s.addEventListener("abort", () => reject(s.reason || new Error("aborted")), { once: true });
      });
    }
    const last = body.messages[body.messages.length - 1].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: `${body.model}:${last}` } }], x_nanogpt_pricing: { costUsd: 0.002 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
}
const opts = (seen) => ({ apiKey: "test-key", baseUrl: "http://fake.invalid", fetch: fakeFetch(seen), quiet: true });

/** draft → writers w1,w2 → join → decider llm */
function writersGraph(m1, m2, extra = {}) {
  return {
    nodes: [
      { id: "d", type: "text", name: "Draft", fields: { text: "hello" } },
      { id: "w1", type: "llm", fields: { model: m1, onError: "skip", ...extra } },
      { id: "w2", type: "llm", fields: { model: m2, onError: "skip", ...extra } },
      { id: "j", type: "join", fields: { sep: "|" } },
      { id: "dec", type: "llm", name: "Decider", fields: { model: "judge" } },
    ],
    links: [
      { from: { node: "d", port: "text" }, to: { node: "w1", port: "prompt" } },
      { from: { node: "d", port: "text" }, to: { node: "w2", port: "prompt" } },
      { from: { node: "w1", port: "text" }, to: { node: "j", port: "a" } },
      { from: { node: "w2", port: "text" }, to: { node: "j", port: "b" } },
      { from: { node: "j", port: "text" }, to: { node: "dec", port: "prompt" } },
    ],
  };
}

test("timeoutMs: a hung node fails with code 'timeout'", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n", type: "llm", fields: { model: "hang", prompt: "hi", timeoutMs: 50 } }], links: [],
  }, opts());
  const t0 = Date.now();
  await assert.rejects(wf.run({}), (e) => {
    assert.ok(e instanceof RunError);
    assert.match(e.result.errors[0].message, /node timed out after 50ms/);
    assert.equal(e.result.errors[0].code, "timeout");
    assert.equal(e.result.nodes.n.status, "error");
    return true;
  });
  assert.ok(Date.now() - t0 < 2000);
});

test("timeoutMs + onError skip: decider runs with the surviving writer", async () => {
  const seen = [];
  const wf = Workflow.fromJSON(writersGraph("ok", "hang", { timeoutMs: 50 }), opts(seen));
  const r = await wf.run({});
  assert.equal(r.nodes.w2.status, "skipped");
  assert.match(r.errors.find((e) => e.nodeId === "w2").message, /timed out/);
  assert.equal(r.errors.find((e) => e.nodeId === "w2").code, "timeout");
  assert.equal(r.nodes.dec.out.text, "judge:ok:hello");
});

test("onError skip: a 400 writer is skipped, join + decider get only survivors", async () => {
  const seen = [];
  const events = [];
  const wf = Workflow.fromJSON(writersGraph("fail", "ok"), opts(seen));
  const r = await wf.run({}, { onProgress: (e) => events.push(e) });
  assert.equal(r.nodes.w1.status, "skipped");
  assert.equal(r.nodes.j.status, "done");
  assert.equal(r.nodes.j.out.text, "ok:hello");
  assert.equal(r.nodes.dec.status, "done");
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].nodeId, "w1");
  assert.ok(events.some((e) => e.type === "node-skipped" && e.reason === "error" && e.nodeId === "w1"));
});

test("onError skip: all writers skipped fails the run naming them", async () => {
  const wf = Workflow.fromJSON(writersGraph("fail", "fail"), opts());
  await assert.rejects(wf.run({}), (e) => {
    assert.ok(e instanceof RunError);
    assert.match(e.result.nodes.j.error, /all inputs were skipped after failing/);
    assert.equal(e.result.nodes.dec.status, "error");
    assert.match(e.message, /run failed/);
    return true;
  });
});

test("onError skip on the only sink still fails the run", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n", type: "llm", fields: { model: "fail", prompt: "hi", onError: "skip" } }], links: [],
  }, opts());
  await assert.rejects(wf.run({}), /every output was skipped/);
});

test("without onError a failed writer still fails the whole run (unchanged)", async () => {
  const g = writersGraph("fail", "ok");
  delete g.nodes[1].fields.onError;
  const wf = Workflow.fromJSON(g, opts());
  await assert.rejects(wf.run({}), /run failed/);
});

test("locked: node fields are not inputs and run with stored values; unlocked unchanged", async () => {
  const graph = (locked) => ({
    nodes: [
      { id: "lab", type: "text", name: "Label", fields: { text: "[A]", ...(locked ? { locked: true } : {}) } },
      { id: "w", type: "llm", name: "Writer", fields: { model: "ok", system: "SYS", ...(locked ? { locked: true } : {}) } },
    ],
    links: [{ from: { node: "lab", port: "text" }, to: { node: "w", port: "prompt" } }],
  });
  const unlocked = deriveInputs(materialize(graph(false)));
  assert.deepEqual(unlocked.map((i) => `${i.nodeId}.${i.field}`), ["lab.text", "w.system"]);
  assert.deepEqual(deriveInputs(materialize(graph(true))), []);

  const seen = [];
  const wf = Workflow.fromJSON(graph(true), opts(seen));
  assert.deepEqual(wf.inputs, []);
  const r = await wf.run({});
  assert.equal(r.nodes.w.out.text, "ok:[A]");
  assert.equal(seen[0].messages[0].content, "SYS");
  // a locked input key is rejected rather than silently overriding the stored value
  await assert.rejects(wf.run({ Label: "x" }));
});

test("cost exactness: a timed-out/skipped network node with no price makes costExact false", async () => {
  const wf = Workflow.fromJSON(writersGraph("ok", "hang", { timeoutMs: 50 }), opts());
  const r = await wf.run({});
  assert.equal(r.nodes.w2.status, "skipped");
  assert.equal(r.nodes.w2.costUsd, null);
  assert.equal(r.costExact, false);
  assert.ok(Math.abs(r.costUsd - 0.004) < 1e-12, "the priced nodes still sum");
});

test("cost exactness: all nodes priced and done stays exact", async () => {
  const wf = Workflow.fromJSON(writersGraph("ok", "ok"), opts());
  const r = await wf.run({});
  assert.equal(r.costExact, true);
});

test("late callbacks: a fetch that ignores abort and reports cost after the run returns changes nothing", async () => {
  let lateReport;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === "stubborn") {
      // ignores init.signal entirely; answers (with a price) only when the test says so
      return new Promise((resolve) => { lateReport = () => resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "late" } }], x_nanogpt_pricing: { costUsd: 0.2 } }),
        { status: 200, headers: { "content-type": "application/json" } })); });
    }
    return fakeFetch()(url, init);
  };
  const g = writersGraph("ok", "stubborn", { timeoutMs: 50 });
  g.nodes[1].id = "w-a"; g.links.forEach((l) => { if (l.from.node === "w1") l.from.node = "w-a"; if (l.to.node === "w1") l.to.node = "w-a"; });
  g.nodes[2].id = "w-b"; g.links.forEach((l) => { if (l.from.node === "w2") l.from.node = "w-b"; if (l.to.node === "w2") l.to.node = "w-b"; });
  const events = [];
  const wf = Workflow.fromJSON(g, { apiKey: "k", baseUrl: "http://fake.invalid", fetch, quiet: true });
  const r = await wf.run({}, { onProgress: (e) => events.push(e) });
  const before = { a: r.nodes["w-a"].costUsd, b: r.nodes["w-b"].costUsd, total: r.costUsd, exact: r.costExact, status: r.nodes["w-b"].status, n: events.length };
  assert.equal(before.status, "skipped");
  lateReport();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(r.nodes["w-a"].costUsd, before.a);
  assert.equal(r.nodes["w-b"].costUsd, before.b);
  assert.equal(r.nodes["w-b"].status, "skipped");
  assert.equal(r.costUsd, before.total);
  assert.equal(r.costExact, before.exact);
  assert.equal(events.length, before.n, "no late progress events");
});

test("locked: a settings override aimed at a locked node is rejected", async () => {
  const g = {
    nodes: [
      { id: "d", type: "text", name: "Draft", fields: { text: "hi" } },
      { id: "w-a", type: "llm", name: "Writer", fields: { model: "ok", locked: true } },
    ],
    links: [{ from: { node: "d", port: "text" }, to: { node: "w-a", port: "prompt" } }],
  };
  const seen = [];
  const wf = Workflow.fromJSON(g, opts(seen));
  await assert.rejects(wf.run({}, { settings: { "w-a.model": "other" } }),
    (e) => e.code === "locked" && /locked node w-a/.test(e.message));
  assert.equal(seen.length, 0, "rejected before any call");
  // unlocked: the same override still applies
  g.nodes[1].fields.locked = false;
  const wf2 = Workflow.fromJSON(g, opts(seen));
  const r = await wf2.run({}, { settings: { "w-a.model": "other" } });
  assert.equal(r.nodes["w-a"].out.text, "other:hi");
});
