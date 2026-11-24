import { NanoodleError } from "./errors.mjs";
import { INPUT_SPECS, SETTING_SPECS } from "./io-specs.mjs";
import { planBranches } from "./branches.mjs";
import { competingInputIssues, staticCompetingInputIssues } from "./input-wires.mjs";

/* Dynamic input-port families also used by the runners to collect their values. */
export const IMG_PORT_RE = /^img\d*$/;      // llm vision references, decide candidates
export const EDIT_IMG_RE = /^image\d*$/;    // edit multi-reference: image, image2, ...
export const VID_PORT_RE = /^vid\d*$/;
export const CLIP_PORT_RE = /^clip\d*$/;    // combine clips
export const REF_PORT_RE = /^ref\d*$/;      // tvideo reference images
export const FRAME_PORT_RE = /^frame[1-9]\d*$/;  // vframes outputs
export const MAX_FRAMES = 48;

const DYNAMIC_INPUTS = new Map([
  ["llm", [IMG_PORT_RE]],
  ["decide", [IMG_PORT_RE]],
  ["edit", [EDIT_IMG_RE]],
  ["tvideo", [REF_PORT_RE]],
  ["vedit", [REF_PORT_RE]],
  ["combine", [VID_PORT_RE, CLIP_PORT_RE]],
]);

// Runtime-consumed fields that aren't surfaced as workflow inputs or settings.
const LORA_FIELDS = ["loras", "loraUrl", "loraStrength"];
const IMAGE_FIELDS = ["modelOpts", "aspect", "customCivitaiAir", "negativePrompt", ...LORA_FIELDS];
const VIDEO_FIELDS = ["modelOpts", ...LORA_FIELDS];
const AUDIO_FIELDS = ["response_format", "extraJson"];
const EXTRA_WIRED_FIELDS = new Map([
  ["upload", ["optional"]],
  ["aupload", ["optional"]],
  ["vupload", ["optional"]],
  ["mupload", ["optional"]],
  ["choice", ["options", "selected"]],
  ["image", ["sel", ...IMAGE_FIELDS]],
  ["edit", IMAGE_FIELDS],
  ["inpaint", ["prompt", ...IMAGE_FIELDS]],
  ["tvideo", VIDEO_FIELDS],
  ["ivideo", VIDEO_FIELDS],
  ["vedit", ["aspect", "duration", ...VIDEO_FIELDS]],
  ["lipsync", ["aspect", "duration", "modelOpts"]],
  ["model3d", ["modelOpts"]],
  ["music", AUDIO_FIELDS],
  ["remix", AUDIO_FIELDS],
  ["tts", AUDIO_FIELDS],
  ["endpoint", ["system", "size"]],
]);

/**
 * Highest frameN port wired OUT of a vframes node. fields.frames is shape-affecting:
 * run() emits frame1..frameN and downstream links read fixed frameK ports. A count below
 * the highest wired port starves consumers mid-run (after upstream paid steps). Mirrors
 * play.html wiredFramesFloor — floor is raised at run and in deriveSettings.
 */
export function wiredFramesFloor(graph, nodeId) {
  let floor = 1;
  for (const l of (graph && graph.links) || []) {
    if (l.from.node !== nodeId) continue;
    const port = String(l.from.port);
    if (FRAME_PORT_RE.test(port)) floor = Math.max(floor, Number(port.slice(5)));
  }
  return Math.min(floor, MAX_FRAMES);
}

/**
 * Node-type registry (execution-relevant subset of the app's NODE_TYPES).
 * flags: local (pure logic / on-device media) | network (calls NanoGPT) | note.
 * extraSourcePorts lists runtime outputs that are absent from the standard port list.
 * Local media: pure-JS first (MP4CAT / PCM-WAV / PNG); ffmpeg on PATH is the heavy fallback.
 */
