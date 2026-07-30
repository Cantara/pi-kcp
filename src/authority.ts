/**
 * Runtime grant_ceiling — the §3.13 authority gate (RFC-0025).
 *
 * The runtime already reads a manifest's `authority_level_scale` and per-unit / per-step
 * `authority_level`, but it never resolved an EFFECTIVE ceiling from them, and so never
 * gated on it. This module is the missing arithmetic: it resolves the effective authority
 * as the MINIMUM across all of a decision's sources — step, playbook, task-type, tenant,
 * enacting agent — naming the source(s) that produced the binding value for the audit
 * trail, and fails closed when a required authority exceeds that ceiling.
 *
 * The reference math (`computeGrantCeiling` / `applyAuthorityCap`) lives in the KCP
 * validator (`knowledge-context-protocol/shared/src/validator.ts`); pi-kcp does not depend
 * on that package (its deps are `js-yaml` and `kcp-harness`), so the MIN is reimplemented
 * here faithfully to §3.13. The two rules that matter:
 *
 *   - "The effective authority level is the minimum across all resolved sources." A minimum
 *     cannot be raised by any single input, by construction — so no source needs special
 *     "may only lower" handling.
 *   - "A source that resolves outside the declared scale is non-binding" — an unknown level
 *     is silently ignored at runtime (§3.13, §7), never treated as the most restrictive.
 *
 * Everything fails closed. A required authority with no ceiling to authorize it is denied:
 * the absence of a declared ceiling is not itself a grant.
 */

/** The manifest-wide ordinal scale, lowest discretion first (§3.13). */
export type AuthorityLevelScale = readonly string[];

/**
 * One resolved input to the minimum. `level` is the authority this source permits; an
 * `undefined` level (a referenced entity that declares none) is non-binding, dropped from
 * the minimum rather than defaulted to the floor.
 */
export interface AuthoritySource {
  readonly id: string;
  readonly level?: string;
}

/** The effective ceiling and the source(s) that produced it. */
export interface EffectiveAuthority {
  /** The minimum across resolved sources, or `undefined` when none resolved. */
  readonly effectiveLevel?: string;
  /** Every source tied for the binding minimum — a capped result needs a named cause. */
  readonly bindingSourceIds: string[];
}

/** A fail-closed authority decision for one required-vs-ceiling check. */
export interface AuthorityDecision {
  readonly allowed: boolean;
  /** The authority the action demanded, echoed back. */
  readonly requiredLevel?: string;
  /** The effective ceiling the demand was checked against. */
  readonly effectiveLevel?: string;
  /** The source(s) that bound the ceiling — named on a denial for the audit trail. */
  readonly bindingSourceIds: string[];
  /** Written, specific reason — the runtime's own words, not a paraphrase. */
  readonly reason: string;
}

function rankOf(scale: AuthorityLevelScale): Map<string, number> {
  return new Map(scale.map((level, index) => [level, index]));
}

/**
 * The effective authority for a set of sources: the minimum across those that resolve to a
 * level on the declared scale, with every source tied for that minimum named (§3.13).
 *
 * Faithful to `computeGrantCeiling`: a source whose level is absent or off-scale is
 * non-binding and excluded from the minimum. When nothing resolves, the effective level is
 * `undefined` and no source is named — absence is not itself a grant.
 */
export function resolveEffectiveAuthority(
  scale: AuthorityLevelScale,
  sources: readonly AuthoritySource[],
): EffectiveAuthority {
  const rank = rankOf(scale);
  let minRank = Infinity;
  const resolved: Array<{ id: string; rank: number }> = [];

  for (const source of sources) {
    if (source.level === undefined || !rank.has(source.level)) continue; // non-binding
    const r = rank.get(source.level)!;
    resolved.push({ id: source.id, rank: r });
    if (r < minRank) minRank = r;
  }

  if (minRank === Infinity) return { effectiveLevel: undefined, bindingSourceIds: [] };
  return {
    effectiveLevel: scale[minRank],
    bindingSourceIds: resolved.filter((r) => r.rank === minRank).map((r) => r.id),
  };
}

/**
 * Gate a required authority against the effective ceiling resolved from `sources`. Fails
 * closed: a demand that exceeds the ceiling — or that has no ceiling to authorize it — is
 * denied, naming the binding source(s).
 *
 * - `requiredLevel` undefined → the unit demands no authority; nothing to gate, allowed.
 * - `requiredLevel` off the declared scale → silently ignored at runtime (§3.13), allowed;
 *   an unknown demand is not a grant to gate on, and gating on it would invent a policy.
 * - no source resolves → **denied**: the absence of a declared ceiling is not a grant.
 * - required rank > effective rank → **denied**, bound by the min source(s).
 * - otherwise allowed.
 */
export function authorityGate(
  scale: AuthorityLevelScale,
  requiredLevel: string | undefined,
  sources: readonly AuthoritySource[],
): AuthorityDecision {
  const rank = rankOf(scale);
  const { effectiveLevel, bindingSourceIds } = resolveEffectiveAuthority(scale, sources);

  if (requiredLevel === undefined) {
    return {
      allowed: true,
      requiredLevel,
      effectiveLevel,
      bindingSourceIds,
      reason: "no authority level demanded — authority gate not applicable",
    };
  }

  if (!rank.has(requiredLevel)) {
    return {
      allowed: true,
      requiredLevel,
      effectiveLevel,
      bindingSourceIds,
      reason: `required authority '${requiredLevel}' is not on the declared authority_level_scale — silently ignored at runtime (§3.13)`,
    };
  }

  if (effectiveLevel === undefined) {
    return {
      allowed: false,
      requiredLevel,
      effectiveLevel,
      bindingSourceIds,
      reason: `no authority ceiling resolved — a required authority of '${requiredLevel}' cannot be granted without a declared ceiling (fail-closed, §3.13)`,
    };
  }

  const requiredRank = rank.get(requiredLevel)!;
  const effectiveRank = rank.get(effectiveLevel)!;
  if (requiredRank > effectiveRank) {
    const bound = bindingSourceIds.length > 0 ? bindingSourceIds.join(", ") : "the effective ceiling";
    return {
      allowed: false,
      requiredLevel,
      effectiveLevel,
      bindingSourceIds,
      reason: `required authority '${requiredLevel}' exceeds the effective ceiling '${effectiveLevel}' — bound by [${bound}] (fail-closed, §3.13)`,
    };
  }

  return {
    allowed: true,
    requiredLevel,
    effectiveLevel,
    bindingSourceIds,
    reason: `required authority '${requiredLevel}' is within the effective ceiling '${effectiveLevel}'`,
  };
}
