# Demo 7 — The Confident Fool (confidence)

**Organ / verdict:** kcp-agent's **confidence** gate — the real exported
`assess(task, answer, units, options)`.

## What it shows

The planner gates what may be *loaded*; grounding gates what may be *asserted*;
`assess` gates what may be **acted on**. Confidence is a *proposal* — the model's
own self-report (`Confidence: 0.92`), an independent evaluator's judgment, or
both. The gate **adjudicates** deterministically: signals are **min-aggregated**
by default (the most skeptical wins) against a caller-supplied org **threshold**,
and anything unmeasurable **fails closed**. Every raw signal is preserved
verbatim on the verdict so an org can calibrate over time.

The "fool" is an answer that self-grades `0.92` on a claim it can't support. On
its own number it would sail past a `0.70` bar. Add one **independent skeptic**
(`0.35`) and min-aggregation **holds** it — with both raw signals recorded.

## LLM behaviour

- The **deterministic** adjudication (scripted skeptic at 0.35) **always runs**.
- When `ANTHROPIC_API_KEY` is set, the demo **additionally** uses a **live model**
  as the independent skeptic (`makeEvaluator()`); it too holds the critical
  conclusion (captured below at 0.15).

## Files

- `run.mjs` — one answer, four adjudications: two-signal hold, self-report-alone
  counterfactual, the no-signal fail-closed case, and (key only) a live skeptic.

## Run it

```bash
cd demos
node 07-confident-fool/run.mjs
# optional: ANTHROPIC_API_KEY=sk-... node 07-confident-fool/run.mjs
```

## Step-by-step

1. **Extract** the answer's self-report → `0.92`.
2. **Assess** with the self-report + an independent skeptic (`0.35`),
   min-aggregated, threshold `0.70`, severity `critical` → **HELD** at `0.35`.
3. **Counterfactual**: trust the self-report alone → it would wrongly **pass** at
   `0.92`. (This is the failure mode the gate exists to stop.)
4. **Fail-closed**: strip the self-report, give no evaluator → no obtainable
   signal → **HELD**, not opened.
5. **Live** (key only): a real model is the skeptic.

## Expected governed output (real, captured)

Two-signal hold:

```json
{
  "gate": "confidence", "passed": false, "score": 0.35, "threshold": 0.7, "severity": "critical",
  "signals": [
    { "source": "self", "score": 0.92, "reasoning": "self-reported: \"Confidence: 0.92\"" },
    { "source": "evaluator", "score": 0.35, "reasoning": "no loaded unit establishes reversibility; 'backwards-compatible' is asserted, not shown" }
  ],
  "detail": "confidence 0.35 < threshold 0.7 on critical task — evaluator: no loaded unit establishes reversibility; 'backwards-compatible' is asserted, not shown"
}
```

Counterfactual (self-report alone) and fail-closed:

```json
{ "passed": true,  "score": 0.92, "detail": "confidence 0.92 >= threshold 0.7 (min of 1 signal)" }
{ "passed": false, "score": 0,    "detail": "no confidence signal obtainable (no self-report in answer, no evaluator) — fail-closed" }
```

Live skeptic (with `ANTHROPIC_API_KEY`) — a real model call, min-aggregated:

```json
{
  "passed": false, "score": 0.15, "threshold": 0.7,
  "signals": [
    { "source": "self", "score": 0.92, "reasoning": "self-reported: \"Confidence: 0.92\"" },
    { "source": "evaluator", "score": 0.15, "reasoning": "The answer provides a definitive safety recommendation without any supporting evidence, data, or reference to the actual migration details, despite the loaded units being empty…" }
  ]
}
```

Verdict block:

```
  ✔ the cocky self-report was extracted at 0.92
  ✔ with an independent skeptic, the conclusion is HELD (below threshold)
  ✔ the held score is the min of the two signals (0.35), not the fool's 0.92
  ✔ BOTH raw signals are preserved on the verdict (calibration/audit)
  ✔ the written reason names the deciding (lowest) signal
  ✔ trusting the self-report ALONE would have WRONGLY passed it
  ✔ no obtainable signal fails closed (not open)
  ✔ live model skeptic also holds the critical conclusion
✅ Demo 7 — The Confident Fool (confidence): ALL CHECKS GREEN
```
