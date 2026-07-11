# Turn a nanoodle workflow into a coding-agent skill

A [nanoodle](https://nanoodle.io) workflow you built visually can become a *skill*: a small
folder with a markdown playbook that tells a coding agent (Claude Code, or any agent that can
read markdown and run a shell command) exactly how to execute your workflow. The agent supplies
the inputs, this package does the API calls, and the outputs land in a directory the agent can
hand back to the user.

No skill-building experience needed — the whole recipe is five steps.

## 1. Build and save your workflow

Design the workflow at [nanoodle.io](https://nanoodle.io) (it runs entirely in your browser
with your own NanoGPT key). When it works, press **💾 Save** — you get a
`noodle-graph.json` file. That file is the workflow; this package re-executes it as-is.

## 2. Name your nodes — names become the keys

In the editor, give a custom name to every node an agent will touch:

- A named **input** node (e.g. a text node named `Idea`) makes the run call read as
  `--input "Idea=..."`.
- A named **output** node (e.g. an image node named `Poster`) makes the result key `Poster`,
  and `--out` saves it as `Poster.png`.

Unnamed nodes still work, but the derived keys are generic (`Text`, `Image`, `Image 2`…),
which makes the skill instructions ambiguous. Name them.

## 3. Put the file in your skill folder

A skill is just a directory:

```
my-skill/
├── SKILL.md                          # the playbook the agent reads
└── workflows/
    └── my-workflow.noodle-graph.json # your saved file
```

For Claude Code, place the directory at `.claude/skills/<name>/` (project-level) or
`~/.claude/skills/<name>/` (user-level). Other agents only need the folder somewhere they can
read `SKILL.md` and run commands.

## 4. Inspect the workflow to see its real interface

`inspect` prints the inputs, outputs, and settings the engine derives from your file — no API
key needed, no network calls:

```sh
npx nanoodle inspect workflows/my-workflow.noodle-graph.json
```

Check that the input keys and output keys are the names you gave your nodes. If not, go back
to the editor, rename, re-save, replace the file. What `inspect` prints is exactly what your
SKILL.md should document.

## 5. Write SKILL.md

The file has two parts:

- **YAML frontmatter** — `name`, plus a `description` that says *what the skill does* **and**
  *when an agent should use it*. Agents pick skills by description; "use when the user asks
  for X" is the load-bearing half.
- **Body** — everything the agent needs to run it without guessing:
  1. How to get the API key: `NANOGPT_API_KEY` from the environment, or a `.env` file passed
     with `--env-file` (precedence: `--key` > `--env-file` > environment).
  2. The exact run command, with one `--input` per input key.
  3. Where outputs land (`--out <dir>`) and what each output is.
  4. An honest per-run cost note — runs spend real NanoGPT credit, so the agent (and its
     user) should know roughly how much.

### Template

Copy, fill the `<angle-bracket>` slots, delete what doesn't apply:

```markdown
---
name: <skill-name>
description: <What it does in one clause>. Use when <the situations where an agent should reach for it>.
---

# <Skill title>

Runs the bundled nanoodle workflow `workflows/<file>.noodle-graph.json` against the NanoGPT
API. Requires Node.js >= 20 and the `nanoodle` npm package (`npx nanoodle` fetches it).

## API key

The run needs a NanoGPT API key. Use whichever is available:

- `NANOGPT_API_KEY` already set in the environment — just run the command.
- A `.env` file (e.g. this skill's directory or the project root) containing
  `NANOGPT_API_KEY=...` — add `--env-file <path-to-.env>` to the command.

Never print the key.

## Run

npx nanoodle run <path-to-this-skill>/workflows/<file>.noodle-graph.json \
  --input "<InputKey>=<what to put here>" \
  --env-file <path-to-.env> \
  --out <output-dir>

Inspect the interface anytime with:
npx nanoodle inspect <path-to-this-skill>/workflows/<file>.noodle-graph.json

## Outputs

- `<output-dir>/<OutputKey>.<ext>` — <what this artifact is>.
- Text outputs are printed to stdout.

## Cost

Each run costs about $<amount> in NanoGPT credit (<which node(s) dominate the cost>).
```

## Worked example

See [`examples/agent-skill/poster-generator/`](../examples/agent-skill/poster-generator/) — a
complete skill (SKILL.md + workflow) that turns a one-line idea into a poster image. Its
workflow is the nanoodle starter graph with the text node named `Idea` and the image node
named `Poster`, so the command reads `--input "Idea=..."` and the result saves as
`Poster.png`.

Skills built this way work for Claude Code out of the box
(`.claude/skills/<name>/SKILL.md`) and for any other agent that can read a markdown playbook
and run a shell command — the playbook *is* the integration.
