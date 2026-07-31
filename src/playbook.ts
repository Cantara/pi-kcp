/**
 * kind:playbook step-orchestrator (§4.3b, RFC-0027).
 *
 * The runtime governed a `kind: playbook` as a single unit: one skill-admission verdict,
 * one action_scope, one authority. §4.3b makes the STEP the unit of governance. A promotion
 * that reads state (`observe`), opens a change (`prepare`), then commits it (`commit`) can
 * no longer be forced into one declared level for all three phases.
 *
 * This module walks a playbook's steps in `depends_on` order and, for each step, applies
 * BOTH bounds §4.3b calls independent:
 *
 *   - the **authority gate** (Gap 1, {@link authorityGate}): the step's required authority
 *     against the effective ceiling — the minimum of the playbook's level, the task-type
 *     grant_ceiling, any tenant ceiling, and the enacting agent's authority. A step that
 *     demands more than the ceiling allows fails closed, naming the binding source.
 *   - the **action_scope conformance check** ({@link checkStepConformance}): the same pure,
 *     no-LLM `checkConformance` the rest of the runtime uses, run against the `action_scope`
 *     of the `kind: skill` unit the step `uses`. A step that `uses` a unit which does not
 *     resolve, is not a skill, or declares no scope fails closed — eligibility does not
 *     compose (§4.3c): a grant on the playbook does not reach the units its steps name.
 *   - the **effective deny** (RFC-0030 / KCP 0.32, §4.3b): the playbook's own
 *     `action_scope.deny` is NORMATIVE for enactment — a blanket prohibition over every
 *     step, inline steps included — while the rest of the playbook's `action_scope`
 *     envelope stays declarative. The effective denylist for a step is the UNION, per
 *     dimension, of the playbook's deny and the used skill's deny; a token matching either
 *     source is refused, overriding any allow, deny-first, with the matching source(s)
 *     named as the binding source. A deny-hit is FINAL — {@link adjudicateStepAction}
 *     shapes it as a notify-only prohibited-attempt event that no grant, approval, or
 *     escalation outcome may enact.
 *
 * The resolved authority is threaded through: {@link PlaybookPlan.resolvedAuthority} is the
 * effective level of the terminal step, the ceiling the commit runs under.
 *
 * This is a planner over the declarative composition, not an enacting agent. It resolves,
 * orders, and gates; it performs no step work (§4.3b "Orchestration"). Enactment,
 * `success_condition` evaluation, and `escalation` handling remain the caller's — see the
 * deferred notes in the PR.
 */

import { checkConformance, type ActionScope, type ConformanceVerdict, type ObservedAction } from "kcp-harness";
import {
  authorityGate,
  resolveEffectiveAuthority,
  type AuthorityDecision,
  type AuthorityLevelScale,
  type AuthoritySource,
} from "./authority.js";
import {
  evaluateEffectiveDeny,
  parseDenyScope,
  prohibitedAttempt,
  type DenySource,
  type ProhibitedAttempt,
} from "./deny.js";

/** One step of a `kind: playbook` composition (§4.3b). */
export interface ManifestStep {
  readonly id: string;
  /** Unit id this step enacts — SHOULD name a `kind: skill` unit. */
  readonly uses?: string;
  /** Inline description when no unit exists yet — scope-unbounded (§4.3b). */
  readonly action?: string;
  readonly depends_on?: string[];
  /** §3.13 scale. Ceiling semantics: at most this level. */
  readonly authority_level?: string;
  readonly escalation?: string | string[];
  readonly success_condition?: string;
  readonly on_failure?: string;
}

/** The subset of a manifest unit this orchestrator reads. */
export interface ManifestUnitLike {
  readonly id: string;
  readonly kind?: string;
  readonly authority_level?: string;
  readonly action_scope?: ActionScope;
  readonly steps?: ManifestStep[];
}

/** The subset of a KCP manifest this orchestrator reads. */
export interface PlaybookManifest {
  readonly authority_level_scale?: string[];
  readonly units?: ManifestUnitLike[];
}

