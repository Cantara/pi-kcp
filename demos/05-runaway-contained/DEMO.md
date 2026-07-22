# Demo 5 — AUTONOMOUS: "The Runaway, Contained" (OpenClaw territory)

**Organ / verdict:** the real **kcp-harness MCP proxy** (`kcp-harness serve`) ·
**skill_eligibility** (load) + **conformance** gate (#39) enforced **in-loop**,
with a **pending human-approval ticket**.

## What it shows

A scripted, deterministic autonomous agent issues a **sequence** of tool calls
**through the real kcp-harness MCP proxy**. We spawn `kcp-harness serve` and act
as an MCP client over stdio; the proxy front-runs a real downstream MCP tool
server (`downstream-server.mjs`, filesystem tools over a sandbox). The agent
loads one sanctioned skill (scoped to `ops/`), does in-scope work, then **mid-run
attempts an out-of-scope read** (`secrets/master.key`). The proxy **blocks it
in-loop and opens a pending approval ticket**; the run continues; the whole run
reconstructs as one audited trail. This is the point autonomy critics miss:
governance is enforced **on every step of the loop**, not once at the start.

The agent is deterministic (no LLM). The governance is 100% the published tool.

## Files

- `fixtures/harness.yaml` — the real harness config (governed domain, skill tool,
  approval store). `run.mjs` renders absolute paths into a temp copy.
- `fixtures/knowledge.yaml` — the KCP manifest: the `deploy-skill` (scoped to
  `ops/`) plus the `ops/*` document units the governor's auto-plan approves
  in-scope file actions against.
- `downstream-server.mjs` — a real downstream MCP server (stdio JSON-RPC) with
  `read_file` / `write_file` / `Skill`. The proxy spawns and polices it.
- `run.mjs` — the autonomous agent + MCP client + verdict.

## Run it

```bash
cd demos
node 05-runaway-contained/run.mjs
```

A human can also drive the same proxy directly:

```bash
cd demos/05-runaway-contained/fixtures
# (edit the __TOKENS__ to real paths, or let run.mjs render them) then:
node ../../node_modules/.bin/kcp-harness serve --config harness.yaml
# …and speak MCP JSON-RPC on stdin. Inspect held tickets with:
node ../../node_modules/.bin/kcp-harness approvals list --config harness.yaml
```

## The governance shape (why two gates, not one)

- The domain **classifies** both `ops/` and `secrets/` as governed.
- The loaded skill's **`action_scope` is tighter**: `ops/` only.
- So `secrets/master.key` is a *governed* path the *skill is not scoped for* —
  exactly what the **conformance** gate catches. It fires **before** plan
  governance (Step 1b of the proxy pipeline) and holds the call fail-closed.

## Step-by-step

1. **Spawn the proxy:** `kcp-harness serve --config <rendered harness.yaml>`.
2. **MCP handshake:** `initialize` → `notifications/initialized` → `tools/list`.
   The governed surface includes `read_file`, `write_file`, `Skill`, plus the
   harness/KCP tools.
3. **Step 1 — load skill:** `Skill { skill: "deploy-skill" }` → passes
   `skill_eligibility`; the proxy records the active skill's `action_scope`.
4. **Step 2 — in-scope read:** `read_file "ops/service.conf"` → conformance
   passes, auto-plan approves → real content returned from the downstream.
5. **Step 3 — in-scope write:** `write_file "ops/release.log"` → allowed.
6. **Step 4 — OUT-OF-SCOPE read:** `read_file "secrets/master.key"` → the proxy
   returns `[kcp-harness] CONFORMANCE BLOCKED: target "secrets/master.key" is
   outside the skill's authorized paths [ops/]`. **The call never reaches the
   downstream** and a `pending_review` ticket is opened.
7. **Step 5 — resume:** `write_file "ops/complete.flag"` → allowed. The run
   proceeds past the hold.
8. **Reconstruct** the whole run from the append-only audit log and read the
   held ticket from the file-backed approval store.

> Ticket UUIDs, timestamps, and the temp workdir path vary per run. The run
> below is one real capture.

## Expected governed output (real, captured)

```
proxy: kcp-harness v0.1.0
governed tool surface: harness_status, harness_session, harness_budget, harness_temporal_check, harness_approvals, harness_assess, kcp_plan, kcp_load, kcp_trace, kcp_validate, kcp_replay, read_file, write_file, Skill

Autonomous run (each step is a real MCP tools/call through the proxy):
  ✅ ALLOW  load skill               → [downstream] skill "deploy-skill" loaded
  ✅ ALLOW  in-scope read            → replicas=3 region=eu-north-1
  ✅ ALLOW  in-scope write           → [downstream] wrote ops/release.log
  ⛔ HELD   OUT-OF-SCOPE read        → [kcp-harness] CONFORMANCE BLOCKED: target "secrets/master.key" is outside the skill's authorized paths [ops/]
  ✅ ALLOW  in-scope write (resume)  → [downstream] wrote ops/complete.flag

Audit trail (append-only JSONL, one line per governed event):
  # 1 session_start        approved     session_start
  # 3 skill_loaded         approved     kind: skill with explicit eligibility grant
  # 2 tool_call            approved     Skill
  # 5 conformance_verdict  approved     action "read_file" on ops/service.conf is within the active skill's declared action_scope
  # 4 tool_call            approved     read_file
  # 7 conformance_verdict  approved     action "write_file" on ops/release.log is within the active skill's declared action_scope
  # 6 tool_call            approved     write_file
  # 9 approval_requested   blocked      approval_requested
  #10 conformance_verdict  blocked      target "secrets/master.key" is outside the skill's authorized paths [ops/]
  #12 conformance_verdict  approved     action "write_file" on ops/complete.flag is within the active skill's declared action_scope
  #11 tool_call            approved     write_file
  #13 session_end          approved     session_end
```

The held runaway action, waiting for a human:

```json
{
  "id": "a2cee526-026f-4c0d-9bc7-76c9ac3c09f1",
  "state": "pending_review",
  "tool": "read_file",
  "target": "secrets/master.key",
  "requiredRole": "governance-reviewer",
  "reason": "target \"secrets/master.key\" is outside the skill's authorized paths [ops/]",
  "conformanceVerdict": "conformance"
}
```

Verdict:

```
  ✔ proxy started and listed a governed tool surface
  ✔ skill loaded (in-scope steps allowed)
  ✔ out-of-scope action BLOCKED in-loop
  ✔ block carries the conformance reason (names the violating target)
  ✔ run PROCEEDS after the hold (next in-scope step allowed)
  ✔ exactly one pending ticket opened for the held action
  ✔ ticket targets the out-of-scope resource, pinning the failed verdict as evidence
  ✔ run reconstructs as an audited chain (skill_loaded + conformance verdicts present)
✅ Demo 5 — The Runaway, Contained: ALL CHECKS GREEN
```

## Note (harness API observation)

The conformance hold's ticket takes its `requiredRole` and `policyRef` from
`governance.confidence.route_to_role` / `policy_ref` if that block is present;
without it the hold uses the default reviewer role `governance-reviewer` and no
`policyRef` (the failed conformance verdict itself is still pinned as ticket
evidence). A dedicated `governance.conformance.route_to_role` would let a
conformance policy citation be attached without borrowing the confidence block.
