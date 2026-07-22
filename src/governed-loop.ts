/**
 * Governed-loop skeleton (#27, scaffolding).
 *
 * A small orchestration unit that:
 *   - mints/holds a per-turn correlation id (W3C traceparent, #29),
 *   - observes skill selection (#28) and remembers the active skill for the turn,
 *   - evaluates each `tool_call` against an injectable {@link ConformanceChecker} and
 *     blocks non-conformant calls before they execute,
 *   - composes recall → plan → emit events → publish, threading the correlation id.
 *
 * The conformance logic itself is out of scope (typed seam only). Everything that talks to
 * kcp-agent / kcp-memory is injected so the loop stays testable without those services.
 */

import { type ConformanceChecker, type ConformanceContext, type ObservedAction, passThroughChecker } from "./conformance.js";
import { childContext, mintTraceparent, type TurnContext } from "./correlation.js";
import { detectAgentSkillLoad, detectForcedSkill, type SkillSelected } from "./skill-detection.js";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/** Result of evaluating a tool call: `block` mirrors Pi's ToolCallEventResult. */
export interface GovernanceDecision {
  readonly block: boolean;
  readonly reason?: string;
}

/** Emitted after a deterministic knowledge plan is produced for the turn. */
export interface PlanProduced {
  readonly intent: string;
  readonly plan: string;
  readonly correlationId: string;
}

/** Injected side-effect surface so the loop can be exercised without live services. */
export interface GovernedLoopHooks {
  /** Notified whenever a skill is selected (agent-loaded or user-forced). */
  onSkillSelected?: (event: SkillSelected) => void;
  /** Notified whenever a plan is produced by the governed orchestration. */
  onPlanProduced?: (event: PlanProduced) => void;
  /** Notified whenever a tool call is blocked as non-conformant. */
  onBlocked?: (action: ObservedAction, reason: string) => void;
}

export interface GovernedLoopOptions {
  /** The conformance seam. Defaults to the allow-all pass-through checker. */
  checker?: ConformanceChecker;
  hooks?: GovernedLoopHooks;
}

/** Injected async dependencies for {@link GovernedLoop.orchestrate}. */
export interface OrchestrationDeps {
  recall: (query: string, correlationId: string) => Promise<string>;
  runPlan: (intent: string, correlationId: string) => Promise<string>;
  publish: (title: string, content: string, correlationId: string) => void;
}

export interface OrchestrationInput {
  intent: string;
  /** Optional recall query; when omitted, recall is skipped. */
  recallQuery?: string;
}

export interface OrchestrationOutcome {
  correlationId: string;
  recallBlock?: string;
  plan?: string;
  skill?: SkillSelected;
}

export class GovernedLoop {
  private readonly checker: ConformanceChecker;
  private readonly hooks: GovernedLoopHooks;
  private turn: TurnContext;
  private activeSkill: SkillSelected | undefined;

  constructor(options: GovernedLoopOptions = {}) {
    this.checker = options.checker ?? passThroughChecker;
    this.hooks = options.hooks ?? {};
    this.turn = mintTraceparent();
  }

  /** Start a new turn: mint a fresh correlation id and clear the active skill. */
  beginTurn(turnIndex?: number): TurnContext {
    this.turn = mintTraceparent(turnIndex);
    this.activeSkill = undefined;
    return this.turn;
  }

  /** The current turn's correlation context. */
  get turnContext(): TurnContext {
    return this.turn;
  }

  /** The current turn's correlation id (W3C traceparent). */
  currentCorrelationId(): string {
    return this.turn.correlationId;
  }

  /** The skill currently active for this turn, if any. */
  currentSkill(): SkillSelected | undefined {
    return this.activeSkill;
  }

  /** Record a skill selection and emit it. Used by both input and tool_call detection. */
  private noteSkillSelected(event: SkillSelected): void {
    this.activeSkill = event;
    this.hooks.onSkillSelected?.(event);
  }

  /**
   * Observe a user input line for a `/skill:<name>` forced-skill selection.
   * Returns the SkillSelected when detected (also emitted via hooks).
   */
  observeInput(text: string, commands: readonly SlashCommandInfo[] = []): SkillSelected | undefined {
    const forced = detectForcedSkill(text, commands);
    if (forced) this.noteSkillSelected(forced);
    return forced;
  }

  /**
   * Evaluate a tool call at the governance boundary.
   *  - detects agent skill loads (read of SKILL.md) and records them,
   *  - builds an {@link ObservedAction} stamped with the turn correlation id + skill context,
   *  - runs the injected conformance checker,
   *  - returns a block decision when the checker deems the action non-conformant.
   */
  async evaluateToolCall(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ConformanceContext,
    commands: readonly SlashCommandInfo[] = [],
  ): Promise<GovernanceDecision> {
    const skillLoad = detectAgentSkillLoad(toolName, input, commands);
    if (skillLoad) this.noteSkillSelected(skillLoad);

    const action: ObservedAction = {
      toolName,
      input,
      correlationId: this.currentCorrelationId(),
      ...(this.activeSkill ? { skillContext: this.activeSkill } : {}),
    };

    const verdict = await this.checker.check(action, ctx);
    if (!verdict.conformant) {
      this.hooks.onBlocked?.(action, verdict.reason);
      return { block: true, reason: verdict.reason };
    }
    return { block: false };
  }

  /**
   * Compose recall → plan → emit events → publish for one governed intent, threading a
   * per-action correlation id derived from the current turn. This is the scaffolding the
   * Wave 3 conformance API and richer governance will build on; it deliberately keeps the
   * existing recall/plan implementations injectable.
   */
  async orchestrate(deps: OrchestrationDeps, input: OrchestrationInput): Promise<OrchestrationOutcome> {
    const action = childContext(this.turn);
    const correlationId = action.correlationId;
    const outcome: OrchestrationOutcome = { correlationId };
    if (this.activeSkill) outcome.skill = this.activeSkill;

    if (input.recallQuery) {
      const block = await deps.recall(input.recallQuery, correlationId);
      if (block) {
        outcome.recallBlock = block;
        deps.publish("KCP recall", block, correlationId);
      }
    }

    const plan = await deps.runPlan(input.intent, correlationId);
    outcome.plan = plan;
    this.hooks.onPlanProduced?.({ intent: input.intent, plan, correlationId });
    deps.publish("KCP plan", plan, correlationId);

    return outcome;
  }
}
