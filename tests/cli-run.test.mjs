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
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    // End Node's own option parsing so Nanoodle sees --env-file itself.
    const p = spawn(process.execPath, ["--", bin, ...args], {
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

test("CLI runs a saved walking character graph with --input model=@file.glb", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-model-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "walk.json"), JSON.stringify({
    nodes: [
      { id: "m", type: "mupload", fields: {} },
      { id: "s", type: "slice-3d", fields: { clip: "Walk", frames: 2, slices: 8, resolution: 16 } },
    ],
    links: [{ from: { node: "m", port: "model" }, to: { node: "s", port: "model" } }],
  }));
  const model = join(here, "fixtures", "fox", "Fox.glb");
  const r = await runCli(["run", "walk.json", "--input", "m.model=@" + model, "--json"], { cwd });
  assert.equal(r.status, 0, r.stderr);
  const {outputs, errors} = JSON.parse(r.stdout);
  assert.deepEqual(errors, []);
  const sheet = await readFile(join(cwd, outputs["Slice 3D"]));
  const { readStackApng } = await import("../src/sprite-sequence.mjs");
  assert.equal(readStackApng(sheet).length, 2);
});

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
  assert.equal(Object.hasOwn(summary, "payments"), false);

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

test("CLI reports preflight failures as one zero-cost run summary", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("unexpected request"));
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-preflight-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const source = { id: "source", type: "text", fields: { text: "wired value" } };
  const writer = { id: "writer", type: "llm", fields: { model: "fixture", prompt: "stored prompt" } };
  const wire = (from, to) => ({ from: { node: from, port: "text" }, to: { node: "writer", port: to } });
  const files = {
    "invalid-target.json": { nodes: [source, writer], links: [wire("source", "promtp")] },
    "missing-source.json": { nodes: [writer], links: [wire("source", "prompt")] },
    "missing-node-type.json": { nodes: [writer, { id: "damaged" }] },
    "missing-node-id.json": { nodes: [{ type: "text" }, writer] },
    "null-node.json": { nodes: [null, writer] },
    "required.json": { nodes: [{ ...writer, fields: { ...writer.fields, prompt: "" } }] },
    "deadline.json": { nodes: [{ ...writer, fields: { ...writer.fields, timeoutMs: 2147483648 } }] },
    "unknown.json": { nodes: [{ id: "future", type: "future-node" }] },
    "valid.json": { nodes: [writer] },
  };
  await Promise.all(Object.entries(files).map(([path, data]) => writeFile(join(cwd, path), JSON.stringify(data))));
  await writeFile(join(cwd, "malformed.json"), "{");
  const cases = [
    { file: "missing.json", message: /ENOENT/, code: "ENOENT" },
    { file: "malformed.json", message: /JSON/i },
    { file: "invalid-target.json", message: /undeclared target port "promtp"/, code: "invalid-target-port" },
    { file: "missing-source.json", message: /missing source node "source"/, code: "missing-wire-node" },
    { file: "missing-node-type.json", message: /node at position 2 has a missing or invalid type/, code: "invalid-node-record" },
    { file: "missing-node-id.json", message: /node at position 1 has a missing or invalid id/, code: "invalid-node-record" },
    { file: "null-node.json", message: /node at position 1 must be an object/, code: "invalid-node-record" },
    { file: "required.json", message: /missing required input.*writer\.prompt/, json: false },
    { file: "deadline.json", message: /node writer timeoutMs expects milliseconds/, code: "invalid-timeout" },
    { file: "unknown.json", message: /unknown node type/, nodeId: "future", nodeType: "future-node" },
    { file: "valid.json", args: ["--set", "missing.model=foo"], message: /unknown setting/ },
    { file: "valid.json", args: ["--input", "writer.prompt=@missing.txt"], message: /missing\.txt/, code: "ENOENT" },
    { file: "valid.json", args: ["--env-file", "missing.env"], message: /--env-file: cannot read missing\.env/, code: "ENOENT" },
  ];
  for (const { file, args = [], message, code, nodeId, nodeType, json = true } of cases) {
    const r = await runCli(["run", file, ...args, ...(json ? ["--json"] : [])], {
      cwd, env: { NANOGPT_BASE_URL: srv.url },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, message);
    const { errors, ...summary } = JSON.parse(r.stdout);
    assert.deepEqual(summary, {
      outputs: {}, costUsd: 0, costExact: true, remainingBalance: null, gated: [], nodes: {},
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, message);
    assert.equal(errors[0].code, code);
    assert.equal(errors[0].nodeId, nodeId);
    assert.equal(errors[0].nodeType, nodeType);
    assert.equal(srv.requests.length, 0);
  }
  await assert.rejects(stat(join(cwd, "noodle-out")), { code: "ENOENT" });
});