/** A step after ordering, authority-gating, and scope resolution. */
export interface GatedStep {
  readonly id: string;
  readonly uses?: string;
  readonly action?: string;
  /** The authority the step declared it needs. */
  readonly requiredLevel?: string;
  /**
   * The effective authority threaded through this step — the minimum of the step's own
   * level and every external ceiling (§4.3b lowest-of). Threaded to the commit step.
   */
  readonly effectiveLevel?: string;
  /** The source(s) that bound the effective ceiling. */
  readonly bindingSourceIds: string[];
  /** The resolved `action_scope` of the `uses` skill, when one resolved. */
  readonly scope?: ActionScope;
  /**
   * The deny declarations that blanket this step (RFC-0030 / §4.3b): the playbook's own
   * `action_scope.deny` — which reaches every step, inline ones included — and the used
   * skill's, when either declares one. The effective denylist is their union, and a token
   * matching any source is refused with that source named as binding.
   */
  readonly denySources: readonly DenySource[];
  /**
   * Whether the step's scope is verifiable — false for an inline (`action`) step, which
   * references no unit and is scope-*unbounded* (§4.3b), and false when `uses` did not
   * resolve to a scoped skill.
   */
  readonly scopeVerified: boolean;
  /** The authority gate's verdict for this step. */
  readonly authority: AuthorityDecision;
  /** Admitted only when the authority gate allowed AND the scope is resolvable. */
  readonly admitted: boolean;
  readonly reason: string;
}

/** The result of planning a playbook: the ordered, gated walk, or a manifest error. */
export interface PlaybookPlan {
  /** Well-formed AND every step admitted — fail-closed: one denial makes the run not ok. */
  readonly ok: boolean;
  readonly playbookId: string;
  /** Steps in execution order. Empty when the manifest itself is malformed. */
  readonly steps: GatedStep[];
  /** The effective authority threaded to the terminal step (the ceiling commit runs under). */
  readonly resolvedAuthority?: string;
  /** A manifest-level error (missing playbook, wrong kind, no steps, cyclic graph). */
  readonly error?: string;
}

/** Extra authority sources beyond the playbook's own level — task-type / tenant / agent ceilings. */
export interface PlanPlaybookOptions {
  readonly extraSources?: AuthoritySource[];
}

type OrderResult =
  | { readonly ok: true; readonly order: ManifestStep[] }
  | { readonly ok: false; readonly error: string };

/**
 * Order steps by their dependency graph (§4.3b "Execution order"). An absent `depends_on`
 * means the step depends on the one immediately preceding it in declaration order. The
 * graph MUST be acyclic and every edge MUST name a declared step; either violation is a
 * manifest error. Declaration order breaks ties, so the order is total and deterministic.
 */
