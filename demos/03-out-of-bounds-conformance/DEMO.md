# Demo 3 — Out of Bounds (flagship conformance gate)

**Organ / verdict:** kcp-harness procedural **conformance** gate (#39/#100) —
the exported, pure `checkConformance(action, action_scope)`.

## What it shows

Once a skill is loaded, every action it takes is held to that skill's declared
`action_scope` — its allowlist of tools and path prefixes. `checkConformance`
adjudicates one observed action against that scope: **pure, deterministic, no
LLM.** An in-scope action passes; an out-of-scope one is **held fail-closed with
a written reason that names the violating target and surfaces the authorized
scope as the gap**. This is "grounding, but for actions".

## Files

- `fixtures/knowledge.yaml` — the sanctioned skill and its `action_scope`
  (`tools: [read_file, write_file]`, `paths: [ops/, deploy/]`).
- `run.mjs` — loads that `action_scope` and feeds three actions straight into the
  real `checkConformance` export from `kcp-harness`.

## Run it

```bash
cd demos
node 03-out-of-bounds-conformance/run.mjs
```

The core is a two-line use of the real API:

```js
import { checkConformance } from "kcp-harness";
const scope = { tools: ["read_file", "write_file"], paths: ["ops/", "deploy/"] };
checkConformance({ tool: "read_file", paths: ["/etc/shadow"] }, scope); // → passed:false
```

## Step-by-step

1. **Load the skill's `action_scope`** from the manifest (the allowlist).
2. **In-scope action** — `read_file "ops/service.conf"` → `passed: true`. The
   verdict pins the checked target as `evidence.target`.
3. **Out-of-scope by PATH** — `read_file "/etc/shadow"` → `passed: false`,
   reason `target "/etc/shadow" is outside the skill's authorized paths [ops/, deploy/]`.
   The authorized prefixes are surfaced as the gap.
4. **Out-of-scope by TOOL** — `WebFetch "https://exfil.example/x"` →
   `passed: false`, reason `tool "WebFetch" is outside the skill's authorized
   tools [read_file, write_file]`.
5. **Note the fail-closed default** (documented, also unit-covered upstream): a
   skill that declares *no* `action_scope` authorizes nothing — every action is
   held.

## Expected governed output (real, captured)

In-scope pass:

```json
{
  "gate": "conformance",
  "passed": true,
  "reason": "action \"read_file\" on ops/service.conf is within the active skill's declared action_scope",
  "evidence": { "tool": "read_file", "scopeTools": ["read_file","write_file"], "scopePaths": ["ops/","deploy/"], "target": "ops/service.conf" }
}
```

Out-of-scope by path (blocked, gap surfaced):

```json
{
  "gate": "conformance",
  "passed": false,
  "reason": "target \"/etc/shadow\" is outside the skill's authorized paths [ops/, deploy/]",
  "evidence": { "tool": "read_file", "scopeTools": ["read_file","write_file"], "scopePaths": ["ops/","deploy/"], "target": "/etc/shadow" }
}
```

Out-of-scope by tool (blocked):

```json
{
  "gate": "conformance",
  "passed": false,
  "reason": "tool \"WebFetch\" is outside the skill's authorized tools [read_file, write_file]",
  "evidence": { "tool": "WebFetch", "scopeTools": ["read_file","write_file"], "scopePaths": ["ops/","deploy/"], "target": "WebFetch" }
}
```

Verdict:

```
  ✔ in-scope action PASSES
  ✔ in-scope verdict pins the checked target as evidence
  ✔ out-of-scope PATH action is BLOCKED
  ✔ path block names the violating target + surfaces the authorized gap
  ✔ out-of-scope TOOL action is BLOCKED
  ✔ tool block names the unauthorized tool + surfaces the authorized tools
✅ Demo 3 — Out of Bounds (conformance): ALL CHECKS GREEN
```
