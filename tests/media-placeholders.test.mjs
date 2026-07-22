/**
 * Media fields hold data:/http(s) URLs — anything else (prose placeholders like
 * "[image content will be provided separately]", bare file paths, objects) is an
 * authoring mistake that used to LOOK like a filled input: inspect printed it as a
 * default and run() posted the prose to the API. materialize() now blanks such values
 * with a how-to-fix warning, so the input surfaces as genuinely required.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { Workflow, materialize } from "../src/index.mjs";
import { PNG_B64 } from "./harness/mock-server.mjs";

const noNet = { apiKey: "unused", quiet: true };
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle.mjs");

test("loader: prose placeholders in media fields are blanked with a how-to warning (image/audio/video/mask)", () => {
  const { nodes, warnings } = materialize({
    nodes: [
      { id: "n1", type: "upload", fields: { image: "[image content will be provided separately]" } },
      { id: "n2", type: "aupload", fields: { audio: "the user's narration clip goes here" } },
      { id: "n3", type: "vupload", fields: { video: "./clips/intro.mp4" } },
      { id: "n4", type: "inpaint", fields: { image: "photo of the user", mask: { path: "mask.png" } } },
    ],
    links: [],
  });
  for (const [i, field] of [["0", "image"], ["1", "audio"], ["2", "video"]]) {
    assert.equal(nodes[i].fields[field], "", `nodes[${i}].fields.${field} should be blanked`);
  }
  assert.equal(nodes[3].fields.image, "");
  assert.equal(nodes[3].fields.mask, "");
  assert.equal(warnings.length, 5);
  assert.match(warnings[0], /node n1 .*fields\.image held "\[image content will be provided separately\]"/);
  assert.match(warnings[0], /treated as empty/);
  assert.match(warnings[0], /--input "<key>=@file"/);
  assert.match(warnings[3], /fields\.image held "photo of the user"/);
  assert.match(warnings[4], /fields\.mask held an object/);
});

test("loader: real media URLs (data:, https:, http:) pass through untouched", () => {
  const png = "data:image/png;base64," + PNG_B64;
  const { nodes, warnings } = materialize({
    nodes: [
      { id: "n1", type: "upload", fields: { image: png } },
      { id: "n2", type: "aupload", fields: { audio: "https://cdn.example.com/clip.mp3" } },
      { id: "n3", type: "vupload", fields: { video: "http://example.com/clip.mp4" } },
      { id: "n4", type: "upload", fields: {} },              // absent field: no warning
      { id: "n5", type: "upload", fields: { image: "" } },   // already empty: no warning
    ],
    links: [],
  });
  assert.equal(nodes[0].fields.image, png);
  assert.equal(nodes[1].fields.audio, "https://cdn.example.com/clip.mp3");
  assert.equal(nodes[2].fields.video, "http://example.com/clip.mp4");
  assert.deepEqual(warnings, []);
});

test("workflow: a placeholder-authored upload derives a REQUIRED input with no default, and run({}) fails fast", async () => {
  const wf = Workflow.fromJSON({
    nodes: [{ id: "n1", type: "upload", fields: { image: "[will be supplied via --input]" } }],
    links: [],
  }, noNet);
  assert.equal(wf.warnings.length, 1);
  const img = wf.inputs.find((i) => i.field === "image");
  assert.equal(img.optional, false);
  assert.equal(img.def, undefined); // no fake "filled" default
  await assert.rejects(wf.run({}), /missing required input "Image" \(n1\.image\)/);
});

test("CLI inspect: media defaults summarized (never a base64 dump), required media gets a supply hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-ph-"));
  const graphPath = join(dir, "graph.json");
  const png = "data:image/png;base64," + PNG_B64;
  await writeFile(graphPath, JSON.stringify({
    nodes: [
      { id: "n1", type: "upload", name: "Prefilled", fields: { image: png } },
      { id: "n2", type: "aupload", name: "Narration", fields: { audio: "[audio goes here]" } },
    ],
    links: [],
  }));
  const r = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, "inspect", graphPath], { env: { ...process.env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(PNG_B64), "inspect must not dump base64 media");
  assert.match(r.stdout, /"Prefilled".*prefilled: inline image\/png \(\d+ KB\)/);
  assert.match(r.stdout, /"Narration".*required.*supply: --input "Narration=@file"/);
  assert.match(r.stdout, /warning: node n2 .*fields\.audio held "\[audio goes here\]"/);
});
