import { NanoodleError, RunError, UnsupportedNodeError } from "./errors.mjs";
import { NODE_TYPES, displayName, isInputPort, materialize, topoSort, wiredFramesFloor, MAX_FRAMES } from "./graph.mjs";
import { deriveInputs, deriveOutputs, deriveSettings, resolveInputKey, resolveSettingKey } from "./io.mjs";
import { NanoClient } from "./client.mjs";
import { MediaRef, coerceMediaInput } from "./media.mjs";
import { RUNNERS } from "./nodes.mjs";
import { decodeShareUrl, isShareRef } from "./share.mjs";

/** Env / process access — safe when `process` is missing (browsers, some workers). */
function envApiKey() {
  try {
    return typeof process !== "undefined" && process.env ? process.env.NANOGPT_API_KEY : undefined;
  } catch {
    return undefined;
  }
}

function warnGraph(msg) {
  try {
    if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
      process.emitWarning(msg, { code: "NANOODLE_GRAPH" });
      return;
    }
  } catch { /* ignore */ }
  if (typeof console !== "undefined" && console.warn) console.warn("[nanoodle]", msg);
}

const MEDIA_KINDS = new Set(["image", "audio", "video", "inpaint"]);

function abortReason(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error) return r;
  return new NanoodleError(r != null ? String(r) : "run aborted", { code: "aborted" });
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortReason(signal);
}

/** The outcome of Workflow.run(). Media values are MediaRef; text values plain strings. */
export class RunResult {
  constructor({ outputs, nodes, errors, costUsd, costExact, remainingBalance }) {
    /** { [friendlyKey | nodeId]: value } — sink node primary outputs */
    this.outputs = outputs;
    /** per-node { status: "done"|"error"|"skipped", out, error, costUsd, ms } */
    this.nodes = nodes;
    /** [{ nodeId, name, message }] for every node that failed (incl. non-sink warnings) */
    this.errors = errors;
    /** summed USD cost of all calls that reported one */
    this.costUsd = costUsd;
    /** false when any network call omitted its price (total is a floor) */
    this.costExact = costExact;
    /** last remaining-balance the API reported, or null */
    this.remainingBalance = remainingBalance;
  }

  /** Output lookup by friendly key or node id (case-insensitive). */
  get(key) {
    // own-key check: `in` would leak Object.prototype members (get("toString") → a function)
    if (Object.hasOwn(this.outputs, key)) return this.outputs[key];
    const norm = String(key).trim().toLowerCase();
    for (const k of Object.keys(this.outputs)) {
      if (k.toLowerCase() === norm) return this.outputs[k];
    }
    throw new NanoodleError(`no output "${key}" — available outputs: ${Object.keys(this.outputs).map((k) => `"${k}"`).join(", ") || "(none)"}`);
  }
}

