# Demo 11 — The Budgeted Researcher (the money_budget gate)

**Organ / verdict:** the real **kcp-agent** planner — the `money_budget` gate
(gate 13 of 13) — the first of the **commerce** batch (governed value transfer, #139).

## What it shows

A researcher agent plans over a corpus where some knowledge sources are **free**
and some are **pay-per-request** (x402, `payment.methods:[{type:x402,
price_per_request, currency}]`). Given a hard spend ceiling (`--budget 5 USDC`),
the deterministic `money_budget` gate charges each selected paid unit against the
ceiling and **skips the one that would overspend**, with the exact arithmetic:

```
over budget: 4 would exceed remaining 2 of 5 USDC
```

A cheaper paid source further down the list **still fits** — proving the gate is
a greedy, explainable walk, not a hard cliff. No LLM, no network: the planner
binary is real and the plan is byte-stable across reruns.

## Files

- `fixtures/knowledge.yaml` — one free source + three x402-paid sources (3, 4, 2 USDC).
- `run.mjs` — drives `kcp-agent plan … --budget 5 --currency USDC --json` (+ `--trace`).

## Run it

```bash
cd demos
node 11-budgeted-researcher/run.mjs
```

## Expected governed output (real, captured)

```
planner: kcp-agent plan … --budget 5 USDC --json

Selected sources (loaded within budget):
  ✅ premium-adoption-report     [3 USDC/request]
  ✅ free-market-primer          [free]
  ✅ paid-vendor-brief           [2 USDC/request]

Skipped sources (held by a gate):
  ⛔ premium-forecast-report     over budget: 4 would exceed remaining 2 of 5 USDC
```

```json
{
  "ceiling": 5,
  "currency": "USDC",
  "projectedSpend": 5,
  "remaining": 0,
  "note": "projected spend 5 of 5 USDC; 0 remaining."
}
```

The `money_budget` gate verdict for the skipped unit (from `--trace --json`):

```json
{
  "rejectedBy": "money_budget",
  "gate": { "gate": "money_budget", "passed": false, "detail": "4 would exceed remaining 2 of 5 USDC" }
}
```

Verdict block:

```
  ✔ the free baseline source was selected
  ✔ a paid (x402) source WAS bought within budget
  ✔ the over-budget paid source was SKIPPED by the money_budget gate
  ✔ the skip carries the real arithmetic reason (would exceed remaining … of … USDC)
  ✔ a cheaper paid source further down STILL fit (greedy walk, not a cliff)
  ✔ projected spend never exceeds the ceiling
  ✔ the money_budget gate pinned its verdict in the trace (rejectedBy=money_budget)
  ✔ the plan is deterministic (byte-identical selection + skip on rerun)
✅ Demo 11 — The Budgeted Researcher: ALL CHECKS GREEN
```
