#!/usr/bin/env node
// Demo 1 — "The Superseded Policy"
// Organ: kcp-agent 13-gate planner · Gate exercised: supersession (#5)
//
// A March-2026 refund policy supersedes the 2024 one. We ask the REAL planner
// to plan a refund task. It must:
//   (a) select only the active successor,
//   (b) skip the superseded unit WITH a written reason, and
//   (c) produce a byte-identical plan on a rerun (determinism).
//
// LLM-free: `kcp-agent plan` is pure/deterministic. We pin --as-of so the plan
// is reproducible across days.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kcpAgent, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = join(here, "fixtures", "knowledge.yaml");
const AS_OF = "2026-07-22"; // pinned so the demo is reproducible forever
const TASK = "what is the refund policy for a returned order";

section('Demo 1: The Superseded Policy — kcp-agent plan --trace --json');

// 1. Human-readable trace (what a reviewer sees).
const trace = kcpAgent([
  "plan", TASK, "--manifest", manifest, "--as-of", AS_OF, "--trace",
]);
console.log(trace.stdout);

// 2. Machine-readable plan — the governed artifact.
const j1 = kcpAgent(["plan", TASK, "--manifest", manifest, "--as-of", AS_OF, "--json"]);
const plan = JSON.parse(j1.stdout);

const selectedIds = plan.selected.map((u) => u.id);
const skipped = plan.skipped ?? [];
const superseded = skipped.find((s) => s.id === "refund-policy-2024");

showJson("Selected units", selectedIds);
showJson("Skipped units (with written reasons)", skipped);

// 3. Determinism: rerun and compare byte-for-byte.
const j2 = kcpAgent(["plan", TASK, "--manifest", manifest, "--as-of", AS_OF, "--json"]);
const identical = j1.stdout === j2.stdout;

section("Verdict");
expect("planner exited 0", trace.status === 0 && j1.status === 0);
expect("active successor selected", selectedIds.includes("refund-policy-2026-03"));
expect("superseded 2024 policy NOT selected", !selectedIds.includes("refund-policy-2024"));
expect("2024 policy skipped WITH a written reason", !!superseded && /superseded by refund-policy-2026-03/.test(superseded.reason),
  superseded ? superseded.reason : "not skipped");
expect("plan is deterministic (byte-identical rerun)", identical);

finish("Demo 1 — Superseded Policy");
