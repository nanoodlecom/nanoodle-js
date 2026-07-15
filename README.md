# nanoodle (JavaScript)

**Run visual AI workflows from Node.js.** Design them in the
[nanoodle](https://nanoodle.com) editor, save as `noodle-graph.json`, then load
and re-run them here — same graph, same [NanoGPT](https://nano-gpt.com) API,
your own key.

Zero runtime dependencies. Library + CLI in one install.

Looking for Python? → **[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py)**

## At a glance

![Pipeline: nanoodle editor → noodle-graph.json → JS executor → NanoGPT API](docs/diagram-pipeline.jpg)

**Build once, run anywhere.** The browser app is for designing and testing.
This package is for automating the same workflows in scripts, servers, and
agents.

![Execution: Workflow.load → wf.run → topological order / concurrent lanes → result](docs/diagram-execution.jpg)

| | |
|---|---|
| **Package** | `nanoodle` on npm |
| **Runtime** | Node ≥ 20 · built-in `fetch` · no deps |
| **Sibling** | [Python package](https://github.com/nanoodlecom/nanoodle-py) (same graphs, same semantics) |
| **Editor** | [nanoodle.com](https://nanoodle.com) — wire nodes, hit 💾, download the graph |

## Install

```bash
npm install nanoodle     # library + CLI
npx nanoodle --help      # or run the CLI without installing
```

## Quickstart (library)

```js
import { Workflow } from "nanoodle";

const wf = await Workflow.load("noodle-graph.json");           // key from NANOGPT_API_KEY
// …or load any nanoodle share link — the URL is the package:
// const wf = await Workflow.load("https://nanoodle.com/#g=…");
const result = await wf.run({ Text: "a cozy ramen shop on a rainy night" });
await result.get("Image").save("ramen.png");                   // media: MediaRef (url + bytes()/save())
console.log(result.costUsd, result.remainingBalance);
```

With the app’s starter graph (text → LLM prompt-writer → image), that’s the whole program.

## Quickstart (CLI)

No graph yet? Scaffold the starter (text → LLM prompt-writer → image) and
inspect it — both offline, no key needed:

```bash
npx nanoodle init                        # writes ./noodle-graph.json
npx nanoodle inspect noodle-graph.json   # shows inputs, outputs, settings
```

Then run (calls NanoGPT and spends from your balance):

```bash
export NANOGPT_API_KEY=...   # or --key K, or --env-file .env
npx nanoodle run noodle-graph.json --input Text="a cozy ramen shop on a rainy night"
npx nanoodle run graph.json --input n2.system=@style.txt --set n3.size=1k --out ./renders
```

Media outputs are saved under `--out` (default `./noodle-out`, created only
when there is media to save); a JSON run summary always goes to stdout,
progress lines to stderr; exit code `0` on success, `1` on failure.

- `--input k=@path` — read a file (media as media; `.txt` / `.md` / `.json` as text)
- `--set k=v` — override a setting (`n3.model=flux-pro`)
- `--out dir` — where media outputs land (default `./noodle-out`)
- `--json` — quiet mode: skip the stderr progress lines (the JSON summary is printed either way)
- `--env-file path` — load `NANOGPT_API_KEY` from a `.env`-style file (`--key` wins if both are set)

### The URL is the package

Every nanoodle share link is a runnable artifact — paste one straight from a
README, a chat, or a tweet, wherever a `graph.json` path is accepted:

```bash
npx nanoodle inspect "https://nanoodle.com/#g=..."                       # what does it need? (offline)
npx nanoodle run "https://nanoodle.com/play.html#a=..." --input Text=hi  # run it
```

Workflow links (`#g=`/`#j=`) and app links (`#a=`, graph only — the app shell
stays in the browser) both work, as do da.gd/TinyURL short links (resolved by
reading redirect headers; no credentials are ever sent). Direct links decode
fully offline. Quote the URL — `#` starts a comment in most shells.

## Inputs, outputs, settings

```js
wf.inputs    // [{ key: "Text", nodeId: "n1", field: "text", kind: "textarea", optional: false, def: "..." }]
wf.outputs   // [{ key: "Image", nodeId: "n3", type: "image", ports: [{ name: "image", type: "image" }] }]
wf.settings  // [{ key: "n3.model", kind: "model", def: "nano-banana-2-lite" }, ...]
```

Input keys are flexible (case-insensitive): the node’s custom name (`"Text"`),
`nodeId.field` (`"n2.system"`), a bare node id, or the input’s label. Output
keys are the sink node’s custom name (or its type name). A workflow with
exactly one required input also accepts a bare value: `wf.run("hello")`.
Settings use `nodeId.field` keys (`"n3.model"`).

### Media inputs

```js
import { mediaFromFile } from "nanoodle";

await wf.run({ Image: await mediaFromFile("photo.jpg") });     // local file
await wf.run({ Image: "https://example.com/photo.jpg" });      // hosted URL
await wf.run({ Image: bytesUint8Array });                      // raw bytes (MIME sniffed)
```

Media is sent inline as base64 (NanoGPT has no upload endpoint). Files over
~4.4 MB (~3.5 MB for transcription) are refused locally with a clear error
before any paid call.

### Progress and errors

```js
const result = await wf.run(
  { Text: "sunset harbor" },
  {
    settings: { "n3.model": "flux-dev", "n3.size": "1024x1024" },
    timeoutMs: 300000,
    onProgress: (e) => console.error(e.type, e.name ?? "", e.status ?? ""),
  },
);
```

`run()` rejects with `RunError` when an output (sink) node fails —
`err.result` still has partial results, per-node statuses, and cost so far.
Failures in lanes no output depends on only appear in `result.errors`.
Unknown node types, missing required inputs, bad keys, and a missing API key
all fail **before** anything is spent.

## Supported nodes

| runs | node types |
|---|---|
| local | text, upload (image/audio/video), choice, join, comment |
| local media† | resize, vframes, combine, soundtrack, trim, extractaudio |
| NanoGPT | llm (incl. vision + audio input), image, draw, edit, inpaint*, vision, tvideo, ivideo, vedit, lipsync, music, remix, tts, transcribe |

† **local media** prefers a pure-JS path that matches the browser (lossless mp4 remux, PCM-WAV trim, PNG resize). **ffmpeg** on `PATH` is the fallback for everything else (soft dependency — not an npm package); clear error if it’s required and missing.

\* **inpaint:** the browser app composites the mask onto black at the source
pixel size; this library passes your mask through verbatim. Supply a
black/white mask matching the source dimensions.

## Use it as an agent skill

A saved workflow plus a short `SKILL.md` playbook is a skill any coding agent
can run — Claude Code, Cursor, Grok, or anything that reads markdown and runs
shell. Recipe and template: [docs/agent-skills.md](docs/agent-skills.md).

**Example skill** (idea → LLM prompt → poster image):

```bash
npx skills add nanoodlecom/nanoodle-js@poster-generator -g -y
```

Source: [examples/agent-skill/poster-generator/](examples/agent-skill/poster-generator/).
Media is saved as `Poster.<ext>` (MIME-derived; often `.jpg`) — use the path the
CLI prints. The Python package ships the same skill name; installing both
overwrites — pick one runtime (see [agent-skills.md](docs/agent-skills.md)).

## API key and cost

Bring your own [nano-gpt.com](https://nano-gpt.com) API key (or OAuth access
token) with balance. **Every `run()` spends real money** — NanoGPT bills per
generation.

- `result.costUsd` — total of prices NanoGPT returned
- `result.costExact` — `false` if any call omitted a price (total is then a floor)
- `result.remainingBalance` — freshest balance the API reported

A price of `0` means known-included (subscription), not unknown. `inspect`
and loading/validating workflows never call the API. No telemetry, no
analytics; the API key is never logged.

## No account at all: pay per run in Nano (x402)

NanoGPT supports [x402](https://nano-gpt.com) accountless payments: call the
API with no key, get an HTTP 402 invoice, settle it in Nano (XNO — instant,
feeless), and the call completes. nanoodle wires that up end to end:

```bash
# each paid call prints a scannable QR + nano: URI on stderr and waits for the deposit
nanoodle run "https://nanoodle.com/#g=..." --input Text="hello" --pay
```

```js
const wf = await Workflow.load(url, {
  payment: async (invoice) => {
    // invoice: { payTo, amountRaw, amount, amountUsd, uri, expiresAt, explorerUrl, ... }
    await myWallet.send(invoice.payTo, invoice.amountRaw); // YOUR signer does the send
  },
});
```

The library **never touches funds or keys**: `payment` must be a callback —
passing a seed or private key throws. Do the send inside the callback with
your own wallet/signer (e.g. a self-custody wallet, or print `invoice.uri`
for a human to scan — `qrTerminal(invoice.uri)` is exported). Each API call
pays at most once; graphs with several paid nodes produce one small invoice
per node. Chat and image nodes are live-verified; async video/audio job
polling under accountless mode is untested upstream.

Copy-paste scripts (CLI, QR callback, wallet stub, bare chat):
[examples/x402/](examples/x402/).

### Accountless image, start to finish

The starter graph (text → LLM prompt-writer → image), run with **no NanoGPT
account and no API key** — scan the Nano invoice, and the image node settles
for a few cents of XNO:

```bash
nanoodle run noodle-graph.json --input Text="a cozy ramen shop on a rainy night" --pay --out ./noodle-out
# → LLM node runs, image node prints a nano: QR, waits for the deposit,
#   then writes noodle-out/Image.jpg
```

![Accountless x402 run of the starter graph — a bowl of ramen generated with no account and no API key](noodle-out/Image.jpg)

## Specs and testing

Format and execution semantics live in [docs/](docs/):
[DESIGN.md](docs/DESIGN.md), [SPEC-format.md](docs/SPEC-format.md),
[SPEC-engine.md](docs/SPEC-engine.md), [SPEC-io.md](docs/SPEC-io.md).

Same contract as the [Python package](https://github.com/nanoodlecom/nanoodle-py).

Tests run fully offline against a mock NanoGPT server (`tests/harness/`):

```bash
npm test
```

Opt-in live probe (spends a fraction of a cent):
`node scripts/live-spot-check.mjs` (add `--image` to also run the starter
graph’s image step).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT. Build workflows at
[nanoodle.com](https://nanoodle.com).