test("CLI contract: --help exits 0 and reads like docs (runnable examples, default out dir, share URLs)", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /examples:/);
  assert.match(r.stdout, /nanoodle run noodle-graph\.json --input Text=/);
  assert.match(r.stdout, /nanoodle init && nanoodle inspect/);
  assert.match(r.stdout, /noodle-out/);
  assert.match(r.stdout, /NANOGPT_API_KEY/);
  assert.match(r.stdout, /<graph\.json\|share-url>/);          // share links are first-class now
  assert.match(r.stdout, /nanoodle\.com\/#g=/);                // …with a paste-a-link example
});

test("CLI: inspect accepts an editor-minted share URL, fully offline", async () => {
  const golden = JSON.parse(await readFile(join(here, "fixtures", "share", "g-starter.json"), "utf8"));
  const r = await runCli(["inspect", golden.url]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Inputs:/);
  assert.match(r.stdout, /Nodes:/);
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

test("CLI: hosted media outputs are named from the download's Content-Type, not .bin", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/chat/completions", chatJson("a vivid ramen-shop prompt"));
  // API hands back a hosted URL (no b64_json) — the mime is only knowable after fetching it
  srv.script("POST /v1/images/generations", {
    headers: { "x-remaining-balance": "4.85" },
    json: { data: [{ url: srv.url + "/media/out" }], cost: 0.02 },
  });
  srv.script("GET /media/out", {
    headers: { "content-type": "image/png" },
    body: Buffer.from(PNG_B64, "base64"),
  });
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));

  const r = await runCli(["run", starterFixture, "--input", "Text=a moonlit koi pond"],
    { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outputs.Image, join("noodle-out", "Image.png"));
  await stat(join(cwd, "noodle-out", "Image.png")); // throws if missing (e.g. saved as Image.bin)
});

test("CLI retains the run summary and other outputs when a hosted media download fails", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", {
    json: { data: [{ url: srv.url + "/media/missing?sig=fixture-signature" }], cost: 0.02 },
  });
  srv.script("GET /media/missing", { status: 404 });
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-download-error-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "graph.json"), JSON.stringify({
    nodes: [
      { id: "remote", type: "image", name: "Remote", fields: { model: "fixture", prompt: "synthetic pixels" } },
      { id: "inline", type: "upload", name: "Inline", fields: { image: "data:image/png;base64," + PNG_B64 } },
      { id: "note", type: "text", name: "Note", fields: { text: "keep this output" } },
    ],
  }));
  const r = await runCli(["run", "graph.json", "--json"], { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 1, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual(summary.outputs, { Remote: null, Inline: join("noodle-out", "Inline.png"), Note: "keep this output" });
  assert.equal(summary.costUsd, 0.02);
  assert.equal(summary.costExact, true);
  assert.equal(summary.nodes.remote.status, "done");
  assert.equal(summary.errors.length, 1);
  const [error] = summary.errors;
  assert.equal(error.code, "output-save-failed");
  assert.equal(error.nodeId, "remote");
  assert.match(error.message, /could not save output "Remote".*couldn't download media \(404\)/);
  assert.match(r.stderr, /could not save output "Remote"/);
  assert.doesNotMatch(r.stdout + r.stderr, /fixture-signature/);
  assert.deepEqual(await readFile(join(cwd, summary.outputs.Inline)), Buffer.from(PNG_B64, "base64"));
  assert.deepEqual(srv.requests.map(req => req.method + " " + req.path), ["POST /v1/images/generations", "GET /media/missing"]);
});

test("CLI reports a failed output directory without losing the run summary", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-output-error-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "blocked"), "existing file");
  await writeFile(join(cwd, "graph.json"), JSON.stringify({
    nodes: [
      { id: "inline", type: "upload", name: "Inline", fields: { image: "data:image/png;base64," + PNG_B64 } },
      { id: "note", type: "text", name: "Note", fields: { text: "keep this output" } },
    ],
  }));
  const r = await runCli(["run", "graph.json", "--out", "blocked", "--json"], {
    cwd, env: { NANOGPT_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(r.status, 1, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual(summary.outputs, { Inline: null, Note: "keep this output" });
  assert.equal(summary.nodes.inline.status, "done");
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].code, "output-save-failed");
  assert.equal(summary.errors[0].nodeId, "inline");
  assert.match(summary.errors[0].message, /could not save output "Inline"/);
  assert.equal(await readFile(join(cwd, "blocked"), "utf8"), "existing file");
});

