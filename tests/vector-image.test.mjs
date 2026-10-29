import test from "node:test";
import assert from "node:assert/strict";
import { Workflow, NanoClient, b64ImageMime, extForMime } from "../src/index.mjs";
import { RUNNERS } from "../src/nodes.mjs";
import { PNG_DATA_URL } from "./harness/mock-server.mjs";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
const opts = JSON.parse('{"vector_operation":"convert","mode":"default","seed":9,"guidance_scale":3,"model":"wrong","prompt":"injected","size":"wrong","n":99,"response_format":"url","imageDataUrl":"wrong","maskDataUrl":"wrong","api_key":"wrong","Authorization":"wrong","headers":{"Authorization":"wrong"},"endpoint":"https://wrong.example","__proto__":{"polluted":true},"constructor":{}}');

for (const type of ["image", "edit"]) {
  test(`${type}: modelOpts reach the image request while node-owned/auth fields win`, async () => {
    const seen = [];
    const wf = Workflow.fromJSON({
      nodes: [
        ...(type === "edit" ? [{ id: "source", type: "upload", fields: { image: PNG_DATA_URL } }] : []),
        { id: "out", type, fields: { model: "ideogram/vector", prompt: type === "edit" ? "" : "an icon", size: "1024x1024", seed: 42, modelOpts: opts } },
      ],
      links: type === "edit" ? [{ id: "l", from: { node: "source", port: "image" }, to: { node: "out", port: "image" } }] : [],
    }, { apiKey: "test-key", fetch: async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(SVG).toString("base64") }], cost: 0.02 }));
    } });
    const result = await wf.run({});
    assert.equal(seen.length, 1);
    const { body, url, init } = seen[0];
    assert.equal(url, "https://nano-gpt.com/v1/images/generations");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    assert.equal(body.model, "ideogram/vector");
    assert.equal(body.size, "1024x1024");
    assert.equal(body.n, 1);
    assert.equal(body.response_format, "b64_json");
    assert.equal(body.vector_operation, "convert");
    assert.equal(body.mode, "default");
    assert.equal(body.seed, 42);
    assert.equal(body.guidance_scale, 3);
    assert.equal(body.prompt, type === "edit" ? undefined : "an icon");
    assert.equal(body.imageDataUrl, type === "edit" ? PNG_DATA_URL : undefined);
    for (const key of ["maskDataUrl", "api_key", "Authorization", "headers", "endpoint", "__proto__", "constructor"]) {
      assert.equal(Object.hasOwn(body, key), false, key);
    }
    const media = result.get(type === "edit" ? "Edit" : "Image");
    assert.equal(media.mime, "image/svg+xml");
    assert.equal(extForMime(media.mime), "svg");
    assert.equal(result.costUsd, 0.02);
  });
}

test("blank instruction is allowed only for the exact Vector convert model/mode (and existing upscalers)", async () => {
  const ctx = { image: async () => [PNG_DATA_URL], catalog: null, progress() {} };
  for (const [model, modelOpts, allowed] of [
    ["ideogram/vector", { vector_operation: "convert" }, true],
    ["ideogram/vector", { vector_operation: "generate" }, false],
    ["ideogram/vector", {}, false],
    ["other/vector", { vector_operation: "convert" }, false],
    ["ideogram/vector-other", { vector_operation: "convert" }, false],
    ["upscaler", {}, true],
  ]) {
    const node = { id: "n", type: "edit", fields: { model, prompt: " ", modelOpts } };
    if (allowed) await RUNNERS.edit(node, { image: PNG_DATA_URL }, ctx);
    else await assert.rejects(RUNNERS.edit(node, { image: PNG_DATA_URL }, ctx), /no edit instruction/);
  }
  await assert.rejects(RUNNERS.edit({ fields: { model: "ideogram/vector", modelOpts: opts } }, {}, ctx), /no image input/);
});

test("direct image client also rejects protected extra fields and malformed option containers", async () => {
  let sent;
  const client = new NanoClient({ apiKey: "test-key", fetch: async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.svg" }] }));
  } });
  for (const extra of [opts, { ...opts, toJSON: () => ({ model: "wrong" }) }, null, ["bad"], "bad"]) {
    await client.image({ model: "ideogram/vector", prompt: "safe", extra });
    assert.equal(sent.model, "ideogram/vector");
    assert.equal(sent.prompt, "safe");
    assert.equal(sent.n, 1);
    assert.equal(Object.hasOwn(sent, "0"), false);
  }
});

test("SVG MIME sniff handles XML, BOM, whitespace and comments without classifying arbitrary XML/HTML as SVG", () => {
  assert.equal(b64ImageMime(Buffer.from("<svg/>").toString("base64")), "image/svg+xml");
  for (const prefix of ["", " \n", "<?xml version=\"1.0\"?>\n", "\ufeff <?xml version=\"1.0\"?>\n<!-- icon -->\n"]) {
    assert.equal(b64ImageMime(Buffer.from(prefix + SVG).toString("base64")), "image/svg+xml");
  }
  for (const text of ["<html><svg></svg></html>", "<?xml version=\"1.0\"?><other/>", "<svg-not-really/>"]) {
    assert.equal(b64ImageMime(Buffer.from(text).toString("base64")), "image/png");
  }
  assert.equal(b64ImageMime("%%%invalid%%%"), "image/png");
  for (const [b64, mime] of [["/9j/", "image/jpeg"], ["iVBOR", "image/png"], ["R0lG", "image/gif"], ["UklG", "image/webp"]]) assert.equal(b64ImageMime(b64), mime);
});
