import test from "node:test";
import assert from "node:assert/strict";
import { estimateGraphCost, graphModelKinds, materialize } from "../src/index.mjs";

// Minimal raw catalog entries in the exact shapes the /api/v1/*-models endpoints return.
const catalogs = {
  chat: [
    { id: "glm-5.2", pricing: { prompt: 0.5, completion: 1.5 } },      // $ per 1M tokens
    { id: "omni", pricing: { note: "varies_by_modality" } },          // unpriceable
  ],
  image: [
    { id: "flux", pricing: { per_image: { square: 0.02, square_hd: 0.04 } }, supported_parameters: { max_output_images: 4 } },
    { id: "fixed4", pricing: { per_image: { square: 0.01 } }, supported_parameters: { fixed_image_count: 4 } },
  ],
  video: [
    { id: "vid-ps", pricing: { per_second_by_resolution: { "720p": 0.05 }, default_resolution: "720p", default_duration: 5 } },
    { id: "vid-flat", pricing: { per_video: 0.3 } },
  ],
  audio: [
    { id: "tts1", pricing: { per_thousand_chars: 0.015 } },
  ],
};

const g = (...nodes) => ({ nodes, links: [] });

test("image node prices exactly, respecting variations clamp and size tier", () => {
  const r1 = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "flux", size: "square", variations: 3 } }), catalogs);
  assert.equal(r1.usd, 0.06);          // 0.02 × 3
  assert.equal(r1.exact, true);
  assert.equal(r1.priced, 1);
  assert.equal(r1.unpriced, 0);

  // over-set variations clamp to max_output_images (4), hd tier
  const r2 = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "flux", size: "square_hd", variations: 99 } }), catalogs);
  assert.equal(r2.usd, 0.16);          // 0.04 × 4

  // fixed_image_count always bills N regardless of requested variations
  const r3 = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "fixed4", variations: 1 } }), catalogs);
  assert.equal(r3.usd, 0.04);          // 0.01 × 4
});

test("chat node estimates from token assumptions and is inexact", () => {
  const r = estimateGraphCost(g({ id: "1", type: "llm", fields: { model: "glm-5.2", prompt: "hi" } }), catalogs);
  assert.ok(r.usd > 0);
  assert.equal(r.exact, false);        // chat/video/audio are forecasts
  assert.equal(r.priced, 1);
});

test("video node prices per-second × duration", () => {
  const r = estimateGraphCost(g({ id: "1", type: "tvideo", fields: { model: "vid-ps", resolution: "720p", duration: 8 } }), catalogs);
  assert.equal(Math.round(r.usd * 100) / 100, 0.4);   // 0.05 × 8
  assert.equal(r.exact, false);
});

test("video ref tier: a wired ref flips the mode price, by param OR by pricing evidence alone", () => {
  const modes = { per_second_by_mode: { text_to_video: 0.1, reference_to_video_image: 0.2 }, default_duration: 5 };
  const cats = { video: [
    { id: "vid-param", pricing: modes, supported_parameters: { parameters: { reference_images: {} } } },
    // minimax-h3 shape: refs priced but never named in supported_parameters
    { id: "vid-evidence", pricing: { ...modes, included_reference_images: 5, extra_reference_image: 0.04 }, supported_parameters: { parameters: { duration: {} } } },
    { id: "vid-norefs", pricing: modes, supported_parameters: { parameters: { duration: {} } } },
  ] };
  const wired = (model) => ({
    nodes: [{ id: "u1", type: "upload", fields: {} }, { id: "1", type: "tvideo", fields: { model } }],
    links: [{ id: "l1", from: { node: "u1", port: "image" }, to: { node: "1", port: "ref1" } }],
  });

  assert.equal(estimateGraphCost(wired("vid-param"), cats).usd, 1);      // 0.2 × 5
  assert.equal(estimateGraphCost(wired("vid-evidence"), cats).usd, 1);   // same tier: the run WILL send the refs
  assert.equal(estimateGraphCost(wired("vid-norefs"), cats).usd, 0.5);   // 0.1 × 5 — wires are dropped, so is the tier
});

