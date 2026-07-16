import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Workflow, NanoodleError, decodeShareUrl, decodeShareFragment, isShareRef } from "../src/index.mjs";

/* Golden fixtures minted by the REAL editor's encoder (buildShareUrl / packShareFit /
   shareableGraph) via tests/harness/gen-share-fixtures.mjs — each pairs an
   editor-minted URL with the editor's own expected decoded graph. If these fail
   after an editor change, regenerate: NANOODLE_ROOT=… node tests/harness/gen-share-fixtures.mjs */
const SHARE_DIR = fileURLToPath(new URL("./fixtures/share/", import.meta.url));
const goldens = readdirSync(SHARE_DIR).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(SHARE_DIR + f, "utf8")));

test("goldens exist for every wire format", () => {
  const kinds = new Set(goldens.map((g) => g.name.split("-")[0]));
  assert.deepEqual([...kinds].sort(), ["a", "g", "j"]);
  assert.ok(goldens.length >= 6);
});

for (const g of goldens) {
  test(`golden ${g.name}: editor-minted URL decodes to the editor's graph`, async () => {
    const r = await decodeShareUrl(g.url);
    assert.deepEqual(r.graph, g.graph);
    if (g.app) {
      for (const [k, v] of Object.entries(g.app)) assert.equal(r.app[k], v, `app.${k}`);
    }
  });

  test(`golden ${g.name}: bare fragment and tail forms decode too`, async () => {
    const frag = g.url.slice(g.url.indexOf("#"));
    assert.deepEqual((await decodeShareFragment(frag)).graph, g.graph);       // "#g=…"
    assert.deepEqual((await decodeShareFragment(frag.slice(1))).graph, g.graph); // "g=…"
  });
}

test("Workflow.load() accepts a share URL offline and derives inputs", async () => {
  const g = goldens.find((x) => x.name === "g-starter");
  const wf = await Workflow.load(g.url, { apiKey: "unused", quiet: true });
  assert.ok(wf.inputs.length >= 1);
  assert.ok(wf.graph.nodes.length === g.graph.nodes.length);
});

test("Workflow.load() still loads plain file paths", async () => {
  const wf = await Workflow.load(fileURLToPath(new URL("./fixtures/starter-graph.json", import.meta.url)), { apiKey: "unused", quiet: true });
  assert.ok(wf.graph.nodes.length > 0);
});

test("isShareRef: URLs and fragments yes, file paths no", () => {
  assert.ok(isShareRef("https://nanoodle.com/#g=abc"));
  assert.ok(isShareRef("http://localhost:8080/play.html#a=abc"));
  assert.ok(isShareRef("#g=abc"));
  assert.ok(isShareRef("g=abc"));
  assert.ok(isShareRef("#j=abc"));
  assert.ok(isShareRef("a=abc"));
  assert.equal(isShareRef("noodle-graph.json"), false);
  assert.equal(isShareRef("./out/graph.json"), false);
  assert.equal(isShareRef("/tmp/g=weird/graph.json"), false);
});

test("#ga= handoff fragments are refused with guidance", async () => {
  await assert.rejects(() => decodeShareFragment("#ga=H4sIAAAA"), /handoff.*internal|internal.*handoff/is);
});

test("corrupt payloads throw NanoodleError, not raw zlib/JSON errors", async () => {
  const g = goldens.find((x) => x.name === "g-starter");
  const frag = g.url.slice(g.url.indexOf("#"));
  await assert.rejects(() => decodeShareFragment(frag.slice(0, 40)), NanoodleError);   // truncated gzip
  await assert.rejects(() => decodeShareFragment("#g=!!not-base64!!"), NanoodleError); // bad alphabet
  await assert.rejects(() => decodeShareFragment("#z=abcd"), NanoodleError);           // unknown tag
  await assert.rejects(() => decodeShareUrl("#g="), NanoodleError);                    // empty payload
});

test("#a= payload without a graph is refused", async () => {
  const json = JSON.stringify({ v: 1, name: "no graph here" });
  const b64u = Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await assert.rejects(() => decodeShareFragment("#a=u" + b64u), /no graph/);
});

/* ---- short links: fragments ride the Location header, so redirects are followed by hand ---- */

const redirect = (loc) => ({ status: 302, headers: new Map([["location", loc]]) });
const asFetch = (routes) => async (url) => {
  const r = routes[url];
  if (!r) throw new Error("unexpected fetch: " + url);
  return { status: r.status, headers: { get: (k) => r.headers?.get(k) ?? null } };
};

test("short link → redirect chain → fragment decodes (relative Location too)", async () => {
  const g = goldens.find((x) => x.name === "g-starter");
  const frag = g.url.slice(g.url.indexOf("#"));
  const f = asFetch({
    "https://da.gd/abc": redirect("https://hop.example/x"),
    "https://hop.example/x": redirect("/final" + frag),
  });
  const r = await decodeShareUrl("https://da.gd/abc", { fetch: f });
  assert.deepEqual(r.graph, g.graph);
  assert.ok(r.url.startsWith("https://hop.example/final#"));
});

test("direct fragment URLs never fetch", async () => {
  const g = goldens.find((x) => x.name === "g-unicode");
  const f = async () => { throw new Error("network touched for a direct link"); };
  const r = await decodeShareUrl(g.url, { fetch: f });
  assert.deepEqual(r.graph, g.graph);
});

test("redirect without fragment ends with a helpful error, not a hang", async () => {
  const f = asFetch({ "https://short.example/x": { status: 200, headers: new Map() } });
  await assert.rejects(() => decodeShareUrl("https://short.example/x", { fetch: f }), /no #g=.*no redirect|share the long/s);
});

test("redirect loops are capped", async () => {
  const f = asFetch({
    "https://a.example/": redirect("https://b.example/"),
    "https://b.example/": redirect("https://a.example/"),
  });
  await assert.rejects(() => decodeShareUrl("https://a.example/", { fetch: f }), /gave up after/);
});

test("unicode survives the round trip byte-for-byte", async () => {
  const g = goldens.find((x) => x.name === "g-unicode");
  const r = await decodeShareUrl(g.url);
  const texts = r.graph.nodes.filter((n) => n.type === "text").map((n) => n.fields?.text);
  assert.ok(texts.some((t) => typeof t === "string" && t.includes("ラーメン🍜")));
});
