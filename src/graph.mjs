import { NanoodleError } from "./errors.mjs";

/* Dynamic input-port families (mirrors the nanoodle app's runGraph). A wire landing on one of
   these ports — or on a port declared in NODE_TYPES[type].inputs — is a data input; a wire
   landing on ANY other port is a field override (wired prompt/system/lyrics/q/...). */
export const IMG_PORT_RE = /^img\d+$/;      // llm / draw vision references
export const EDIT_IMG_RE = /^image\d*$/;    // edit multi-reference: image, image2, ...
export const VID_PORT_RE = /^vid\d+$/;
export const CLIP_PORT_RE = /^clip\d+$/;    // combine clips
export const REF_PORT_RE = /^ref\d+$/;      // tvideo reference images
export const FRAME_PORT_RE = /^frame\d+$/;  // vframes outputs
export const MAX_FRAMES = 12;

const DYNAMIC_INPUT_RES = [IMG_PORT_RE, EDIT_IMG_RE, VID_PORT_RE, CLIP_PORT_RE, REF_PORT_RE];
const DYNAMIC_INPUT_NAMES = new Set(["audio", "endframe"]);

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
    const m = /^frame(\d+)$/.exec(String(l.from.port));
    if (m) floor = Math.max(floor, parseInt(m[1], 10) || 1);
  }
  return Math.min(floor, MAX_FRAMES);
}

/**
 * Node-type registry (execution-relevant subset of the app's NODE_TYPES).
 * flags: local (pure logic / on-device media) | network (calls NanoGPT) | note.
 * Local media: pure-JS first (MP4CAT / PCM-WAV / PNG); ffmpeg on PATH is the heavy fallback.
 */
export const NODE_TYPES = {
  text:    { title: "Text",            inputs: [], outputs: [{ name: "text", type: "text" }], local: true },
  upload:  { title: "Image input",     inputs: [], outputs: [{ name: "image", type: "image" }], local: true },
  aupload: { title: "Audio input",     inputs: [], outputs: [{ name: "audio", type: "audio" }], local: true },
  vupload: { title: "Video input",     inputs: [], outputs: [{ name: "video", type: "video" }], local: true },
  choice:  { title: "Choice",          inputs: [], outputs: [{ name: "text", type: "text" }], local: true },
  join:    { title: "Join",            inputs: ["a", "b"], outputs: [{ name: "text", type: "text" }], local: true },
  llm:     { title: "LLM",             inputs: [], outputs: [{ name: "text", type: "text" }], network: true },
  image:   { title: "Image",           inputs: [], outputs: [{ name: "image", type: "image" }], network: true },
  draw:    { title: "Draw",            inputs: [], outputs: [{ name: "image", type: "image" }, { name: "text", type: "text" }], network: true },
  edit:    { title: "Edit",            inputs: [], outputs: [{ name: "image", type: "image" }], network: true },
  inpaint: { title: "Inpaint",         inputs: ["image", "mask"], outputs: [{ name: "image", type: "image" }], network: true },
  resize:  { title: "Resize / crop",   inputs: ["image"], outputs: [{ name: "image", type: "image" }], local: true },
  vision:  { title: "Vision",          inputs: ["image"], outputs: [{ name: "text", type: "text" }], network: true },
  tvideo:  { title: "Text→Video",      inputs: [], outputs: [{ name: "video", type: "video" }], network: true },
  ivideo:  { title: "Image→Video",     inputs: ["image"], outputs: [{ name: "video", type: "video" }], network: true },
  vedit:   { title: "Video edit",      inputs: ["video"], outputs: [{ name: "video", type: "video" }], network: true },
  vframes: { title: "Video → frames",  inputs: ["video"], outputs: [{ name: "frame1", type: "image" }], local: true, framesOut: true }, // dynamic frame1..N
  combine: { title: "Combine videos",  inputs: [], outputs: [{ name: "video", type: "video" }], local: true },
  soundtrack: { title: "Soundtrack",   inputs: ["video", "audio"], outputs: [{ name: "video", type: "video" }], local: true },
  lipsync: { title: "Avatar / lipsync", inputs: ["image", "audio"], outputs: [{ name: "video", type: "video" }], network: true },
  music:   { title: "Music",           inputs: [], outputs: [{ name: "audio", type: "audio" }], network: true },
  remix:   { title: "Remix audio",     inputs: ["audio"], outputs: [{ name: "audio", type: "audio" }], network: true },
  tts:     { title: "Speech",          inputs: [], outputs: [{ name: "audio", type: "audio" }], network: true },
  trim:    { title: "Trim audio",      inputs: ["audio"], outputs: [{ name: "audio", type: "audio" }], local: true },
  extractaudio: { title: "Extract audio", inputs: ["video"], outputs: [{ name: "audio", type: "audio" }], local: true },
  transcribe: { title: "Transcribe",   inputs: ["audio"], outputs: [{ name: "text", type: "text" }], network: true },
  comment: { title: "Comment",         inputs: [], outputs: [], note: true, local: true },
};

/** Display name: node.name (trimmed) → type title → type → "?". */
export function displayName(node) {
  const nm = (node.name || "").trim();
  if (nm) return nm;
  const t = NODE_TYPES[node.type];
  return (t && t.title) || node.type || "?";
}

/** Is a wire landing on `port` of `node` a data input (vs a field override)? */
export function isInputPort(node, port) {
  const t = NODE_TYPES[node.type];
  if (t && (t.inputs || []).includes(port)) return true;
  if (DYNAMIC_INPUT_NAMES.has(port)) return true;
  return DYNAMIC_INPUT_RES.some((re) => re.test(port));
}

/**
 * Load raw parsed graph JSON into an executable graph (mirrors the app's applyGraphData):
 * - `audio` type aliases to `tts` (legacy saves)
 * - unknown node types are KEPT but flagged (`unknown: true`) + a warning; run() fails fast on them
 * - links are kept only when both endpoints exist
 * - links into music/tts port "text" migrate to "prompt"
 * @returns {{ nodes, links, warnings: string[] }}
 */
export function materialize(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.nodes)) {
    throw new NanoodleError("not a nanoodle graph: expected an object with a nodes array (the noodle-graph.json save)");
  }
  const warnings = [];
  const nodes = [];
  for (const raw of data.nodes) {
    if (!raw || raw.id == null || !raw.type) continue;
    const type = raw.type === "audio" ? "tts" : raw.type;
    const n = { id: String(raw.id), type, name: raw.name, fields: { ...(raw.fields || {}) } };
    if (!NODE_TYPES[type]) {
      n.unknown = true;
      warnings.push(`unknown node type "${raw.type}" (node ${n.id}) — kept, but running this workflow will fail; you may need a newer nanoodle library`);
    }
    nodes.push(n);
  }
  const ids = new Set(nodes.map((n) => n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = [];
  for (const l of data.links || []) {
    if (!l || !l.from || !l.to) continue;
    const from = { node: String(l.from.node), port: String(l.from.port) };
    const to = { node: String(l.to.node), port: String(l.to.port) };
    if (!ids.has(from.node) || !ids.has(to.node)) continue;
    const toNode = byId.get(to.node);
    if ((toNode.type === "music" || toNode.type === "tts") && to.port === "text") to.port = "prompt"; // legacy port migration
    links.push({ id: l.id, from, to });
  }
  return { nodes, links, warnings };
}

/**
 * Kahn topological sort. Throws naming the cyclic nodes.
 * @returns node array in dependency order
 */
export function topoSort(graph) {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  const outAdj = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const l of graph.links) {
    indeg.set(l.to.node, (indeg.get(l.to.node) || 0) + 1);
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
