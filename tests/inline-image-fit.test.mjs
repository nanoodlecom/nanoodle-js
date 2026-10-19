/**
 * Oversized inline images: NanoGPT 413s any request body over ~4.4 MB
 * (FUNCTION_PAYLOAD_TOO_LARGE — no upload endpoint exists), and modern image
 * models return 4K PNGs (~13 MB as base64). fitImageInline downscales before
 * the send so generate→animate/edit/describe chains survive instead of dying
 * at the body-size preflight.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workflow } from "../src/index.mjs";
import { fitImageInline, INLINE_IMAGE_BUDGET } from "../src/local-media.mjs";
import { MEDIA_INLINE_MAX } from "../src/media.mjs";
import { startMockServer, mockOpts, PNG_DATA_URL } from "./harness/mock-server.mjs";

const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function skipWithoutFfmpeg(t) {
  // t.skip() returns undefined and does NOT abort the body: return true so callers
  // (`if (skipWithoutFfmpeg(t)) return;`) actually stop before shelling out to ffmpeg.
  if (!hasFfmpeg) { t.skip("ffmpeg not on PATH"); return true; }
  return false;
}

/** Incompressible noise PNG well over the inline cap (pure resize path handles it). */
async function bigNoisePng(dir) {
  const path = join(dir, "noise.png");
  const r = spawnSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=gray:size=1600x1600", "-frames:v", "1",
    "-vf", "noise=alls=100:allf=t", path,
  ], { stdio: "ignore" });
  assert.equal(r.status, 0);
  const url = `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
  assert.ok(url.length > MEDIA_INLINE_MAX, "fixture must exceed the inline cap");
  return url;
}

test("fitImageInline: passthrough for fitting data URLs and http(s) URLs", async () => {
  assert.equal(await fitImageInline(PNG_DATA_URL), PNG_DATA_URL);
  assert.equal(await fitImageInline("https://cdn.example/a.png"), "https://cdn.example/a.png");
});

test("fitImageInline: oversized PNG shrinks under the send budget", async (t) => {
  if (skipWithoutFfmpeg(t)) return;
  const dir = await mkdtemp(join(tmpdir(), "nn-fit-"));
  try {
    const big = await bigNoisePng(dir);
    let shrunkTo = 0;
    const out = await fitImageInline(big, { onShrink: (d) => { shrunkTo = d; } });
    assert.match(out, /^data:image\//);
    assert.ok(out.length <= INLINE_IMAGE_BUDGET, `still ${out.length} bytes`);
    assert.ok(shrunkTo > 0, "onShrink should fire");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ivideo: a 4K-class upstream image is downscaled into the generate-video body", async (t) => {
  if (skipWithoutFfmpeg(t)) return;
  const dir = await mkdtemp(join(tmpdir(), "nn-fit-"));
  try {
    const big = await bigNoisePng(dir);
    const srv = await startMockServer();
    t.after(() => srv.close());
    srv.script("POST /api/generate-video", { json: { runId: "v1", cost: 0.1 } });
    srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/v.mp4" } } });

    const wf = Workflow.fromJSON({
      nodes: [
        { id: "n1", type: "upload", fields: { image: big } },
        { id: "n2", type: "ivideo", name: "Vid", fields: { model: "test-i2v", prompt: "go" } },
      ],
      links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
    }, mockOpts(srv));
    const result = await wf.run({});

    const body = srv.of("POST /api/generate-video")[0].json;
    assert.match(body.imageDataUrl, /^data:image\//);
    assert.ok(body.imageDataUrl.length <= INLINE_IMAGE_BUDGET, `sent ${body.imageDataUrl.length} bytes`);
    assert.equal(result.get("Vid").url, "https://cdn.example/v.mp4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("run inputs: an oversized image input is no longer refused at load time", async (t) => {
  if (skipWithoutFfmpeg(t)) return;
  const dir = await mkdtemp(join(tmpdir(), "nn-fit-"));
  try {
    const big = await bigNoisePng(dir);
    const srv = await startMockServer();
    t.after(() => srv.close());
    srv.script("POST /api/generate-video", { json: { runId: "v1", cost: 0.1 } });
    srv.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/v.mp4" } } });

    const wf = Workflow.fromJSON({
      nodes: [
        { id: "n1", type: "upload", fields: {} },
        { id: "n2", type: "ivideo", name: "Vid", fields: { model: "test-i2v", prompt: "go" } },
      ],
      links: [{ id: "l1", from: { node: "n1", port: "image" }, to: { node: "n2", port: "image" } }],
    }, mockOpts(srv));
    const result = await wf.run({ Image: big }); // pre-fix: threw "too large to send inline" before any node ran
    assert.equal(result.get("Vid").url, "https://cdn.example/v.mp4");
    const body = srv.of("POST /api/generate-video")[0].json;
    assert.ok(body.imageDataUrl.length <= INLINE_IMAGE_BUDGET);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
