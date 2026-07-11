// Guards examples/agent-skill/poster-generator against engine renames: its SKILL.md
// documents `--input "Idea=..."` and a saved `Poster.png`, so the workflow file must
// keep deriving exactly those keys. Offline — no server, no run().
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Workflow } from "../src/index.mjs";

const workflowPath = fileURLToPath(new URL(
  "../examples/agent-skill/poster-generator/workflows/poster.noodle-graph.json",
  import.meta.url,
));

test("poster-generator example derives input \"Idea\" and output \"Poster\"", async () => {
  const wf = await Workflow.load(workflowPath, { apiKey: "unused" });
  assert.deepEqual(wf.inputs.filter((i) => !i.optional).map((i) => i.key), ["Idea"],
    "required input keys must match SKILL.md's --input flag");
  assert.deepEqual(wf.outputs.map((o) => o.key), ["Poster"],
    "output keys must match SKILL.md's documented Poster.png");
  assert.deepEqual(wf.warnings, []);
});
