/**
 * CLI run contract (shared with nanoodle-py and the docs):
 *   nanoodle run <graph.json> [--input k=v]... [--out dir]
 *   - media outputs saved under --out (default ./noodle-out, created only when needed)
 *   - JSON run summary ALWAYS on stdout; progress/log lines on stderr
 *   - exit 0 success / 1 failure
 * Plus: --help with runnable examples, --version, init (starter-graph scaffold).
 * Fully offline — all network goes to the mock server via NANOGPT_BASE_URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { startMockServer, chatJson, PNG_B64 } from "./harness/mock-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "bin", "nanoodle.mjs");
const starterFixture = join(here, "fixtures", "starter-graph.json");

// async spawn — MUST NOT be spawnSync: the mock server lives in THIS process, and a blocked
// event loop can never answer the child CLI's request (deadlock until undici's 5-min timeout)
function runCli(args, { env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, NANOGPT_API_KEY: "test-key", ...env },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function scriptStarterRoutes(srv) {
  srv.script("POST /api/v1/chat/completions", chatJson("a vivid ramen-shop prompt"));
  srv.script("POST /v1/images/generations", {
    headers: { "x-remaining-balance": "4.85" },
    json: { data: [{ b64_json: PNG_B64 }], cost: 0.02 },
  });
}

test("CLI contract: run with no --out saves media under ./noodle-out and prints a JSON summary to stdout", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  scriptStarterRoutes(srv);
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));

  const r = await runCli(["run", starterFixture, "--input", "Text=a moonlit koi pond"],
    { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 0, r.stderr);

  // stdout is EXACTLY one JSON summary (machine-parseable without flags)
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.outputs.Image, join("noodle-out", "Image.png"));
  assert.equal(summary.costUsd, 0.0212);
  assert.deepEqual(summary.errors, []);

  // the media file really exists in the DEFAULT out dir, with the mock's PNG bytes
  const saved = await readFile(join(cwd, "noodle-out", "Image.png"));
  assert.deepEqual(saved, Buffer.from(PNG_B64, "base64"));

  // human progress went to stderr, not stdout
  assert.match(r.stderr, /saved/);
});

test("CLI contract: --out overrides the default directory", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  scriptStarterRoutes(srv);
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));

  const r = await runCli(["run", starterFixture, "--out", "renders"],
    { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outputs.Image, join("renders", "Image.png"));
  await stat(join(cwd, "renders", "Image.png")); // throws if missing
  await assert.rejects(stat(join(cwd, "noodle-out")), /ENOENT/, "default dir must not be created when --out is given");
});

test("CLI contract: text-only runs print JSON to stdout without --json and create no out dir", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("mock reply"));
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  const graph = {
    nodes: [
      { id: "n1", type: "text", fields: { text: "hello" } },
      { id: "n2", type: "llm", fields: { model: "test-model" } },
    ],
    links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
  };
  const graphPath = join(cwd, "g.json");
  await writeFile(graphPath, JSON.stringify(graph));

  const r = await runCli(["run", graphPath], { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outputs.LLM, "mock reply");
  await assert.rejects(stat(join(cwd, "noodle-out")), /ENOENT/, "no media → no out dir");
});

test("CLI contract: a failed sink exits 1 but still emits the JSON summary with the error", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("a prompt"));
  srv.script("POST /v1/images/generations", { status: 500, json: { error: "mock boom" } });
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));

  const r = await runCli(["run", starterFixture], { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run failed/);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.outputs.Image, null);
  assert.ok(summary.errors.length >= 1, "summary.errors must name the failure");
});

test("CLI contract: --help exits 0 and reads like docs (runnable examples, default out dir, share-URL TODO)", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /examples:/);
  assert.match(r.stdout, /nanoodle run noodle-graph\.json --input Text=/);
  assert.match(r.stdout, /nanoodle init && nanoodle inspect/);
  assert.match(r.stdout, /noodle-out/);
  assert.match(r.stdout, /NANOGPT_API_KEY/);
  assert.match(r.stdout, /Share URLs .* not accepted yet/);
});

test("CLI: init scaffolds the exact starter-graph fixture and never overwrites", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  const r = await runCli(["init"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "noodle-graph.json");

  // drift guard: the shipped template must stay byte-identical to the tested fixture
  const written = await readFile(join(cwd, "noodle-graph.json"), "utf8");
  assert.equal(written, await readFile(starterFixture, "utf8"));

  const again = await runCli(["init"], { cwd });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test("CLI: init accepts a custom path and the result inspects cleanly offline", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  const r = await runCli(["init", "custom.json"], { cwd });
  assert.equal(r.status, 0, r.stderr);

  const insp = await runCli(["inspect", "custom.json"], { cwd });
  assert.equal(insp.status, 0, insp.stderr);
  assert.match(insp.stdout, /Inputs:/);
  assert.match(insp.stdout, /"Text"/);
  assert.match(insp.stdout, /"Image"/);
});
