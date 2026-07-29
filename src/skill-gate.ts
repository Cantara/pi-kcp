/**
 * Procedural governance at runtime (#28).
 *
 * pi-kcp ships the very skills the model selects, so it is the place where a skill can be
 * checked *before* it shapes a turn. `kcp-agent plan --trace --json` adjudicates every
 * declared unit against the planner's gates — audience, not_for, temporal, deprecated,
 * supersession, relevance, skill_eligibility, attestation, and the budget gates — and
 * reports a written verdict per gate.
 *
 * This module reads those verdicts. A skill whose unit failed a gate is refused with the
 * planner's own words rather than a paraphrase: "deprecated since 2026-01-01" is evidence,
 * "skill not allowed" is not.
 */
import { matchSkillUnit } from "./harness-conformance.js";
import type { SkillSelected } from "./skill-detection.js";

export interface GateVerdict {
  readonly gate: string;
  readonly passed: boolean;
  readonly detail?: string;
}

/** One unit as the planner traced it. */
export interface TracedUnit {
  readonly id: string;
  readonly path: string;
  readonly outcome: string;
  readonly gates: readonly GateVerdict[];
}

export interface SkillAdmission {
  /** Whether the skill may shape this turn. */
  readonly admitted: boolean;
  /**
   * Whether a declared procedure actually adjudicated this. `false` means the skill is not
   * a governed procedure at all — admitted, but never *checked*, and the record says so.
   */
  readonly governed: boolean;
  /** The planner's words, or why no adjudication happened. */
  readonly reason: string;
  readonly failedGates: readonly string[];
}

/**
 * Read the units out of `plan --trace --json`. Anything that is not a trace yields no
 * units, which admits everything — a malformed trace must not silently refuse work.
 */
export function parseTrace(output: string): TracedUnit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const units = (parsed as { units?: unknown } | null)?.units;
  if (!Array.isArray(units)) return [];

  return units.flatMap((raw): TracedUnit[] => {
    if (!raw || typeof raw !== "object") return [];
    const unit = raw as Record<string, unknown>;
    const gates = Array.isArray(unit.gates)
      ? (unit.gates.filter((g) => g && typeof g === "object") as GateVerdict[])
      : [];
    return [
      {
        id: typeof unit.id === "string" ? unit.id : "",
        path: typeof unit.path === "string" ? unit.path : "",
        outcome: typeof unit.outcome === "string" ? unit.outcome : "",
        gates,
      },
    ];
  });
}

/** Find the traced unit a skill selection refers to — same resolution the harness uses. */
export function findTracedUnit(
  units: readonly TracedUnit[],
  skill: SkillSelected,
): TracedUnit | undefined {
  return matchSkillUnit(units, skill);
}

/** Adjudicate a skill against its traced unit. */
export function admitSkill(unit: TracedUnit | undefined, skill: SkillSelected): SkillAdmission {
  if (!unit) {
    return {
      admitted: true,
      governed: false,
      reason: `no governed procedure declared for skill "${skill.skillName}" — admitted ungoverned`,
      failedGates: [],
    };
  }

  const failed = unit.gates.filter((g) => !g.passed);
  if (failed.length === 0) {
    return {
      admitted: true,
      governed: true,
      reason: `passed ${unit.gates.length} planner gate(s)`,
      failedGates: [],
    };
  }

  // The planner's detail is the evidence. Carry it verbatim.
  const written = failed.map((g) => `${g.gate}: ${g.detail ?? "failed"}`).join("; ");
  return {
    admitted: false,
    governed: true,
    reason: `skill "${skill.skillName}" refused by the planner — ${written}`,
    failedGates: failed.map((g) => g.gate),
  };
}
