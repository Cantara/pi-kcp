/**
 * Conformance seam (the typed interface, NOT the logic).
 *
 * This is the enforcement point that the kcp-harness conformance API (Wave 3) will
 * implement. pi-kcp ships only the seam plus a default allow-all `PassThroughChecker`.
 * The governed loop calls the injected checker at the `tool_call` boundary; a
 * non-conformant verdict blocks the tool call before it executes.
 */

import type { ProhibitedAttempt } from "./deny.js";
import type { SkillSelected } from "./skill-detection.js";

/** A tool call observed at the governance boundary, with its correlation and skill context. */
export interface ObservedAction {
  /** The tool being invoked (e.g. "read", "bash", or a custom tool name). */
  readonly toolName: string;
  /** The (possibly already-mutated) tool arguments. */
  readonly input: Record<string, unknown>;
  /** W3C traceparent correlating this action with its turn / recall / plan / messages. */
  readonly correlationId: string;
  /** The skill this action is being taken under, when one is active. */
  readonly skillContext?: SkillSelected;
  /**
   * A governed spend of value this action performs (#139) — present only for a buy: the
   * vendor paid, the amount, and the currency. When set and the active skill declares a
   * `spend` envelope, the purchase is adjudicated against it (vendor / currency / max_spend).
   * Mapped through to the harness {@link ObservedAction.purchase} by `toHarnessAction`.
   */
  readonly purchase?: {
    readonly vendor: string;
    readonly amount: number;
    readonly currency: string;
  };
}

/** Context handed to a checker alongside the action (kept minimal and forward-compatible). */
export interface ConformanceContext {
  /** Current working directory of the session. */
  readonly cwd: string;
}

/** The verdict a checker returns for an observed action. */
export interface ConformanceResult {
  readonly conformant: boolean;
  readonly reason: string;
  /**
   * Present iff an `action_scope.deny` bound the refusal (RFC-0029/RFC-0030): the
   * notify-only prohibited-attempt event. Unlike an ordinary non-conformant hold, a
   * prohibited action is refused FINALLY — no grant, approval, or escalation outcome may
   * enact it (§4.3b v0.32).
   */
  readonly prohibited?: ProhibitedAttempt;
}

/**
 * The injectable conformance seam. Wave 3's kcp-harness API implements this; until then the
 * default is {@link PassThroughChecker}. Keep this interface stable — it is the contract.
 */
export interface ConformanceChecker {
  check(action: ObservedAction, ctx: ConformanceContext): Promise<ConformanceResult>;
}

/** Default allow-all checker used when no conformance policy is wired in. */
export class PassThroughChecker implements ConformanceChecker {
  async check(): Promise<ConformanceResult> {
    return { conformant: true, reason: "pass-through: no conformance policy loaded" };
  }
}

/** Shared singleton for the common no-op case. */
export const passThroughChecker: ConformanceChecker = new PassThroughChecker();
