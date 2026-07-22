# Release notes

## Runtime-depth governance — 2026-07-22

This milestone turns `pi-kcp` from an ergonomics-and-recall adapter into the
**reference KCP runtime**: the layer that makes a KCP agent *defendable* by closing
the governance loop where the agent actually acts — inside the Pi turn, at the
`tool_call` boundary — not only in front of an MCP tool server.

Shipped on top of `0.2.0` as `#30` (issues `#26`–`#29`). No breaking changes to the
existing `/kcp` command surface; the new behavior is additive and on by default, but
scoped to skills — it never blocks a general tool call out of the box.

### What pi-kcp now is

Until now, KCP governance lived at **proxy-depth**: `kcp-harness` sits in front of an
agent's MCP tools, routes knowledge calls through the `kcp-agent` deterministic
planner, and emits compliance artifacts. That is airtight for anything the agent
reaches *through the proxy* — but a coding agent also reads files, runs shell, and
fetches URLs through its harness's own native tools, which never touch the MCP proxy.

`pi-kcp` closes that gap at **runtime-depth**. It observes Pi's own tool lifecycle,
learns which skill an action is being taken under, and adjudicates each native tool
call against that skill's declared authority using *the same deterministic decision
function the proxy uses*. The result: the agent can't read what its active skill was
never authorized to read, and every governed turn carries one correlation id that
ties recall, plan, messages, and conformance decisions together.

### New capabilities

- **Pi-native runtime observation.** New `turn_start` / `input` / `tool_call`
  subscriptions (`src/index.ts`). The extension mints a per-turn correlation id at
  `turn_start`, watches `input` for user-forced skills, and inspects every
  `tool_call` before it executes.
- **Skill-selection detection** (`src/skill-detection.ts`). Two entry points are
  recognized: the agent self-loading a skill (a `read` whose path ends in
  `SKILL.md`) and a user forcing one (`/skill:<name>`). Detected selections resolve
  to a real registered skill command name when one exists, otherwise to the
  path-derived name.
