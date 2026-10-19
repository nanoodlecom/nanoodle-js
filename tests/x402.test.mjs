import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NanoClient } from "../src/client.mjs";
import { parseNanoInvoice, looksLikeResult } from "../src/x402.mjs";
import { qrModules, qrTerminal } from "../src/qr.mjs";

// tests/fixtures/x402/402.json is a REAL nano-gpt.com response (captured 2026-07-12,
// x-x402: true + no key on /api/v1/chat/completions) — the parser is pinned to the
// production wire format, not a re-derivation of it.
const fixture402 = JSON.parse(await readFile(new URL("./fixtures/x402/402.json", import.meta.url), "utf8"));

const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? (k.toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const CHAT_OK = { choices: [{ message: { content: "paid hello" } }], cost: 0.0001 };

// the fixture's real expiresAt is ~15 min after capture — long dead by test time.
// Settle-flow tests need a live window; only the parser test uses the raw fixture.
function fresh402(minutes = 15) {
  const j = JSON.parse(JSON.stringify(fixture402));
  const secs = Math.floor(Date.now() / 1000) + minutes * 60;
  for (const a of j.accepts || []) a.expiresAt = secs;
  for (const a of (j.payment && j.payment.accepted) || []) a.expiresAt = new Date(secs * 1000).toISOString();
  if (j.payment) j.payment.expiresAt = new Date(secs * 1000).toISOString();
  return j;
}

test("parseNanoInvoice: real fixture → nano scheme, absolute URLs, ms expiry, nano: URI", () => {
  const inv = parseNanoInvoice(fixture402, "https://nano-gpt.com");
  assert.equal(inv.scheme, "nano");
  assert.match(inv.paymentId, /^pay_[0-9a-f]+$/);
  assert.match(inv.payTo, /^nano_[a-z0-9]+$/);
  assert.match(inv.amountRaw, /^\d+$/); // integer raw units
  assert.match(inv.amount, /XNO$/);
  assert.ok(inv.amountUsd > 0);
  assert.equal(inv.uri, "nano:" + inv.payTo + "?amount=" + inv.amountRaw);
  assert.ok(inv.statusUrl.startsWith("https://nano-gpt.com/api/x402/status/pay_"));
  assert.ok(inv.completeUrl.startsWith("https://nano-gpt.com/api/x402/complete/pay_"));
  assert.ok(inv.expiresAt > 1e12, "expiresAt is epoch ms");
  assert.match(inv.explorerUrl, /^https:\/\//);
  assert.ok(Object.isFrozen(inv));
});

test("parseNanoInvoice: no nano option → null (never falls back to other rails)", () => {
  const stripped = {
    ...fixture402,
    accepts: fixture402.accepts.filter((a) => a.scheme !== "nano"),
    payment: { ...fixture402.payment, accepted: [] },
  };
  assert.equal(parseNanoInvoice(stripped, "https://nano-gpt.com"), null);
});

test("looksLikeResult: replayed API bodies yes, settle receipts no", () => {
  assert.ok(looksLikeResult(CHAT_OK));
  assert.ok(looksLikeResult({ data: [{ b64_json: "x" }] }));
  assert.ok(!looksLikeResult({ status: "completed", paymentId: "pay_x" }));
  assert.ok(!looksLikeResult(null));
});

test("x402 chat: 402 → payment callback → complete replays the result (no re-POST)", async () => {
  const calls = [];
  const invoices = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/chat/completions")) return jsonRes(402, fresh402());
    if (url.includes("/api/x402/complete/")) {
      // first complete: deposit not seen yet; second: verified, replays the chat result
      const n = calls.filter((c) => c.url.includes("/complete/")).length;
      return n === 1 ? jsonRes(402, { error: "Payment not verified", status: "pending" }) : jsonRes(200, CHAT_OK);
    }
    throw new Error("unexpected url " + url);
  };
  const c = new NanoClient({ payment: async (inv) => invoices.push(inv), fetch, pollIntervals: { x402: 1 } });
  const out = await c.chat([{ role: "user", content: "hi" }], "chatgpt-4o-latest");
  assert.equal(out, "paid hello");
  assert.equal(invoices.length, 1, "exactly one payment per request");
  assert.equal(invoices[0].payTo, parseNanoInvoice(fixture402, "https://nano-gpt.com").payTo);
  const first = calls[0];
  assert.equal(first.init.headers["x-x402"], "true");
  assert.equal(first.init.headers.Authorization, undefined, "keyless request carries no Authorization");
  assert.equal(calls.filter((c2) => c2.url.includes("/chat/completions")).length, 1, "result came from complete, not a re-POST");
});

test("x402 chat: settle-only complete → re-POST stamped with x-x402-payment-id", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/chat/completions")) {
      return init.headers["x-x402-payment-id"] ? jsonRes(200, CHAT_OK) : jsonRes(402, fresh402());
    }
    if (url.includes("/api/x402/complete/")) return jsonRes(200, { status: "completed", paymentId: "pay_x" });
    throw new Error("unexpected url " + url);
  };
  const c = new NanoClient({ payment: async () => {}, fetch, pollIntervals: { x402: 1 } });
  assert.equal(await c.chat([{ role: "user", content: "hi" }], "m"), "paid hello");
  const rePost = calls.filter((x) => x.url.includes("/chat/completions"))[1];
  assert.match(rePost.init.headers["x-x402-payment-id"], /^pay_/);
});

