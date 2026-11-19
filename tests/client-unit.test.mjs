import test from "node:test";
import assert from "node:assert/strict";
import { costFromJson, costFromHeaders, costWithHeaders, httpError, NanoClient, sleep } from "../src/client.mjs";

/** Minimal Response-like shim carrying only headers. */
const res = (headers = {}) => ({ headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) } });

test("costFromJson: top-level j.cost > 0 wins over x_nanogpt_pricing", () => {
  assert.deepEqual(costFromJson({ cost: 0.5, x_nanogpt_pricing: { costUsd: 0.1 } }), { usd: 0.5, balance: null });
});

test("costFromJson: pricing priority costUsd → cost → amount (Anthropic routes send only amount)", () => {
  assert.equal(costFromJson({ x_nanogpt_pricing: { costUsd: 1, cost: 2, amount: 3 } }).usd, 1);
  assert.equal(costFromJson({ x_nanogpt_pricing: { cost: 2, amount: 3 } }).usd, 2);
  assert.equal(costFromJson({ x_nanogpt_pricing: { amount: 3 } }).usd, 3);
  assert.equal(costFromJson({ x_nanogpt_pricing: { amount: "0.004" } }).usd, 0.004); // string amounts coerce
});

test("costFromJson: pricing beats metadata.cost; metadata used when nothing else", () => {
  assert.equal(costFromJson({ x_nanogpt_pricing: { cost: 0.2 }, metadata: { cost: 9 } }).usd, 0.2);
  assert.equal(costFromJson({ metadata: { cost: 0.001 } }).usd, 0.001); // transcription endpoint shape
});

test("costFromJson: present-but-zero = known-free, kept as 0 (never treated as unknown)", () => {
  assert.equal(costFromJson({ cost: 0 }).usd, 0);
  assert.equal(costFromJson({ x_nanogpt_pricing: { costUsd: 0 } }).usd, 0);
  // j.cost of 0 does NOT shadow a real pricing figure (only >0 short-circuits)
  assert.equal(costFromJson({ cost: 0, x_nanogpt_pricing: { costUsd: 0.3 } }).usd, 0.3);
});

test("costFromJson: absent cost → unknown (null); null/empty json safe", () => {
  assert.deepEqual(costFromJson({ choices: [] }), { usd: null, balance: null });
  assert.deepEqual(costFromJson(null), { usd: null, balance: null });
});

test("costFromJson: balance priority j.remainingBalance → pricing.remainingBalance", () => {
  assert.equal(costFromJson({ remainingBalance: 4.5, x_nanogpt_pricing: { remainingBalance: 9 } }).balance, 4.5);
  assert.equal(costFromJson({ x_nanogpt_pricing: { remainingBalance: 9 } }).balance, 9);
});

test("costFromHeaders: x-cost, x-nano-cost fallback, zero kept, x-remaining-balance", () => {
  assert.deepEqual(costFromHeaders(res({ "x-cost": "0.005", "x-remaining-balance": "3.2" })), { usd: 0.005, balance: 3.2 });
  assert.equal(costFromHeaders(res({ "x-nano-cost": "0.01" })).usd, 0.01);
  assert.equal(costFromHeaders(res({ "x-cost": "0" })).usd, 0); // known-free
  assert.deepEqual(costFromHeaders(res({})), { usd: null, balance: null });
  assert.deepEqual(costFromHeaders(null), { usd: null, balance: null });
});

test("costWithHeaders: JSON usd wins over x-cost; header only fills a silent body", () => {
  assert.equal(costWithHeaders({ cost: 0.5 }, res({ "x-cost": "0.9" })).usd, 0.5);
  assert.equal(costWithHeaders({}, res({ "x-cost": "0.9" })).usd, 0.9);
});

test("costWithHeaders: x-remaining-balance header is canonical — wins over any body figure", () => {
  assert.equal(costWithHeaders({ remainingBalance: 9 }, res({ "x-remaining-balance": "3.3" })).balance, 3.3);
  assert.equal(costWithHeaders({ remainingBalance: 9 }, res({})).balance, 9);
});

test("httpError: ordinary 401 and 403 map to key-rejected auth errors", () => {
  for (const status of [401, 403]) {
    const e = httpError(status, "whatever");
    assert.equal(e.code, "auth");
    assert.match(e.message, new RegExp(`API key rejected \\(HTTP ${status}\\)`));
  }
});

test("httpError: a Vercel 403 challenge page is reported separately", () => {
  const page = "<!DOCTYPE html><html><head><title>Vercel Security Checkpoint</title></head></html>";
  const error = httpError(403, page);
  assert.equal(error.code, "blocked");
  assert.equal(error.status, 403);
  assert.equal(httpError(403, "<html><title>Forbidden</title></html>").code, "auth");
  assert.equal(httpError(403, '{"reason":"Vercel Security Checkpoint"}').code, "auth");
});

test("NanoClient: image POST keeps the challenge header and reports a blocked request", async () => {
  const client = new NanoClient({
    apiKey: "test-key",
    fetch: async () => new Response("", { status: 403, headers: { "x-vercel-mitigated": "challenge" } }),
  });
  await assert.rejects(client.image({ prompt: "test", model: "test-model" }), {
    code: "blocked",
    status: 403,
    message: /automated traffic protection/,
  });
});

test("httpError: 401/403 stay auth even when the body says 'insufficient' (auth owns those statuses)", () => {
  const e = httpError(401, "insufficient permissions for this key");
  assert.equal(e.code, "auth");
  assert.ok(!/out of balance/.test(e.message));
});

test("httpError: 402 or a balance-flavoured body map to out-of-funds", () => {
  assert.equal(httpError(402, "").code, "funds");
  for (const body of ["Insufficient balance", "not enough funds", "Payment Required"]) {
    assert.equal(httpError(400, body).code, "funds", body);
    assert.match(httpError(400, body).message, /out of balance/);
  }
});

test("httpError: anything else → '<status>: <body first 160 chars>'", () => {
  const e = httpError(500, "x".repeat(500));
  assert.equal(e.code, "http");
  assert.equal(e.message, "500: " + "x".repeat(160));
});

test("sleep: rejects promptly on an aborted signal (poll loops must exit at once)", async () => {
  const ac = new AbortController();
  const p = sleep(10000, ac.signal);
  ac.abort();
  const t0 = Date.now();
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 1000);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(sleep(10000, pre.signal)); // already-aborted signal short-circuits
});
