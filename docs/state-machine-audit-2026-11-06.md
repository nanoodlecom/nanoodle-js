# Implicit state-machine audit — 2026-11-06

Scope: nanoodlecom/nanoodle-js, base `7734e7f` (main). Reviewed every source module,
the CLI, tests, package metadata and repository workflows. This is a static audit
with offline reproductions, not a proof against every possible provider response.
No paid API calls, wallet sends, production data changes or npm publication.

## Inventory

| Machine / source | States and transitions | Invariants and recovery |
| --- | --- | --- |
| Graph import, `graph.mjs` | raw save → legacy audio/port migration → placeholder cleanup → known/unknown nodes → filtered links → materialized graph | Unknown nodes survive load with warnings but block execution; duplicate IDs now reject at import. Invalid links are discarded. |
| Share load, `share.mjs`, `zlib.mjs`, `Workflow.load` | file/JSON/direct fragment/short URL → bounded manual redirects → g/j/a decode → strict parse → optional salvage → graph | Direct fragments stay offline; at most five redirects; recovered payloads are marked/warned; internal handoff format rejects. Compression backend is lazily selected and cached. |
| Input/settings preparation, `io.mjs`, `workflow.mjs` | derived schema → key resolution → overrides → scalar/media coercion → defaults/required checks → authorized execution | All supplied keys resolve before spend; locked/wired values reject overrides; explicit optional blanks survive; wired frame floor is raised. Graph fields are copied per run. |
| DAG scheduler, `workflow.mjs` | pending → dependencies settled → node-start → runner → media publication → done/error/gated/skipped | Siblings run concurrently; dependents await upstream promises; failed sinks throw a RunError with partial results; annotation nodes skip. No transactional rollback of independent successful lanes. |
| Gate propagation, `decide.mjs`, `workflow.mjs` | decision request → yes/no → open or billed closed gate → transitive downstream skip | A closed gate is success; real upstream errors take precedence; sink lookup explains gated absence. |
| Error-skip propagation, `workflow.mjs` | runner error/deadline → recorded error → skipped empty output → surviving inputs continue | All-skipped inputs fail; all-skipped sinks fail; run cancellation cannot be converted to an error skip. |
| Cancellation/deadlines, `workflow.mjs` | outer signal/run timer/node timer → abort → terminal node records → settled immutable snapshot | New races bound runners and provider media publication even when injected I/O ignores signals. Abort during node-start prevents submission. Late results/cost/progress cannot modify finalized records. Synchronous CPU work still cannot be preempted by JavaScript timers. |
| Cost ledger, `workflow.mjs`, `client.mjs` | unknown → per-call reported USD/balance → accumulated run floor → exact/inexact terminal summary | Unpriced started network nodes make the total inexact; late callbacks freeze. Provider prices, not estimates, are authoritative. |
| Prompt adaptation, `prompt-caps.mjs` | static/catalog/learned cap → fitted prompt → request → recognized rejection learns new cap | Per-Workflow in-memory map affects later runs; no automatic paid generation retry; trims emit progress/warning. Not durable across processes. |
| Generic transport, `client.mjs` | request serialization → inline-size check → POST → HTTP mapping → response decode → result/cost | No generic generation POST retries. API key is non-enumerable; hosted download paths omit it. |
| Video/3D jobs, `client.mjs` | submit or resume → retain runId → poll → pending/transient failure → completed/failed/cancelled/deadline | Permanent 4xx now stop (408/429 retry); 5xx bodies cannot masquerade as success; cancellation spellings and policy failure terminate. Finite deadlines cover sleep, request and body. Default video deadline remains infinite by design; server job can outlive local cancellation. Resume skips submission. |
| Audio jobs, `client.mjs` | submit → binary or immediate JSON URL or async job → poll → completed/failed/cancelled/deadline | Callback receives full submit job including refund metadata; resume takes that object and skips submission. New cancellation states, HTTP checks and bounded polling match video. |
| x402, `client.mjs`, `x402.mjs` | keyless request → invoice → callback → deposit wait → replayed result or settlement receipt → one stamped retry | Abort/expired invoice now prevent entering payment callback. Unreadable completion fails with paymentId instead of replaying generation. A second 402 never invokes payment twice. Binary replay is preserved. Callback wallet behavior and durable payment recovery belong to caller/server. |
| Provider media publication, `client.mjs`, `workflow.mjs` | relative content path → same-origin authenticated fetch → bounded redirects → external URL or inline bytes → node output | Auth stays on API origin; signed queries are redacted in errors; inline limits apply; distinct outputs share per-node resolution cache. Deadline now includes publication. |
| Hosted download, `media.mjs` | GET → body read → success or interruption → bounded backoff/retry (three attempts) | Only downloads retry, never generation; HTTP failures and intentional aborts terminate. MediaRef lazily fetches/sniffs MIME, then save chooses extension and writes bytes. |
| Local media, `local-media.mjs`, `mp4cat.mjs`, `zlib.mjs` | bytes → pure PNG/WAV/MP4 processing → compatible result or ffmpeg fallback → temporary files → probe/spawn → output → cleanup | Abort checks, process timeout/SIGKILL, bounded stdout/stderr, image/sample bounds, temporary-directory finally cleanup. Browser paths avoid eager Node imports. Frame extraction has EOF retry; combine/mux have explicit format fallbacks. |
| Clean voice, `cleanvoice.mjs` | choose public source → browser metadata load/error/10s fallback → duration quote → audio job | Invalid data/blob source rejects before spend; metadata settles once; Node uses quote fallback; server remeasures billing duration. Workflow cancellation bounds this stage. |
| Custom endpoint, `endpoint.mjs` | route/mode resolution → URL/auth guard → payload mapping → direct POST → mode-specific decode | Independent endpoint authorization only; no NanoGPT API key; local/LAN HTTP allowed, public hosts HTTPS. Workflow deadline applies to endpoint I/O. |
| Node runners, `nodes.mjs`, `decide.mjs` | validate/catalog gate → media fitting/mask alignment → payload → transport/local operation → typed ports | Includes multi-image sequential fitting, dual-order concurrent decision requests, video reference gates, 3D output selection and local-media dispatch. No independent durable queue. |
| Cost forecast, `estimate.mjs`, `catalog.mjs` | catalog capability/pricing lookup → known/free/unknown units → aggregate exact/floor estimate | Data supplied by caller, no implicit catalog fetch. Separate from execution billing. Existing PR #54 owns lipsync duration estimate corrections. |
| CLI, `bin/nanoodle.mjs` | parse → key/env precedence or pay mode → load/inspect/init/run → partial RunError recovery → save outputs → JSON summary/exit | Init never overwrites; stdout summary versus stderr progress; output save can fail after successful paid work. New summary runId retains accepted-job identity on failure. |
| Release, `package.json`, `.github/workflows/test.yml` | branch → PR → Node matrix tests → reviewed merge → consumer explicitly updates | Zero npm dependencies; CI is test-only. No deployment or npm publish workflow. npm package and app-vendored engine are separate release surfaces. |