test("CLI contract: a closed ⚖️ Decide gate exits 0 and reports gated, not failed", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /api/v1/decisions", { json: { answers: { answer: { type: "noul", noul: 0.12 } }, usage: { input_tokens: 30, output_tokens: 0, cost: 0.000003 } } });
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  const graph = join(cwd, "gate.json");
  await writeFile(graph, JSON.stringify({
    nodes: [
      { id: "t", type: "text", fields: { text: "a dog" } },
      { id: "g", type: "decide", fields: { model: "liquid/d1", mode: "yesno", gate: true, question: "Is it a cat?" } },
      { id: "l", type: "llm", fields: { model: "gpt-x", prompt: "x" } },
    ],
    links: [
      { id: "l1", from: { node: "t", port: "text" }, to: { node: "g", port: "text" } },
      { id: "l2", from: { node: "g", port: "text" }, to: { node: "l", port: "prompt" } },
    ],
  }));
  const r = await runCli(["run", graph], { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.errors, []);
  assert.equal(s.gated.length, 1);
  assert.equal(s.gated[0].nodeId, "g");
  assert.deepEqual(s.gated[0].skipped, ["l"]);
  assert.equal(s.nodes.g.status, "gated");
  assert.equal(s.nodes.g.gate.yes, 0.12);
  assert.equal(s.nodes.l.status, "skipped");
  assert.equal(s.nodes.l.gatedBy, "g");
  assert.equal(s.outputs.LLM, null);
  assert.equal(s.costUsd, 0.000003);
  assert.match(r.stderr, /⛔ Decide \(g\) gated: gate closed/);
  assert.match(r.stderr, /⤼ LLM \(l\) skipped — gate g said no/);
  assert.ok(srv.requests.every((q) => q.path !== "/api/v1/chat/completions"));
});

test('CLI failure summary retains accepted job ID for recovery', async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script('POST /api/generate-video', { json: { runId: 'accepted-job', cost: 0.2 } });
  const cwd = await mkdtemp(join(tmpdir(), 'nanoodle-cli-'));
  const graphPath = join(cwd, 'g.json');
  await writeFile(graphPath, JSON.stringify({ nodes: [{ id: 'v', type: 'tvideo', fields: { model: 'test', prompt: 'hi' } }], links: [] }));
  const r = await runCli(['run', graphPath, '--timeout', '300'], { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 1, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.nodes.v.runId, 'accepted-job');
  assert.equal(summary.nodes.v.status, 'error');
});

test("CLI rejects malformed or out-of-range --timeout before running the workflow", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  scriptStarterRoutes(srv);
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const value of ["nonsense", "", "  ", "500ms", "0x20", "Infinity", "-1", "2147483648", "1e-500"]) {
    const r = await runCli(["run", starterFixture, "--timeout", value, "--json"], {
      cwd, env: { NANOGPT_BASE_URL: srv.url },
    });
    assert.equal(r.status, 1, JSON.stringify(value));
    assert.equal(r.stdout, "", JSON.stringify(value));
    assert.match(r.stderr, /--timeout expects milliseconds between 0 and 2147483647/);
    assert.equal(srv.requests.length, 0);
  }
});

