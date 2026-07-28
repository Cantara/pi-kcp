# pi-kcp user guide

`pi-kcp` makes a Pi coding agent **defendable**. It gives the agent KCP memory and
deterministic knowledge plans through a small `/kcp` command surface, and — new in
the runtime-depth milestone — it governs what the agent actually does: it learns
which skill an action is being taken under and blocks any native tool call that falls
outside that skill's declared authority, using the same deterministic decision the
`kcp-harness` proxy makes. Every governed turn carries one correlation id, so you can
reconstruct exactly why the agent read what it read.

This guide is task-oriented. Copy-paste the commands and YAML and adjust paths.

## Prerequisites

- **Pi** (`@earendil-works/pi-coding-agent`, `>= 0.80.6`) and **Node `>= 20`** (Bun
  for local dev).
- The KCP tools this extension talks to, as needed:
  - **kcp-agent** CLI (`0.16.0`) — for `/kcp plan`, `/kcp validate`, `/kcp init`.
  - **kcp-memory** HTTP daemon (`0.33.0`) — for episodic recall.
  - **kcp-harness** (`0.10.1`) — a dependency; provides the conformance decision
    function and the compliance export/audit tooling.
- A project **`knowledge.yaml`** manifest (create one with `/kcp init`).

Stock Pi ships without an MCP client, and `pi-kcp` does **not** require one: the
`/kcp` commands, automatic recall, and runtime governance all work on stock Pi. MCP
is only needed for optional model-facing KCP / code-intelligence queries.

## Install (development)

```bash
bun install
bun run build
bun run smoke          # verifies /kcp registers on both source and built extension
pi -e ./dist/src/index.js
```

For a fast source reload while iterating:

```bash
pi -e ./src/index.ts
```

## Quick start: the `/kcp` commands

```text
/kcp help                 Show the command list
/kcp health               Check configuration, kcp-memory, and kcp-agent discovery
/kcp recall <query>       Add episodic memory to the next turn
/kcp plan <intent>        Add a deterministic knowledge plan to the next turn
/kcp validate             Validate the project's knowledge.yaml
/kcp init                 Create knowledge.yaml (won't overwrite an existing file)
```

Start with:

```text
/kcp health
```

It reports whether your `.pi/kcp.json` is valid, whether the kcp-memory daemon is
reachable, and where (if anywhere) the kcp-agent CLI was found. `/kcp recall` and
`/kcp plan` don't answer inline — they place their result into the **next** Pi turn as
a context message, so the model sees it. Plans are requested from kcp-agent with
`--json` and rejected if the response isn't structured JSON.

## Declaring governed knowledge and skills

Governance is driven entirely by your `knowledge.yaml`. A **skill** is a unit with
`kind: skill` and an `action_scope` — the tools, paths, and capabilities that skill is
permitted to touch. That scope is exactly what the runtime enforces.

```yaml
kcp_version: "0.29"
project: my-app
version: 1.0.0
language: en

units:
  # A normal knowledge unit (documentation the planner may load).
  - id: architecture
    path: docs/architecture.md
    intent: "How the service is structured and deployed."
    scope: project
    audience: [agent, developer]
    triggers: [architecture, deploy, layout]

  # A governed skill: kind: skill + action_scope defines its authority.
  - id: deploy
    path: .pi/skills/deploy/SKILL.md
    intent: "Deploy the service to staging."
    scope: project
    audience: [agent]
    triggers: [deploy, release, ship]
    kind: skill
    action_scope:
      tools: [read, bash]                 # only these tools are authorized
      paths: [src/deploy, scripts/deploy.sh]  # only these paths/prefixes
      capabilities: [deploy]              # optional capability allowlist
```

Notes on `action_scope`:

- Each declared dimension is an **allowlist**. If `tools` is declared, the action's
  tool must be a member. If `paths` is declared, every path (or URL prefix) the action
  reaches must sit under an authorized prefix. If `capabilities` is declared and the
  action asserts one, it must be listed.
- A dimension you **don't** declare does not constrain that facet.
- A scope that declares **nothing** authorizes nothing — every action under that skill
  is held (fail-closed).