export const NODE_TYPES = {
  text:    { title: "Text",            inputs: [], outputs: [{ name: "text", type: "text" }], local: true },
  upload:  { title: "Image input",     inputs: [], outputs: [{ name: "image", type: "image" }], local: true },
  aupload: { title: "Audio input",     inputs: [], outputs: [{ name: "audio", type: "audio" }], local: true },
  vupload: { title: "Video input",     inputs: [], outputs: [{ name: "video", type: "video" }], local: true },
  "slice-3d": { title: "Slice 3D", inputs: ["model", "paletteImage"], outputs: [{ name: "sheet", type: "image" }, { name: "layout", type: "text" }, { name: "image", type: "image" }], local: true },
  "sprite-stack-render": { title: "Sprite stack render", inputs: ["sheet"], outputs: [{ name: "image", type: "image" }, { name: "video", type: "video" }], local: true },
  mupload: { title: "3D input",        inputs: [], outputs: [{ name: "model", type: "model3d" }], local: true },
  choice:  { title: "Choice",          inputs: [], outputs: [{ name: "text", type: "text" }], local: true },
  join:    { title: "Join",            inputs: ["a", "b"], outputs: [{ name: "text", type: "text" }], local: true },
  llm:     { title: "LLM",             inputs: ["audio", "video"], outputs: [{ name: "text", type: "text" }], network: true },
  image:   { title: "Image",           inputs: [], outputs: [{ name: "image", type: "image" }], extraSourcePorts: ["images"], network: true },
  edit:    { title: "Edit",            inputs: [], outputs: [{ name: "image", type: "image" }], extraSourcePorts: ["images", "layers"], network: true },
  inpaint: { title: "Inpaint",         inputs: ["image", "mask"], outputs: [{ name: "image", type: "image" }], extraSourcePorts: ["images", "layers"], network: true },
  resize:  { title: "Resize / crop",   inputs: ["image"], outputs: [{ name: "image", type: "image" }], local: true },
  vision:  { title: "Vision",          inputs: ["image"], outputs: [{ name: "text", type: "text" }], network: true },
  decide:  { title: "Decide",          inputs: ["text"], outputs: [{ name: "text", type: "text" }, { name: "image", type: "image" }], extraSourcePorts: ["yes", "no", "decision"], network: true }, // img1… candidates (IMG_PORT_RE)
  tvideo:  { title: "Text→Video",      inputs: [], outputs: [{ name: "video", type: "video" }], network: true },
  ivideo:  { title: "Image→Video",     inputs: ["image", "endframe"], outputs: [{ name: "video", type: "video" }], network: true },
  model3d: { title: "3D model",        inputs: ["image", "model"], outputs: [{ name: "model", type: "model3d" }], network: true },
  vedit:   { title: "Video edit",      inputs: ["video", "image"], outputs: [{ name: "video", type: "video" }], network: true },
  vframes: { title: "Video → frames",  inputs: ["video"], outputs: [{ name: "frame1", type: "image" }], local: true, framesOut: true }, // dynamic frame1..N
  render3d: { title: "Render 3D",      inputs: ["model"], outputs: [{ name: "image", type: "image" }, { name: "video", type: "video" }], local: true },
  combine: { title: "Combine videos",  inputs: [], outputs: [{ name: "video", type: "video" }], local: true },
  soundtrack: { title: "Soundtrack",   inputs: ["video", "audio"], outputs: [{ name: "video", type: "video" }], local: true },
  lipsync: { title: "Avatar / lipsync", inputs: ["image", "audio"], outputs: [{ name: "video", type: "video" }], network: true },
  music:   { title: "Music",           inputs: [], outputs: [{ name: "audio", type: "audio" }], network: true },
  remix:   { title: "Remix audio",     inputs: ["audio"], outputs: [{ name: "audio", type: "audio" }], network: true },
  tts:     { title: "Speech",          inputs: [], outputs: [{ name: "audio", type: "audio" }], network: true },
  trim:    { title: "Trim audio",      inputs: ["audio"], outputs: [{ name: "audio", type: "audio" }], local: true },
  extractaudio: { title: "Extract audio", inputs: ["video"], outputs: [{ name: "audio", type: "audio" }], local: true },
  transcribe: { title: "Transcribe",   inputs: ["audio"], outputs: [{ name: "text", type: "text" }], network: true },
  cleanvoice: { title: "Clean voice", inputs: ["audio", "video"], outputs: [{ name: "audio", type: "audio" }], network: true },
  // Custom URL — not a NanoGPT call, so `network` stays unset (no API key required).
  // Output port follows the selected route mode (see deriveOutputs / endpointOutPort).
  endpoint: { title: "Custom endpoint", inputs: ["text", "image", "audio", "video"], outputs: [{ name: "text", type: "text" }], extraSourcePorts: ["image", "audio", "video", "images"] },
  comment: { title: "Comment",         inputs: [], outputs: [], note: true, local: true },
};

/** Display name: node.name (trimmed) → type title → type → "?". */
export function displayName(node) {
  const nm = (node.name || "").trim();
  if (nm) return nm;
  const t = NODE_TYPES[node.type];
  return (t && t.title) || node.type || "?";
}

/**
 * Author-marked optional node: fields.optional (the editor's "optional" checkbox on
 * input nodes) makes every input this node surfaces skippable — the run proceeds and
 * the node yields an empty value instead of failing. Serialized inside fields so it
 * survives save/share/materialize with zero format changes.
 */
