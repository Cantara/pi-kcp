/**
 * Real conformance checker backed by kcp-harness@0.8.0 (#28 enforcement, Wave 3).
 *
 * The seam ({@link ConformanceChecker}) stays a pure typed interface; this module is the
 * first non-pass-through implementation. On each observed tool call it:
 *
 *   1. resolves the *active skill's* declared `action_scope` (the tools/paths/capabilities
 *      the loaded skill is permitted to touch), and
 *   2. adjudicates the action against that scope with the harness's pure, no-LLM
 *      {@link checkConformance} — the SAME deterministic decision the harness proxy makes.
 *
 * Conformance bounds a *skill's* actions. By default it therefore engages only when a skill
 * is active: with no skill loaded the action is unscoped/general and passes conformance (it is
 * still governed by the other gates + approval, which conformance does not replace). Once a
 * skill is active, enforcement is fail-closed and consistent with the harness: an unresolvable
 * scope or a scope that declares nothing → nothing is authorized and the action is held.
 *
 * Strict mode ({@link HarnessConformanceOptions.requireActiveSkill}, default `false`) restores
 * the fail-closed-when-no-skill behavior for high-assurance autonomous agents that should only
 * ever act within a declared skill.
 *
 * Scope resolution — how `action_scope` is obtained today:
 *   kcp-agent's `plan --json` / `plan --trace --json` do NOT currently surface a planned
 *   unit's `action_scope` (neither `PlannedUnit` nor `UnitTrace` carry it as of kcp-agent
 *   0.16). So the resolver reads the skill unit's `action_scope` directly from the project
 *   manifest (`knowledge.yaml`) — the same field the harness governor reads. See
 *   {@link ManifestScopeResolver}. When kcp-agent begins emitting `action_scope` in its plan
 *   JSON, a CLI-backed resolver can replace the direct read behind this same interface.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  checkConformance as harnessCheckConformance,
  extractTargets,
  type ActionScope,
  type ObservedAction as HarnessObservedAction,
} from "kcp-harness";
import type {
  ConformanceChecker,
  ConformanceContext,
  ConformanceResult,
  ObservedAction,
} from "./conformance.js";
import { evaluateEffectiveDeny, parseDenyScope, prohibitedAttempt } from "./deny.js";
import type { SkillSelected } from "./skill-detection.js";

/** The pure adjudicator's signature — injectable so tests can spy on the harness call. */
export type CheckConformanceFn = typeof harnessCheckConformance;

/** Resolves the declared `action_scope` for the skill active on an observed action. */
export interface ScopeResolver {
  /**
   * @returns the skill's declared scope, or `undefined` when no scope is resolvable
   * (unknown skill, no `action_scope`, unreadable manifest) — the checker then fail-closes.
   */
  resolve(skill: SkillSelected, ctx: ConformanceContext): Promise<ActionScope | undefined>;
}

export interface HarnessConformanceOptions {
  /** Manifest filename resolved against the session cwd. Default `knowledge.yaml`. */
  manifest?: string;
  /** Injectable scope resolver. Default reads the skill unit's `action_scope` from the manifest. */
  resolveScope?: ScopeResolver;
  /** Injectable adjudicator. Default: the real, pure harness `checkConformance`. */
  check?: CheckConformanceFn;
  /**
   * Strict mode (default `false`). When `true`, an action taken with **no active skill** is
   * fail-closed (held for review) instead of passing through. For high-assurance autonomous
   * agents that should only ever act within a declared skill's `action_scope`.
   */
  requireActiveSkill?: boolean;
}

const DEFAULT_MANIFEST = "knowledge.yaml";

/** Input keys pi tools use to name a filesystem target (pi `read` uses `path`). */
const PI_PATH_KEYS = ["path", "file_path", "filePath"] as const;
/** Input keys pi tools use to name a URL target. */
const PI_URL_KEYS = ["url"] as const;

