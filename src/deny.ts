/**
 * Runtime negative scope — the RFC-0029 / KCP 0.31 `action_scope.deny` gate.
 *
 * `action_scope` gains an OPTIONAL negative-scope sibling `deny` with the same shape as the
 * allowlist: `{ tools?, paths?, capabilities? }`. A requested tool / path / capability that
 * MATCHES `deny` is REFUSED, and this refusal OVERRIDES any allow (deny-overrides,
 * deny-first, fail-closed). It is evaluated BEFORE the allowlist adjudication, so a token
 * that both an allow clause permits and a deny clause names is denied. An empty `deny`
 * object is a no-op.
 *
 * Path matching reuses the harness's `action_scope` path-glob semantics (the same matching
 * the allow side uses in kcp-harness `checkConformance`): a declared glob
 * (`**` crosses directory boundaries, `*`/`?` stay within one segment), a filesystem prefix
 * at a directory boundary, or — for a URL target — a raw prefix. Filesystem targets are
 * normalised first so a `../` traversal cannot slip past on its raw spelling. `normalizePath`
 * and `matchesPrefix` are reused from the harness; only the small glob compile is mirrored
 * here (the harness keeps it private).
 *
 * The reference implementation this mirrors lives in the KCP validator
 * (`knowledge-context-protocol` — `DenyScope`, `parseDenyScope`, `deniesToken`); the field
 * name and semantics match it exactly.
 *
 * RFC-0030 / KCP 0.32 (§4.3b) extends this with the UNION of deny sources — a playbook's
 * own `deny` composed with the used skill's, a match in either refusing the token
 * ({@link evaluateEffectiveDeny}, mirroring the reference `effectiveDeniesToken`) — and
 * with deny FINALITY: a deny-hit raises a notify-only {@link ProhibitedAttempt} event and
 * is never grantable.
 */

import { matchesPrefix, normalizePath } from "kcp-harness";

/** The three dimensions a deny clause may constrain. */
export type DenyDimension = "tools" | "paths" | "capabilities";

/**
 * A negative scope: tokens whose match REFUSES the action, overriding any allow. Same shape
 * as the allowlist. A dimension the deny does not declare refuses nothing on that facet.
 */
export interface DenyScope {
  /** Tool names that are refused (exact match, as the allowlist matches tools). */
  readonly tools?: string[];
  /** File-system / URL path globs that are refused (allowlist path-glob semantics). */
  readonly paths?: string[];
  /** Named capabilities that are refused (exact match). */
  readonly capabilities?: string[];
}

/** A single deny match — the dimension, the requested token, and the deny pattern that bound it. */
export interface DenyMatch {
  readonly dimension: DenyDimension;
  /** The requested tool / path / capability that was refused. */
  readonly token: string;
  /** The deny pattern that matched it. */
  readonly pattern: string;
  /** Written, specific reason naming the deny as the binding cause — the runtime's own words. */
  readonly reason: string;
}

/** The observed action's requested tokens, as the deny gate sees them. */
export interface DeniableAction {
  readonly tool: string;
  readonly paths?: string[];
  readonly urls?: string[];
  readonly capabilities?: string[];
}

/** An array of non-empty strings, or `undefined` when nothing usable was declared. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  return out.length > 0 ? out : undefined;
}

/**
 * Read the `deny` sibling off an `action_scope`. Returns `undefined` when there is no `deny`,
 * when it declares no usable dimension, or when it is not an object — an empty or absent deny
 * is a no-op. Malformed entries (non-string / empty) are dropped during parse; a dimension
 * left with nothing usable is treated as undeclared for that facet.
 */
export function parseDenyScope(actionScope: unknown): DenyScope | undefined {
  if (!actionScope || typeof actionScope !== "object") return undefined;
  const raw = (actionScope as { deny?: unknown }).deny;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const tools = stringArray(r.tools);
  const paths = stringArray(r.paths);
  const capabilities = stringArray(r.capabilities);
  if (!tools && !paths && !capabilities) return undefined; // empty deny → no-op
  const deny: DenyScope = {
    ...(tools ? { tools } : {}),
    ...(paths ? { paths } : {}),
    ...(capabilities ? { capabilities } : {}),
  };
  return deny;
}