test("x402: re-POST still 402 after settling → hard error, never a second payment", async () => {
  let paid = 0;
  const fetch = async (url, init) => {
    if (url.includes("/chat/completions")) return jsonRes(402, fresh402());
    return jsonRes(200, { status: "completed" });
  };
  const c = new NanoClient({ payment: async () => { paid++; }, fetch, pollIntervals: { x402: 1 } });
  await assert.rejects(c.chat([{ role: "user", content: "hi" }], "m"), (e) => e.code === "x402" && /still answered 402/.test(e.message));
  assert.equal(paid, 1);
});

test("x402 tts: complete replays raw audio/mpeg → that IS the result (settle-then-402 regression)", async (t) => {
  // Stub NanoGPT over real HTTP, modelled on prod 2026-10-19 (pay_69e0343c…): /api/v1/audio/speech
  // quotes a 402; /api/x402/complete replays the stored TTS request and answers the MP3 bytes
  // (Minimax-Speech returns audio/mpeg, not JSON); the payment is then "completed", so a re-POST
  // stamped with x-x402-payment-id gets a fresh 402 — which used to fail the Speech step.
  const { createServer } = await import("node:http");
  const stub402 = () => { // the real quote, with every complete/status URL made relative → the stub
    const q = fresh402();
    const rel = (o) => {
      if (o && o.completeUrl) o.completeUrl = "/api/x402/complete/" + o.paymentId;
      if (o && o.statusUrl) o.statusUrl = "/api/x402/status/" + o.paymentId;
    };
    rel(q.payment); (q.payment.accepted || []).forEach(rel); (q.accepts || []).forEach(rel);
    return q;
  };
  const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64]);
  const hits = { speech: 0, rePost: 0, complete: 0 };
  let completed = false;
  const srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/api/v1/audio/speech") {
        hits.speech++;
        if (req.headers["x-x402-payment-id"]) hits.rePost++;
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify(stub402()));
      }
      if (req.url.startsWith("/api/x402/complete/")) {
        hits.complete++;
        if (hits.complete === 1) { // deposit not seen on-chain yet
          res.writeHead(402, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "Payment not verified", status: "pending" }));
        }
        if (completed) { res.writeHead(409, { "content-type": "application/json" }); return res.end("{\"error\":\"already completed\"}"); }
        completed = true;
        res.writeHead(200, { "content-type": "audio/mpeg", "x-cost": "0.0012" });
        return res.end(MP3);
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const base = "http://127.0.0.1:" + srv.address().port;
  let paid = 0;
  const c = new NanoClient({ baseUrl: base, payment: async () => { paid++; }, pollIntervals: { x402: 1 } });
  const url = await c.audio("Minimax-Speech-2.8-HD", "Hello there.", { voice: "Deep_Voice_Man", response_format: "mp3" });
  assert.equal(url, "data:audio/mpeg;base64," + MP3.toString("base64"));
  assert.equal(paid, 1, "exactly one payment");
  assert.equal(hits.rePost, 0, "no re-POST after complete replayed the audio");
  assert.equal(hits.speech, 1);
});

/** Chat-call stub: 402 quote, then the complete call answers `completeRes()`. Counts payments + re-POSTs. */
function completeStub(completeRes) {
  const hits = { paid: 0, posts: 0, rePost: 0, complete: 0 };
  const fetch = async (url, init) => {
    if (url.includes("/chat/completions") || url.includes("/audio/speech")) {
      hits.posts++;
      if (init.headers && init.headers["x-x402-payment-id"]) hits.rePost++;
      return jsonRes(402, fresh402());
    }
    hits.complete++;
    return completeRes();
  };
  const c = new NanoClient({ payment: async () => { hits.paid++; }, fetch, pollIntervals: { x402: 1 } });
  return { c, hits };
}
const rawRes = (status, contentType, text) => new Response(text, { status, headers: { "content-type": contentType } });

test("x402: text/plain settlement ack on complete → error, not a result; one payment, no re-POST", async () => {
  const { c, hits } = completeStub(() => rawRes(200, "text/plain; charset=utf-8", "OK settled"));
  await assert.rejects(c.audio("Minimax-Speech-2.8-HD", "Hello.", { response_format: "mp3" }),
    (e) => e.code === "x402" && /text\/plain instead of a result/.test(e.message) && /OK settled/.test(e.message) && /^pay_/.test(e.paymentId));
  assert.equal(hits.paid, 1);
  assert.equal(hits.rePost, 0);
  assert.equal(hits.posts, 1);
});