function collectStrings(input: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

/**
 * Map a pi {@link ObservedAction} to the harness {@link HarnessObservedAction} shape.
 *
 * `tool` is the runtime tool name verbatim, so the scope's `tools` allowlist is checked
 * against the names skills actually declare. Targets are gathered pi-natively (lowercase
 * tools, `path`/`file_path`/`url` keys) AND via the harness's own extractors (Claude-Code
 * capitalized names, bash-command sniffing) so both conventions are covered.
 */
export function toHarnessAction(action: ObservedAction): HarnessObservedAction {
  const paths = new Set(collectStrings(action.input, PI_PATH_KEYS));
  const urls = new Set(collectStrings(action.input, PI_URL_KEYS));

  const extracted = extractTargets(action.toolName, action.input);
  for (const path of extracted.paths) paths.add(path);
  for (const url of extracted.urls) urls.add(url);

  const harnessAction: HarnessObservedAction = { tool: action.toolName };
  if (paths.size > 0) harnessAction.paths = [...paths];
  if (urls.size > 0) harnessAction.urls = [...urls];
  // A purchase facet passes straight through so the harness adjudicates it against
  // the skill's declared `spend` envelope (#139) with the same deterministic decision.
  if (action.purchase) harnessAction.purchase = { ...action.purchase };
  return harnessAction;
}

/** The subset of a KCP manifest unit this resolver reads. */
interface ManifestUnit {
  id?: unknown;
  path?: unknown;
  kind?: unknown;
  action_scope?: ActionScope;
}

interface ParsedManifest {
  units?: unknown;
}

function normalizeUnitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

/** Loose path overlap — mirrors the harness governor's skill/unit path matching. */
function pathOverlaps(target: string, unitPath: string): boolean {
  const a = normalizeUnitPath(target);
  const b = normalizeUnitPath(unitPath);
  return a === b || a.endsWith(`/${b}`) || a.endsWith(b) || b.endsWith(`/${a}`);
}

/**
 * Find the manifest unit an observed skill selection refers to. Prefers an exact `id`
 * match (the harness's own resolution key), then falls back to a loose overlap between the
 * `SKILL.md` path the agent read and a unit's declared `path`.
 */
export function matchSkillUnit<T extends { id?: unknown; path?: unknown }>(
  units: readonly T[],
  skill: SkillSelected,
): T | undefined {
  const name = skill.skillName.toLowerCase();
  const byId = units.find((unit) => typeof unit.id === "string" && unit.id.toLowerCase() === name);
  if (byId) return byId;
  return units.find((unit) => typeof unit.path === "string" && pathOverlaps(skill.skillPath, unit.path));
}

/**
 * Default resolver: read the active skill's `action_scope` directly from the project
 * manifest (`knowledge.yaml`). This is the working path today because kcp-agent's plan
 * JSON does not yet expose a planned unit's `action_scope` (see module doc).
 */
export class ManifestScopeResolver implements ScopeResolver {
  constructor(private readonly manifestName: string = DEFAULT_MANIFEST) {}

  async resolve(skill: SkillSelected, ctx: ConformanceContext): Promise<ActionScope | undefined> {
    const manifestPath = resolve(ctx.cwd, this.manifestName);
    const raw = await readFile(manifestPath, "utf8");
    const parsed = loadYaml(raw) as ParsedManifest | undefined;
    const units = Array.isArray(parsed?.units) ? (parsed.units as ManifestUnit[]) : [];
    const unit = matchSkillUnit(units, skill);
    return unit?.action_scope;
  }
}

/**
 * A conformance checker that adjudicates each action against the active skill's declared
 * `action_scope` using the harness's deterministic {@link checkConformance}.
 */
export class HarnessConformanceChecker implements ConformanceChecker {
  private readonly resolver: ScopeResolver;
  private readonly adjudicate: CheckConformanceFn;
  /**
   * Strict mode: when `true`, an action with no active skill is fail-closed. Mutable so the
   * built-in checker can pick the value up from `.pi/kcp.json` at the turn boundary; embedders
   * that pin it via `RegisterOptions`/constructor options should treat it as fixed.
   */
  requireActiveSkill: boolean;
  /** Resolved scope per active skill (keyed by cwd + skill path). */
  private readonly scopeCache = new Map<string, ActionScope | undefined>();

  constructor(options: HarnessConformanceOptions = {}) {
    this.resolver = options.resolveScope ?? new ManifestScopeResolver(options.manifest ?? DEFAULT_MANIFEST);
    this.adjudicate = options.check ?? harnessCheckConformance;
    this.requireActiveSkill = options.requireActiveSkill ?? false;
  }

  async check(action: ObservedAction, ctx: ConformanceContext): Promise<ConformanceResult> {
    const skill = action.skillContext;
    if (!skill) {
      // Conformance bounds a skill's actions. With no skill active the action is
      // unscoped/general — conformance passes and defers to the other gates + approval.
      if (!this.requireActiveSkill) {
        return {
          conformant: true,
          reason: `no active skill — conformance not applicable; "${action.toolName}" deferred to the other gates`,
        };
      }
      // Strict mode: only ever act within a declared skill → fail-closed with no skill.
      return {
        conformant: false,
        reason: `no active skill — fail-closed (requireActiveSkill); action "${action.toolName}" is held for review`,
      };
    }

    const scope = await this.resolveScopeCached(skill, ctx);
    const harnessAction = toHarnessAction(action);

    // Deny-first (RFC-0029 / KCP 0.31): a requested tool/path/capability that matches the
    // scope's negative-space `deny` sibling is REFUSED, and this refusal OVERRIDES any allow
    // (and any grant) — it is evaluated before the allowlist adjudication and fails closed,
    // naming the deny as the binding source. Per RFC-0030 (KCP 0.32) the refusal is FINAL:
    // it travels with the notify-only prohibited-attempt event, which no approval enacts.
    const denial = evaluateEffectiveDeny(
      [{ id: `skill:${skill.skillName}`, deny: parseDenyScope(scope) }],
      harnessAction,
    );
    if (denial) return { conformant: false, reason: denial.reason, prohibited: prohibitedAttempt(denial) };

    // An unresolved scope becomes `{}`; the harness fail-closes on a scope that declares nothing.
    const verdict = this.adjudicate(harnessAction, scope ?? {});
    return { conformant: verdict.passed, reason: verdict.reason };
  }

  private async resolveScopeCached(skill: SkillSelected, ctx: ConformanceContext): Promise<ActionScope | undefined> {
    const key = `${ctx.cwd}\u0000${skill.skillPath}`;
    if (this.scopeCache.has(key)) return this.scopeCache.get(key);

    let scope: ActionScope | undefined;
    try {
      scope = await this.resolver.resolve(skill, ctx);
    } catch {
      // Unreadable/absent manifest → nothing authorized (fail-closed).
      scope = undefined;
    }
    this.scopeCache.set(key, scope);
    return scope;
  }
}