test("CLI reports a missing option value before another flag", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  scriptStarterRoutes(srv);
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const flag of ["--timeout", "--input", "--set", "--out", "--key", "--env-file"]) {
    const r = await runCli(["run", starterFixture, flag, "--json"], {
      cwd, env: { NANOGPT_BASE_URL: srv.url },
    });
    assert.equal(r.status, 1, flag);
    assert.equal(r.stdout, "", flag);
    assert.match(r.stderr, new RegExp(`${flag} expects a value`));
    assert.equal(srv.requests.length, 0);
  }
});

test("CLI preserves valid timeouts, dash-leading input names, and quiet JSON output", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const graph = join(cwd, "g.json");
  await writeFile(graph, JSON.stringify({ nodes: [{ id: "t", type: "text", name: "--prompt", fields: { text: "saved" } }] }));
  for (const value of ["0", "1500.5", "2e3", "2147483647"]) {
    const r = await runCli(["run", graph, "--timeout", value, "--input", "--prompt=--hello", "--json"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(JSON.parse(r.stdout).outputs["--prompt"], "--hello");
  }
});

test("CLI --pay JSON reports the original payment after a completion failure", async (t) => {
  const srv = await startMockServer();
  t.after(() => srv.close());
  srv.script("POST /v1/images/generations", {
    status: 402, json: { accepts: [{ scheme: "nano", payTo: "nano_test", paymentId: "pay_cli", amount: "1" }] },
  });
  srv.script("POST /api/x402/complete/pay_cli", {
    status: 502, headers: { "x-request-id": "request_cli" }, json: { error: "private provider error" },
  });
  const cwd = await mkdtemp(join(tmpdir(), "nanoodle-cli-pay-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const graphPath = join(cwd, "g.json");
  await writeFile(graphPath, JSON.stringify({ nodes: [{ id: "n", type: "image", fields: { model: "test", prompt: "hi" } }] }));
  const r = await runCli(["run", graphPath, "--pay", "--json"], { cwd, env: { NANOGPT_BASE_URL: srv.url } });
  assert.equal(r.status, 1, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.equal(summary.payments[0].paymentId, "pay_cli");
  assert.equal(summary.payments[0].statusUrl, srv.url + "/api/x402/status/pay_cli");
  assert.equal(summary.payments[0].status, "callback-returned");
  assert.equal(summary.payments[0].redeemed, false);
  assert.equal(summary.errors[0].requestId, "request_cli");
  assert.doesNotMatch(r.stdout, /nano_test|private provider error/);
});

test('CLI preserves distinct media outputs when sanitized filenames or suffixes collide', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nanoodle-cli-'));
  const names = ['A B', 'A_B', 'A_B_2', 'a-b?', 'A-b!'];
  const bytes = names.map((name) => Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.from(name)]));
  const graphPath = join(cwd, 'g.json');
  await writeFile(graphPath, JSON.stringify({ nodes: names.map((name, i) => ({
    id: `n${i}`, type: 'upload', name, fields: { image: 'data:image/png;base64,' + bytes[i].toString('base64') },
  })), links: [] }));
  const r = await runCli(['run', graphPath, '--json'], { cwd });
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  const paths = names.map(name => summary.outputs[name]);
  assert.equal(new Set(paths.map(path => path.toLowerCase())).size, names.length, 'every output receives a distinct path');
  for (let i = 0; i < names.length; i++) assert.deepEqual(await readFile(join(cwd, paths[i])), bytes[i], names[i]);
});

test('CLI accepts and summarizes prototype-named friendly input/output keys', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'nanoodle-cli-'));
  const graphPath = join(cwd, 'g.json');
  await writeFile(graphPath, JSON.stringify({ nodes: [{ id: '__proto__', type: 'text', name: '__proto__', fields: { text: 'stored' } }], links: [] }));
  const r = await runCli(['run', graphPath, '--input', '__proto__=supplied', '--json'], { cwd });
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.ok(Object.hasOwn(summary.outputs, '__proto__'));
  assert.equal(summary.outputs.__proto__, 'supplied');
  assert.ok(Object.hasOwn(summary.nodes, '__proto__'));
});
