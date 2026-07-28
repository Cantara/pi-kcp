#!/usr/bin/env node
// Demo 15 — "The Governed Composition"
// Organ: kcp-agent procedural plane · Gate exercised: skill_eligibility (#7)
// Spec: KCP v0.29 §4.3b (kind: playbook, RFC-0027) + §3.13 authority_level
//
// A promotion procedure spans four authority levels: read state at `observe`,
// open a change at `prepare`, wait for a human, then `commit`. A single
// `kind: skill` must declare ONE level for all four — either over-granting the
// reading steps or blocking the committing one. §4.3b closes that gap by making
// the STEP the unit of governance rather than the artifact.
//
// The demo asserts three things:
//   1. an ungranted playbook fails CLOSED, exactly as an ungranted skill does
//   2. a superseded playbook is still dropped by supersession
//   3. the sanctioned playbook is admitted, and its declared per-step ceilings
//      are visible in the manifest the planner read
//
// (1) is not free. Until kcp-agent 0.20.0 the eligibility gate tested
// `kind === "skill"` literally, so a playbook fell through as "not a skill" and
// was OFFERED while the skill it composes was withheld — the composition
// escaping the gate its parts are held to. See Cantara/kcp-agent#118.
//
// LLM-free and deterministic (--as-of pinned).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { kcpAgent, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "fixtures", "knowledge.yaml");
const AS_OF = "2026-07-28";
const TASK = "promote the verified build to production";

section("Demo 15: The Governed Composition — kcp-agent plan --trace --strict");

const trace = kcpAgent([
  "plan", TASK, "--manifest", manifestPath, "--as-of", AS_OF, "--trace", "--strict",
]);
console.log(trace.stdout);

const j = kcpAgent([
  "plan", TASK, "--manifest", manifestPath, "--as-of", AS_OF, "--strict", "--json",
]);
const plan = JSON.parse(j.stdout);
const selectedIds = plan.selected.map((u) => u.id);
const skipped = plan.skipped ?? [];

const rogue = skipped.find((s) => s.id === "rogue-promotion");
const laundering = skipped.find((s) => s.id === "laundering-playbook");
const legacy = skipped.find((s) => s.id === "legacy-promotion");

showJson("Selected units", selectedIds);
showJson("Skipped units (with written reasons)", skipped);

// The steps are read from the manifest rather than the plan: the planner's
// PlannedUnit does not carry `steps`, so this is the honest source. Asserting on
// the plan would be asserting on something that is not there.
const manifest = yaml.load(readFileSync(manifestPath, "utf8"));
const sanctioned = manifest.units.find((u) => u.id === "promote-release");
const ladder = manifest.authority_level_scale;
const levels = sanctioned.steps.map((s) => ({ step: s.id, uses: s.uses, level: s.authority_level }));

showJson("Declared per-step ceilings (§4.3b)", levels);

section("Verdict");

expect("planner exited 0", trace.status === 0 && j.status === 0);

expect("sanctioned playbook admitted", selectedIds.includes("promote-release"));

expect(
  "ungranted playbook NOT admitted (fail-closed)",
  !selectedIds.includes("rogue-promotion"),
);
expect(
  "ungranted playbook skipped WITH a written reason naming its kind",
  Boolean(rogue) && /kind: playbook/.test(rogue.reason) && /not invoke-eligible/.test(rogue.reason),
  rogue?.reason ?? "(no skip record)",
);

expect(
  "superseded playbook NOT admitted",
  !selectedIds.includes("legacy-promotion"),
);
expect(
  "superseded playbook skipped by supersession, not by eligibility",
  Boolean(legacy) && /supersed/i.test(legacy.reason),
  legacy?.reason ?? "(no skip record)",
);

// The property that makes a playbook safe to select automatically: every declared
// level is a real rung on the manifest's own ladder, and none exceeds the
// playbook-level ceiling. A playbook can never RAISE authority.
expect(
  "every step declares a level on the declared authority_level_scale",
  levels.every((l) => ladder.includes(l.level)),
  levels.map((l) => `${l.step}=${l.level}`).join(", "),
);
expect(
  "no step exceeds the playbook-level ceiling",
  levels.every((l) => ladder.indexOf(l.level) <= ladder.indexOf(sanctioned.authority_level)),
  `ceiling=${sanctioned.authority_level}`,
);
expect(
  "the procedure spans more than one level — which is why it is not a skill",
  new Set(levels.map((l) => l.level)).size > 1,
  [...new Set(levels.map((l) => l.level))].join(" → "),
);
expect(
  "the commit step gates on human approval before enactment (§3.14)",
  sanctioned.steps.find((s) => s.authority_level === "commit")?.escalation === "requires_approval",
);
// §4.3c (v0.30, RFC-0028) — eligibility does not compose. `laundering-playbook` holds
// its own grant and names a skill that does not. Without this rule a grant on a
// playbook would be a universal grant: any skill in the manifest becomes reachable by
// naming it in a step, including one a human deliberately withheld.
expect(
  "a granted playbook naming an UNGRANTED skill is refused",
  !selectedIds.includes("laundering-playbook"),
);
expect(
  "refused for the composition reason, not merely 'ungranted'",
  Boolean(laundering) && /does not compose|not invoke-eligible/.test(laundering.reason),
  laundering?.reason ?? "(no skip record)",
);
expect(
  "the withheld skill is not offered either",
  !selectedIds.includes("withheld-tool"),
);

expect(
  "every step resolves to a declared kind: skill unit",
  sanctioned.steps.every((s) => {
    const target = manifest.units.find((u) => u.id === s.uses);
    return target && target.kind === "skill";
  }),
);

finish("Demo 15 — The Governed Composition");
