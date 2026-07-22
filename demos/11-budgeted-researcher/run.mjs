#!/usr/bin/env node
// Demo 11 — "The Budgeted Researcher"
// Organ: the REAL kcp-agent planner (CLI) — the `money_budget` gate (#13 of 13).
//
// A researcher agent plans over a corpus of knowledge sources, some FREE and some
// pay-per-request (x402). We give the planner a hard spend ceiling (`--budget`).
// The deterministic `money_budget` gate charges each selected paid unit against
// the ceiling and SKIPS the one that would overspend — with the exact arithmetic
// reason (`over budget: X would exceed remaining Y of Z USDC`). A cheaper paid
// source further down still fits, proving the gate is a greedy walk, not a cliff.
//
// No LLM, no network: the planner binary is real and the decision is byte-stable.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kcpAgent, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = join(here, "fixtures", "knowledge.yaml");
const TASK = "research governed autonomous agent adoption trends for 2026";
const BUDGET = 5;
const CURRENCY = "USDC";

function plan(extra = []) {
  const res = kcpAgent(["plan", TASK, "--manifest", manifest, "--methods", "free,x402",
    "--budget", String(BUDGET), "--currency", CURRENCY, ...extra]);
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    throw new Error(`kcp-agent plan exited ${res.status}`);
  }
  return res.stdout;
}

section("Demo 11: The Budgeted Researcher — the money_budget gate holds the line");
console.log(`\ntask:     "${TASK}"`);
console.log(`budget:   ${BUDGET} ${CURRENCY}  (--budget, whole federated walk)`);
console.log(`methods:  free,x402   (the agent can settle free + x402 pay-per-request)`);

// --- 1. Plan under the budget (real planner, stable --json) ------------------
const out = plan(["--json"]);
const p = JSON.parse(out);
const selected = p.selected ?? [];
const skipped = p.skipped ?? [];

console.log(`\nplanner: kcp-agent plan … --budget ${BUDGET} ${CURRENCY} --json`);
console.log("\nSelected sources (loaded within budget):");
for (const u of selected) {
  const cost = u.payment?.cost ? `  [${u.payment.cost}]` : "  [free]";
  console.log(`  ✅ ${u.id.padEnd(26)}${cost}`);
}
console.log("\nSkipped sources (held by a gate):");
for (const u of skipped) {
  console.log(`  ⛔ ${u.id.padEnd(26)}  ${u.reason}`);
}
showJson("Budget projection (the planner's own arithmetic)", p.budget);

// --- 2. The gate cascade for the over-budget unit (real --trace) -------------
const traceOut = JSON.parse(plan(["--trace", "--json"]));
const forecast = (traceOut.units ?? []).find((u) => u.id === "premium-forecast-report");
const moneyGate = forecast?.gates?.find((g) => g.gate === "money_budget");
showJson("money_budget gate verdict for premium-forecast-report", {
  rejectedBy: forecast?.rejectedBy,
  gate: moneyGate,
});

// --- 3. Determinism: the plan is byte-identical on a rerun -------------------
const rerun = JSON.parse(plan(["--json"]));
const sameSelection = JSON.stringify(rerun.selected?.map((u) => u.id)) === JSON.stringify(selected.map((u) => u.id));
const sameSkip = JSON.stringify(rerun.skipped) === JSON.stringify(skipped);

// --- 4. Verdict --------------------------------------------------------------
section("Verdict");
const overBudget = skipped.find((u) => /over budget:/.test(u.reason));
const boughtPaid = selected.filter((u) => u.payment?.cost);
expect("the free baseline source was selected",
  selected.some((u) => u.id === "free-market-primer"));
expect("a paid (x402) source WAS bought within budget",
  boughtPaid.length >= 1, `bought: ${boughtPaid.map((u) => u.id).join(", ")}`);
expect("the over-budget paid source was SKIPPED by the money_budget gate",
  !!overBudget, `skipped: ${JSON.stringify(skipped)}`);
expect("the skip carries the real arithmetic reason (would exceed remaining … of … USDC)",
  !!overBudget && /over budget: 4 would exceed remaining 2 of 5 USDC/.test(overBudget.reason),
  overBudget?.reason);
expect("a cheaper paid source further down STILL fit (greedy walk, not a cliff)",
  selected.some((u) => u.id === "paid-vendor-brief"));
expect("projected spend never exceeds the ceiling",
  typeof p.budget?.projectedSpend === "number" && p.budget.projectedSpend <= BUDGET,
  `projected=${p.budget?.projectedSpend}`);
expect("the money_budget gate pinned its verdict in the trace (rejectedBy=money_budget)",
  forecast?.rejectedBy === "money_budget" && moneyGate?.passed === false);
expect("the plan is deterministic (byte-identical selection + skip on rerun)",
  sameSelection && sameSkip);

finish("Demo 11 — The Budgeted Researcher");
