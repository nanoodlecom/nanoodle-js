#!/usr/bin/env node
/**
 * nanoodle CLI — run and inspect noodle-graph.json workflows and share links.
 *
 *   nanoodle run graph.json --input Text="a cozy ramen shop" --out ./noodle-out
 *   nanoodle run "https://nanoodle.com/#g=..."
 *   nanoodle inspect graph.json
 *   nanoodle init [path]
 *
 * Contract: media outputs are written under --out (default ./noodle-out); a JSON
 * run summary always goes to stdout; progress/log lines go to stderr; exit 0 on
 * success, 1 on failure.
 *
 * API key: NANOGPT_API_KEY env var, --key <key>, or --env-file <path> (.env-style file).
 * Precedence: --key > --env-file > NANOGPT_API_KEY. NANOGPT_BASE_URL overrides the API host.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import process from "node:process";
import { Workflow, RunError, mediaFromFile } from "../src/index.mjs";
import { MediaRef, extForMime, sniffMime } from "../src/media.mjs";

const HELP = `nanoodle — run nanoodle.com visual AI workflows from the terminal

usage:
  nanoodle run <graph.json|share-url> [--input k=v]... [--set k=v]... [--out dir] [--json] [--key K] [--env-file path] [--timeout ms]
  nanoodle inspect <graph.json|share-url>
  nanoodle init [path]
  nanoodle --help | --version

commands:
  run       execute a workflow (needs an API key; spends from your NanoGPT balance)
  inspect   show a workflow's inputs, outputs, and settings — fully offline, no key needed
  init      write the starter graph (text → LLM prompt-writer → image) to path (default ./noodle-graph.json)

flags:
  --input k=v   set a workflow input ("Text=hello", "n2.system=@notes.txt"; @path reads a file —
                media files ride as media, .txt/.md/.json as text)
  --set k=v     override a setting ("n3.model=flux-pro", "n3.size=1k")
  --out dir     directory for media outputs (default ./noodle-out, created only when needed)
  --json        quiet mode: skip progress/log lines on stderr
                (the JSON run summary is always printed to stdout either way)
  --key K       NanoGPT API key (defaults to NANOGPT_API_KEY)
  --env-file p  read NANOGPT_API_KEY from a .env-style file (--key wins if both given)
  --pay         accountless run — no API key or account: each paid call prints a Nano (XNO)
                invoice as a scannable QR + nano: URI on stderr and waits for the deposit
                (x402; ignores any configured key; self-custody wallet does the send)
  --timeout ms  overall run timeout

examples:
  # scaffold the starter graph and see its inputs/outputs — no API key needed
  nanoodle init && nanoodle inspect noodle-graph.json

  # run it: media lands in ./noodle-out, JSON summary on stdout
  export NANOGPT_API_KEY=...   # key from nano-gpt.com
  nanoodle run noodle-graph.json --input Text="a cozy ramen shop on a rainy night"

  # feed a file into a wired field, override a setting, pick the output dir
  nanoodle run graph.json --input n2.system=@style.txt --set n3.size=1k --out ./renders

  # any nanoodle share link is runnable — paste it straight from a README or chat
  nanoodle inspect "https://nanoodle.com/#g=..."
  nanoodle run "https://nanoodle.com/play.html#a=..." --input Text="hello"

  # no account at all: pay per run in Nano — scan the QR that appears in the terminal
  nanoodle run "https://nanoodle.com/#g=..." --input Text="hello" --pay

Graphs are the noodle-graph.json files saved from the https://nanoodle.com editor (💾),
or any share link (#g=/#j=/#a= URLs, including da.gd/TinyURL short links) — quote it;
# starts a comment in most shells. Direct links decode offline; only short links fetch.
Exit codes: 0 success, 1 failure. The API key is never logged.`;

function usage(code = 1) {
  (code === 0 ? console.log : console.error)(HELP);
  process.exit(code);
}

function parseKv(arg, flag) {
  const eq = arg.indexOf("=");
  if (eq < 1) { console.error(`${flag} expects key=value, got: ${arg}`); process.exit(1); }
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

const TEXT_EXT = new Set([".txt", ".md", ".json", ".csv", ".html", ".xml"]);

async function resolveValue(v) {
  if (!v.startsWith("@")) return v;
  const path = v.slice(1);
  if (TEXT_EXT.has(extname(path).toLowerCase())) return await readFile(path, "utf8");
  return mediaFromFile(path);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (cmd === "--version") {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    console.log(`nanoodle ${pkg.version}`);
    process.exit(0);
  }
  if (!cmd || cmd === "--help" || cmd === "-h") usage(cmd ? 0 : 1);

  if (cmd === "init") {
    const dest = argv[0] ?? "noodle-graph.json";
    if (argv.length > 1 || dest.startsWith("-")) usage();
    // the template is the same starter graph the tests exercise (tests/fixtures/starter-graph.json)
    const tpl = await readFile(new URL("../templates/starter-graph.json", import.meta.url), "utf8");
    try {
      await writeFile(dest, tpl, { flag: "wx" }); // never overwrite
    } catch (e) {
      if (e.code === "EEXIST") { console.error(`init: ${dest} already exists — not overwriting`); process.exit(1); }
      throw e;
    }
    console.log(dest);
    console.error(`wrote ${dest} — starter graph (text → LLM prompt-writer → image)
next: nanoodle inspect ${dest}
then: NANOGPT_API_KEY=... nanoodle run ${dest} --input Text="your idea"`);
    return;
  }

  if (cmd !== "run" && cmd !== "inspect") usage();

  let graphPath = null, outDir = null, quiet = false, keyFlag = null, envFile = null, timeoutMs, pay = false;
  const inputArgs = [], setArgs = [];
  let i = 0;
  const val = (flag) => { // a value-taking flag at end of argv is a usage error, not a TypeError
    const v = argv[++i];
    if (v === undefined) { console.error(`${flag} expects a value`); usage(); }
    return v;
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") inputArgs.push(val("--input"));
    else if (a === "--set") setArgs.push(val("--set"));
    else if (a === "--out") outDir = val("--out");
    else if (a === "--json") quiet = true;
    else if (a === "--key") keyFlag = val("--key");
    else if (a === "--env-file") envFile = val("--env-file");
    else if (a === "--pay") pay = true;
    else if (a === "--timeout") timeoutMs = +val("--timeout");
    else if (a.startsWith("-")) { console.error("unknown flag: " + a); usage(); }
    else if (!graphPath) graphPath = a;
    else { console.error("unexpected argument: " + a); usage(); }
  }
  if (!graphPath) usage();

  // key precedence: --key > --env-file > NANOGPT_API_KEY (same .env parsing as scripts/live-spot-check.mjs)
  let apiKey = keyFlag ?? process.env.NANOGPT_API_KEY;
  if (envFile && keyFlag == null) {
    let envText;
    try { envText = await readFile(envFile, "utf8"); }
    catch (e) { console.error(`--env-file: cannot read ${envFile}: ${e.message}`); process.exit(1); }
    const m = envText.match(/^NANOGPT_API_KEY\s*=\s*"?([^"\n]+)"?/m);
    if (!m) { console.error(`--env-file: no NANOGPT_API_KEY entry in ${envFile}`); process.exit(1); }
    apiKey = m[1].trim();
  }

  // --pay = accountless x402: the key (flag or env) is deliberately ignored, each paid call
  // prints a Nano invoice on stderr and the run resumes once the deposit is seen on-chain.
  // The send happens in the user's own wallet — the CLI never asks for a seed or key.
  let payment;
  if (pay) {
    apiKey = null; // null, not undefined — undefined would let Workflow's NANOGPT_API_KEY env fallback re-inject a key
    const { qrTerminal } = await import("../src/qr.mjs");
    payment = async (inv) => {
      const mins = inv.expiresAt ? Math.max(1, Math.round((inv.expiresAt - Date.now()) / 60000)) : null;
      console.error(`\n⚡ payment required: ${inv.amount || inv.amountRaw + " raw"}${inv.amountUsd != null ? ` (~$${inv.amountUsd})` : ""}`);
      console.error(qrTerminal(inv.uri));
      console.error("scan with your Nano wallet (dark terminals scan best), or send to:");
      console.error("  " + inv.payTo);
      console.error("  " + inv.uri);
      if (inv.explorerUrl) console.error("  explorer: " + inv.explorerUrl);
      console.error(`waiting for the deposit…${mins ? ` (invoice expires in ~${mins} min,` : " ("}Ctrl-C aborts)\n`);
    };
  }

  const wf = await Workflow.load(graphPath, { apiKey, payment, baseUrl: process.env.NANOGPT_BASE_URL || undefined });

  if (cmd === "inspect") {
    const pad = (s, n) => String(s).padEnd(n);
    // Media defaults are data: URLs (megabytes of base64) — summarize instead of dumping,
    // and tell the caller HOW to supply an unfilled media input, right in the listing.
    const MEDIA_INPUT_KINDS = new Set(["image", "audio", "video"]);
    const fmtSize = (chars) => chars >= 1024 * 1024
      ? (chars / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(chars / 1024)) + " KB";
    const describeDefault = (i) => {
      if (i.def == null) return null;
      const s = String(i.def);
      if (!MEDIA_INPUT_KINDS.has(i.kind)) return `default: ${JSON.stringify(i.def)}`;
      if (/^data:/i.test(s)) {
        const mime = (s.match(/^data:([^;,]+)/) || [])[1] || i.kind;
        return `prefilled: inline ${mime} (${fmtSize(s.length)})`;
      }
      return `prefilled: ${s.length > 60 ? s.slice(0, 57) + "…" : s}`;
    };
    console.log("Inputs:");
    for (const i of wf.inputs) {
      const extras = [i.optional ? "optional" : "required", describeDefault(i),
        i.options ? `options: ${i.options.join(" | ")}` : null,
        MEDIA_INPUT_KINDS.has(i.kind) && i.def == null ? `supply: --input "${i.key}=@file"` : null,
      ].filter(Boolean).join(", ");
      console.log(`  ${pad('"' + i.key + '"', 26)} ${pad(i.nodeId + "." + i.field, 16)} ${pad(i.kind, 9)} ${extras}`);
    }
    if (!wf.inputs.length) console.log("  (none)");
    console.log("Outputs:");
    for (const o of wf.outputs) {
      console.log(`  ${pad('"' + o.key + '"', 26)} ${pad(o.nodeId, 16)} ${o.type} → ${o.ports.map((p) => p.name + ":" + p.type).join(", ")}`);
    }
    if (!wf.outputs.length) console.log("  (none)");
    console.log("Settings:");
    for (const s of wf.settings) {
      const extras = [s.def != null && s.def !== "" ? `current: ${JSON.stringify(s.def)}` : null,
        s.options ? `options: ${s.options.join(" | ")}` : null].filter(Boolean).join(", ");
      console.log(`  ${pad(s.key, 26)} ${pad(s.kind, 9)} ${extras}`);
    }
    if (!wf.settings.length) console.log("  (none)");
    console.log("Nodes:");
    for (const n of wf.graph.nodes) {
      console.log(`  ${pad(n.id, 5)} ${pad(n.type, 13)} ${n.name ? '"' + n.name + '"' : ""}`);
    }
    for (const w of wf.warnings) console.log("warning: " + w);
    return;
  }

  // ---- run ----
  const inputs = {};
  for (const arg of inputArgs) {
    const [k, v] = parseKv(arg, "--input");
    inputs[k] = await resolveValue(v);
  }
  const settings = {};
  for (const arg of setArgs) {
    const [k, v] = parseKv(arg, "--set");
    settings[k] = v;
  }

  let result;
  try {
    result = await wf.run(inputs, {
      settings, timeoutMs,
      onProgress: quiet ? undefined : (e) => {
        if (e.type === "node-start") console.error(`▶ ${e.name} (${e.nodeId})`);
        if (e.type === "node-done") console.error(`✔ ${e.name} (${e.nodeId}) ${e.ms}ms${e.costUsd != null ? ` $${e.costUsd}` : ""}`);
        if (e.type === "node-error") console.error(`✖ ${e.name} (${e.nodeId}): ${e.error}`);
      },
    });
  } catch (e) {
    if (e instanceof RunError && e.result) {
      console.error("run failed: " + e.message);
      result = e.result;
      process.exitCode = 1;
    } else {
      console.error("error: " + e.message);
      process.exit(1);
    }
  }

  // media outputs land under --out (default ./noodle-out; created only if there is media to save)
  const dir = outDir ?? "noodle-out";
  let dirMade = false;
  const printable = {};
  for (const o of wf.outputs) {
    const value = result.outputs[o.key];
    if (value === undefined) { printable[o.key] = null; continue; }
    if (value instanceof MediaRef) {
      if (!dirMade) { await mkdir(dir, { recursive: true }); dirMade = true; }
      const safe = o.key.replace(/[^\w.-]+/g, "_");
      // fetch before naming: hosted media only reveals its mime via the response Content-Type
      const data = await value.bytes();
      const path = join(dir, safe + "." + extForMime(value.mime || sniffMime(data)));
      await writeFile(path, data);
      printable[o.key] = path;
      if (!quiet) console.error(`${o.key}: saved ${path}`);
    } else {
      printable[o.key] = value;
      if (!quiet) console.error(`${o.key}: ${value}`);
    }
  }

  // the run summary is ALWAYS the JSON on stdout (contract shared with nanoodle-py and the docs)
  console.log(JSON.stringify({
    outputs: printable,
    costUsd: result.costUsd,
    costExact: result.costExact,
    remainingBalance: result.remainingBalance,
    errors: result.errors,
    nodes: Object.fromEntries(Object.entries(result.nodes).map(([id, r]) => [id, { status: r.status, ms: r.ms, costUsd: r.costUsd, error: r.error }])),
  }, null, 2));
  if (!quiet) {
    const approx = result.costExact ? "" : "≥ ";
    console.error(`cost: ${approx}$${result.costUsd}${result.remainingBalance != null ? ` · balance: $${result.remainingBalance}` : ""}`);
  }
}

main().catch((e) => { console.error("error: " + (e && e.message || e)); process.exit(1); });
