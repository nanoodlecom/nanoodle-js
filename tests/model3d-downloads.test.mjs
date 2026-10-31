import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaRef, NanoClient, estimateGraphCost, extForMime, mediaFromFile, sniffMime } from "../src/index.mjs";
import { model3dStatusUrl } from "../src/client.mjs";
import { readFileSync } from "node:fs";

// Public NanoGPT catalog snapshot, 2026-10-31; no inference calls are used.
const catalog = JSON.parse(readFileSync(new URL("./fixtures/3d-models-20261031.json", import.meta.url), "utf8"));

const ply = Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 1\nend_header\n");

test("Idol returns its Gaussian splat, keeps other models on GLB, and refuses a missing splat", async () => {
  const output = {
    kind: "3d", format: "glb", model_url: "https://cdn.example/preview.glb",
    model_mesh: { url: "https://cdn.example/output.ply" },
  };
  assert.equal(model3dStatusUrl({ data: { output } }, "speridlabs/idol"), output.model_mesh.url);
  assert.equal(model3dStatusUrl({ output }, "tripo3d/v2.5"), output.model_url);
  const requests = [];
  const client = new NanoClient({ apiKey: "synthetic", pollIntervals: { model3d: 1 }, fetch: async (url, init) => {
    requests.push([url, init]);
    return init.method === "POST" ? Response.json({ runId: "idol-job", cost: 0.1 })
      : Response.json({ data: { status: "COMPLETED", output } });
  } });
  assert.equal(await client.video("speridlabs/idol", "", { mediaKind: "model3d" }, "https://cdn.example/input.png"), output.model_mesh.url);
  assert.equal(requests.filter(([, init]) => init.method === "POST").length, 1);
  delete output.model_mesh;
  await assert.rejects(client.video("speridlabs/idol", "", { mediaKind: "model3d" }, null, { resume: "idol-job" }), /no model url/);
  assert.equal(requests.filter(([, init]) => init.method === "POST").length, 1, "resume does not resubmit a paid generation");
});

test("TRELLIS.2 estimates all resolution/texture variants and catalog defaults", () => {
  const id = "wavespeed-ai/trellis-2/image-to-3d";
  const estimate = (opts, m = catalog.find((x) => x.id === id)) => estimateGraphCost({
    nodes: [{ id: "mesh", type: "model3d", fields: { model: id, modelOpts: opts } }], links: [],
  }, { model3d: [m] });
  for (const [resolution, price] of [[512, 0.1], [1024, 0.2], [1536, 0.4]]) {
    for (const texture_size of [1024, 2048, 4096]) {
      const r = estimate({ resolution, texture_size });
      assert.equal(r.usd, texture_size === 4096 ? Number((price + 0.05).toFixed(2)) : price);
      assert.equal(r.exact, true);
    }
  }
  assert.equal(estimate({}).usd, 0.2);
  assert.equal(estimate({ texture_size: "4096" }).usd, 0.25);
  assert.equal(estimate({ resolution: "future" }).exact, false, "unknown variants retain an honest fallback");
  const m = structuredClone(catalog.find((x) => x.id === id));
  m.pricing.per_run_by_variant["512"] = 0;
  assert.equal(estimate({ resolution: "512" }, m).usd, 0, "known zero is not a missing price");
  const graph = { nodes: [
    { id: "picture", type: "image", fields: { model: "klein", size: "1k" } },
    { id: "splat", type: "model3d", fields: { model: "speridlabs/idol" } },
    { id: "mesh", type: "model3d", fields: { model: id, modelOpts: { resolution: "512", texture_size: 1024 } } },
  ], links: [] };
  const r = estimateGraphCost(graph, { model3d: catalog, image: [{ id: "klein", pricing: { per_image: { "1k": 0.009 } } }] });
  assert.equal(Number(r.usd.toFixed(3)), 0.209);
  assert.equal(r.unpriced, 0);
});

test("PLY has a recognized media MIME and extension, including binary downloads", async (t) => {
  assert.equal(sniffMime(ply), "model/ply");
  assert.equal(extForMime("model/ply"), "ply");
  assert.equal(extForMime("application/ply"), "ply");
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-ply-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let gets = 0;
  const media = new MediaRef("https://cdn.example/result?signature=private", {
    fetch: async () => {
      gets++;
      return new Response(ply, { headers: { "content-type": "application/octet-stream" } });
    },
  });
  const path = await media.save(join(dir, "splat"));
  assert.equal(path, join(dir, "splat.ply"));
  assert.equal(media.mime, "model/ply");
  assert.deepEqual(await readFile(path), ply);
  assert.equal((await mediaFromFile(path)).mime, "model/ply");
  assert.equal(gets, 1);
  await assert.rejects(stat(join(dir, "splat")), /ENOENT/);
});

test("save infers a missing filename extension and preserves explicit filenames", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-suffix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const media = new MediaRef("data:application/octet-stream;base64," + png.toString("base64"));
  assert.equal(await media.save(join(dir, "preview")), join(dir, "preview.png"));
  assert.deepEqual(await readFile(join(dir, "preview.png")), png);
  const explicit = join(dir, "exact.custom");
  assert.equal(await media.save(explicit), explicit);
  assert.deepEqual(await readFile(explicit), png);
  const unknown = new MediaRef("data:application/octet-stream;base64,AQID");
  assert.equal(await unknown.save(join(dir, "unknown")), join(dir, "unknown.bin"));
});