Authoring conventions for skill units — what a *good* `kind: skill` + `action_scope`
looks like, an SK001–SK008 linter, conformance vectors with expected verdicts, and a
curated library of governed playbooks — live in
[Cantara/kcp-skill](https://github.com/Cantara/kcp-skill). Lint your manifest's skill
units with `npx kcp-skill-lint knowledge.yaml`; the `vectors/` there are the canonical
fixtures for testing any producer or consumer of skill units, including this
extension's conformance seam.

Validate it before relying on it:

```text
/kcp validate
```

## How governance works, turn by turn

For each turn, the extension runs this loop:

1. **`turn_start` — correlate.** A fresh W3C `traceparent` correlation id is minted for
   the turn.
2. **`input` — recall + forced skill.** If the prompt uses clearly temporal/retrospective
   language (e.g. *"what did we decide last week?"*) and the kcp-memory daemon is
   reachable, an **Episodic Memory** block is prepended to the prompt. Recall is
   **fail-open**: if memory is down or slow, the prompt is sent unchanged. A
   `/skill:<name>` line here forces that skill for the turn.
3. **Skill gating.** When the agent loads a skill by reading its `SKILL.md`, that read
   is recognized and the skill becomes *active* for the turn.
4. **Conformance block.** Every native `tool_call` is checked before it runs. When a
   skill is active, the call is mapped to a harness action (its tool name, plus `path`
   / `file_path` / `url` targets), the active skill's `action_scope` is resolved from
   `knowledge.yaml`, and kcp-harness's deterministic `checkConformance` adjudicates.
   Out of scope → the call is **blocked** with the harness's written reason. **No
   active skill → conformance is not applicable and the call passes through** to the
   other gates + approval (conformance bounds a *skill's* actions; it does not govern
   general, unscoped ones). Strict mode (`requireActiveSkill`) instead fail-closes a
   no-skill call — see Configuration.
5. **Approval / evidence.** The correlation id is stamped on recall lookups and every
   published message (including the plan result), so the turn's recall → plan → skill →
   decision chain shares one id.

A blocked call looks like this to the agent:

```text
target "/etc/passwd" is outside the skill's authorized paths [src/deploy, scripts/deploy.sh]
```

> **Scoped by default, not blanket-blocking.** Enforcement is on by default but bounds
> a *skill's* actions — it does **not** block general tool calls when no skill is
> active; those pass conformance and defer to the other gates + approval. Once a skill
> is active, calls outside its `action_scope` are held (fail-closed). For agents that
> should only ever act within a declared skill, set `requireActiveSkill: true` to
> fail-close no-skill calls too (see Configuration).

## Configuration

### `.pi/kcp.json` (optional)

All fields are optional; conservative defaults apply. Invalid configuration disables
automatic behavior and is reported by `/kcp health`.

```json
{
  "enabled": true,
  "autoRecall": true,
  "memoryUrl": "http://localhost:7735",
  "maxResults": 3,
  "timeoutMs": 400,
  "manifest": "knowledge.yaml",
  "requireActiveSkill": false,
  "agentCli": "/path/to/kcp-agent/dist/cli.js"
}
```

- `memoryUrl` — the kcp-memory HTTP daemon (default `http://localhost:7735`).
- `maxResults` — recall result cap (1–10, default 3).
- `timeoutMs` — recall network timeout (50–5000 ms, default 400).
- `manifest` — manifest filename (default `knowledge.yaml`).
- `requireActiveSkill` — strict conformance mode (default `false`). When `true`, tool
  calls taken with **no active skill** are fail-closed instead of passing through to
  the other gates. Use it for high-assurance autonomous agents that should only ever
  act within a declared skill's `action_scope`.
- `agentCli` — explicit kcp-agent CLI path or command. Discovery also checks
  `KCP_AGENT_CLI`, known Homebrew/npm install locations, and `kcp-agent` on `PATH`.

### `.pi/settings.json`

Enable skill commands so `/skill:<name>` and skill-name resolution work:

```json
{
  "enableSkillCommands": true
}
```

### Injecting or disabling the conformance checker

The default checker is the `HarnessConformanceChecker` — scoped to skills, fail-closed
once a skill is active. When you embed the extension programmatically you can tune or
swap it:

```ts
import register, { passThroughChecker } from "@cantara/pi-kcp";

// Strict mode: fail-close tool calls taken with no active skill too.
// (Equivalent to "requireActiveSkill": true in .pi/kcp.json; the option here pins it.)
register(pi, { requireActiveSkill: true });

// Disable enforcement (allow-all):
register(pi, { conformanceChecker: passThroughChecker });

// Or wire a custom ConformanceChecker implementation:
register(pi, { conformanceChecker: myChecker });
```

`requireActiveSkill` passed to `register` takes precedence and is fixed for the
session; when omitted, the built-in checker reads `requireActiveSkill` from
`.pi/kcp.json` at each turn. It has no effect when a custom `conformanceChecker` is
injected.

### Optional MCP providers

If you want model-facing KCP or code-intelligence tools, configure them as lazy Pi MCP
servers in `.pi/mcp.json` (requires an MCP client extension such as
`pi install npm:pi-mcp-adapter`). See `docs/mcp-providers.md`.

## Reading the evidence

**In-session.** Recall, plan, and validation results are published as Pi messages, and
governed messages carry the turn's correlation id in `details.correlationId`. A blocked
tool call surfaces the harness's specific reason (which target/tool/capability failed),
so you can see *why* an action was held.

**The correlation chain.** One `traceparent` per turn is threaded to kcp-memory
(`?traceparent=`) and onto published messages — including the plan result, so the id
still lines up a turn's recall lookup, its knowledge plan, and its conformance
decisions. It is not passed to the kcp-agent CLI: no released kcp-agent accepts
`--correlation-id`, and its parser fail-closes on unknown options (see
Cantara/kcp-agent#114 for the upstream proposal).

**Compliance artifacts.** Formal export is produced by the `kcp-harness` proxy over its
append-only audit log. `pi-kcp` shares the harness's decision function and correlation
scheme, so runtime-depth decisions line up with proxy-depth audit. To export:

```bash
# SOC 2 Type II, ISO 27001, ISO/IEC 42001, EU AI Act, or all:
kcp-harness export --format soc2      --out evidence
kcp-harness export --format iso27001  --out evidence
kcp-harness export --format iso42001  --out evidence
kcp-harness export --format euaiact   --out evidence
kcp-harness export --format both      --out evidence   # SOC 2 + ISO 27001

# Live decision dashboard over the audit log:
kcp-harness dashboard --port 3847
```

> Runtime-depth audit emission from `pi-kcp` itself is on the roadmap; today the
> compliance export reads the harness proxy's audit trail.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Every tool call is blocked / "no active skill … held (requireActiveSkill)" | Strict mode is on (`requireActiveSkill: true`). This only happens in strict mode — the default lets no-skill calls through. Load or force a skill whose `action_scope` covers the work, set `requireActiveSkill: false`, or inject `passThroughChecker`. |
| "outside the skill's authorized paths/tools/capabilities" | The action left the active skill's `action_scope`. Widen the scope in `knowledge.yaml` (and `/kcp validate`) or take a different action. |
| `/kcp plan` returns "invalid --json output" or a schema error | kcp-agent version mismatch. Update `pi-kcp` or pin a compatible `kcp-agent`; this extension understands plan `schemaVersion` 1. |
| `/kcp health` shows `kcp-agent: unavailable` | Set `agentCli` in `.pi/kcp.json`, set `KCP_AGENT_CLI`, or install the `kcp-agent` executable on `PATH`. |
| `/kcp health` shows `kcp-memory: unavailable` | The recall daemon isn't reachable at `memoryUrl`. Recall is fail-open, so prompts still work; start the daemon to enable episodic recall. |
| Automatic recall never fires | It only triggers on clearly temporal/retrospective wording, and only with `autoRecall: true` and a reachable daemon. Use `/kcp recall <query>` to force it. |
| "Invalid .pi/kcp.json" | Run `/kcp health` for the specific validation error; invalid config fails closed for automatic recall. |
| `/skill:<name>` not recognized | Set `enableSkillCommands: true` in `.pi/settings.json`. |
| `/kcp init` refuses to run | It won't overwrite an existing `knowledge.yaml`, and only creates the default filename. |

## Where to go next

- `README.md` — project overview and design lanes.
- `docs/architecture.md` — how Pi, kcp-memory, kcp-agent, MCP, and code-intelligence
  providers are separated.
- `RELEASE.md` — the runtime-depth governance milestone in detail.
- `AGENTS.md` — invariants and development workflow.
