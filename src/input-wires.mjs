import { isBranchDecider } from "./branches.mjs";

export const COMPETING_INPUT_WIRES = "competing-input-wires";

/** One logical input can receive one value. Repeated copies of a wire share a supplier. */
export function competingInputIssues(links) {
  const inputs = new Map();
  for (const { from, to } of links) {
    const inputKey = JSON.stringify([to.node, to.port]);
    if (!inputs.has(inputKey)) inputs.set(inputKey, { to, sources: new Set() });
    inputs.get(inputKey).sources.add(`${from.node}.${from.port}`);
  }
  const issues = [];
  for (const { to, sources } of inputs.values()) {
    if (sources.size < 2) continue;
    const suppliers = [...sources].sort().join(", ");
    issues.push(`input ${to.node}.${to.port} has competing wires from ${suppliers}. Leave one active wire for this input.`);
  }
  return issues.sort();
}

function canOmitOutput(node, port) {
  if (node.type === "endpoint" || node.type === "render3d" || node.type === "vframes") return true;
  if (node.type === "sprite-stack-render") return port === "video";
  return port === "layers" && (node.type === "edit" || node.type === "inpaint");
}

/** Defer to the run when an upstream output or the consumer can be inactive. */
export function staticCompetingInputIssues(graph, order, branches, fieldsFor = node => node.fields) {
  const inbound = new Map(order.map(node => [node.id, []]));
  const byId = new Map(order.map(node => [node.id, node]));
  for (const link of graph.links) inbound.get(link.to.node)?.push(link);

  const mayGate = new Set();
  const steady = [];
  for (const node of order) {
    const links = inbound.get(node.id);
    if (links.some(link => mayGate.has(link.from.node))) {
      mayGate.add(node.id);
      continue;
    }
    if (node.type === "decide" && !isBranchDecider(node)) {
      const fields = fieldsFor(node);
      const canEnable = fields.gate === true || fields.gate === "true" || links.some(link => link.to.port === "gate");
      const canBeYesNo = fields.mode === "yesno" || links.some(link => link.to.port === "mode");
      if (canEnable && canBeYesNo) mayGate.add(node.id);
    }
    if (branches?.isRouted(node.id)) continue;
    for (const link of links) {
      const supplier = byId.get(link.from.node);
      if (!supplier || supplier.unknown || fieldsFor(supplier).onError === "skip" || canOmitOutput(supplier, link.from.port)) continue;
      steady.push(link);
    }
  }
  return competingInputIssues(steady);
}
