import { NanoodleError } from "./errors.mjs";
import { NODE_TYPES, displayName, lockedNode, optionalNode, topoSort, wiredFramesFloor, MAX_FRAMES } from "./graph.mjs";
import { endpointOutPort } from "./endpoint.mjs";
import { CHARACTER_SLICE_DEFAULTS } from "./sprite-slices.mjs";
import { INPUT_SPECS, SETTING_SPECS } from "./io-specs.mjs";

export { INPUT_SPECS, SETTING_SPECS };

// Allocate the final key, not just a count of the unsuffixed name: an authored
// "Out 2" can otherwise collide with the suffix generated for a second "Out".
function uniqueKey(base, used, isReserved) {
  let key = base;
  for (let suffix = 2; used.has(key.toLowerCase()) || isReserved(key.toLowerCase()); suffix++) key = base + " " + suffix;
  used.add(key.toLowerCase());
  return key;
}

/* ============================== INPUTS ============================== */

export const MEDIA_INPUT_KINDS = new Set(["image", "audio", "video", "model3d", "inpaint"]);

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
      nodeId: n.id, field, label, kind, optional: !!optional || optionalNode(n),
      def: cur != null && String(cur) !== "" ? cur : specDef,
      title: displayName(n), _node: n,
    };
  };
  for (const n of graph.nodes) {
    if (n.unknown) continue;
    // fields.locked: the node's fields are fixed by the graph — never surfaced as inputs,
    // so runs use the stored values.
    if (lockedNode(n)) continue;
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
      const optional = s.optional || (n.type === "endpoint" && s.f === "prompt" && fed(n.id, "text"));
      entries.push(mk(n, s.f, s.label, s.kind, optional, s.def));
    }
  }
  // Friendly keys: a node's custom name labels its input when it contributes exactly one
  // REQUIRED input (app PR #138) — or exactly one input at all, so an author-optional
  // renamed node (e.g. an optional "Style reference" upload) keeps its name as the key.
  // Otherwise the generic spec label. Suffix collisions with other names or addresses.
  const byNode = new Map();
  for (const e of entries) {
    if (!byNode.has(e.nodeId)) byNode.set(e.nodeId, []);
    byNode.get(e.nodeId).push(e);
  }
  const reserved = new Map();
  const reserve = (address, owner) => {
    const key = address.trim().toLowerCase();
    reserved.set(key, reserved.has(key) && reserved.get(key) !== owner ? null : owner);
  };
  for (const e of entries) {
    reserve(`${e.nodeId}.${e.field}`, e);
    if (byNode.get(e.nodeId).length === 1) reserve(e.nodeId, e);
  }
  for (const { to } of graph.links) {
    if (to.node != null) reserve(`${to.node}.${to.port}`, null);
  }
  const used = new Set();
  for (const e of entries) {
    const nodeEntries = byNode.get(e.nodeId);
    const required = nodeEntries.filter((x) => !x.optional);
    const custom = (e._node.name || "").trim();
    const names = (required.length === 1 && required[0] === e) ||
                  (required.length === 0 && nodeEntries.length === 1);
    e.key = uniqueKey(custom && names ? custom : e.label, used, key => reserved.has(key) && reserved.get(key) !== e);
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
 * Order: derived key → nodeId.field / bare nodeId → node custom name → label/field if unique.
 */
export function resolveInputKey(graph, inputs, userKey) {
  const spelling = String(userKey).trim();
  const norm = spelling.toLowerCase();
  const byKey = inputs.filter((i) => i.key.toLowerCase() === norm);
  if (byKey.length === 1) return byKey[0];

  const dot = spelling.lastIndexOf(".");
  if (dot > 0) {
    const head = spelling.slice(0, dot);
    const field = spelling.slice(dot + 1).toLowerCase();
    const canonical = new Map(inputs.filter(i => `${i.nodeId}.${i.field}`.trim().toLowerCase() === norm)
      .map(i => [i.nodeId, i]));
    for (const { to } of graph.links) {
      if (to.node != null && `${to.node}.${to.port}`.trim().toLowerCase() === norm) {
        canonical.set(to.node, null);
      }
    }
    const addressed = canonical.has(head) ? [head] : [...canonical.keys()];
    if (addressed.length === 1) {
      const input = canonical.get(addressed[0]);
      if (input) return input;
      throw new NanoodleError(`"${userKey}" is wired from another node in this workflow and can't be supplied as an input`);
    }
    if (addressed.length > 1) {
      const keys = addressed.map(id => {
        const input = canonical.get(id);
        return input ? `${id}.${input.field}` : `${id}.${field} (wired)`;
      });
      throw new NanoodleError(`input "${userKey}" is ambiguous — matches ${keys.join(", ")}`);
    }
  }
  const byNode = inputs.filter(i => i.nodeId.trim().toLowerCase() === norm);
  const exact = byNode.filter(i => i.nodeId === spelling);
  const addressed = exact.length ? exact : byNode;
  if (addressed.length === 1) return addressed[0];
  if (addressed.length > 1) throw ambiguous(userKey, addressed);

  const named = graph.nodes.filter((n) => (n.name || "").trim().toLowerCase() === norm);
  if (named.length) {
    const cand = inputs.filter((i) => named.some((n) => n.id === i.nodeId));
    if (cand.length === 1) return cand[0];
    if (cand.length > 1) throw ambiguous(userKey, cand);
  }

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
  const used = new Set();
  return sinks.map((n) => {
    const aliases = new Set(sinks.filter(other => other.id !== n.id).map(other => other.id.toLowerCase()));
    const key = uniqueKey(displayName(n), used, key => aliases.has(key));
    const t = NODE_TYPES[n.type];
    let ports = t.outputs.map((p) => ({ ...p }));
    // vframes grows frame1..frameN from max(fields.frames, wired floor) (mirrors browser)
    if (n.type === "vframes") {
      const authored = Math.max(1, Math.min(MAX_FRAMES, parseInt(n.fields && n.fields.frames, 10) || 1));
      const count = Math.max(authored, wiredFramesFloor(graph, n.id));
      ports = [];
      for (let i = 1; i <= count; i++) ports.push({ name: "frame" + i, type: "image" });
    }
    // The authored endpoint route predicts the port before run-time wires or settings.
    if (n.type === "endpoint") ports = [endpointOutPort(n)];
    if (n.type === "render3d" && n.fields?.mode === "video") ports = [ports[1], ports[0]];
    return { key, nodeId: n.id, type: n.type, ports };
  });
}

/* ============================== SETTINGS ============================== */

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
    const preset = n.type === "slice-3d" && n.fields.preset === "character" ? CHARACTER_SLICE_DEFAULTS : {};
    for (const s of specs) {
      if (graph.links.some((l) => l.to.node === n.id && l.to.port === s.f)) continue; // wired knob is decided upstream
      const cur = n.fields[s.f];
      const fallback = s.kind === "number" && preset[s.f] != null ? String(preset[s.f]) : preset[s.f] ?? s.def;
      // vframes frames is shape-affecting — never offer a floor below the highest wired frameK
      const min = (n.type === "vframes" && s.f === "frames")
        ? Math.max(s.min || 1, wiredFramesFloor(graph, n.id))
        : s.min;
      out.push({
        key: `${n.id}.${s.f}`, nodeId: n.id, field: s.f, kind: s.kind, label: s.label,
        def: cur != null && String(cur) !== "" ? cur : fallback,
        ...(s.options ? { options: [...s.options] } : {}),
        ...(min != null ? { min } : {}),
        ...(s.max != null ? { max: s.max } : {}),
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
  const spelling = String(userKey).trim();
  const norm = spelling.toLowerCase();
  const dot = spelling.lastIndexOf(".");
  if (dot >= 0) {
    const spelledHead = spelling.slice(0, dot);
    const head = spelledHead.toLowerCase(), field = spelling.slice(dot + 1).toLowerCase();
    const wiredError = `setting "${userKey}": that field is wired from another node and can't be overridden`;
    const canonical = new Map(settings.filter((s) => s.key.toLowerCase() === norm).map((s) => [s.nodeId, s]));
    const wired = new Set();
    for (const { to } of graph.links) {
      if (to.port.toLowerCase() !== field) continue;
      wired.add(to.node);
      // A wire reserves the canonical address even when the settings list omits it.
      if (`${to.node}.${to.port}`.toLowerCase() === norm) canonical.set(to.node, null);
    }

    const addressed = canonical.has(spelledHead) ? [spelledHead] : [...canonical.keys()];
    if (addressed.length === 1) {
      const spec = canonical.get(addressed[0]);
      if (spec) return spec;
      throw new NanoodleError(wiredError);
    }
    if (addressed.length > 1) {
      const keys = addressed.map((id) => canonical.get(id)?.key ?? `${id}.${field} (wired)`);
      throw new NanoodleError(`setting "${userKey}" is ambiguous — matches ${keys.join(", ")}`);
    }

    const nodes = graph.nodes.filter((n) => displayName(n).toLowerCase() === head);
    const cand = settings.filter((s) => nodes.some((n) => n.id === s.nodeId) && s.field.toLowerCase() === field);
    if (cand.length === 1) return cand[0];
    if (cand.length > 1) {
      throw new NanoodleError(`setting "${userKey}" is ambiguous — matches ${cand.map((c) => c.key).join(", ")}`);
    }
    if (nodes.some((n) => wired.has(n.id))) throw new NanoodleError(wiredError);
  }

  const byField = settings.filter((s) => s.field.toLowerCase() === norm || s.label.toLowerCase() === norm);
  if (byField.length === 1) return byField[0];
  if (byField.length > 1) {
    throw new NanoodleError(`setting "${userKey}" is ambiguous — matches ${byField.map((c) => c.key).join(", ")}`);
  }

  const avail = settings.map((s) => s.key).join(", ") || "(none)";
  throw new NanoodleError(`unknown setting "${userKey}" — available settings: ${avail}`);
}