export function orderSteps(steps: readonly ManifestStep[]): OrderResult {
  const ids = steps.map((s) => s.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return { ok: false, error: `duplicate step id '${id}'` };
    seen.add(id);
  }

  const byId = new Map(steps.map((s) => [s.id, s]));
  const deps = new Map<string, string[]>();
  steps.forEach((step, index) => {
    // Absent depends_on → the immediately preceding step (§4.3b execution order).
    deps.set(step.id, step.depends_on ?? (index > 0 ? [steps[index - 1]!.id] : []));
  });

  // Validate edges up front so an unknown ref is reported as such, not as a phantom cycle.
  for (const step of steps) {
    for (const d of deps.get(step.id)!) {
      if (!byId.has(d)) return { ok: false, error: `step '${step.id}' depends on unknown step '${d}'` };
    }
  }

  const order: ManifestStep[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();

  const visit = (id: string): string | undefined => {
    if (done.has(id)) return undefined;
    if (onStack.has(id)) return `dependency cycle involving step '${id}'`;
    onStack.add(id);
    for (const d of deps.get(id)!) {
      const err = visit(d);
      if (err) return err;
    }
    onStack.delete(id);
    done.add(id);
    order.push(byId.get(id)!);
    return undefined;
  };

  for (const step of steps) {
    const err = visit(step.id);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, order };
}

/**
 * Plan a `kind: playbook` from a manifest: order its steps, then gate each on authority and
 * resolve its scope. Fail-closed throughout — a malformed playbook, a step that exceeds its
 * ceiling, or a step that `uses` a skill which does not resolve to a scoped unit all make
 * the plan not `ok`.
 */
export function planPlaybook(
  manifest: PlaybookManifest,
  playbookId: string,
  options: PlanPlaybookOptions = {},
): PlaybookPlan {
  const scale: AuthorityLevelScale = manifest.authority_level_scale ?? [];
  const units = manifest.units ?? [];
  const playbook = units.find((u) => u.id === playbookId);

  if (!playbook) return { ok: false, playbookId, steps: [], error: `no unit '${playbookId}' in manifest` };
  if (playbook.kind !== "playbook") {
    return { ok: false, playbookId, steps: [], error: `unit '${playbookId}' is kind '${playbook.kind ?? "knowledge"}', not playbook` };
  }
  if (!playbook.steps || playbook.steps.length === 0) {
    return { ok: false, playbookId, steps: [], error: `playbook '${playbookId}' declares no steps (§4.3b)` };
  }

  const ordered = orderSteps(playbook.steps);
  if (!ordered.ok) return { ok: false, playbookId, steps: [], error: ordered.error };

  // External ceilings: the playbook's own level plus any task-type / tenant / agent ceiling.
  // The step's own level is added per-step so the threaded effective level includes it.
  const externalSources: AuthoritySource[] = [
    { id: "playbook-ceiling", level: playbook.authority_level },
    ...(options.extraSources ?? []),
  ];

  const unitById = new Map(units.map((u) => [u.id, u]));
  // §4.3b v0.32: the playbook's own `deny` is normative — parsed once, bound to every step.
  const playbookDeny = parseDenyScope(playbook.action_scope);
  const steps: GatedStep[] = ordered.order.map((step) => {
    const authority = authorityGate(scale, step.authority_level, externalSources);
    // §4.3b lowest-of, including the step's own level — the level actually enacted.
    const effective = resolveEffectiveAuthority(scale, [
      { id: `step:${step.id}`, level: step.authority_level },
      ...externalSources,
    ]);

    let scope: ActionScope | undefined;
    let scopeVerified = false;
    let scopeReason = "";
    if (step.uses) {
      const target = unitById.get(step.uses);
      if (!target) {
        scopeReason = `step '${step.id}' uses '${step.uses}' which does not resolve to a declared unit — fail-closed (§4.3c)`;
      } else if (target.kind !== "skill") {
        scopeReason = `step '${step.id}' uses '${step.uses}' which is kind '${target.kind ?? "knowledge"}', not a skill — fail-closed (§4.3b)`;
      } else if (!target.action_scope) {
        scopeReason = `step '${step.id}' uses '${step.uses}' which declares no action_scope — nothing is authorized (fail-closed)`;
      } else {
        scope = target.action_scope;
        scopeVerified = true;
      }
    } else {
      // Inline `action` step: references no unit, so it is scope-unbounded (§4.3b), bounded
      // only by its authority_level. Not a scope failure — but not a verified scope either.
      scopeReason = `step '${step.id}' is an inline action — scope-unbounded, bounded only by authority (§4.3b)`;
    }

    // The step's deny sources (RFC-0030): the playbook's blanket deny — inline steps
    // included — plus the used skill's own deny when its scope resolved. Union of denies.
    const denySources: DenySource[] = [];
    if (playbookDeny) denySources.push({ id: `playbook:${playbookId}`, deny: playbookDeny });
    const skillDeny = parseDenyScope(scope);
    if (skillDeny) denySources.push({ id: `skill:${step.uses}`, deny: skillDeny });

    // Admission: authority must allow, and a `uses` step must resolve to a scoped skill.
    const scopeAdmits = step.uses ? scopeVerified : true;
    const admitted = authority.allowed && scopeAdmits;
    const reason = !authority.allowed
      ? authority.reason
      : scopeAdmits
        ? `step '${step.id}' admitted at '${effective.effectiveLevel ?? "unbounded"}'`
        : scopeReason;

    return {
      id: step.id,
      ...(step.uses ? { uses: step.uses } : {}),
      ...(step.action ? { action: step.action } : {}),
      requiredLevel: step.authority_level,
      effectiveLevel: effective.effectiveLevel,
      bindingSourceIds: authority.bindingSourceIds,
      ...(scope ? { scope } : {}),
      denySources,
      scopeVerified,
      authority,
      admitted,
      reason,
    };
  });

  const resolvedAuthority = steps.length > 0 ? steps[steps.length - 1]!.effectiveLevel : undefined;
  const ok = steps.every((s) => s.admitted);
  return { ok, playbookId, steps, resolvedAuthority };
}

/**
 * Run the runtime's existing action_scope conformance check for one step, against the
 * `action_scope` of the skill the step `uses`. The same pure, deterministic
 * `checkConformance` the harness proxy makes its decision with — a step with no verified
 * scope authorizes nothing (fail-closed).
 *
 * Deny-first (RFC-0030 / §4.3b): before the allowlist adjudication, the action is checked
 * against the step's effective deny — the union of the playbook's own `deny` and the used
 * skill's. A match in either refuses the action, overriding any allow, with the binding
 * source(s) named in the reason. This is how the playbook deny reaches inline (`action`)
 * steps too, which have no `uses` scope to adjudicate against.
 */
export function checkStepConformance(
  step: GatedStep,
  action: ObservedAction,
  check: typeof checkConformance = checkConformance,
): ConformanceVerdict {
  const denial = evaluateEffectiveDeny(step.denySources, action);
  if (denial) {
    return {
      gate: "conformance",
      passed: false,
      reason: denial.reason,
      evidence: { tool: action.tool, target: denial.token },
    };
  }
  // An unverified/absent scope becomes `{}`; checkConformance fail-closes on a scope that
  // declares nothing, holding every action.
  return check(action, step.scope ?? {});
}

/**
 * A step-action admission with the RFC-0030 distinction {@link checkStepConformance}'s
 * binary verdict cannot carry: WHY the action did not pass decides what may happen next.
 *
 * - `conformant` — within scope, untouched by any deny.
 * - `held` — outside the allowlist but named by no deny. `escalatable: true`: a §3.14
 *   escalation / grant may still enact it, the way an over-threshold `spend` proceeds
 *   once granted.
 * - `prohibited` — a deny-hit. `escalatable: false` (the literal — no code path can flip
 *   it), carrying the notify-only {@link ProhibitedAttempt} event. The action is refused
 *   FINALLY: a grant resolved against the event records acknowledgement and MUST NOT
 *   cause enactment; the only way past a deny is a new manifest version (§4.3b v0.32).
 */
export type StepActionAdmission =
  | { readonly outcome: "conformant"; readonly reason: string }
  | { readonly outcome: "held"; readonly escalatable: true; readonly reason: string }
  | {
      readonly outcome: "prohibited";
      readonly escalatable: false;
      readonly reason: string;
      readonly event: ProhibitedAttempt;
    };

/**
 * Adjudicate one action for one step, deny-first, separating the never-grantable refusal
 * from the merely-held one. The discriminated union is the structural guarantee: an
 * enactment path that switches on `outcome` has no branch in which a `prohibited` action
 * proceeds, and `escalatable` is literally `false` on that arm.
 */
export function adjudicateStepAction(
  step: GatedStep,
  action: ObservedAction,
  check: typeof checkConformance = checkConformance,
): StepActionAdmission {
  const denial = evaluateEffectiveDeny(step.denySources, action);
  if (denial) {
    return { outcome: "prohibited", escalatable: false, reason: denial.reason, event: prohibitedAttempt(denial) };
  }
  const verdict = check(action, step.scope ?? {});
  return verdict.passed
    ? { outcome: "conformant", reason: verdict.reason }
    : { outcome: "held", escalatable: true, reason: verdict.reason };
}