export function optionalNode(node) {
  const v = node && node.fields && node.fields.optional;
  return v === true || v === "true";
}

/** Author-locked node: fields.locked keeps every field at its stored value (no inputs derived). */
export function lockedNode(node) {
  const v = node && node.fields && node.fields.locked;
  return v === true || v === "true";
}

/** Is a wire landing on `port` of `node` a data input (vs a field override)? */
export function isInputPort(node, port) {
  const t = NODE_TYPES[node.type];
  return t?.inputs?.includes(port) || DYNAMIC_INPUTS.get(node.type)?.some((re) => re.test(port));
}

/** Check the possible source ports without depending on what a particular run emits. */
function isSourcePort(source, port) {
  const type = NODE_TYPES[source.type];
  return type?.outputs?.some(output => output.name === port) || type?.extraSourcePorts?.includes(port) ||
    (type?.framesOut && FRAME_PORT_RE.test(port) && Number(port.slice(5)) <= MAX_FRAMES);
}

function isTargetPort(target, port) {
  return isInputPort(target, port) ||
    INPUT_SPECS[target.type]?.some(spec => spec.f === port) ||
    SETTING_SPECS[target.type]?.some(spec => spec.f === port) ||
    EXTRA_WIRED_FIELDS.get(target.type)?.includes(port) ||
    (port === "timeoutMs" && !NODE_TYPES[target.type].note);
}

/** Report the first problem with a link, using the same checks on load and before a run. */
export function wireIssue({ from, to }, byId) {
  const source = byId.get(from.node);
  const target = byId.get(to.node);
  const wire = `wire ${from.node ?? "(missing)"}.${from.port} → ${to.node ?? "(missing)"}.${to.port}`;
  if (!source) return { code: "missing-wire-node", message: `${wire} references missing source node "${from.node ?? ""}"` };
  if (!target) return { code: "missing-wire-node", message: `${wire} references missing target node "${to.node ?? ""}"` };
  if (!source.unknown && !isSourcePort(source, from.port)) {
    return { code: "invalid-source-port", message: `${wire} uses undeclared source port "${from.port}" on ${displayName(source)}` };
  }
  if (!target.unknown && !isTargetPort(target, to.port)) {
    return { code: "invalid-target-port", message: `${wire} uses undeclared target port "${to.port}" on ${displayName(target)}` };
  }
  if (target.type === "llm" && to.port === "video") {
    return {
      code: "unsupported-target-port",
      message: `${wire} uses unsupported LLM input "video" in the JavaScript executor. Run this workflow in the nanoodle editor or player to use the clip.`,
    };
  }
}

/**
 * Media fields (upload image, inpaint image/mask, audio/video clips) hold a data: or
 * http(s) URL — the editor writes data: URLs, hand-authored graphs may inline either.
 * Agents authoring graphs sometimes leave a prose placeholder instead ("[image will be
 * provided at run time]") or a bare file path: those LOOK filled (inspect prints a
 * default, run() skips the required-input check) but post garbage to the API. Anything
 * that isn't a real media URL is treated as EMPTY at load, with a warning that says how
 * to actually supply the media.
 */
const MEDIA_FIELD_KEYS = ["image", "mask", "audio", "video"];
const MEDIA_URL_RE = /^(data:|https?:)/i;

