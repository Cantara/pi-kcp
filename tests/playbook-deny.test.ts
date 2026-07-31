// RFC-0030 / KCP 0.32 (§4.3b) — playbook-level prohibitions + deny finality.
//
// The gap, in two halves. (1) A `kind: playbook` unit's `action_scope.deny` is normative
// for enactment: a blanket prohibition over EVERY step, inline steps included. The
// effective denylist for a step is the UNION, per dimension, of the playbook's deny and
// the used skill's deny — a token matching EITHER source is denied, overriding any allow,
// with the matching source named as the binding source in the trace (both, when both
// match). Before this change the playbook walk read only the skill's scope, and an inline
// step had no scope bound at all. (2) A deny is NEVER grantable: a deny-hit is refused
// finally and raises a notify-only prohibited-attempt event — no grant, approval, or
// escalation outcome may enact it, and that must hold structurally in the runtime.
import { describe, expect, it } from "bun:test";

import {
  adjudicateStepAction,
  type ActionScope,
  checkStepConformance,
  type ConformanceContext,
  evaluateEffectiveDeny,
  GovernedLoop,
  HarnessConformanceChecker,
  type ObservedAction,
  planPlaybook,
  type PlaybookManifest,
  type ProhibitedAttempt,
  type ScopeResolver,
  type SkillSelected,
  digest,
} from "../src/index.js";

// Mirrors the RFC-0030 worked example: a deletion playbook that can never touch legal
// hold, whichever skill runs, in whatever order — plus each skill's own RFC-0029 deny.
const MANIFEST: PlaybookManifest = {
  authority_level_scale: ["observe", "explain", "suggest", "prepare", "commit"],
  units: [
    {
      id: "document-agent",
      kind: "skill",
      action_scope: { tools: ["Read"], paths: ["records/"] },
    },
    {
      id: "deletion-agent",
      kind: "skill",
      // The skill allows deletion broadly, and carries its own RFC-0029 prohibition.
      action_scope: {
        tools: ["Bash", "transfer_ownership"],
        paths: ["records/**"],
        deny: { tools: ["publish_external"] },
      } as ActionScope,
    },
    {
      id: "gdpr-deletion",
      kind: "playbook",
      authority_level: "commit",
      // §4.3b v0.32: normative for enactment — enforced against every step below.
      action_scope: {
        deny: { tools: ["transfer_ownership"], paths: ["records/legal-hold/**"] },
      } as ActionScope,
      steps: [
        { id: "identify", uses: "document-agent", authority_level: "observe" },
        { id: "delete", uses: "deletion-agent", authority_level: "commit" },
        // An inline step: scope-unbounded on the allow axis — the playbook deny is the
        // first hard edge it has ever had.
        { id: "confirm", action: "confirm the deletion with the requester", authority_level: "observe" },
      ],
    },
  ],
};

describe("planPlaybook — the playbook deny blankets every step (§4.3b v0.32)", () => {
  it("threads the playbook's deny into every step's deny sources, inline steps included", () => {
    const plan = planPlaybook(MANIFEST, "gdpr-deletion");
    expect(plan.ok).toBe(true);
    for (const step of plan.steps) {
      expect(step.denySources.map((s) => s.id)).toContain("playbook:gdpr-deletion");
    }
    // The used skill's own deny rides along as its own source — union, not replacement.
    const del = plan.steps.find((s) => s.id === "delete")!;
    expect(del.denySources.map((s) => s.id)).toEqual([
      "playbook:gdpr-deletion",
      "skill:deletion-agent",
    ]);
    // The inline step is bounded by the playbook alone.
    const confirm = plan.steps.find((s) => s.id === "confirm")!;
    expect(confirm.denySources.map((s) => s.id)).toEqual(["playbook:gdpr-deletion"]);
  });

  it("declares no deny sources when neither the playbook nor the skill carries a deny", () => {
    const plan = planPlaybook(MANIFEST, "gdpr-deletion");
    // document-agent has no deny; only the playbook binds the identify step.
    const identify = plan.steps.find((s) => s.id === "identify")!;
    expect(identify.denySources.map((s) => s.id)).toEqual(["playbook:gdpr-deletion"]);
  });
});