function isPlainObject(v) {
  if (v == null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export class Workflow {
  /**
   * @param {object} graphData parsed noodle-graph.json
   * @param {{ apiKey?, payment?, baseUrl?, fetch?, pollIntervals?, timeouts?, quiet? }} [opts]
   */
  constructor(graphData, opts = {}) {
    const { nodes, links, warnings } = materialize(graphData);
    this.graph = { nodes, links };
    /** Load-time warnings (unknown / unsupported node types). load() only warns; run() fails fast. */
    this.warnings = warnings;
    this.client = new NanoClient({
      apiKey: opts.apiKey !== undefined ? opts.apiKey : envApiKey(),
      baseUrl: opts.baseUrl,
      fetch: opts.fetch,
      pollIntervals: opts.pollIntervals,
      timeouts: opts.timeouts,
      payment: opts.payment, // accountless x402: a callback that sends the Nano invoice (never a seed)
    });
    /** [{ key, nodeId, field, kind, label, optional, def, options? }] */
    this.inputs = deriveInputs(this.graph);
    /** [{ key, nodeId, type, ports }] */
    this.outputs = deriveOutputs(this.graph);
    /** [{ key, nodeId, field, kind, def, options? }] */
    this.settings = deriveSettings(this.graph);
    if (warnings.length && !opts.quiet) {
      for (const w of warnings) warnGraph(w);
    }
  }

  /**
   * Load a workflow from a noodle-graph.json file on disk, or from any nanoodle
   * share link — a full URL (nanoodle.com/#g=…, /play.html#a=…, a da.gd/TinyURL
   * short link) or a bare #g=/#j=/#a= fragment. Direct fragment links decode
   * offline; only fragment-less short links touch the network (redirect-header
   * reads, no credentials attached).
   *
   * File paths use Node's `fs` (dynamic import). In browsers, pass a parsed
   * object / JSON string to `Workflow.fromJSON`, or a share URL/fragment.
   */
  static async load(src, opts = {}) {
    if (isShareRef(src)) {
      const { graph } = await decodeShareUrl(src, { fetch: opts.fetch });
      return new Workflow(graph, opts);
    }
    if (typeof src === "string" && /^\s*[\[{]/.test(src)) {
      return Workflow.fromJSON(src, opts);
    }
    const { readFile } = await import("node:fs/promises");
    return Workflow.fromJSON(await readFile(src, "utf8"), opts);
  }

  /** Build from a parsed object or a JSON string. */
  static fromJSON(objOrString, opts = {}) {
    const data = typeof objOrString === "string" ? JSON.parse(objOrString) : objOrString;
    return new Workflow(data, opts);
  }

  /**
   * Execute the whole graph.
   * @param {object|string|Uint8Array|MediaRef} inputs friendly-keyed values, or a bare scalar
   *   when the workflow has exactly one required input
   * @param {{ settings?, timeoutMs?, signal?, onProgress? }} [runOpts]
   * @returns {Promise<RunResult>} rejects with RunError (carrying .result) when a sink failed
   */
  async run(inputs = {}, runOpts = {}) {
    const { settings = {}, timeoutMs, signal, onProgress } = runOpts;
    const graph = this.graph;

    // bare scalar → the single required input
    if (!isPlainObject(inputs)) {
      const required = this.inputs.filter((i) => !i.optional);
      if (required.length !== 1) {
        throw new NanoodleError(
          `a bare input value needs exactly one required input; this workflow has ${required.length} ` +
          `(${required.map((i) => `"${i.key}"`).join(", ")}) — pass an object instead`);
      }
      inputs = { [required[0].key]: inputs };
    }

    // ---- upfront validation: resolve every key BEFORE running/spending anything ----
    const inputAssignments = [];
    for (const [key, value] of Object.entries(inputs)) {
      const entry = resolveInputKey(graph, this.inputs, key);
      inputAssignments.push({ entry, value });
    }
    const settingAssignments = [];
    for (const [key, value] of Object.entries(settings)) {
      const entry = resolveSettingKey(graph, this.settings, key);
      settingAssignments.push({ entry, value });
    }

    // unknown node types fail fast — before any network call
    for (const n of graph.nodes) {
      if (n.unknown) {
        throw new UnsupportedNodeError(
          `node ${n.id}: unknown node type '${n.type}' — this graph needs a newer nanoodle library`,
          { nodeId: n.id, nodeType: n.type });
      }
    }

    const order = topoSort(graph); // throws naming cyclic nodes

    // Local-only graphs never POST media — skip the ~4 MB inline cap on inputs.
    // Mixed/network graphs keep the cap so we fail before spending on an oversize body.
    const hasNetwork = graph.nodes.some((n) => NODE_TYPES[n.type] && NODE_TYPES[n.type].network);
    const mediaCoerceOpts = { enforceInlineMax: hasNetwork };

    // effective fields: graph fields + settings overrides + user inputs
    const effFields = new Map(graph.nodes.map((n) => [n.id, { ...n.fields }]));
    for (const { entry, value } of settingAssignments) {
      effFields.get(entry.nodeId)[entry.field] = this._coerceSetting(entry, value);
    }
    const explicit = new Set();
    for (const { entry, value } of inputAssignments) {
      effFields.get(entry.nodeId)[entry.field] = this._coerceInput(entry, value, mediaCoerceOpts);
      explicit.add(entry);
    }
    // vframes: raise frames to highest wired frameK (play.html wiredFramesFloor) so a
    // persisted frames=1 with frame3 wired doesn't starve the consumer after paid upstream.
    for (const n of graph.nodes) {
      if (n.type !== "vframes") continue;
      const fields = effFields.get(n.id);
      const floor = wiredFramesFloor(graph, n.id);
      const cur = Math.max(1, Math.min(MAX_FRAMES, parseInt(fields.frames, 10) || 1));
      if (floor > cur) fields.frames = String(floor);
    }
    // defaults + required check
    for (const entry of this.inputs) {
      const fields = effFields.get(entry.nodeId);
      const v = fields[entry.field];
      if (v == null || String(v).trim() === "") {
        // an EXPLICIT empty value clears an optional input (e.g. run with no system prompt) —
        // the def only backfills when the key wasn't supplied at all (the app's prefilled textarea)
        if (entry.optional && explicit.has(entry)) continue;
        if (entry.def != null && String(entry.def) !== "") fields[entry.field] = entry.def;
        else if (!entry.optional) {
          throw new NanoodleError(`missing required input "${entry.key}" (${entry.nodeId}.${entry.field})`);
        }
      }
    }

    // API key (or an x402 payment callback) required only when the graph actually calls NanoGPT
    if (!this.client.apiKey && !this.client.payment && hasNetwork) {
      throw new NanoodleError("no API key — pass { apiKey } to Workflow.load/fromJSON, set NANOGPT_API_KEY, or pass { payment } for accountless x402 runs (this workflow calls the NanoGPT API)");
    }

    // ---- execution ----
    const ac = new AbortController();
    let timer = null;
    const onOuterAbort = () => ac.abort(signal.reason);
    if (signal) {
      if (signal.aborted) ac.abort(signal.reason);
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    if (timeoutMs) {
      timer = setTimeout(() => ac.abort(new NanoodleError(`run timed out after ${timeoutMs}ms`, { code: "timeout" })), timeoutMs);
    }

    const emit = (evt) => { if (onProgress) { try { onProgress(evt); } catch { /* listener errors never kill the run */ } } };
    const nodesRec = {};
    const errors = [];
    const cost = { total: 0, exact: true, balance: null };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const promises = new Map();
    const mediaFetch = this.client.fetch;

    const ctxFor = (node, rec) => {
      const onCost = (c) => {
        if (!c) return;
        if (c.usd != null) { rec.costUsd = (rec.costUsd || 0) + c.usd; cost.total += c.usd; }
        else cost.exact = false;
        if (c.balance != null) cost.balance = c.balance;
      };
      const onPoll = (info) => emit({ type: "poll", nodeId: node.id, name: displayName(node), ...info });
      const io = { onCost, onPoll, signal: ac.signal };
      return {
        chat: (messages, model, opts) => this.client.chat(messages, model, opts, io),
        chatImage: (messages, model, opts) => this.client.chatImage(messages, model, opts, io),
        image: (args) => this.client.image(args, io),
        video: (model, prompt, opts, imageDataUrl) => this.client.video(model, prompt, opts, imageDataUrl, io),
        audio: (model, input, extra) => this.client.audio(model, input, extra, io),
        transcribe: (model, audioUrl, language) => this.client.transcribe(model, audioUrl, language, io),
        fetchMedia: (url) => this.client.fetchMediaDataUrl(url, io),
        // local media (resize/combine/…) — same fetch + signal as network I/O
        fetch: mediaFetch,
        signal: ac.signal,
        progress: (msg) => emit({ type: "node-progress", nodeId: node.id, name: displayName(node), message: msg }),
      };
    };

    const execNode = async (n) => {
      const rec = nodesRec[n.id];
      try {
        throwIfAborted(ac.signal);
        const inbound = graph.links.filter((l) => l.to.node === n.id);
        const inp = {};
        let fields = effFields.get(n.id);
        let upstreamFail = null;
        for (const l of inbound) {
          let srcOut;
          try { srcOut = await promises.get(l.from.node); }
          catch { if (!upstreamFail) upstreamFail = displayName(byId.get(l.from.node)); continue; }
          const v = srcOut[l.from.port];
          if (isInputPort(n, l.to.port)) inp[l.to.port] = v;
          // wired textarea port = field override; a missing upstream port (degraded save) must
          // NOT clobber the typed field with undefined — the app only applies v != null
          else if (v != null) fields = { ...fields, [l.to.port]: v };
        }
        if (upstreamFail) throw new NanoodleError("upstream failed: " + upstreamFail);
        throwIfAborted(ac.signal);
        emit({ type: "node-start", nodeId: n.id, name: displayName(n) });
        const t0 = Date.now();
        const out = await RUNNERS[n.type]({ ...n, fields }, inp, ctxFor(n, rec));
        throwIfAborted(ac.signal);
        rec.status = "done";
        rec.out = out;
        rec.ms = Date.now() - t0;
        emit({ type: "node-done", nodeId: n.id, name: displayName(n), ms: rec.ms, costUsd: rec.costUsd });
        return out;
      } catch (e) {
        rec.status = "error";
        rec.error = e.message;
        errors.push({ nodeId: n.id, name: displayName(n), message: e.message });
        emit({ type: "node-error", nodeId: n.id, name: displayName(n), error: e.message });
        throw e;
      }
    };

    try {
      for (const n of order) {
        if (NODE_TYPES[n.type].note) { nodesRec[n.id] = { status: "skipped", out: null, error: null, costUsd: null, ms: null }; continue; }
        nodesRec[n.id] = { status: "pending", out: null, error: null, costUsd: null, ms: null };
        promises.set(n.id, execNode(n)); // siblings run concurrently; a node starts when ITS deps finish
      }
      await Promise.allSettled([...promises.values()]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onOuterAbort);
    }

    // ---- result ----
    const outputsMap = {};
    for (const o of this.outputs) {
      const rec = nodesRec[o.nodeId];
      if (!rec || rec.status !== "done") continue;
      const primary = o.ports[0];
      const value = this._wrapValue(rec.out[primary.name], primary.type);
      outputsMap[o.key] = value;
      outputsMap[o.nodeId] = value;
    }
    const result = new RunResult({
      outputs: outputsMap,
      nodes: nodesRec,
      errors,
      costUsd: cost.total,
      costExact: cost.exact,
      remainingBalance: cost.balance,
    });

    // timeout/abort must fail the run even when local media finished after the deadline
    // (or nodes never observed the signal). Prefer the abort reason when present.
    if (ac.signal.aborted) {
      const reason = abortReason(ac.signal);
      const msg = reason.message || "run aborted";
      // mark any still-pending nodes so result.errors is complete
      for (const n of order) {
        const rec = nodesRec[n.id];
        if (rec && rec.status === "pending") {
          rec.status = "error";
          rec.error = msg;
          if (!errors.some((e) => e.nodeId === n.id)) {
            errors.push({ nodeId: n.id, name: displayName(n), message: msg });
          }
        }
      }
      throw new RunError(msg, result, reason.code ? { code: reason.code } : {});
    }

    const failedSinks = this.outputs.filter((o) => nodesRec[o.nodeId] && nodesRec[o.nodeId].status === "error");
    if (failedSinks.length) {
      const detail = failedSinks.map((o) => `"${o.key}": ${nodesRec[o.nodeId].error}`).join("; ");
      throw new RunError("run failed — " + detail, result);
    }
    return result;
  }

  _coerceInput(entry, value, mediaOpts) {
    if (MEDIA_KINDS.has(entry.kind)) {
      return coerceMediaInput(value, `input "${entry.key}"`, mediaOpts);
    }
    if (entry.kind === "choice") {
      const v = String(value);
      if (!(entry.options || []).includes(v)) {
        throw new NanoodleError(`input "${entry.key}": "${v}" is not one of the choices (${(entry.options || []).join(", ")})`);
      }
      return v;
    }
    if (value != null && typeof value === "object" && !(value instanceof String)) {
      throw new NanoodleError(`input "${entry.key}" expects text — got ${Array.isArray(value) ? "an array" : "an object"}`);
    }
    return value == null ? value : String(value);
  }

  _coerceSetting(entry, value) {
    // settings come from DOM inputs in the app, so runners assume strings — coerce scalars
    // (numbers/booleans) the same way instead of crashing a runner mid-run
    if (value == null) return value;
    if (typeof value === "object" && !(value instanceof String)) {
      throw new NanoodleError(`setting "${entry.key}" expects a scalar — got ${Array.isArray(value) ? "an array" : "an object"}`);
    }
    return String(value);
  }

  _wrapValue(value, portType) {
    if (portType !== "text" && typeof value === "string" && value) {
      return new MediaRef(value, { fetch: this.client.fetch });
    }
    return value;
  }
}