function scrubMediaPlaceholders(n, warnings) {
  // mupload stores the .glb on fields.model. That key is an AI model id on every
  // other node, so it is only treated as media here.
  const keys = n.type === "mupload" ? MEDIA_FIELD_KEYS.concat(["model"]) : MEDIA_FIELD_KEYS;
  for (const k of keys) {
    const v = n.fields[k];
    // Built-in editor examples store their same-origin assets as relative paths.
    if (typeof v === "string" && /^examples\/[A-Za-z0-9_./-]+$/.test(v) && !v.includes("..")) {
      const origin = globalThis.location?.origin;
      n.fields[k] = (/^https?:\/\//.test(origin || "") ? origin : "https://nanoodle.com") + "/" + v;
      continue;
    }
    if (v == null || v === "" || (typeof v === "string" && MEDIA_URL_RE.test(v.trim()))) continue;
    const shown = typeof v === "string"
      ? `"${v.length > 60 ? v.slice(0, 57) + "…" : v}"`
      : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`;
    n.fields[k] = "";
    warnings.push(
      `node ${n.id} (${displayName(n)}): fields.${k} held ${shown} — not a data: or http(s) URL, so it was ` +
      `treated as empty. Leave media fields "" in the graph and supply the ${k} at run time ` +
      `(CLI: --input "<key>=@file", library: run({ "<key>": mediaFromFile(path) }), key from inspect/wf.inputs), ` +
      `or inline a data: URL.`);
  }
}

function nonblankString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Reject structurally invalid records before normalizing their IDs or types. */
export function assertNodeRecord(node, index) {
  let issue;
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    issue = "must be an object";
  } else if (!Object.hasOwn(node, "id") || !(nonblankString(node.id) || Number.isFinite(node.id))) {
    issue = "has a missing or invalid id (expected a non-empty string or finite number)";
  } else if (!Object.hasOwn(node, "type") || !nonblankString(node.type)) {
    issue = "has a missing or invalid type (expected a non-empty string)";
  }
  if (issue) throw new NanoodleError(`node at position ${index + 1} ${issue}`, { code: "invalid-node-record" });
}

/**
 * Load raw parsed graph JSON into an executable graph (mirrors the app's applyGraphData):
 * - malformed node records are rejected with their position in the nodes array
 * - `audio` type aliases to `tts` (legacy saves)
 * - unknown node types are KEPT but flagged (`unknown: true`) + a warning; run() fails fast on them
 * - media fields that aren't a data:/http(s) URL (prose placeholders, file paths) are blanked + a warning
 * - links into music/tts port "text" migrate to "prompt"
 * - links with missing nodes or undeclared ports are kept with a warning so they can be repaired
 * @returns {{ nodes, links, warnings: string[] }}
 */
export function materialize(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.nodes)) {
    throw new NanoodleError("not a nanoodle graph: expected an object with a nodes array (the noodle-graph.json save)");
  }
  const warnings = [];
  const nodes = [];
  const seenIds = new Set();
  for (const [index, raw] of data.nodes.entries()) {
    assertNodeRecord(raw, index);
    const id = String(raw.id);
    if (seenIds.has(id)) throw new NanoodleError(`duplicate node id "${id}" — every node must have a unique id`);
    seenIds.add(id);
    const type = raw.type === "audio" ? "tts" : raw.type === "decide-branch" ? "decide" : raw.type;
    const n = { id, type, name: raw.name, fields: { ...(raw.fields || {}) } };
    if (raw.type === "decide-branch") n.fields.branch = true;
    if (!Object.hasOwn(NODE_TYPES, type)) {
      n.unknown = true;
      warnings.push(`unknown node type "${raw.type}" (node ${n.id}) — kept, but running this workflow will fail; you may need a newer nanoodle library`);
    } else {
      scrubMediaPlaceholders(n, warnings);
    }
    nodes.push(n);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = [];
  const validLinks = [];
  for (const l of data.links || []) {
    const from = normalizeEndpoint(l?.from);
    const to = normalizeEndpoint(l?.to);
    const toNode = byId.get(to.node);
    if ((toNode?.type === "music" || toNode?.type === "tts") && to.port === "text") to.port = "prompt"; // legacy port migration
    const link = { id: l?.id, from, to };
    const issue = wireIssue(link, byId);
    if (issue) warnings.push(issue.message);
    else validLinks.push(link);
    links.push(link);
  }
  if (competingInputIssues(validLinks).length) {
    const validGraph = { nodes, links: validLinks };
    try {
      const order = topoSort(validGraph);
      const branches = planBranches(validGraph, order.map(node => node.id));
      warnings.push(...staticCompetingInputIssues(validGraph, order, branches));
    } catch (error) {
      if (!(error instanceof NanoodleError)) throw error;
      // Invalid routing or cycles will be reported by run's graph preflight.
    }
  }
  return { nodes, links, warnings };
}

function normalizeEndpoint(endpoint) {
  return { node: endpoint?.node == null ? null : String(endpoint.node), port: String(endpoint?.port ?? "") };
}

/**
 * Kahn topological sort. Throws naming the cyclic nodes.
 * @returns node array in dependency order
 */
export function topoSort(graph) {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const outAdj = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const l of graph.links) {
    // Inspection still sorts the existing nodes when a retained wire dangles.
    if (!indeg.has(l.from.node) || !indeg.has(l.to.node)) continue;
    indeg.set(l.to.node, indeg.get(l.to.node) + 1);
    outAdj.get(l.from.node).push(l.to.node);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(byId.get(id));
    for (const next of outAdj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== graph.nodes.length) {
    const cyclic = graph.nodes.filter((n) => !order.includes(n)).map((n) => `${displayName(n)} (${n.id})`);
    throw new NanoodleError("workflow has a cycle involving: " + cyclic.join(", "));
  }
  return order;
}
