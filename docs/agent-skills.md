# Turn a nanoodle workflow into a coding-agent skill

A [nanoodle](https://nanoodle.com) workflow you built visually can become a *skill*: a small
folder with a markdown playbook that tells a coding agent (Claude Code, Cursor, Grok, or any
agent that can read markdown and run a shell command) exactly how to execute your workflow.
The agent supplies the inputs, this package does the API calls, and the outputs land in a
directory the agent can hand back to the user.

No skill-building experience needed — the whole recipe is five steps.

## 1. Build and save your workflow

Design the workflow at [nanoodle.com](https://nanoodle.com) (it runs entirely in your browser
with your own NanoGPT key). When it works, press **💾 Save** — you get a
`noodle-graph.json` file. That file is the workflow; this package re-executes it as-is.

## 2. Name your nodes — names become the keys

In the editor, give a custom name to every node an agent will touch:

- A named **input** node (e.g. a text node named `Idea`) makes the run call read as
  `--input "Idea=..."`.
- A named **output** node (e.g. an image node named `Poster`) makes the result key `Poster`,
  and `--out` saves it as `Poster.<ext>` where `<ext>` is chosen from the media MIME type
  (e.g. `jpg`, `png`). Document that agents should use the path the CLI prints, not a
  hard-coded extension.

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

### Install for agents

**Manual (Claude Code and most agents):** place the directory at
`.claude/skills/<name>/` (project-level) or `~/.claude/skills/<name>/` (user-level). Other
agents only need the folder somewhere they can read `SKILL.md` and run commands
(`.agents/skills/`, `~/.grok/skills/`, etc.).

**Via the open skills CLI** (multi-agent install into `~/.agents/skills/` and vendor
symlinks):

```sh
npx skills add nanoodlecom/nanoodle-js@poster-generator -g -y
```

Replace `poster-generator` with your skill's frontmatter `name` when publishing your own
repo. The CLI discovers skills nested under `examples/` (or anywhere a `SKILL.md` lives).

### JavaScript vs Python skills

This repo's example skill is named `poster-generator`. The sibling
[nanoodle-py](https://github.com/nanoodlecom/nanoodle-py) package ships a skill with the **same
name** (same workflow, Python CLI). Installing both into the same agent skill root
**overwrites** — pick one runtime:

| Runtime | Install skill | Run command |
|---------|---------------|-------------|
| Node (this package) | `npx skills add nanoodlecom/nanoodle-js@poster-generator -g -y` | `npx nanoodle run …` |
| Python | `npx skills add nanoodlecom/nanoodle-py@poster-generator -g -y` | `python -m nanoodle run …` |

## 4. Inspect the workflow to see its real interface

`inspect` prints the inputs, outputs, and settings the engine derives from your file — no API
key needed, no network calls:

```sh
npx nanoodle inspect workflows/my-workflow.noodle-graph.json
```

Check that the input keys and output keys are the names you gave your nodes. If not, go back
to the editor, rename, re-save, replace the file. What `inspect` prints is exactly what your
SKILL.md should document — including optional inputs (e.g. an LLM `System prompt` field) and
`--set`table settings.

## 5. Write SKILL.md

The file has two parts:

- **YAML frontmatter** — `name`, plus a `description` that says *what the skill does* **and**
  *when an agent should use it*. Agents pick skills by description; "use when the user asks
  for X" is the load-bearing half.
- **Body** — everything the agent needs to run it without guessing:
  1. How to get the API key: prefer ambient `NANOGPT_API_KEY`; use `--env-file` only when
     needed. Precedence for this CLI: `--key` > `--env-file` > environment. Porting note:
     the Python CLI (`nanoodle-py`) differs — there an ambient environment variable wins
     over `--env-file`.
  2. The exact run command, with one `--input` per input key. Paths relative to the skill
     directory (or absolute).
  3. Where outputs land (`--out <dir>`, default `./noodle-out`): key + MIME-derived
     extension. Tell the agent to use `outputs.<OutputKey>` from the JSON summary the CLI
     prints to stdout, not a hard-coded `.png`.
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

The run needs a NanoGPT API key. Prefer `NANOGPT_API_KEY` already in the environment.
Otherwise pass `--env-file <path-to-.env>` (this CLI: `--env-file` overrides ambient env).

Never print the key.

## Run

npx nanoodle run <path-to-this-skill>/workflows/<file>.noodle-graph.json \
  --input "<InputKey>=<what to put here>" \
  --out <output-dir>

Add `--env-file …` only if the key is not in the environment. The CLI prints a JSON summary
(paths, costUsd, remainingBalance) to stdout; add `--json` to silence the stderr progress lines.

Inspect the interface anytime with:
npx nanoodle inspect <path-to-this-skill>/workflows/<file>.noodle-graph.json

## Outputs

- Media: `<output-dir>/<OutputKey>.<ext>` — extension follows MIME (jpg/png/…). Use the path
  printed on the `<OutputKey>:` line; do not hard-code `.png`.
- Text outputs are printed to stdout.

## Cost

Each run costs about $<amount> in NanoGPT credit (<which node(s) dominate the cost>).
```

## Worked example

See [`examples/agent-skill/poster-generator/`](../examples/agent-skill/poster-generator/) — a
complete skill (SKILL.md + workflow) that turns a one-line idea into a poster image. Its
workflow is the nanoodle starter graph with the text node named `Idea` and the image node
named `Poster`, so the command reads `--input "Idea=..."` and the result saves as
`Poster.<ext>` (path printed by the CLI).

Install that example for coding agents:

```sh
npx skills add nanoodlecom/nanoodle-js@poster-generator -g -y
```

Skills built this way work for Claude Code out of the box
(`.claude/skills/<name>/SKILL.md`) and for any other agent that can read a markdown playbook
and run a shell command — the playbook *is* the integration.
