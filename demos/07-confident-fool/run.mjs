#!/usr/bin/env node
// Demo 7 — "The Confident Fool" (confidence)
// Organ: kcp-agent's confidence gate — the REAL exported assess(task, answer, units, opts)
// API: assess + extractSelfReport; a self-report and an injected evaluator are two SIGNALS,
//      combined by deterministic min-aggregation (fail-closed) against an org threshold.
//
// The planner gates what may be *loaded*; grounding gates what may be *asserted*; assess
// gates what may be *acted on*. Confidence is a *proposal* — the model's own self-report,
// an independent evaluator's judgment, or both. The gate *adjudicates*: min-aggregated by
// default so the most skeptical signal wins, fail-closed on anything unmeasurable. Every
// raw signal is preserved verbatim on the verdict so an org can calibrate over time.

import { assess, extractSelfReport } from "kcp-agent";
import { section, expect, finish, showJson } from "../lib/runner.mjs";

const THRESHOLD = 0.7; // org policy: hold critical conclusions below 70%
const task = "Is it safe to auto-approve this production database migration?";

// The agent's answer ends with a cocky self-report. This is the "fool": high
// self-assessed confidence on a claim it cannot actually support.
const answer =
  "Yes, auto-approve it — the migration is backwards-compatible and reversible.\n" +
  "Confidence: 0.92";

// No units were loaded to support the conclusion — which is exactly why an
// independent skeptic rates it low.
const units = [];

section("Demo 7: The Confident Fool — assess(task, answer, units, { threshold, evaluator })");
console.log(`\nTask (critical):   ${task}`);
console.log(`Answer:            "Yes, auto-approve it …"`);
const self = extractSelfReport(answer);
showJson("Signal 1 — the answer's own self-report (extracted from the text)", self);

// An INDEPENDENT skeptic — deterministic here (an LLM in production via makeEvaluator).
// It is a SEPARATE judgment from whoever wrote the answer; it rates the same answer 0.35.
const skeptic = async () => ({
  source: "evaluator",
  score: 0.35,
  reasoning: "no loaded unit establishes reversibility; 'backwards-compatible' is asserted, not shown",
});

// --- 1. Two signals, min-aggregated → HELD (the skeptic wins) ----------------
const held = await assess(task, answer, units, {
  threshold: THRESHOLD,
  severity: "critical",
  evaluator: skeptic,
  aggregate: "min",
});
showJson("Verdict — self-report (0.92) + independent skeptic (0.35), min-aggregated", held);

// --- 2. Contrast: trust ONLY the fool's own number → it would PASS -----------
// This is the failure mode the gate exists to stop: a system that believes an
// agent's self-graded confidence sails a 0.92 past a 0.70 bar.
const credulous = await assess(task, answer, units, { threshold: THRESHOLD, severity: "critical" });
showJson("Counterfactual — self-report ALONE (no independent signal)", {
  passed: credulous.passed, score: credulous.score, detail: credulous.detail,
});

// --- 3. Fail-closed: NO obtainable signal ------------------------------------
// Strip the self-report and provide no evaluator: nothing measurable → held.
const noSignal = await assess(task, "Ship it.", units, {
  threshold: THRESHOLD,
  severity: "critical",
  includeSelfReport: false,
});
showJson("Fail-closed — no self-report, no evaluator", {
  passed: noSignal.passed, score: noSignal.score, signals: noSignal.signals, detail: noSignal.detail,
});

// --- 4. Live evaluator — ONLY when a key is present --------------------------
const liveKey = process.env.ANTHROPIC_API_KEY;
let live;
if (liveKey) {
  section("Live evaluator (ANTHROPIC_API_KEY set) — a real model is the independent skeptic");
  const { makeEvaluator } = await import("kcp-agent");
  const evaluator = makeEvaluator(process.env.KCP_ASSESS_MODEL); // default claude-haiku-4-5
  live = await assess(task, answer, units, { threshold: THRESHOLD, severity: "critical", evaluator, aggregate: "min" });
  showJson("Live confidence verdict (self-report + live model skeptic, min)", {
    passed: live.passed, score: live.score, threshold: live.threshold,
    signals: live.signals, detail: live.detail,
  });
} else {
  console.log("\n(ANTHROPIC_API_KEY not set — skipped the live model evaluator; the deterministic");
  console.log(" adjudication above is the governed outcome. Set ANTHROPIC_API_KEY to add a live skeptic.)");
}

// --- 5. Verdict --------------------------------------------------------------
section("Verdict");
expect("the cocky self-report was extracted at 0.92", self?.score === 0.92 && self.source === "self");
expect("with an independent skeptic, the conclusion is HELD (below threshold)", held.passed === false);
expect("the held score is the min of the two signals (0.35), not the fool's 0.92", held.score === 0.35);
expect("BOTH raw signals are preserved on the verdict (calibration/audit)",
  held.signals.length === 2 &&
  held.signals.some((s) => s.source === "self" && s.score === 0.92) &&
  held.signals.some((s) => s.source === "evaluator" && s.score === 0.35));
expect("the written reason names the deciding (lowest) signal", /skeptic|reversibility|evaluator/i.test(held.detail), held.detail);
expect("trusting the self-report ALONE would have WRONGLY passed it", credulous.passed === true && credulous.score === 0.92);
expect("no obtainable signal fails closed (not open)", noSignal.passed === false && /no confidence signal/.test(noSignal.detail));
if (liveKey) {
  expect("live model skeptic also holds the critical conclusion", live.passed === false && live.score < THRESHOLD);
}

finish("Demo 7 — The Confident Fool (confidence)");