/** A target with a URL scheme (`http://`, `https://`, …) is matched by raw prefix. */
function isUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * Compile one deny-path glob to a regex, mirroring the harness allow matcher: `**` crosses
 * directory boundaries, `*` and `?` stay within one segment. Anchored both ends.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${body}$`);
}

/**
 * Whether a path/URL target matches one of the deny patterns — the same matching the allow
 * side uses for `paths`. Returns the matching pattern, or `undefined` when none match.
 */
function matchingPathPattern(target: string, patterns: string[]): string | undefined {
  const norm = normalizePath(target);
  for (const p of patterns) {
    if (/[*?]/.test(p)) {
      if (globToRegExp(normalizePath(p)).test(norm)) return p;
    } else if (matchesPrefix(norm, normalizePath(p)) || (isUrl(target) && target.startsWith(p))) {
      return p;
    }
  }
  return undefined;
}

/**
 * Does `deny` refuse a single token on the given dimension? Tools and capabilities match by
 * exact membership (as the allowlist matches them); paths match by the allowlist path-glob
 * semantics. Returns the deny pattern that bound the refusal, or `undefined`.
 */
export function deniesToken(
  deny: DenyScope | undefined,
  dimension: DenyDimension,
  token: string,
): string | undefined {
  if (!deny) return undefined;
  const patterns = deny[dimension];
  if (!patterns || patterns.length === 0) return undefined;
  if (dimension === "paths") return matchingPathPattern(token, patterns);
  return patterns.includes(token) ? token : undefined;
}

function denialReason(dimension: DenyDimension, token: string, pattern: string, patterns: string[]): string {
  const noun = dimension === "tools" ? "tool" : dimension === "capabilities" ? "capability" : "target";
  return (
    `${noun} "${token}" is denied by action_scope.deny.${dimension} [${patterns.join(", ")}]` +
    ` (pattern "${pattern}") — deny overrides allow (fail-closed, RFC-0029)`
  );
}

/**
 * One declaration an effective deny is drawn from (RFC-0030 / KCP 0.32 §4.3b): the
 * playbook's own `action_scope.deny` or the used skill's. Named as the binding source in
 * the decision trace — the same auditing shape as the §3.13 grant_ceiling minimum.
 */
export interface DenySource {
  /** Where the deny was declared, e.g. `playbook:gdpr-deletion` or `skill:deletion-agent`. */
  readonly id: string;
  readonly deny: DenyScope | undefined;
}

/** A deny match adjudicated over the UNION of sources, naming every source that bound it. */
export interface EffectiveDenyMatch extends DenyMatch {
  /** The source(s) whose deny matched the token — both, when both match (§4.3b). */
  readonly bindingSourceIds: readonly string[];
}

/**
 * The notify-only prohibited-attempt event a deny-hit raises (RFC-0030). A deny is NEVER
 * grantable: the action is refused finally, and no response to this event — grant,
 * approval, or escalation, human or otherwise — may enact it. The only way past a deny is
 * a new, reviewed, signed manifest version that no longer declares it. `grantable` is the
 * literal `false` so no code path can type-correctly turn a prohibition into an approval.
 */
export interface ProhibitedAttempt {
  readonly record: "prohibited_attempt";
  readonly dimension: DenyDimension;
  readonly token: string;
  readonly pattern: string;
  readonly bindingSourceIds: readonly string[];
  readonly reason: string;
  readonly grantable: false;
}

function effectiveDenialReason(
  dimension: DenyDimension,
  token: string,
  pattern: string,
  sourceIds: readonly string[],
): string {
  const noun = dimension === "tools" ? "tool" : dimension === "capabilities" ? "capability" : "target";
  return (
    `${noun} "${token}" is denied by action_scope.deny.${dimension} of ${sourceIds.join(" and ")}` +
    ` (pattern "${pattern}") — deny overrides allow and is never grantable (fail-closed, RFC-0030 §4.3b)`
  );
}

/** The sources (with their matching patterns) whose deny refuses one token, in declaration order. */
function matchingSources(
  sources: readonly DenySource[],
  dimension: DenyDimension,
  token: string,
): Array<{ id: string; pattern: string }> {
  const out: Array<{ id: string; pattern: string }> = [];
  for (const source of sources) {
    const pattern = deniesToken(source.deny, dimension, token);
    if (pattern !== undefined) out.push({ id: source.id, pattern });
  }
  return out;
}

/**
 * Evaluate an observed action against the UNION of deny sources (RFC-0030 / §4.3b):
 * `effective_deny(step) = playbook.action_scope.deny ∪ uses(step).action_scope.deny`. A
 * token matching EITHER source is denied, deny-first in the same order as
 * {@link evaluateDeny} (tools, then every path/URL target, then every capability). Returns
 * the first refused token with EVERY source that bound it — the trace names both when both
 * match — or `undefined` when nothing is denied. Union is the only sound composition:
 * adding a source can only refuse more, never less (the scope-axis mirror of the §3.13
 * lowest-of rule).
 */
export function evaluateEffectiveDeny(
  sources: readonly DenySource[],
  action: DeniableAction,
): EffectiveDenyMatch | undefined {
  const bind = (dimension: DenyDimension, token: string): EffectiveDenyMatch | undefined => {
    const matched = matchingSources(sources, dimension, token);
    if (matched.length === 0) return undefined;
    const pattern = matched[0]!.pattern;
    const bindingSourceIds = matched.map((m) => m.id);
    return {
      dimension,
      token,
      pattern,
      bindingSourceIds,
      reason: effectiveDenialReason(dimension, token, pattern, bindingSourceIds),
    };
  };

  const byTool = bind("tools", action.tool);
  if (byTool) return byTool;

  for (const target of [...(action.paths ?? []), ...(action.urls ?? [])]) {
    const byPath = bind("paths", target);
    if (byPath) return byPath;
  }

  for (const cap of action.capabilities ?? []) {
    const byCapability = bind("capabilities", cap);
    if (byCapability) return byCapability;
  }

  return undefined;
}

/** Shape an effective deny match as the §17-style prohibited-attempt event it raises. */
export function prohibitedAttempt(match: EffectiveDenyMatch): ProhibitedAttempt {
  return {
    record: "prohibited_attempt",
    dimension: match.dimension,
    token: match.token,
    pattern: match.pattern,
    bindingSourceIds: match.bindingSourceIds,
    reason: match.reason,
    grantable: false,
  };
}

/**
 * Evaluate an observed action against a deny scope, deny-first: tools, then every path/URL
 * target, then every asserted capability. Returns the FIRST match — the binding refusal —
 * naming the deny as the reason, or `undefined` when nothing is denied.
 */
export function evaluateDeny(deny: DenyScope | undefined, action: DeniableAction): DenyMatch | undefined {
  if (!deny) return undefined;

  if (deny.tools) {
    const pattern = deniesToken(deny, "tools", action.tool);
    if (pattern !== undefined) {
      return { dimension: "tools", token: action.tool, pattern, reason: denialReason("tools", action.tool, pattern, deny.tools) };
    }
  }

  if (deny.paths) {
    for (const target of [...(action.paths ?? []), ...(action.urls ?? [])]) {
      const pattern = deniesToken(deny, "paths", target);
      if (pattern !== undefined) {
        return { dimension: "paths", token: target, pattern, reason: denialReason("paths", target, pattern, deny.paths) };
      }
    }
  }

  if (deny.capabilities) {
    for (const cap of action.capabilities ?? []) {
      const pattern = deniesToken(deny, "capabilities", cap);
      if (pattern !== undefined) {
        return { dimension: "capabilities", token: cap, pattern, reason: denialReason("capabilities", cap, pattern, deny.capabilities) };
      }
    }
  }

  return undefined;
}
