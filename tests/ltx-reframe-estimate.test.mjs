import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { estimateGraphCost } from "../src/index.mjs";

// Public /api/v1/video-models entry captured 2026-11-13. No inference or quote POST.
const model = JSON.parse(readFileSync(new URL("./fixtures/ltx-reframe-catalog-2026-11-13.json", import.meta.url)));
const quote = (seconds, resolution, overrides = {}, pricing = model.pricing) => estimateGraphCost({
  nodes: [
    { id: "source", type: "vupload", fields: { duration: seconds } },
    { id: "reframe", type: "vedit", fields: { model: model.id, resolution, duration: 999, ...overrides } },
  ],
  links: [{ from: { node: "source", port: "video" }, to: { node: "reframe", port: "video" } }],
}, { video: [{ ...model, pricing }] });

test("Reframe bills fractional input seconds at the chosen output resolution", () => {
  for (const [resolution, rate] of [["720p", 0.1], ["1080p", 0.2]]) {
    for (const seconds of [0.5, 1, 5, 5.041667, 12.25, 60]) {
      const result = quote(seconds, resolution);
      assert.ok(Math.abs(result.usd - seconds * rate) < 1e-9, `${resolution}, ${seconds}s`);
      assert.equal(result.priced, 1);
      assert.equal(result.unpriced, 0);
      assert.equal(result.exact, false);
    }
  }
});

test("Reframe uses the catalog's 1080p default rather than the first/cheapest rate", () => {
  assert.equal(quote(5).usd, 1);
  assert.equal(quote(5, undefined, { modelOpts: { resolution: "720p" } }).usd, 0.5);
});

test("Reframe input limits and output-duration fields never become a price", () => {
  assert.equal(quote(5, "720p", {}, { ...model.pricing, maximum_seconds: 400, maximum_frames: 300, max_input_bytes: 100 }).usd, 0.5);
  assert.equal(quote(5, "1080p", { duration: 60, modelOpts: { duration: 1800 } }).usd, 1);
});

test("missing, invalid, or over-limit source duration remains unpriced", () => {
  for (const seconds of [undefined, null, "", 0, -1, NaN, Infinity, "5 seconds", 60.01]) {
    const result = quote(seconds, "720p");
    assert.equal(result.usd, 0, String(seconds));
    assert.equal(result.priced, 0);
    assert.equal(result.unpriced, 1);
  }
  assert.equal(quote(5, "4k").unpriced, 1);
});

test("an unmeasured Reframe step leaves an explicit unpriced count beside the subtotal", () => {
  const result = estimateGraphCost({ nodes: [
    { id: "image", type: "image", fields: { model: "still" } },
    { id: "reframe", type: "vedit", fields: { model: model.id, duration: 5, resolution: "1080p" } },
  ], links: [] }, { video: [model], image: [{ id: "still", pricing: { per_image: { square: 3 } } }] });
  assert.equal(result.usd, 3);
  assert.equal(result.priced, 1);
  assert.equal(result.unpriced, 1);
});
