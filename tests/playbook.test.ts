// Gap 2 — kind:playbook step-orchestrator (§4.3b, RFC-0027).
//
// The runtime treats a kind:playbook as a single gated unit. §4.3b makes the STEP the unit
// of governance: walk the steps in depends_on order, and for each apply BOTH the per-step
// action_scope conformance check AND the Gap-1 authority gate, threading the resolved
// authority through to the commit step. A step whose required authority exceeds the
// effective ceiling, or whose `uses` skill is withheld, fails closed.
import { describe, expect, it } from "bun:test";

import {
  orderSteps,
  planPlaybook,
  checkStepConformance,
  type PlaybookManifest,
} from "../src/playbook.js";

// Mirrors demos/15-governed-composition: a promotion that spans four authority levels.
const MANIFEST: PlaybookManifest = {
  authority_level_scale: ["observe", "explain", "suggest", "prepare", "commit"],
  units: [
    {
      id: "read-build-status",
      kind: "skill",
      action_scope: { tools: ["Read"], paths: ["ci/"] },
    },
    {
      id: "open-promotion-request",
      kind: "skill",
      action_scope: { tools: ["Bash", "Read"], paths: [".forge/"] },
    },
    {
      id: "complete-promotion",
      kind: "skill",
      action_scope: { tools: ["Bash"], paths: ["deploy/"], capabilities: ["release-promotion"] },
    },
    {
      id: "withheld-tool",
      kind: "skill",
      // load_eligible absent — a human declined this one
      action_scope: { tools: ["Bash"], paths: ["**"] },
    },
    {
      id: "promote-release",
      kind: "playbook",
      authority_level: "commit",
      steps: [
        { id: "verify", uses: "read-build-status", authority_level: "observe", on_failure: "abort" },
        {
          id: "prepare-change",
          uses: "open-promotion-request",
          depends_on: ["verify"],
          authority_level: "prepare",
          on_failure: "abort",
        },
        {
          id: "promote",
          uses: "complete-promotion",
          depends_on: ["prepare-change"],
          authority_level: "commit",
          escalation: "requires_approval",
          on_failure: "escalate",
        },
      ],
    },
    // A granted playbook whose step names a WITHHELD skill (§4.3c) — must fail closed.
    {
      id: "laundering-playbook",
      kind: "playbook",
      steps: [{ id: "shortcut", uses: "withheld-tool", authority_level: "commit" }],
    },
  ],
};

describe("orderSteps — depends_on ordering (§4.3b execution order)", () => {
  it("orders by explicit depends_on edges", () => {
    // `a` declares an explicit (empty) dependency so it does not fall back to the
    // preceding-step default — which, given declaration order [c, a, b], would be a cycle.
    const r = orderSteps([
      { id: "c", depends_on: ["b"] },
      { id: "a", depends_on: [] },
      { id: "b", depends_on: ["a"] },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("defaults a step with no depends_on to the immediately preceding step", () => {
    const r = orderSteps([{ id: "first" }, { id: "second" }, { id: "third" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.order.map((s) => s.id)).toEqual(["first", "second", "third"]);
  });

  it("fails on a dependency cycle", () => {
    const r = orderSteps([
      { id: "a", depends_on: ["b"] },
      { id: "b", depends_on: ["a"] },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cycle/i);
  });

  it("fails on an unknown dependency", () => {
    const r = orderSteps([{ id: "a", depends_on: ["ghost"] }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown|ghost/i);
  });
});

describe("planPlaybook — per-step authority gate threaded through the walk", () => {
  it("admits the sanctioned playbook, resolving each step within the playbook ceiling", () => {
    const plan = planPlaybook(MANIFEST, "promote-release");
    expect(plan.ok).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(["verify", "prepare-change", "promote"]);
    // Each step admitted, and its effective authority threaded through.
    expect(plan.steps.every((s) => s.admitted)).toBe(true);
    expect(plan.steps.find((s) => s.id === "verify")!.effectiveLevel).toBe("observe");
    expect(plan.steps.find((s) => s.id === "promote")!.effectiveLevel).toBe("commit");
    // The resolved authority threaded to the terminal (commit) step.
    expect(plan.resolvedAuthority).toBe("commit");
    // Each step carries the resolved action_scope of the skill it uses.
    expect(plan.steps.find((s) => s.id === "verify")!.scope).toEqual({ tools: ["Read"], paths: ["ci/"] });
  });

  it("fails closed when a tenant ceiling caps a step below what it requires", () => {
    // The promote step needs `commit`, but the enacting agent is capped at `prepare`.
    const plan = planPlaybook(MANIFEST, "promote-release", {
      extraSources: [{ id: "agent-capability-ceiling", level: "prepare" }],
    });
    expect(plan.ok).toBe(false);
    const promote = plan.steps.find((s) => s.id === "promote")!;
    expect(promote.admitted).toBe(false);
    expect(promote.authority.allowed).toBe(false);
    expect(promote.authority.bindingSourceIds).toContain("agent-capability-ceiling");
    // Earlier steps that fit under the ceiling still resolve.
    expect(plan.steps.find((s) => s.id === "verify")!.admitted).toBe(true);
  });

  it("fails closed when a step's `uses` names a skill that declares no action_scope grant", () => {
    // withheld-tool has an action_scope but imagine it withheld: model as missing skill.
    const bad: PlaybookManifest = {
      authority_level_scale: MANIFEST.authority_level_scale,
      units: [
        { id: "ghost-playbook", kind: "playbook", steps: [{ id: "s1", uses: "does-not-exist" }] },
      ],
    };
    const plan = planPlaybook(bad, "ghost-playbook");
    expect(plan.ok).toBe(false);
    expect(plan.steps[0]!.admitted).toBe(false);
    expect(plan.steps[0]!.reason).toMatch(/does-not-exist|not resolve|withheld/i);
  });

  it("errors on a playbook with no steps (§4.3b)", () => {
    const bad: PlaybookManifest = {
      units: [{ id: "empty", kind: "playbook", steps: [] }],
    };
    const plan = planPlaybook(bad, "empty");
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/step/i);
  });
});

describe("checkStepConformance — the existing action_scope check, per step", () => {
  it("passes an action within the step's resolved scope", () => {
    const plan = planPlaybook(MANIFEST, "promote-release");
    const verify = plan.steps.find((s) => s.id === "verify")!;
    const verdict = checkStepConformance(verify, { tool: "Read", paths: ["ci/build.json"] });
    expect(verdict.passed).toBe(true);
  });

  it("holds an action that reaches outside the step's scope", () => {
    const plan = planPlaybook(MANIFEST, "promote-release");
    const verify = plan.steps.find((s) => s.id === "verify")!;
    const verdict = checkStepConformance(verify, { tool: "Bash", paths: ["deploy/prod"] });
    expect(verdict.passed).toBe(false);
  });
});
