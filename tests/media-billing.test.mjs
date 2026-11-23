import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateGraphCost, Workflow } from "../src/index.mjs";

import { mockOpts, PNG_DATA_URL, startMockServer } from "./harness/mock-server.mjs";
// Public provider catalog snapshot, not a payment receipt. No network/paid calls.
const catalog = JSON.parse(readFileSync(new URL("./fixtures/media-billing-catalog-2026-10-31.json", import.meta.url)));
const quote = (kind, model, duration, modelOpts = {}, resolution = "1080p") => estimateGraphCost({
  nodes: [{ id: "n", type: kind === "video" ? "vedit" : "music", fields: { model, duration, resolution, modelOpts } }], links: [],
}, catalog);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("Mirelo SFX 2.0 preserves fractional seconds in both audio and video catalogs", () => {
  for (const kind of ["video", "audio"]) {
    const result = quote(kind, "mirelo-ai/sfx2.0", 1.2, { num_samples: 1 });
    near(result.usd, 0.011 * 1.2); // one sample; quantity multiplier is outside this rounding regression
    assert.equal(result.exact, false);
  }
});

test("audio isolation bills proportional source duration, retaining its minimum price", () => {
  for (const seconds of [0.6, 1.2, 60.1]) {
    const result = estimateGraphCost({
      nodes: [{ id: "source", type: "aupload", fields: { duration: seconds } },
        { id: "clean", type: "cleanvoice", fields: { model: "elevenlabs/audio-isolation" } }],
      links: [{ from: { node: "source", port: "audio" }, to: { node: "clean", port: "audio" } }],
    }, catalog);
    near(result.usd, Math.max(0.002016666666666667 * seconds, 0.00121));
    assert.equal(result.exact, false);
  }
});

test("SeedVR2 rounds then applies its documented billable-duration bounds", () => {
  for (const [duration, billed] of [[0.6, 3], [3, 3], [5.04, 6], [599.1, 600], [601.2, 600]]) {
    near(quote("video", "seedvr2-video-upscaler", duration).usd, 0.04 * billed);
  }
});

test("P-video applies the documented FPS-dependent frame cap and rate; Turbo adds no surcharge", () => {
  for (const resolution of ["720p", "1080p", "2k", "4k"]) {
    const pricing = catalog.video.find((m) => m.id === "pruna-ai/p-video/upscale").pricing;
    for (const fps of [24, 30, 60]) {
      for (const duration of [5.04, 100.1]) {
        const seconds = Math.ceil(Math.min(duration, (pricing.frame_limits_by_resolution[resolution] - 2) / fps));
        const usd = pricing.per_second_by_resolution[resolution] * seconds * (fps === 60 ? 2 : 1);
        for (const turbo of [false, true]) {
          const result = quote("video", "pruna-ai/p-video/upscale", duration, { fps, turbo }, resolution);
          near(result.usd, usd);
          assert.equal(result.exact, false); // source duration remains a forecast until the server verifies media bytes
        }
      }
    }
  }
  // The model's documented output-FPS default is 24; do not infer source FPS.
  near(quote("video", "pruna-ai/p-video/upscale", 100.1).usd, 0.02 * 50);
});

test("FlashVSR has no whole-second contract: preserve fractional forecast and mark inexact", () => {
  const result = quote("video", "video-upscaler", 5.04);
  near(result.usd, 0.0225 * 5.04);
  assert.equal(result.exact, false);
});

test("rounding mentioned only for references does not round MiniMax output or LoRA output", () => {
  const m = catalog.video.find((m) => m.id === "minimax-h3");
  const estimate = (fields) => estimateGraphCost({ nodes: [{ id: "n", type: "tvideo", fields: {
    model: m.id, duration: 5.04, resolution: "480p", ...fields,
  } }], links: [] }, { video: [m] });
  // Existing generic fallback chooses its smallest per-second rate, without inventing an output rounding rule.
  near(estimate({}).usd, 0.14 * 5.04);
  near(estimate({ loraUrl: "https://cdn.example/lora" }).usd, 0.05 * 5.04);
});

