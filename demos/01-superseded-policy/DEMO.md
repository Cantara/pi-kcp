# Demo 1 — The Superseded Policy

**Organ / verdict:** kcp-agent 13-gate planner · the **supersession** gate (#5).

## What it shows

A knowledge base carries two versions of the same refund policy. The 2024 unit
declares `temporal.superseded_by: refund-policy-2026-03`. When an agent plans a
refund task, the deterministic planner must **skip the stale policy — with a
written reason** — and select only the active March-2026 successor. Rerunning
produces a byte-identical plan (determinism).

This is the "stale knowledge can't leak into the plan" property: retirement is a
declared, audited gate, not a hope that the model noticed the date.

## Files

- `fixtures/knowledge.yaml` — the manifest (2024 unit + 2026-03 successor).
- `run.mjs` — runs the real `kcp-agent` CLI and asserts the outcome.

## Run it

```bash
cd demos
node 01-superseded-policy/run.mjs
```

Or the exact underlying tool commands:

```bash
# Human-readable gate trace
node node_modules/.bin/kcp-agent plan "what is the refund policy for a returned order" \
  --manifest 01-superseded-policy/fixtures/knowledge.yaml --as-of 2026-07-22 --trace

# Machine-readable governed plan (stable schema)
node node_modules/.bin/kcp-agent plan "what is the refund policy for a returned order" \
  --manifest 01-superseded-policy/fixtures/knowledge.yaml --as-of 2026-07-22 --json
```

> `--as-of 2026-07-22` is pinned so the plan is reproducible on any day.

## Step-by-step

1. **Plan the task with `--trace`.** The planner scores both units, then walks
   the 13-gate cascade. The 2024 unit passes `audience`, `not_for`, `temporal`,
   `deprecated`, then is **rejected at `supersession`**.
2. **Read the gate summary.** `supersession   1 passed, 1 rejected` — one of the
   two units was retired by the gate.
3. **Read the written reason.** The skipped unit reports
   `superseded by refund-policy-2026-03 (successor active)` — a specific,
   reviewable reason, not a silent drop.
4. **Inspect the JSON plan.** `selected` = `["refund-policy-2026-03"]`;
   `skipped` carries `{ id: "refund-policy-2024", reason: "superseded by …" }`.
5. **Rerun and diff.** The `--json` output is byte-identical across runs →
   deterministic, replayable governance.

## Expected governed output (real, captured)

```
Plan for: "what is the refund policy for a returned order"
  acme-policy v1.0.0 · kcp 0.26 · …/01-superseded-policy/fixtures/knowledge.yaml · as-of 2026-07-22

Load plan (1 unit):
  ● 1. refund-policy-2026-03 (score 22)  policies/refund-2026-03.md  free
     What is the ACME refund policy and how are customer refunds processed?
     why: intent matches 2 term(s); triggers match 3 term(s); id/path matches 2 term(s)

Skipped (1):
  · refund-policy-2024: superseded by refund-policy-2026-03 (successor active)

Gate summary:
  audience         2 passed
  not_for          2 passed
  temporal         2 passed
  deprecated       2 passed
  supersession     1 passed, 1 rejected
  relevance        1 passed
  …

○ refund-policy-2024 policies/refund-2024.md
  ✓ audience         role 'agent' in ["agent","human"]
  ✓ not_for          no not_for declarations
  ✓ temporal         active as-of 2026-07-22
  ✓ deprecated       not deprecated
  ✗ supersession     superseded by refund-policy-2026-03 (successor active)
```

JSON skip record:

```json
{
  "id": "refund-policy-2024",
  "reason": "superseded by refund-policy-2026-03 (successor active)"
}
```

Verdict:

```
  ✔ planner exited 0
  ✔ active successor selected
  ✔ superseded 2024 policy NOT selected
  ✔ 2024 policy skipped WITH a written reason
  ✔ plan is deterministic (byte-identical rerun)
✅ Demo 1 — Superseded Policy: ALL CHECKS GREEN
```
