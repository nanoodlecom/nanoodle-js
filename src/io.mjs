import { NanoodleError } from "./errors.mjs";
import { NODE_TYPES, displayName, topoSort } from "./graph.mjs";

/* ============================== INPUTS ============================== */

/** Which node types contribute user inputs, and with what fields (mirrors play.html INPUT_SPECS). */
export const INPUT_SPECS = {
  text:    [{ f: "text",   label: "Text",  kind: "textarea" }],
  upload:  [{ f: "image",  label: "Image", kind: "image" }],
  aupload: [{ f: "audio",  label: "Audio", kind: "audio" }],
  vupload: [{ f: "video",  label: "Video", kind: "video" }],
  llm:     [{ f: "prompt", label: "Prompt", kind: "textarea" },
            { f: "system", label: "System prompt", kind: "textarea", optional: true, def: "You are a helpful, concise assistant." }],
  image:   [{ f: "prompt", label: "Image prompt", kind: "textarea" }],
  draw:    [{ f: "prompt", label: "Prompt", kind: "textarea" },
            { f: "system", label: "System prompt", kind: "textarea", optional: true }],
  tvideo:  [{ f: "prompt", label: "Video prompt", kind: "textarea" }],
  music:   [{ f: "prompt", label: "Style / prompt", kind: "textarea" }],
  remix:   [{ f: "prompt", label: "Style / direction", kind: "textarea" }],
  tts:     [{ f: "prompt", label: "Text to speak", kind: "textarea" }],
};

/**
 * Derive the workflow's user inputs: INPUT_SPECS fields not fed by a wire, plus the
 * inpaint / choice special cases. Each entry gets a unique friendly `key`.
 * @returns [{ key, nodeId, field, kind, label, optional, def, options?, title }]
 */