test("missing or invalid output FPS does not invent frame-cap quantities", () => {
  const model = structuredClone(catalog.video.find((m) => m.id === "pruna-ai/p-video/upscale"));
  delete model.pricing.default_fps;
  for (const fps of [undefined, 0, 25, "not-a-number"]) {
    const result = estimateGraphCost({ nodes: [{ id: "n", type: "vedit", fields: {
      model: model.id, duration: 5.04, resolution: "1080p", modelOpts: { fps },
    } }], links: [] }, { video: [model] });
    near(result.usd, 0.02 * 5.04);
    assert.equal(result.exact, false);
  }
});

test("VEED Clean Audio retains its documented started-minute billing intervals", () => {
  const model = catalog.audio.find((m) => m.id === "veed/clean-audio");
  const pricing = model.pricing;
  for (const seconds of [0.6, 59.1, 60, 60.1, 119.99, 120.1]) {
    const result = estimateGraphCost({
      nodes: [{ id: "source", type: "aupload", fields: { duration: seconds } },
        { id: "clean", type: "cleanvoice", fields: { model: model.id } }],
      links: [{ from: { node: "source", port: "audio" }, to: { node: "clean", port: "audio" } }],
    }, { audio: [model] });
    near(result.usd, Math.max(pricing.minimum || 0,
      Math.ceil(seconds / pricing.billing_interval_seconds) * pricing.per_billing_interval));
  }
});

const h3Hyper = JSON.parse(readFileSync(new URL("./fixtures/h3-hyper-video-catalog-2026-11-23.json", import.meta.url)));
const h3Catalog = { video: [h3Hyper] };

function h3Video(type, fields, image = PNG_DATA_URL, endframe = false) {
  const nodes = [{ id: "h3", type, fields: { model: h3Hyper.id, prompt: "A drawn paper boat rocks gently on rainwater.", ...fields } }];
  const links = [];
  if (type === "ivideo") {
    nodes.unshift({ id: "still", type: "upload", fields: { image } });
    links.push({ from: { node: "still", port: "image" }, to: { node: "h3", port: "image" } });
    if (endframe) links.push({ from: { node: "still", port: "image" }, to: { node: "h3", port: "endframe" } });
  }
  return { nodes, links };
}

test("MiniMax H3 Hyper bills the requested 15-second image-to-video lane", async (t) => {
  const server = await startMockServer();
  t.after(() => server.close());
  server.script("POST /api/generate-video", { json: { runId: "h3-offline-fixture", cost: 0.62 } });
  server.script("GET /api/video/status", { json: { status: "COMPLETED", output: { url: "https://cdn.example/fixture.mp4" } } });

  const graph = h3Video("ivideo", { duration: "15", resolution: "768p", modelOpts: { mode: "image-to-video", duration: "4" } });
  const result = await Workflow.fromJSON(graph, mockOpts(server, { catalog: h3Catalog })).run({});
  assert.deepEqual(server.of("POST /api/generate-video").map(request => request.json), [{
    model: h3Hyper.id, prompt: "A drawn paper boat rocks gently on rainwater.",
    duration: "15", aspect_ratio: "16:9", resolution: "768p",
    imageDataUrl: PNG_DATA_URL, mode: "image-to-video",
  }]);
  assert.equal(result.costUsd, 0.62);
  const estimate = estimateGraphCost(graph, h3Catalog);
  assert.equal(estimate.usd, 0.62);
  assert.equal(estimate.exact, false);
});

test("MiniMax H3 Hyper uses the catalog mode and duration instead of its cheapest clip", () => {
  for (const [type, duration, expected] of [
    ["ivideo", "4", 0.11], ["ivideo", undefined, 0.18],
    ["tvideo", "4", 0.10], ["tvideo", "15", 0.55],
  ]) {
    assert.equal(estimateGraphCost(h3Video(type, { duration }), h3Catalog).usd, expected);
  }
  const firstLastModel = structuredClone(h3Hyper);
  firstLastModel.pricing.first_last_frame_per_duration["15"] = 0.61;
  const firstLast = h3Video("ivideo", { duration: "15" }, PNG_DATA_URL, true);
  assert.equal(estimateGraphCost(firstLast, { video: [firstLastModel] }).usd, 0.61);

  for (const duration of ["15.5", "16", "3"]) {
    const estimate = estimateGraphCost(h3Video("ivideo", { duration }), h3Catalog);
    assert.equal(estimate.unpriced, 1);
  }
});