- **In-loop conformance enforcement** (`src/conformance.ts`,
  `src/harness-conformance.ts`). A typed `ConformanceChecker` seam is gated at the
  `tool_call` boundary. The default `HarnessConformanceChecker` resolves the active
  skill's `action_scope` and adjudicates the call with kcp-harness's pure, no-LLM
  `checkConformance` — the identical verdict the harness proxy produces, with the
  harness's own written reason (e.g. `target "/etc/passwd" is outside the skill's
  authorized paths [...]`). A non-conformant call is **blocked before it runs**.
- **Scoped by default, fail-closed under a skill.** Conformance bounds a *skill's*
  actions, so the default checker engages only when a skill is active. With **no
  skill active** an action is unscoped/general and **passes conformance** — it is
  still governed by the other gates + approval, which conformance does not replace.
  Once a **skill is active**, enforcement is fail-closed and consistent with the
  harness: an unresolvable scope or a scope that declares nothing → nothing is
  authorized and the action is held for review.
- **Strict opt-in (`requireActiveSkill`).** High-assurance autonomous agents that
  should only ever act within a declared skill can flip a single option to fail-close
  no-skill actions too. Off by default; settable per-embedder via
  `register(pi, { requireActiveSkill: true })` or per-project via
  `requireActiveSkill: true` in `.pi/kcp.json`. Enforcement can also be disabled
  entirely by injecting the exported `passThroughChecker`, or replaced with a custom
  checker via `register(pi, { conformanceChecker })`.
- **One correlation chain** (`src/correlation.ts`). Every governed turn is stamped
  with a W3C `traceparent` (version `00`, sampled). The same id is threaded onto
  kcp-memory recall (`?traceparent=`), kcp-agent plan invocations
  (`--correlation-id`), and published Pi messages (`details.correlationId`), so a
  reviewer can reconstruct a turn end to end.
- **The governed loop** (`src/governed-loop.ts`). A small, fully injectable
  orchestration unit that holds the turn's correlation context, remembers the active
  skill, runs the conformance check, and composes recall → plan → publish. All
  side-effecting dependencies are injected, so the loop is exercised in tests without
  live KCP services.

New pure/unit surfaces are covered by `tests/skill-detection.test.ts`,
`tests/correlation.test.ts`, `tests/conformance.test.ts`,
`tests/harness-conformance.test.ts`, and `tests/register-wiring.test.ts` (including an
end-to-end `register()` path that fail-closes an out-of-scope read against a real
`knowledge.yaml`).

### Proxy-depth and runtime-depth, together

| | Proxy-depth (`kcp-harness`) | Runtime-depth (`pi-kcp`) |
|---|---|---|
| Where it sits | In front of the agent's MCP tools | Inside the Pi turn, at `tool_call` |
| What it governs | Knowledge calls made *through the proxy* | The agent's *native* read / bash / fetch |
| Decision function | `checkConformance` (planner's 14 gates behind it: the 13-gate knowledge cascade **plus** the `skill_eligibility` gate) | The **same** `checkConformance` |
| Compliance output | Audit log, decision traces, exports | Correlated block reasons, same `traceparent` |
| Trust posture | Fail-closed | Fail-closed once a skill is active; strict `requireActiveSkill` fail-closes with no skill |

The two are complementary, not redundant: the proxy governs the MCP surface, the
runtime governs everything the agent does without the proxy, and one correlation
scheme spans both.

### KCP family versions

| Component | Version | Role in this milestone |
|---|---|---|
| `pi-kcp` | this release (on `0.2.0`) | Runtime-depth governance for Pi |
| `kcp-harness` | `0.8.0` (dependency) | `checkConformance`, `ActionScope`, `extractTargets`; proxy-depth audit + SOC 2 / ISO 27001 / ISO 42001 / EU AI Act export |
| `kcp-agent` | `0.16.0` (CLI) | Deterministic planner — gate cascade incl. `skill_eligibility`, grounding, confidence gate (`assess`) |
| `kcp-memory` | `0.33.0` (HTTP) | Episodic recall + memory governance |
| Pi | `@earendil-works/pi-coding-agent` `^0.80.6` | Host harness (tool lifecycle, skill commands) |
| KCP spec | procedural plane / runtime contract | The `kind: skill` + `action_scope` contract this runtime enforces |

### Known limitations

- **`action_scope` is read from `knowledge.yaml` directly.** kcp-agent `0.16.0`
  does not yet surface a planned unit's `action_scope` in its `plan --json` output
  (neither `PlannedUnit` nor `UnitTrace` carries it), so `ManifestScopeResolver`
  reads the field straight from the project manifest — the same field the harness
  governor reads. When kcp-agent begins emitting `action_scope` in plan JSON
  (tracked upstream as **kcp-agent#102**), a CLI-backed resolver can replace the
  direct read behind the unchanged `ScopeResolver` interface.
- **Skill selection is heuristic (read-sniff).** Agent skill loads are inferred from
  a `read` of a `SKILL.md` path; forced skills from a `/skill:<name>` input line.
  There is no first-class "skill activated" event from Pi yet, so a skill loaded by
  means other than these two paths is not observed.
- **No runtime audit emission yet.** `pi-kcp` enforces and correlates in-loop, but
  does not itself write to the harness append-only audit log; full compliance
  artifacts are still produced by the `kcp-harness` proxy over its own audit trail.
  Runtime-depth audit emission, fleet-wide correlation, and deeper kcp-memory
  governance integration are the next roadmap items.

### Upgrade notes

- Enforcement is **on by default, but scoped to skills**. It does **not** block
  general tool calls out of the box: in a session where no skill is active, native
  tool calls pass conformance and defer to the other gates + approval. Once a skill
  is active, calls outside its `action_scope` are held (fail-closed) — load or force
  a skill whose scope authorizes the work, or inject `passThroughChecker` to opt out.
- For high-assurance autonomous agents that should only ever act within a declared
  skill, set `requireActiveSkill: true` (via `register(pi, { requireActiveSkill:
  true })` or `.pi/kcp.json`) to restore fail-closed-when-no-skill behavior.
- Ensure `.pi/settings.json` has `enableSkillCommands: true` so `/skill:<name>` and
  skill command resolution work.
- No configuration migration is required. `.pi/kcp.json` gains one optional field,
  `requireActiveSkill` (boolean, default `false`); existing files remain valid.
