import { NanoodleError } from "./errors.mjs";

export function isBranchDecider(node) {
  return node.type === "decide" && node.fields?.branch === true;
}

const branchPort = (port) => port === "yes" || port === "no";

/**
 * Build per-run routing over a topologically ordered set of node IDs.
 * Explicit Yes/No wires control entry to a branch. Further downstream, any
 * active routed input opens a join. Ordinary dependencies never open a branch.
 */
export function planBranches(graph, order) {
  const deciders = new Map(graph.nodes.filter(n => n.type === "decide").map(n => [n.id, n]));
  const direct = new Set();
  for (const link of graph.links) {
    const source = deciders.get(link.from.node);
    if (!source || !branchPort(link.from.port)) continue;
    if (!isBranchDecider(source)) {
      throw new NanoodleError(`node ${source.id}: enable branching on Decide to wire ${link.from.port}`, { code: "decide-branch" });
    }
    direct.add(link);
  }
  if (!direct.size) return null;

  const inbound = new Map(order.map(id => [id, []]));
  for (const link of graph.links) inbound.get(link.to.node)?.push(link);
  const selectors = new Map();
  for (const id of order) {
    const links = inbound.get(id);
    const fromDeciders = links.filter(link => direct.has(link));
    const controls = fromDeciders.length ? fromDeciders : links.filter(link => selectors.has(link.from.node));
    if (controls.length) selectors.set(id, controls);
  }
  const skipped = new Set();
  return {
    isRouted: id => selectors.has(id),
    // Call after this node's upstreams have settled. A failed router is left
    // to the usual upstream-error handling, which must also prevent execution.
    activeLinks(id, outFor) {
      const closed = (link) => {
        if (skipped.has(link.from.node)) return true;
        if (!direct.has(link)) return false;
        const branch = outFor(link.from.node)?.decision?.branch;
        return branchPort(branch) && branch !== link.from.port;
      };
      const controls = selectors.get(id);
      if (controls?.every(closed)) {
        skipped.add(id);
        return null;
      }
      return inbound.get(id).filter(link => !closed(link));
    },
  };
}
