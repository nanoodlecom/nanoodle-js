import test from "node:test";
import assert from "node:assert/strict";
import { NanoClient } from "../src/client.mjs";

// Credential scoping for provider content URLs: the API key is sent ONLY to
// the exact content paths in CONTENT_API_PATHS. Any other same-origin /api
// or /v1 URL is refused before any fetch — otherwise an account or upload
// endpoint's 200 body would be inlined into a graph output with the caller's
// credentials attached. (This policy shipped in the nanoodle-mcp vendored
// snapshot and its test suite; ported to the SDK 2026-11-18 so the re-pin
// onto 0.13.x does not silently drop it.)

const KEY = "unit-test-key-do-not-leak";
const RELATIVE = "/api/generate-video/content?runId=grok1&model=grok-imagine-video-1.5-lite";

function fakeRes({ status = 200, headers = {}, body = "" } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: h,
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    body: { cancel: async () => {} },
  };
}

const client = (fetch) => new NanoClient({ apiKey: KEY, baseUrl: "https://nano-gpt.com", fetch });

test("credentials go only to the exact content paths; other same-origin /api and /v1 URLs are not fetched", async () => {
  const secret = "account-balance-secret";
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init && init.headers && init.headers.Authorization });
    return fakeRes({ status: 200, headers: { "content-type": "application/json" }, body: secret });
  };
  const c = client(fetch);
  const blocked = [
    "https://nano-gpt.com/api/v1/models",
    "https://nano-gpt.com/api/user/me",
    "https://nano-gpt.com/v1/chat/completions",
    "/api/generate-video/content/extra",
    "/api/generate-video/content/",
    "/v1/audio/content/extra",
    "https://nano-gpt.com/api/upload?id=user-file",
    "/api/upload/pic.png",
  ];
  for (const url of blocked) {
    seen.length = 0;
    await assert.rejects(c.resolveContentUrl(url), (e) => {
      assert.match(e.message, /not a provider content file/);
      assert.equal(e.message.includes(secret), false);
      assert.equal(e.message.includes(KEY), false);
      return true;
    });
    assert.equal(seen.length, 0, url + " was fetched");
  }
});

test("a content redirect onto another same-origin /api path is not followed with credentials and its body is not inlined", async () => {
  const secret = "whoami-secret-body";
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers && init.headers.Authorization });
    const u = new URL(url);
    if (u.pathname === "/api/generate-video/content") {
      return fakeRes({ status: 307, headers: { location: "/api/v1/whoami" } });
    }
    return fakeRes({ status: 200, headers: { "content-type": "application/json" }, body: secret });
  };
  await assert.rejects(client(fetch).resolveContentUrl(RELATIVE), /not a provider content file/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, "Bearer " + KEY);
  assert.match(seen[0].url, /\/api\/generate-video\/content/);
  assert.equal(JSON.stringify(seen).includes(secret), false);
});

test("an allowlisted content path still resolves (redirect to the file host is handed back, not fetched)", async () => {
  const presigned = "https://files.example/clip.mp4?X-Amz-Signature=SUPERSECRET";
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init.headers && init.headers.Authorization });
    return fakeRes({ status: 307, headers: { location: presigned } });
  };
  const out = await client(fetch).resolveContentUrl(RELATIVE);
  assert.equal(out, presigned);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].authorization, "Bearer " + KEY);
});
