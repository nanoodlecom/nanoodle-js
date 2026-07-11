/**
 * CLI --env-file: load NANOGPT_API_KEY from a .env-style file (same parsing as
 * scripts/live-spot-check.mjs). Fully offline — network runs go to the mock server
 * via NANOGPT_BASE_URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { startMockServer, chatJson } from "./harness/mock-server.mjs";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "nanoodle.mjs");

const LLM_GRAPH = {
  nodes: [
    { id: "n1", type: "text", fields: { text: "hello" } },
    { id: "n2", type: "llm", fields: { model: "test-model" } },
  ],
  links: [{ id: "l1", from: { node: "n1", port: "text" }, to: { node: "n2", port: "prompt" } }],
};

// env WITHOUT any ambient NANOGPT_API_KEY, so only the flags under test can supply one
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NANOGPT_API_KEY;
  return env;
}

// async spawn — MUST NOT be spawnSync: the mock server lives in THIS process, and a blocked
// event loop can never answer the child CLI's request (deadlock until undici's 5-min timeout)
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, ...args], { env });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function writeGraph(dir) {
  const graphPath = join(dir, "g.json");
  await writeFile(graphPath, JSON.stringify(LLM_GRAPH));
  return graphPath;
}

test("CLI: --env-file supplies the API key and it reaches the wire as auth headers", async () => {
  const srv = await startMockServer();
  try {
    srv.script("POST /api/v1/chat/completions", chatJson("mock reply"));
    const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
    const graphPath = await writeGraph(dir);
    const envPath = join(dir, ".env");
    await writeFile(envPath, `# comment\nOTHER=1\nNANOGPT_API_KEY="sk-from-env-file"\n`);

    const r = await runCli(["run", graphPath, "--env-file", envPath, "--json"], cleanEnv({ NANOGPT_BASE_URL: srv.url }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).outputs.LLM, "mock reply");
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].headers.authorization, "Bearer sk-from-env-file");
    assert.equal(srv.requests[0].headers["x-api-key"], "sk-from-env-file");
  } finally {
    await srv.close();
  }
});

test("CLI: --key wins over --env-file", async () => {
  const srv = await startMockServer();
  try {
    srv.script("POST /api/v1/chat/completions", chatJson("mock reply"));
    const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
    const graphPath = await writeGraph(dir);
    const envPath = join(dir, ".env");
    await writeFile(envPath, "NANOGPT_API_KEY=sk-from-env-file\n");

    const r = await runCli(["run", graphPath, "--env-file", envPath, "--key", "sk-from-flag", "--json"], cleanEnv({ NANOGPT_BASE_URL: srv.url }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(srv.requests[0].headers.authorization, "Bearer sk-from-flag");
  } finally {
    await srv.close();
  }
});

test("CLI: without --env-file/--key/env var a network graph fails fast (no API key), and never dials out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
  const graphPath = await writeGraph(dir);
  const r = await runCli(["run", graphPath], cleanEnv({ NANOGPT_BASE_URL: "http://127.0.0.1:9" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no API key/);
});

test("CLI: --env-file pointing at a file without NANOGPT_API_KEY errors clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
  const graphPath = await writeGraph(dir);
  const envPath = join(dir, ".env");
  await writeFile(envPath, "SOMETHING_ELSE=1\n");
  const r = await runCli(["run", graphPath, "--env-file", envPath], cleanEnv());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no NANOGPT_API_KEY entry/);
  assert.ok(!/SOMETHING_ELSE/.test(r.stderr));
});

test("CLI: --env-file beats an ambient NANOGPT_API_KEY (proves the CLI's own parsing, not Node's --env-file)", async () => {
  // Node >= 20.7 also understands --env-file, but its loader never overrides ambient env vars —
  // so the file key reaching the wire here can only come from the CLI's documented precedence.
  const srv = await startMockServer();
  try {
    srv.script("POST /api/v1/chat/completions", chatJson("mock reply"));
    const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
    const graphPath = await writeGraph(dir);
    const envPath = join(dir, ".env");
    await writeFile(envPath, "NANOGPT_API_KEY=sk-from-env-file\n");

    const r = await runCli(["run", graphPath, "--env-file", envPath, "--json"], cleanEnv({ NANOGPT_BASE_URL: srv.url, NANOGPT_API_KEY: "sk-ambient" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(srv.requests[0].headers.authorization, "Bearer sk-from-env-file");
  } finally {
    await srv.close();
  }
});

test("CLI: --env-file pointing at a missing file errors clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
  const graphPath = await writeGraph(dir);
  const r = await runCli(["run", graphPath, "--env-file", join(dir, "nope.env")], cleanEnv());
  // Node itself also parses --env-file and may exit 9 ("node: <path>: not found") before our
  // handler runs; either way the exit is nonzero and the message names the problem.
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not found|cannot read/);
  assert.ok(!/Cannot read properties/.test(r.stderr));
});

test("CLI: inspect accepts --env-file (works offline, no key needed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nanoodle-envfile-"));
  const graphPath = await writeGraph(dir);
  const envPath = join(dir, ".env");
  await writeFile(envPath, "NANOGPT_API_KEY=sk-unused\n");
  const r = await runCli(["inspect", graphPath, "--env-file", envPath], cleanEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Inputs:/);
  assert.match(r.stdout, /Outputs:/);
  assert.ok(!/sk-unused/.test(r.stdout + r.stderr), "inspect must never print the key");
});
