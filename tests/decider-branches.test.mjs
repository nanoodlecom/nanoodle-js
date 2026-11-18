import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Workflow } from "../src/index.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/decider-branches.json", import.meta.url)));
const { cases, legacy, ...graph } = fixture;
const models = Object.fromEntries(graph.nodes.filter(n => n.type === "llm").map(n => [n.fields.model, n.id]));

test("conditional Decide workflow, including a fresh routing choice on retry", async () => {
  let answers, calls;
  const workflow = Workflow.fromJSON(JSON.stringify(graph), {
    apiKey: "offline-fixture",
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      const usage = { cost: 0.001 };
      switch (new URL(url).pathname) {
        case "/api/v1/decisions": {
          const id = calls.includes("n2") ? "n5" : "n2";
          calls.push(id);
          const value = answers.shift();
          const answer = value == null ? null : { type: "noul", noul: value };
          return Response.json({ answers: { answer }, usage });
        }
        case "/api/v1/chat/completions": {
          const id = models[payload.model];
          assert(id, "unexpected model");
          calls.push(id);
          return Response.json({ choices: [{ message: { content: id } }], cost: usage.cost });
        }
        default:
          assert.fail(`unexpected request ${url}`);
      }
    },
  });
  for (const scenario of cases) {
    calls = [];
    answers = [...scenario.answers];
    const result = await workflow.run().then(
      output => { assert(!scenario.error, scenario.name); return output; },
      error => { assert(scenario.error, error.message); assert.match(error.message, /valid yes\/no answer/); return error.result; },
    );
    assert.deepEqual(calls.sort(), [...scenario.calls].sort(), scenario.name);
    assert.equal(answers.length, 0, scenario.name);
    assert(Math.abs(result.costUsd - calls.length * 0.001) < 1e-9, scenario.name);
    assert.equal(result.costExact, true);
    if (scenario.error) continue;
    assert.equal(result.get("Answer"), scenario.output, scenario.name);
    for (const id of scenario.skipped) {
      assert.equal(result.nodes[id].status, "skipped");
      assert.equal(result.nodes[id].skipReason, "branch");
      assert.equal(result.nodes[id].costUsd, null);
    }
  }
});

test("legacy yes/no gate survives a serialized round trip", async () => {
  const calls = [];
  const workflow = Workflow.fromJSON(JSON.stringify(legacy), {
    apiKey: "offline-fixture",
    fetch: async (url) => {
      calls.push(new URL(url).pathname);
      return Response.json({ answers: { answer: { type: "noul", noul: 0 } }, usage: { cost: 0.001 } });
    },
  });
  const result = await workflow.run();
  assert.equal(workflow.graph.nodes.find(n => n.id === "n2").fields.branch, undefined);
  assert.equal(result.nodes.n2.status, "gated");
  assert.equal(result.nodes.n4.gatedBy, "n2");
  assert.deepEqual(calls, ["/api/v1/decisions"]);
  assert.equal(result.costUsd, 0.001);
});

test("an unselected custom endpoint is never called", async () => {
  const scenario = structuredClone(graph);
  Object.assign(scenario.nodes.find(n => n.id === "n7"), {
    type: "endpoint",
    fields: { url: "https://offline.invalid/v1", mode: "chat" },
  });
  const urls = [];
  const workflow = new Workflow(scenario, {
    apiKey: "offline-fixture",
    fetch: async (url) => {
      urls.push(new URL(url));
      if (urls.at(-1).pathname === "/api/v1/decisions") {
        return Response.json({ answers: { answer: { type: "noul", noul: 1 } }, usage: { cost: 0.001 } });
      }
      return Response.json({ choices: [{ message: { content: "selected" } }], cost: 0.001 });
    },
  });
  const result = await workflow.run();
  assert.equal(result.nodes.n7.skipReason, "branch");
  assert.equal(result.nodes.n7.costUsd, null);
  assert.equal(result.costUsd, 0.003);
  assert.equal(urls.length, 3);
  assert(!urls.some(url => url.hostname === "offline.invalid"));
});
