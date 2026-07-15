import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaRef, mediaFromFile, Workflow } from "../src/index.mjs";
import { coerceMediaInput, bytesToDataUrl, sniffMime, MEDIA_INLINE_MAX } from "../src/media.mjs";
import { startMockServer, mockOpts, PNG_B64, PNG_DATA_URL } from "./harness/mock-server.mjs";

const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, "base64"));

test("MediaRef: data: URL bytes/save/toString/mime", async () => {
  const ref = new MediaRef(PNG_DATA_URL);
  assert.equal(ref.mime, "image/png");
  assert.equal(String(ref), PNG_DATA_URL);
  assert.equal(JSON.stringify({ img: ref }), JSON.stringify({ img: PNG_DATA_URL }));
  assert.deepEqual([...(await ref.bytes())], [...PNG_BYTES]);

  const dir = await mkdtemp(join(tmpdir(), "nanoodle-test-"));
  const path = join(dir, "out.png");
  await ref.save(path);
  assert.deepEqual([...new Uint8Array(await readFile(path))], [...PNG_BYTES]);
});

test("MediaRef: https URL fetches lazily with the injected fetch and picks up mime", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("GET /media/pic.png", { headers: { "content-type": "image/png" }, body: Buffer.from(PNG_BYTES) });

  const ref = new MediaRef(srv.url + "/media/pic.png");
  assert.equal(ref.mime, null); // unknown until fetched
  assert.deepEqual([...(await ref.bytes())], [...PNG_BYTES]);
  assert.equal(ref.mime, "image/png");
});

test("mediaFromFile: extension mime + bytes; feeds an image input end-to-end", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-test-"));
  const path = join(dir, "photo.png");
  await writeFile(path, PNG_BYTES);
  const media = await mediaFromFile(path);
  assert.equal(media.mime, "image/png");

  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", { json: { choices: [{ message: { content: "a pixel" } }], cost: 0.001 } });
  const wf = Workflow.fromJSON({
    nodes: [
      { id: "n1", type: "upload", fields: {} },
      { id: "n2", type: "vision", fields: { model: "gpt-5o" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
  }, mockOpts(srv));
  await wf.run({ Image: media });
  assert.equal(srv.requests[0].json.messages[0].content[1].image_url.url, PNG_DATA_URL);
});

test("coerceMediaInput: URLs verbatim, bytes → sniffed data:, plain strings refused, oversize refused", () => {
  assert.equal(coerceMediaInput("https://cdn.example/a.png", "x"), "https://cdn.example/a.png");
  assert.equal(coerceMediaInput(PNG_DATA_URL, "x"), PNG_DATA_URL);
  assert.equal(coerceMediaInput(PNG_BYTES, "x"), PNG_DATA_URL); // magic bytes → image/png
  assert.equal(coerceMediaInput({ data: PNG_BYTES, mime: "image/png" }, "x"), PNG_DATA_URL);
  assert.throws(() => coerceMediaInput("./photo.png", "x"), /mediaFromFile/);
  const big = "data:image/png;base64," + "A".repeat(MEDIA_INLINE_MAX);
  assert.throws(() => coerceMediaInput(big, "x"), /too large to send inline/);
  // local-only graphs opt out of the inline cap
  assert.equal(coerceMediaInput(big, "x", { enforceInlineMax: false }), big);
});

test("sniffMime magic bytes", () => {
  assert.equal(sniffMime(PNG_BYTES), "image/png");
  assert.equal(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMime(Buffer.from("RIFFxxxxWAVEfmt ")), "audio/wav");
  assert.equal(sniffMime(Buffer.from("ID3xxxx")), "audio/mpeg");
  assert.equal(sniffMime(Buffer.from("OggSxxxx")), "audio/ogg");
  assert.equal(sniffMime(Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])), "video/mp4");
  assert.equal(bytesToDataUrl(new Uint8Array([1, 2, 3])).split(";")[0], "data:application/octet-stream");
});