export function deriveInputs(graph) {
  const fed = (id, port) => graph.links.some((l) => l.to.node === id && l.to.port === port);
  const entries = [];
  const mk = (n, field, label, kind, optional, specDef) => {
    const cur = n.fields[field];
    return {
      nodeId: n.id, field, label, kind, optional: !!optional,
      def: cur != null && String(cur) !== "" ? cur : specDef,
      title: displayName(n), _node: n,
    };
  };
  for (const n of graph.nodes) {
    if (n.unknown) continue;
    if (n.type === "inpaint") {
      if (!fed(n.id, "prompt")) entries.push(mk(n, "prompt", "What to paint in", "textarea", false));
      // image and/or mask surface whenever not wired (SPEC-io). The app's combined brush widget
      // captures both at once when neither is wired; the library derives two plain image inputs —
      // dropping the mask half would make such graphs un-runnable (the sink needs a mask, and
      // "n.mask" wouldn't even resolve as an input key).
      const imgFed = fed(n.id, "image"), maskFed = fed(n.id, "mask");
      if (!imgFed) entries.push(mk(n, "image", maskFed ? "Image" : "Image — the picture to repaint", "image", false));
      if (!maskFed) entries.push(mk(n, "mask", "Mask (white = repaint)", "image", false));
      continue;
    }
    if (n.type === "choice") {
      const options = String(n.fields.options || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const e = { ...mk(n, "selected", "Choice", "choice", false), options };
      // The play page renders this input as a <select>, which always holds a value: an unset or
      // stale `selected` shows (and submits) the FIRST option — mirror that here, matching the
      // choice runner's own fallback, instead of tripping the upfront required-input check.
      if (e.def == null || !options.includes(String(e.def))) e.def = options[0];
      entries.push(e);
      continue;
    }
    const specs = INPUT_SPECS[n.type];
    if (!specs) continue;
    for (const s of specs) {
      if (fed(n.id, s.f)) continue;
      entries.push(mk(n, s.f, s.label, s.kind, s.optional, s.def));
    }
  }
  // Friendly keys: a node's custom name labels its input when it contributes exactly one
  // REQUIRED input (app PR #138); otherwise the generic spec label. Dedupe with " 2", " 3".
  const used = new Map();
  for (const e of entries) {
    const nodeEntries = entries.filter((x) => x.nodeId === e.nodeId);
    const required = nodeEntries.filter((x) => !x.optional);
    const custom = (e._node.name || "").trim();
    let key = custom && required.length === 1 && required[0] === e ? custom : e.label;
    const lower = key.toLowerCase();
    const count = (used.get(lower) || 0) + 1;
    used.set(lower, count);
    if (count > 1) key = key + " " + count;
    e.key = key;
  }
  for (const e of entries) delete e._node;
  return entries;
}

function ambiguous(userKey, candidates) {
  return new NanoodleError(
    `input "${userKey}" is ambiguous — matches ${candidates.map((c) => `${c.nodeId}.${c.field} ("${c.key}")`).join(", ")}; ` +
    "use the nodeId.field form to disambiguate");
}

/**
 * Resolve a user-supplied input name to a derived input entry (case-insensitive, trimmed).
 * Order: derived key → exact node custom name → nodeId.field / bare nodeId → label/field if unique.
 */
export function resolveInputKey(graph, inputs, userKey) {
  const norm = String(userKey).trim().toLowerCase();
  const byKey = inputs.filter((i) => i.key.toLowerCase() === norm);
  if (byKey.length === 1) return byKey[0];

  const named = graph.nodes.filter((n) => (n.name || "").trim().toLowerCase() === norm);
  if (named.length) {
    const cand = inputs.filter((i) => named.some((n) => n.id === i.nodeId));
    if (cand.length === 1) return cand[0];
    if (cand.length > 1) throw ambiguous(userKey, cand);
  }

  const dot = norm.lastIndexOf(".");
  if (dot > 0) {
    const nid = norm.slice(0, dot), field = norm.slice(dot + 1);
    const hit = inputs.find((i) => i.nodeId.toLowerCase() === nid && i.field.toLowerCase() === field);
    if (hit) return hit;
    const node = graph.nodes.find((n) => n.id.toLowerCase() === nid);
    if (node && graph.links.some((l) => l.to.node === node.id && l.to.port.toLowerCase() === field)) {
      throw new NanoodleError(`"${userKey}" is wired from another node in this workflow and can't be supplied as an input`);
    }
  }
  const byNode = inputs.filter((i) => i.nodeId.toLowerCase() === norm);
  if (byNode.length === 1) return byNode[0];
  if (byNode.length > 1) throw ambiguous(userKey, byNode);

  const byLabel = inputs.filter((i) => i.label.toLowerCase() === norm || i.field.toLowerCase() === norm);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw ambiguous(userKey, byLabel);

  const avail = inputs.map((i) => `"${i.key}"`).join(", ") || "(none)";
  throw new NanoodleError(`unknown input "${userKey}" — available inputs: ${avail}`);
}

/* ============================== OUTPUTS ============================== */

/**
 * Output nodes = nodes with outputs and no outgoing link (sinks).
 * Keyed by display name; duplicates suffixed " 2", " 3" in topological order. Always also
 * addressable by node id (handled at result-build time).
 * @returns [{ key, nodeId, type, ports }]
 */
export function deriveOutputs(graph) {
  let ordered;
  try { ordered = topoSort(graph); } catch { ordered = graph.nodes; } // cyclic graphs still get keys; run() errors properly
  const sinks = ordered.filter((n) => {
    if (n.unknown) return false;
    const t = NODE_TYPES[n.type];
    if (!t.outputs || !t.outputs.length) return false;
    return !graph.links.some((l) => l.from.node === n.id);
  });
  const used = new Map();
  return sinks.map((n) => {
    let key = displayName(n);
    const lower = key.toLowerCase();
    const count = (used.get(lower) || 0) + 1;
    used.set(lower, count);
    if (count > 1) key = key + " " + count;
    return { key, nodeId: n.id, type: n.type, ports: NODE_TYPES[n.type].outputs.map((p) => ({ ...p })) };
  });
}

/* ============================== SETTINGS ============================== */

// Option lists verbatim from play.html (SIZES line 897, DURATIONS line 3232).
const SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"];
const DURATIONS = ["5", "10"];

/** Per-node knobs that are not part of the IO shape (mirrors play.html SETTING_SPECS). */
export const SETTING_SPECS = {
  llm: [
    { f: "model", label: "Model", kind: "model" },
    { f: "temperature", label: "Temperature", kind: "number", def: "0.8" },
    { f: "maxTokens", label: "Max tokens", kind: "number" },
    { f: "format", label: "Output format", kind: "select", options: ["Text", "JSON"], def: "Text" },
    { f: "reasoningEffort", label: "Reasoning effort", kind: "select", options: ["default", "low", "medium", "high"], def: "default" },
    { f: "showThinking", label: "Show thinking", kind: "boolean" },
  ],
  vision: [
    { f: "model", label: "Model", kind: "model" },
    { f: "q", label: "Question", kind: "textarea", def: "Describe this image." },
  ],
  image: [
    { f: "model", label: "Model", kind: "model" },
    { f: "size", label: "Image size", kind: "select", options: SIZES, def: "1024x1024" },
    { f: "variations", label: "Variations", kind: "number", def: "1" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  edit: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Edit instruction", kind: "textarea" },
    { f: "size", label: "Image size", kind: "select", options: SIZES, def: "1024x1024" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  draw: [
    { f: "model", label: "Model", kind: "model" },
    { f: "showThinking", label: "Show thinking", kind: "boolean", def: true },
  ],
  tvideo: [
    { f: "model", label: "Model", kind: "model" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
    { f: "aspect", label: "Aspect ratio", kind: "select", options: ["16:9", "9:16", "1:1", "4:3", "3:4"], def: "16:9" },
    { f: "duration", label: "Duration", kind: "select", options: DURATIONS, def: "5" },
  ],
  ivideo: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Motion prompt", kind: "textarea" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
    { f: "aspect", label: "Aspect ratio", kind: "select", options: ["16:9", "9:16", "1:1", "4:3", "3:4"], def: "16:9" },
    { f: "duration", label: "Duration", kind: "select", options: DURATIONS, def: "5" },
  ],
  vedit: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Edit instruction", kind: "textarea" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
  ],
  lipsync: [
    { f: "model", label: "Model", kind: "model" },
    { f: "prompt", label: "Guidance prompt", kind: "textarea" },
    { f: "resolution", label: "Resolution", kind: "select", def: "" },
  ],
  music: [
    { f: "model", label: "Model", kind: "model" },
    { f: "lyrics", label: "Lyrics", kind: "textarea" },
    { f: "instrumental", label: "Instrumental", kind: "boolean" },
    { f: "duration", label: "Duration (s)", kind: "number" },
    { f: "negative_prompt", label: "Negative prompt", kind: "textarea" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
  remix: [
    { f: "model", label: "Model", kind: "model" },
    { f: "lyrics", label: "Lyrics", kind: "textarea" },
    { f: "duration", label: "Duration (s)", kind: "number" },
  ],
  tts: [
    { f: "model", label: "Model", kind: "model" },
    { f: "voice", label: "Voice", kind: "text" },
    { f: "speed", label: "Speed", kind: "number", def: "1" },
    { f: "instructions", label: "Voice instructions", kind: "textarea" },
  ],
  transcribe: [
    { f: "model", label: "Model", kind: "model" },
    { f: "language", label: "Language", kind: "text", def: "auto" },
  ],
  join: [{ f: "sep", label: "Separator (use \\n for a line break)", kind: "text", def: " " }],
  inpaint: [
    { f: "model", label: "Model", kind: "model" },
    { f: "size", label: "Image size", kind: "select", options: SIZES, def: "1024x1024" },
    { f: "seed", label: "Seed", kind: "number" },
  ],
};

/**
 * Derive overridable settings: SETTING_SPECS fields that aren't wired.
 * @returns [{ key, nodeId, field, kind, label, def, options?, title }]
 */
export function deriveSettings(graph) {
  const out = [];
  for (const n of graph.nodes) {
    if (n.unknown) continue;
    const specs = SETTING_SPECS[n.type];
    if (!specs) continue;
    for (const s of specs) {
      if (graph.links.some((l) => l.to.node === n.id && l.to.port === s.f)) continue; // wired knob is decided upstream
      const cur = n.fields[s.f];
      out.push({
        key: `${n.id}.${s.f}`, nodeId: n.id, field: s.f, kind: s.kind, label: s.label,
        def: cur != null && String(cur) !== "" ? cur : s.def,
        ...(s.options ? { options: [...s.options] } : {}),
        title: displayName(n),
      });
    }
    if (n.type === "image" && n.fields && n.fields.model === "custom-civitai") {
      out.push({ key: `${n.id}.customCivitaiAir`, nodeId: n.id, field: "customCivitaiAir", kind: "text", label: "CivitAI model", def: n.fields.customCivitaiAir || "", title: displayName(n) });
    }
  }
  return out;
}

/**
 * Resolve a settings key: "nodeId.field" → "customName.field" / "Title.field" → bare field/label if unique.
 * Refuses wired fields with a clear error.
 */
export function resolveSettingKey(graph, settings, userKey) {
  const norm = String(userKey).trim().toLowerCase();
  const exact = settings.find((s) => s.key.toLowerCase() === norm);
  if (exact) return exact;

  const dot = norm.lastIndexOf(".");
  if (dot > 0) {
    const head = norm.slice(0, dot), field = norm.slice(dot + 1);
    const nodes = graph.nodes.filter((n) =>
      n.id.toLowerCase() === head ||
      (n.name || "").trim().toLowerCase() === head ||
      displayName(n).toLowerCase() === head);
    const cand = settings.filter((s) => nodes.some((n) => n.id === s.nodeId) && s.field.toLowerCase() === field);
    if (cand.length === 1) return cand[0];
    if (cand.length > 1) {
      throw new NanoodleError(`setting "${userKey}" is ambiguous — matches ${cand.map((c) => c.key).join(", ")}`);
    }
    for (const n of nodes) {
      if (graph.links.some((l) => l.to.node === n.id && l.to.port.toLowerCase() === field)) {
        throw new NanoodleError(`setting "${userKey}": that field is wired from another node and can't be overridden`);
      }
    }
  }

  const byField = settings.filter((s) => s.field.toLowerCase() === norm || s.label.toLowerCase() === norm);
  if (byField.length === 1) return byField[0];
  if (byField.length > 1) {
    throw new NanoodleError(`setting "${userKey}" is ambiguous — matches ${byField.map((c) => c.key).join(", ")}`);
  }

  const avail = settings.map((s) => s.key).join(", ") || "(none)";
  throw new NanoodleError(`unknown setting "${userKey}" — available settings: ${avail}`);
}