## Reproduced and fixed

1. Workflow run timeout/outer abort could hang on an uncooperative injected fetch.
2. Node deadline raced the runner but omitted final provider media publication.
3. A node-start callback could abort before a child signal was linked and still submit work.
4. Cancelled invoice parsing could still invoke the caller's payment callback; expired invoices also reached it.
5. Poll responses ignored HTTP status, accepting apparent success in HTTP error bodies and retrying permanent failures indefinitely by default for video.
6. Cancelled audio jobs and alternate cancelled video states did not terminate.
7. Direct client poll deadlines did not bound a hung fetch/body or an overlong sleep.
8. Duplicate persisted node IDs executed against shared/overwritten scheduler records.
9. CLI JSON discarded the SDK's retained job IDs on success/failure.
10. An accepted lipsync job could be trim-retried when a poll error matched the audio-duration rejection message. Poll errors now retain runId and block the retry.
11. Unreadable/missing-MIME x402 completion was interpreted as settlement-only and could replay generation. It now stops with a payment ID for reconciliation.

Regression coverage: `tests/state-machine-lifecycle.test.mjs` and a CLI mock-server
job-recovery test. Seven independently selected tests fail against original main;
fixed tests include late-result immutability and no payment/replay after cancellation.

## Recovery and release boundaries

The SDK has no durable run registry, database, automatic restart recovery, server-job
cancellation or rollback of paid work. Persist job IDs/full audio submit objects via
onRunId, then use NanoClient resume. Workflow.run itself does not accept a resume map.
Cancelling local waiting does not cancel server-side generation or reverse payment.
An arbitrary wallet callback already entered cannot be preempted or rolled back.
Payment/network ambiguity must be reconciled using the retained invoice ID/status;
there is no safe automatic second payment.

CLI output saving occurs after execution and is not atomic across several files;
keep the graph and returned hosted URLs/job IDs when building durable orchestration.
Infinite video polling is deliberate; callers needing a deadline must configure it.
Finite client media caps start after submission; Workflow run/node deadlines also
cover submission. MediaRef standalone downloads have no built-in overall deadline.

Existing open PRs #54 (audio duration estimate) and #55 (P-H3 LoRA family) are separate
owners' changes and were not modified. No dependencies, package version, tags,
publish configuration, credentials or permissions change in this audit.
Merging this PR only updates git main. The nanoodle app owner must regenerate and
release its embedded engine separately; an npm release requires explicit release
handling and was not performed here.
