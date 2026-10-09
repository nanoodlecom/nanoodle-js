/**
 * ⚖️ Decide (NanoGPT /api/v1/decisions) — the twin of the editor/play node.
 * Pure question/merge/output logic runs without ffmpeg; the image path (fitImageJpeg) needs it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Workflow } from "../src/index.mjs";
import { decideRun, decideQuestionFor, decideMergeOrders, decideImageLimits, DECIDE_IMG_FALLBACK } from "../src/decide.mjs";
import { estimateGraphCost } from "../src/estimate.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const usage = (cost) => ({ input_tokens: 40, output_tokens: 0, cost });

test("decide: question shapes per mode, refusals before any request", () => {
  const p = decideQuestionFor("pick", {}, 3);
  assert.deepEqual(Object.keys(p.criteria), ["image_1", "image_2", "image_3"]);
  assert.equal(p.type, "choice");
  assert.throws(() => decideQuestionFor("pick", {}, 1), /at least two images/);
  assert.deepEqual(Object.keys(decideQuestionFor("choose", { options: "a\n b \n\na" }, 0).criteria), ["a", "b"]);
  assert.throws(() => decideQuestionFor("choose", { options: "only" }, 0), /two labels/);
  assert.deepEqual(decideQuestionFor("score", {}, 0).criteria, ["poor", "okay", "good", "great"]);
  assert.equal(decideQuestionFor("yesno", { question: "Cat?" }, 0).type, "noul");
  assert.equal(decideImageLimits(undefined, false), DECIDE_IMG_FALLBACK);
  assert.equal(decideImageLimits({ image_input: false }, true), null);
});

test("decide: pick merges in-order + reversed runs back onto the original images", () => {
  const m = decideMergeOrders([
    { answers: { answer: { probabilities: { image_1: 0.45, image_2: 0.05, image_3: 0.5 } } }, usage: usage(1) },
    { answers: { answer: { probabilities: { image_1: 0.8, image_2: 0.05, image_3: 0.15 } } }, usage: usage(2) },
  ], [[0, 1, 2], [2, 1, 0]]);
  assert.equal(m.answers.answer.choice, "image_3");
  assert.ok(Math.abs(m.answers.answer.probabilities.image_3 - 0.65) < 1e-9);
  assert.equal(m.usage.cost, 3);
});

test("decide: decideRun pick with a fake send — two requests, winner image out", async () => {
  const sent = [];
  const out = await decideRun({ mode: "pick" }, "m", "brief", ["data:a", "data:b"], DECIDE_IMG_FALLBACK,
    async (body) => {
      sent.push(body);
      const first = body.state[2].image_url.url; // slot 1
      // a real preference for "b" wherever it sits, plus a first-slot bias
      return { answers: { answer: { type: "choice", probabilities: first === "fit:b" ? { image_1: 0.9, image_2: 0.1 } : { image_1: 0.55, image_2: 0.45 } } }, usage: usage(0.00001) };
    },
    async (u) => "fit:" + u.slice(5));
  assert.equal(sent.length, 2);
  assert.equal(out.text, "image 2");
  assert.equal(out.image, "data:b");
  assert.ok(Math.abs(out.decision.cost - 0.00002) < 1e-12);
});

test("decide: choose (text only) — exact body, label out, usage.cost billed", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/decisions", { json: { id: "d1", model: "liquid/d1", answers: { answer: { type: "choice", choice: "billing", confidence: 0.41, probabilities: { billing: 0.44, shipping: 0.39, sales: 0.17 } } }, usage: usage(0.0000023) } });
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "t", type: "text", fields: { text: "My order arrived broken, refund please." } },
      { id: "d", type: "decide", fields: { model: "liquid/d1", mode: "choose", question: "Which team?", options: "billing\nshipping\nsales" } },
    ],
    links: [{ id: "l", from: { node: "t", port: "text" }, to: { node: "d", port: "text" } }],
  }, mockOpts(srv));
  const result = await wf.run({});
  assert.equal(srv.requests.length, 1);
  assert.deepEqual(srv.requests[0].json, {
    model: "liquid/d1",
    state: "My order arrived broken, refund please.",
    questions: { answer: { type: "choice", instructions: "Which team?", criteria: { billing: null, shipping: null, sales: null } } },
  });
  assert.equal(result.get("Decide"), "billing");
  assert.ok(Math.abs(result.costUsd - 0.0000023) < 1e-12);
});

test("decide: a closed yes/no gate skips downstream nodes (no request for them)", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/decisions", { json: { answers: { answer: { type: "noul", noul: 0.1 } }, usage: usage(0.000001) } });
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "t", type: "text", fields: { text: "a dog" } },
      { id: "g", type: "decide", fields: { model: "liquid/d1", mode: "yesno", gate: true, question: "Is it a cat?" } },
      { id: "l", type: "llm", fields: { model: "gpt-x", prompt: "write a cat poem" } },
    ],
    links: [
      { id: "l1", from: { node: "t", port: "text" }, to: { node: "g", port: "text" } },
      { id: "l2", from: { node: "g", port: "text" }, to: { node: "l", port: "prompt" } },
    ],
  }, mockOpts(srv));
  await assert.rejects(wf.run({}), (e) => {
    const recs = e.result && e.result.nodes;
    return /gate closed/.test(JSON.stringify(recs || e.message));
  });
  assert.ok(srv.requests.every((r) => r.path !== "/api/v1/chat/completions"), "the LLM behind a closed gate never ran");
});

test("decide: pick shrinks wired images to JPEG within the decision budget (ffmpeg)", async (t) => {
  if (!hasFfmpeg) return t.skip("ffmpeg not on PATH");
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/decisions", { json: { answers: { answer: { type: "choice", probabilities: { image_1: 0.5, image_2: 0.5 } } }, usage: usage(0.00001) } });
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "a", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "b", type: "upload", fields: { image: PNG_DATA_URL } },
      { id: "d", type: "decide", fields: { model: "perplexity/pplx-decider-v1.1-27b" } },
    ],
    links: [
      { id: "l1", from: { node: "a", port: "image" }, to: { node: "d", port: "img1" } },
      { id: "l2", from: { node: "b", port: "image" }, to: { node: "d", port: "img2" } },
    ],
  }, mockOpts(srv));
  const result = await wf.run({});
  assert.equal(srv.requests.length, 2, "pick asks in order + reversed");
  for (const r of srv.requests) {
    const parts = r.json.state.filter((p) => p && p.type === "image_url");
    assert.equal(parts.length, 2);
    for (const p of parts) {
      assert.match(p.image_url.url, /^data:image\/jpeg;base64,/);
      assert.ok(p.image_url.url.length <= Math.floor(240000 * 0.95 / 2));
    }
    assert.equal(r.json.questions.answer.type, "choice");
  }
  assert.equal(result.get("Decide"), "image 1");
  assert.ok(Math.abs(result.costUsd - 0.00002) < 1e-12);
});

test("decide: estimate bills input tokens only, ×2 for pick", () => {
  const catalog = { chat: [{ id: "m", pricing: { prompt: 0.04, completion: 0 } }] };
  const g = (mode) => ({ nodes: [{ id: "d", type: "decide", fields: { model: "m", mode } }], links: [] });
  const one = estimateGraphCost(g("yesno"), catalog);
  const pick = estimateGraphCost(g("pick"), catalog);
  assert.ok(one.usd > 0 && one.usd < 0.0001);
  assert.ok(Math.abs(pick.usd - 2 * one.usd) < 1e-15);
});