test("x402: text/html error page on complete → error, not audio; one payment, no re-POST", async () => {
  const { c, hits } = completeStub(() => rawRes(200, "text/html", "<html><body>Bad gateway</body></html>"));
  await assert.rejects(c.audio("Minimax-Speech-2.8-HD", "Hello.", { response_format: "mp3" }),
    (e) => e.code === "x402" && /text\/html instead of a result/.test(e.message));
  assert.equal(hits.paid, 1);
  assert.equal(hits.rePost, 0);
  assert.equal(hits.posts, 1);
});

test("x402: application/octet-stream complete is still the replayed audio", async () => {
  const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64]);
  const { c, hits } = completeStub(() => new Response(MP3, { status: 200, headers: { "content-type": "application/octet-stream" } }));
  const url = await c.audio("Minimax-Speech-2.8-HD", "Hello.", { response_format: "mp3" });
  assert.equal(url, "data:audio/mpeg;base64," + MP3.toString("base64"));
  assert.equal(hits.paid, 1);
  assert.equal(hits.rePost, 0);
});

test("x402: expired invoice window → x402-expired with the address and explorer in the message", async () => {
  const expired = JSON.parse(JSON.stringify(fixture402));
  for (const a of expired.accepts) a.expiresAt = Math.floor(Date.now() / 1000) - 60;
  expired.payment.expiresAt = new Date(Date.now() - 60000).toISOString();
  const fetch = async (url) =>
    url.includes("/chat/completions") ? jsonRes(402, expired) : jsonRes(402, { error: "Payment not verified" });
  const c = new NanoClient({ payment: async () => {}, fetch, pollIntervals: { x402: 1 } });
  await assert.rejects(c.chat([{ role: "user", content: "hi" }], "m"),
    (e) => e.code === "x402-expired" && /nano_/.test(e.message));
});

test("x402: 402 with no nano option → actionable error, callback never invoked", async () => {
  let paid = 0;
  const noNano = { accepts: fixture402.accepts.filter((a) => a.scheme !== "nano") };
  const fetch = async () => jsonRes(402, noNano);
  const c = new NanoClient({ payment: async () => { paid++; }, fetch });
  await assert.rejects(c.chat([{ role: "user", content: "hi" }], "m"), (e) => e.code === "x402" && /no usable Nano option/.test(e.message));
  assert.equal(paid, 0);
});

test("guard: payment must be a callback — a seed/key string is refused loudly", () => {
  assert.throws(() => new NanoClient({ payment: "vault grief snake ... twelve words" }),
    (e) => /never accepts wallet seeds or private keys/.test(e.message));
});

test("guard: with an apiKey, 402 stays the classic funds error — payment callback is not consulted", async () => {
  let paid = 0;
  const fetch = async () => jsonRes(402, fixture402);
  const c = new NanoClient({ apiKey: "k", payment: async () => { paid++; }, fetch });
  await assert.rejects(c.chat([{ role: "user", content: "hi" }], "m"), (e) => e.code === "funds");
  assert.equal(paid, 0);
});

test("keyless means keyless: apiKey null + payment defeats the NANOGPT_API_KEY env fallback", async (t) => {
  // regression: --pay once charged a real account because apiKey undefined fell back to the env var
  const { Workflow } = await import("../src/index.mjs");
  const tpl = await readFile(new URL("../templates/starter-graph.json", import.meta.url), "utf8");
  const prev = process.env.NANOGPT_API_KEY;
  process.env.NANOGPT_API_KEY = "sk-should-never-be-used";
  t.after(() => { if (prev === undefined) delete process.env.NANOGPT_API_KEY; else process.env.NANOGPT_API_KEY = prev; });
  const wf = Workflow.fromJSON(tpl, { apiKey: null, payment: async () => {} });
  assert.ok(!wf.client.apiKey, "no key on the client");
  assert.equal(typeof wf.client.payment, "function");
});

test("qr: module matrix is square with a finder ring at the origin; terminal render is stable", () => {
  const uri = "nano:nano_3msc38fyn67pgio16dj586pdrceahtn75qgnx7fy19wht7qsdkhzrhuwmvuu?amount=184060000000000000000000000";
  const m = qrModules(uri);
  assert.ok(m.length >= 21 && m.every((row) => row.length === m.length), "square, at least version 1");
  for (let i = 0; i < 7; i++) { // top + left edges of the top-left finder pattern are dark
    assert.equal(m[0][i], true);
    assert.equal(m[i][0], true);
  }
  const t = qrTerminal(uri);
  const lines = t.split("\n");
  assert.equal(lines.length, Math.ceil((m.length + 4) / 2), "two module rows per text line incl. quiet zone");
  assert.ok(lines.every((l) => l.length === m.length + 4));
  assert.equal(t, qrTerminal(uri), "deterministic");
});
