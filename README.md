# nanoodle

**Run [nanoodle](https://nanoodle.io) visual AI workflows from JavaScript.** nanoodle is a
no-server, bring-your-own-key editor where you wire AI nodes (LLMs, image, video, audio) into a
graph and download it as `noodle-graph.json`. This package is the zero-dependency executor for
those files: load a saved workflow, feed it inputs, get its outputs — same execution semantics
as the app (topological order, concurrent lanes, wired-field overrides), against the same
[NanoGPT](https://nano-gpt.com) API. Build and test workflows visually at
[nanoodle.io](https://nanoodle.io); automate them here.

- Zero runtime dependencies — Node >= 20, built-in `fetch`
- Text, image, video (submit + poll), audio (sync + async poll), vision, transcription
- Cost tracking per node and per run
- Library and CLI in one install

## Install

```bash
npm install nanoodle     # library + CLI
npx nanoodle --help      # or run the CLI without installing
```

## Quickstart (library)

```js
import { Workflow } from "nanoodle";

const wf = await Workflow.load("noodle-graph.json");           // key from NANOGPT_API_KEY
const result = await wf.run({ Text: "a cozy ramen shop on a rainy night" });
await result.get("Image").save("ramen.png");                   // media outputs: MediaRef (url + bytes()/save())
console.log(result.costUsd, result.remainingBalance);
```

With the starter graph from the app (text → LLM prompt-writer → image), that's the whole program.

## Quickstart (CLI)

Inspect first — it's offline and shows the workflow's inputs, outputs, and settings:

```bash
npx nanoodle inspect graph.json
```

Then run (this calls the NanoGPT API and spends from your balance):

```bash
export NANOGPT_API_KEY=...   # or --key K, or --env-file .env
npx nanoodle run graph.json --input Text="a cozy ramen shop" --out ./out
npx nanoodle run graph.json --input n2.system=@style.txt --set n3.size=1k --json
```

`--env-file path` reads `NANOGPT_API_KEY` from a `.env`-style file (`--key` wins if both are
given). `--input k=@path` reads a file — media files ride as media, `.txt`/`.md`/`.json` as
text. `--out dir` saves media outputs to disk; `--json` prints a machine-readable result.

## Inputs, outputs, settings

```js
wf.inputs    // [{ key: "Text", nodeId: "n1", field: "text", kind: "textarea", optional: false, def: "..." }]
wf.outputs   // [{ key: "Image", nodeId: "n3", type: "image", ports: [{ name: "image", type: "image" }] }]
wf.settings  // [{ key: "n3.model", kind: "model", def: "nano-banana-2-lite" }, ...]
```

Input keys resolve flexibly (case-insensitive): the node's custom name (`"Text"`),
`nodeId.field` (`"n2.system"`), a bare node id, or the input's label. Output keys are the sink
node's custom name (or its type name). A workflow with exactly one required input also accepts
a bare value: `wf.run("hello")`. Settings use `nodeId.field` keys (`"n3.model"`).

### Media inputs

```js
import { mediaFromFile } from "nanoodle";

await wf.run({ Image: await mediaFromFile("photo.jpg") });     // local file
await wf.run({ Image: "https://example.com/photo.jpg" });      // hosted URL
await wf.run({ Image: bytesUint8Array });                      // raw bytes (MIME sniffed)
```

Media is sent inline as base64 (NanoGPT has no upload endpoint); files over ~4.4 MB are
refused locally with a clear error before any paid call.

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

`run()` rejects with `RunError` when an output (sink) node failed — `err.result` still carries
the partial results, per-node statuses, and cost so far. Failures in lanes no output depends on
only surface in `result.errors`. Unknown/unsupported node types, missing required inputs, bad
keys, and a missing API key all fail **before** anything is spent.

## Supported nodes

| runs | node types |
|---|---|
| local | text, upload (image/audio/video), choice, join, comment |
| NanoGPT | llm (incl. vision + audio input), image, draw, edit, inpaint*, vision, tvideo, ivideo, vedit, lipsync, music, remix, tts, transcribe |
| **not supported** (browser-only media processing) | resize, vframes, combine, soundtrack, trim, extractaudio |

Workflows containing unsupported node types load with a warning and fail fast at `run()` with
`UnsupportedNodeError` — before any network call.

\* inpaint caveat: the browser app composites the mask onto black at the source's pixel size;
this library passes your mask through verbatim, so supply a black/white mask matching the
source dimensions.

## API key and cost

This is bring-your-own-key: you need a [nano-gpt.com](https://nano-gpt.com) API key (or OAuth
access token) with balance, and **every `run()` spends real money** — NanoGPT bills per
generation. The library reports what each run cost: `result.costUsd` totals the prices NanoGPT
returned, `result.costExact` turns false when any call omitted a price (the total is then a
floor), and `result.remainingBalance` is the freshest balance the API reported. A price of 0
means known-included (subscription), not unknown. `inspect` and loading/validating workflows
never call the API.

## Specs and testing

The format and execution semantics are specified in [docs/](docs/):
[DESIGN.md](docs/DESIGN.md), [SPEC-format.md](docs/SPEC-format.md),
[SPEC-engine.md](docs/SPEC-engine.md), [SPEC-io.md](docs/SPEC-io.md).

Tests run fully offline against a mock NanoGPT server (`tests/harness/`):

```bash
npm test
```

An opt-in live probe (spends a fraction of a cent) exists for hand-verification:
`node scripts/live-spot-check.mjs` (add `--image` to also run the starter graph's image step).

## License

MIT — see [LICENSE](LICENSE). Not affiliated with NanoGPT. Build workflows at
[nanoodle.io](https://nanoodle.io).