test("audio node prices per-thousand-chars off the prompt length", () => {
  const r = estimateGraphCost(g({ id: "1", type: "tts", fields: { model: "tts1", prompt: "x".repeat(2000) } }), catalogs);
  assert.equal(Math.round(r.usd * 1000) / 1000, 0.03); // 0.015 × 2
});

test("multi-node graph sums; any non-image node makes the total inexact", () => {
  const r = estimateGraphCost(g(
    { id: "1", type: "image", fields: { model: "flux", size: "square", variations: 1 } },   // 0.02 exact
    { id: "2", type: "tvideo", fields: { model: "vid-flat" } },                             // 0.30 flat
  ), catalogs);
  assert.equal(Math.round(r.usd * 100) / 100, 0.32);
  assert.equal(r.exact, false);
  assert.equal(r.priced, 2);
});

test("free/local nodes and empty-model nodes are ignored; unknown model counts as unpriced", () => {
  const r = estimateGraphCost(g(
    { id: "1", type: "text", fields: { text: "just a prompt" } },      // local node → skipped
    { id: "2", type: "image", fields: { model: "flux", size: "square", variations: 1 } },   // 0.02
    { id: "3", type: "image", fields: { model: "does-not-exist" } },   // billable but unpriceable
  ), catalogs);
  assert.equal(r.usd, 0.02);
  assert.equal(r.priced, 1);
  assert.equal(r.unpriced, 1);         // signals the sum is a lower bound
});

test("model whose pricing shape is unknown (omni) is unpriced, not $0", () => {
  const r = estimateGraphCost(g({ id: "1", type: "llm", fields: { model: "omni" } }), catalogs);
  assert.equal(r.priced, 0);
  assert.equal(r.unpriced, 1);
  assert.equal(r.usd, 0);
});

test("empty / missing catalogs → everything unpriced, never throws", () => {
  const r = estimateGraphCost(g({ id: "1", type: "image", fields: { model: "flux" } }), {});
  assert.equal(r.priced, 0);
  assert.equal(r.unpriced, 1);
});

test("graphModelKinds reports only the kinds a graph touches (post-materialize alias)", () => {
  const graph = materialize({
    nodes: [
      { id: "1", type: "image", fields: {} },
      { id: "2", type: "audio", fields: {} },   // legacy alias → tts (audio kind)
      { id: "3", type: "text", fields: {} },     // local
    ],
    links: [],
  });
  assert.deepEqual([...graphModelKinds(graph)].sort(), ["audio", "image"]);
});

test("materialized real graph estimates without throwing", () => {
  const graph = materialize({
    nodes: [
      { id: "a", type: "llm", fields: { model: "glm-5.2", prompt: "write a caption" } },
      { id: "b", type: "image", fields: { model: "flux", size: "square", variations: 2 } },
    ],
    links: [{ id: "l1", from: { node: "a", port: "text" }, to: { node: "b", port: "prompt" } }],
  });
  const r = estimateGraphCost(graph, catalogs);
  assert.ok(r.usd > 0.04);   // at least the two images
  assert.equal(r.priced, 2);
  assert.equal(r.exact, false);
});

// The `draw` type retired on 2026-07-22. The loader treats it as an unknown type, so it
// throws UnsupportedNodeError before any network call. A legacy graph that still carries
// one must therefore forecast $0 for it, and must NOT report it as `unpriced` — `unpriced`
// means "billable but we could not price it", and a draw node is not billable at all.
test("retired 'draw' node is not billable: no cost, no unpriced count, no chat catalog fetch", () => {
  const draw = { id: "1", type: "draw", fields: { model: "glm-5.2", prompt: "a moon" } };
  const r = estimateGraphCost(g(draw), catalogs);
  assert.equal(r.usd, 0);
  assert.equal(r.priced, 0);
  assert.equal(r.unpriced, 0);
  assert.deepEqual([...graphModelKinds(g(draw))], []);

  // A billable sibling still prices normally — the draw node adds nothing to the quote.
  const mixed = estimateGraphCost(
    g(draw, { id: "2", type: "image", fields: { model: "flux", size: "square", variations: 1 } }),
    catalogs);
  assert.equal(mixed.usd, 0.02);
  assert.equal(mixed.priced, 1);
  assert.equal(mixed.unpriced, 0);
});
