# Demo 10 — Two Depths, One Verdict

**Organ / verdict:** the **same** `checkConformance` adjudicator, reached at two
different depths of the stack, producing an **identical** verdict + reason.

## What it shows

The same out-of-scope action — `read_file "secrets/master.key"` under a skill
scoped to `paths:[ops/]` — is caught by the **same** deterministic adjudicator at
two depths:

- **(a) Proxy depth** — driven through the real `kcp-harness serve` MCP proxy (as
  demo 5). The proxy resolves the skill's `action_scope` and adjudicates with
  `checkConformance`.
- **(b) Runtime depth** — pi-kcp's real `HarnessConformanceChecker` (the seam its
  Pi extension wires at the `tool_call` boundary) resolves the **same** skill's
  `action_scope` from the **same** manifest and calls the **same** pure
  `checkConformance`.

The two depths return a **byte-identical** `passed` and `reason`. Governance
verdicts do not depend on *where* in the stack the action is observed.

## Note on the `pi` binary

pi-kcp's in-loop Pi hook needs the `pi` binary, which isn't installed here, so we
exercise the shared adjudicator **programmatically** rather than in a full Pi
session — the equivalence is the point. The runtime-depth leg runs pi-kcp's
**real** `src/harness-conformance.ts`, transpiled on demand with `bun` (its only
non-type imports, `kcp-harness` + `js-yaml`, are kept external and resolved from
`demos/node_modules`; the `@earendil-works/pi-coding-agent` imports are type-only
and stripped). If `bun` is absent, the leg falls back to the same shared
`checkConformance` adjudicator the wrapper delegates to, clearly labelled.

## Files

- `fixtures/knowledge.yaml` — one skill (`deploy-skill`, scope `paths:[ops/]`).
- `fixtures/harness.yaml` — the proxy config for the proxy-depth leg.
- `run.mjs` — drives the action through the proxy, then through pi-kcp's real
  checker, and asserts the two verdicts are identical. Reuses demo 5's
  `downstream-server.mjs`.

## Run it

```bash
cd demos
node 10-two-depths-one-verdict/run.mjs
```

## Expected governed output (real, captured)

```
(a) PROXY DEPTH — spawning: kcp-harness serve --config <config>
  proxy tool result: ⛔ HELD — [kcp-harness] CONFORMANCE BLOCKED: target "secrets/master.key" is outside the skill's authorized paths [ops/]
```

```json
// Proxy-depth conformance verdict (from the audit log)
{ "skillId": "deploy-skill", "passed": false,
  "reason": "target \"secrets/master.key\" is outside the skill's authorized paths [ops/]",
  "tool": "read_file", "target": "secrets/master.key", "ticketId": "…" }
```

```
(b) RUNTIME DEPTH — pi-kcp HarnessConformanceChecker over the SAME action + manifest
  ran via: REAL pi-kcp HarnessConformanceChecker (transpiled from src/harness-conformance.ts)
```

```json
// Runtime-depth conformance verdict
{ "passed": false, "reason": "target \"secrets/master.key\" is outside the skill's authorized paths [ops/]" }
```

Verdict block:

```
  ✔ proxy depth BLOCKED the out-of-scope action in-loop
  ✔ proxy depth emitted a conformance verdict (passed:false)
  ✔ runtime depth also holds the action (passed:false)
  ✔ SAME passed verdict at both depths
  ✔ SAME written reason at both depths (identical adjudication)
  ✔ the shared reason names the violating target + the authorized scope
✅ Demo 10 — Two Depths, One Verdict: ALL CHECKS GREEN
```