describe("checkStepConformance — deny-first union, binding source named (§4.3b v0.32)", () => {
  const plan = planPlaybook(MANIFEST, "gdpr-deletion");
  const del = plan.steps.find((s) => s.id === "delete")!;

  it("refuses a tool the skill allows but the playbook deny names, naming the playbook", () => {
    // transfer_ownership is on deletion-agent's allowlist — the playbook deny must win.
    const verdict = checkStepConformance(del, { tool: "transfer_ownership" });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("transfer_ownership");
    expect(verdict.reason).toContain("playbook:gdpr-deletion");
  });

  it("refuses a path the playbook deny covers, under a tool the skill allows", () => {
    const verdict = checkStepConformance(del, {
      tool: "Bash",
      paths: ["records/legal-hold/2025-case/evidence.pdf"],
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("records/legal-hold/2025-case/evidence.pdf");
    expect(verdict.reason).toContain("playbook:gdpr-deletion");
  });

  it("refuses a token only the skill's own deny names, naming the skill", () => {
    const verdict = checkStepConformance(del, { tool: "publish_external" });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("skill:deletion-agent");
    expect(verdict.reason).not.toContain("playbook:gdpr-deletion");
  });

  it("names both sources when both denies match the same token", () => {
    const both: PlaybookManifest = {
      units: [
        {
          id: "s",
          kind: "skill",
          action_scope: { tools: ["Bash"], deny: { tools: ["Bash"] } } as ActionScope,
        },
        {
          id: "p",
          kind: "playbook",
          action_scope: { deny: { tools: ["Bash"] } } as ActionScope,
          steps: [{ id: "only", uses: "s" }],
        },
      ],
    };
    const step = planPlaybook(both, "p").steps[0]!;
    const verdict = checkStepConformance(step, { tool: "Bash" });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("playbook:p");
    expect(verdict.reason).toContain("skill:s");
  });

  it("still passes an action neither deny matches and the allowlist permits", () => {
    const verdict = checkStepConformance(del, { tool: "Bash", paths: ["records/2024/old.txt"] });
    expect(verdict.passed).toBe(true);
  });

  it("applies the playbook deny to an inline step — its first scope bound (§4.3b)", () => {
    const confirm = plan.steps.find((s) => s.id === "confirm")!;
    const verdict = checkStepConformance(confirm, { tool: "transfer_ownership" });
    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain("playbook:gdpr-deletion");
  });
});

describe("adjudicateStepAction — a deny-hit is prohibited, finally; a scope miss is merely held", () => {
  const plan = planPlaybook(MANIFEST, "gdpr-deletion");
  const del = plan.steps.find((s) => s.id === "delete")!;

  it("returns a prohibited admission with the prohibited-attempt event on a deny-hit", () => {
    const admission = adjudicateStepAction(del, { tool: "transfer_ownership" });
    expect(admission.outcome).toBe("prohibited");
    if (admission.outcome !== "prohibited") throw new Error("unreachable");
    // Structural finality: the literal types leave no branch that can enact this.
    expect(admission.escalatable).toBe(false);
    expect(admission.event.record).toBe("prohibited_attempt");
    expect(admission.event.grantable).toBe(false);
    expect(admission.event.dimension).toBe("tools");
    expect(admission.event.token).toBe("transfer_ownership");
    expect(admission.event.bindingSourceIds).toEqual(["playbook:gdpr-deletion"]);
  });

  it("holds (escalatable) an action outside the allowlist that no deny names", () => {
    const admission = adjudicateStepAction(del, { tool: "Write", paths: ["records/x"] });
    expect(admission.outcome).toBe("held");
    if (admission.outcome !== "held") throw new Error("unreachable");
    expect(admission.escalatable).toBe(true);
  });

  it("admits an in-scope action untouched by any deny", () => {
    const admission = adjudicateStepAction(del, { tool: "Bash", paths: ["records/2024/a"] });
    expect(admission.outcome).toBe("conformant");
  });
});

describe("evaluateEffectiveDeny — union per dimension, all matching sources bound", () => {
  it("collects every source whose deny matches the refused token", () => {
    const match = evaluateEffectiveDeny(
      [
        { id: "playbook:p", deny: { tools: ["Bash"] } },
        { id: "skill:s", deny: { tools: ["Bash"] } },
      ],
      { tool: "Bash" },
    );
    expect(match?.bindingSourceIds).toEqual(["playbook:p", "skill:s"]);
  });

  it("names only the source that matched", () => {
    const match = evaluateEffectiveDeny(
      [
        { id: "playbook:p", deny: { paths: ["legal/hold/**"] } },
        { id: "skill:s", deny: { tools: ["publish_external"] } },
      ],
      { tool: "Bash", paths: ["legal/hold/x"] },
    );
    expect(match?.dimension).toBe("paths");
    expect(match?.bindingSourceIds).toEqual(["playbook:p"]);
  });

  it("refuses nothing when no source matches", () => {
    expect(
      evaluateEffectiveDeny([{ id: "playbook:p", deny: { tools: ["Bash"] } }], { tool: "Read" }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// Deny finality in the governed loop: a deny-hit raises a notify-only prohibited-attempt
// event, and NO approval path can enact it — the prohibited digest can never enter the
// approvals map, so an execution of it is recorded as a violation, not an enactment.
// ---------------------------------------------------------------------------------------

const ctx: ConformanceContext = { cwd: "/repo" };

const deploySkill: SkillSelected = {
  skillPath: "/repo/skills/deploy/SKILL.md",
  skillName: "deploy",
  source: "agent",
};

function stubResolver(scope: ActionScope | undefined): ScopeResolver {
  return {
    async resolve() {
      return scope;
    },
  };
}

describe("deny finality in the governed loop (RFC-0030 — never grantable)", () => {
  const scope = { tools: ["read", "bash"], deny: { tools: ["bash"] } } as ActionScope;

  it("the conformance checker marks a deny-hit as a prohibited attempt", async () => {
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(scope) });
    const action: ObservedAction = {
      toolName: "bash",
      input: { command: "ls" },
      correlationId: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      skillContext: deploySkill,
    };
    const verdict = await checker.check(action, ctx);
    expect(verdict.conformant).toBe(false);
    expect(verdict.prohibited?.record).toBe("prohibited_attempt");
    expect(verdict.prohibited?.grantable).toBe(false);
    expect(verdict.prohibited?.bindingSourceIds).toEqual(["skill:deploy"]);
  });

  it("emits the notify-only prohibited-attempt event and blocks, finally", async () => {
    const prohibited: ProhibitedAttempt[] = [];
    const loop = new GovernedLoop({
      checker: new HarnessConformanceChecker({ resolveScope: stubResolver(scope) }),
      hooks: { onProhibitedAttempt: (_action, event) => prohibited.push(event) },
    });
    loop.beginTurn(1);
    loop.observeInput("/skill:deploy");

    const decision = await loop.evaluateToolCall("bash", { command: "ls" }, ctx);
    expect(decision.block).toBe(true);
    expect(decision.prohibited?.record).toBe("prohibited_attempt");
    expect(prohibited).toHaveLength(1);
    expect(prohibited[0]!.token).toBe("bash");
  });

  it("no approval path enacts a prohibited action — the approval never records", async () => {
    const loop = new GovernedLoop({
      checker: new HarnessConformanceChecker({ resolveScope: stubResolver(scope) }),
    });
    loop.beginTurn(1);
    loop.observeInput("/skill:deploy");

    const input = { command: "ls" };
    const decision = await loop.evaluateToolCall("bash", input, ctx);
    expect(decision.block).toBe(true);

    // An escalation/approval path tries to wave the refused call through anyway. The
    // structural guarantee: a prohibited input digest cannot enter the approvals map, so
    // if the call executes it is recorded as a VIOLATION, never as an approved enactment.
    loop.noteApproval("t1", digest(input));
    const outcome = loop.checkExecuted("t1", input);
    expect(outcome.status).toBe("violated");
    expect(outcome.reason).toMatch(/no recorded approval/);
  });

  it("an ordinary (non-deny) hold is still approvable — finality is the deny's alone", async () => {
    const allowScope = { tools: ["read"] } as ActionScope;
    const loop = new GovernedLoop({
      checker: new HarnessConformanceChecker({ resolveScope: stubResolver(allowScope) }),
    });
    loop.beginTurn(1);
    loop.observeInput("/skill:deploy");

    const input = { path: "a.ts" };
    const decision = await loop.evaluateToolCall("read", input, ctx);
    expect(decision.block).toBe(false);
    expect(decision.prohibited).toBeUndefined();
    loop.noteApproval("t2", digest(input));
    expect(loop.checkExecuted("t2", input).status).toBeUndefined();
  });
});
