#!/usr/bin/env node
// Demo 2 — "The Poisoned Playbook"
// Organ: kcp-agent procedural plane · Gate exercised: skill_eligibility (#7)
//
// A poisoned `kind: skill` unit (no load_eligible grant) and a retired one
// (superseded) sit next to a sanctioned procedure. The planner's
// skill_eligibility gate must FAIL CLOSED on both untrusted procedures, WITH a
// written reason, and admit only the sanctioned one.
//
// We run with --strict so ineligible skills are dropped (fail-closed), which is
// how the harness governor invokes the planner for a skill invocation.
// LLM-free and deterministic (--as-of pinned).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { kcpAgent, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = join(here, "fixtures", "knowledge.yaml");
const AS_OF = "2026-07-22";
const TASK = "deploy the service to production";

section("Demo 2: The Poisoned Playbook — kcp-agent plan --trace --strict");

const trace = kcpAgent([
  "plan", TASK, "--manifest", manifest, "--as-of", AS_OF, "--trace", "--strict",
]);
console.log(trace.stdout);

const j = kcpAgent(["plan", TASK, "--manifest", manifest, "--as-of", AS_OF, "--strict", "--json"]);
const plan = JSON.parse(j.stdout);
const selectedIds = plan.selected.map((u) => u.id);
const skipped = plan.skipped ?? [];
const poisoned = skipped.find((s) => s.id === "poisoned-playbook");
const retired = skipped.find((s) => s.id === "retired-playbook");

showJson("Selected units", selectedIds);
showJson("Skipped units (with written reasons)", skipped);

section("Verdict");
expect("planner exited 0", trace.status === 0 && j.status === 0);
expect("sanctioned deploy-playbook admitted", selectedIds.includes("deploy-playbook"));
expect("poisoned playbook NOT admitted", !selectedIds.includes("poisoned-playbook"));
expect(
  "poisoned playbook skipped fail-closed WITH reason",
  !!poisoned && /not invoke-eligible|no explicit eligibility grant/.test(poisoned.reason),
  poisoned ? poisoned.reason : "not skipped",
);
expect("retired (superseded) playbook NOT admitted", !selectedIds.includes("retired-playbook"));
expect(
  "retired playbook skipped WITH reason",
  !!retired && /superseded|not invoke-eligible/.test(retired.reason),
  retired ? retired.reason : "not skipped",
);

finish("Demo 2 — Poisoned Playbook");
