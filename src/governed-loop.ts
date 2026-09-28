/**
 * Governed-loop skeleton (#27, scaffolding).
 *
 * A small orchestration unit that:
 *   - mints/holds a per-turn correlation id (W3C traceparent, #29),
 *   - observes skill selection (#28) and remembers the active skill for the PROMPT
 *     (`input` … `agent_settled`), not just the Pi turn/round it was selected in (#67, #71),
 *   - checks a SKILL.md read against the skill already in force before letting it swap in,
 *     with a user-forced selection taking precedence over an agent-driven one (#70),
 *   - evaluates each `tool_call` against an injectable {@link ConformanceChecker} and
 *     blocks non-conformant calls before they execute,
 *   - composes recall → plan → emit events → publish, threading the correlation id.
 *
 * The conformance logic itself is out of scope (typed seam only). Everything that talks to
 * kcp-agent / kcp-memory is injected so the loop stays testable without those services.
 */

import { type ConformanceChecker, type ConformanceContext, type ObservedAction, passThroughChecker } from "./conformance.js";
import type { ProhibitedAttempt } from "./deny.js";
import { childContext, mintTraceparent, type TurnContext } from "./correlation.js";
import {
  erroredStages,
  expectedStagesFor,
  type GovernanceMode,
  type Stage,
  type StageOutcome,
  TurnLedger,
  type TurnRecord,
  ungovernedReason,
} from "./runtime.js";
import { digest } from "./evidence.js";
import { admitSkill, findTracedUnit, type SkillAdmission, type TracedUnit } from "./skill-gate.js";
import { detectAgentSkillLoad, detectForcedSkill, type SkillSelected } from "./skill-detection.js";
import {
  DEMO_SIGNING_KEY_ID,
  DEMO_SIGNING_KEY_PEM,
  MockPaymentExecutor,
  MockWallet,
  type PaymentExecutor,
  type PaymentReceipt,
  type PaymentRequestFn,
  type PaymentRequirements,
  purchaseFromRequirements,
  requirementsFromPurchase,
  type WalletProvider,
} from "./wallet.js";
import {
  buildPurchaseEvent,
  signPurchaseReceipt,
  type AuditEvent,
  type PurchaseReceiptPayload,
  type PurchaseReceiptSignature,
} from "kcp-harness";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/** Result of evaluating a tool call: `block` mirrors Pi's ToolCallEventResult. */
export interface GovernanceDecision {
  readonly block: boolean;
  readonly reason?: string;
  /**
   * Present iff a `deny` bound the refusal (RFC-0030): the notify-only prohibited-attempt
   * event. The block is FINAL — the loop refuses to record any approval for the action, so
   * no escalation path can turn it into an enactment.
   */
  readonly prohibited?: ProhibitedAttempt;
}

/** Emitted after a deterministic knowledge plan is produced for the turn. */
export interface PlanProduced {
  readonly intent: string;
  readonly plan: string;
  readonly correlationId: string;
}

/** A purchase intent detected on a direct-buy tool call, or recovered from x402 requirements. */
export type PurchaseIntent = { vendor: string; amount: number; currency: string };

/**
 * The outcome of a settled, conformant purchase: the settlement receipt, the harness-signed
 * purchase receipt binding it, and the `purchase_settled`-shaped audit event handed to
 * `onSettled`.
 */
export interface SettlementResult {
  /** The executor's settlement receipt (network / txHash / settledAt). */
  readonly settlement: PaymentReceipt;
  /** The canonical purchase-receipt payload the signature commits to. */
  readonly receipt: PurchaseReceiptPayload;
  /** The detached ed25519 signature over the receipt (demo key in the default path). */
  readonly signature: PurchaseReceiptSignature;
  /** The `purchase_settled` audit event (also delivered to the `onSettled` hook). */
  readonly event: AuditEvent;
}

/** Detect a direct-buy purchase carried on a tool call's input (`{vendor, amount, currency}`). */
export function detectPurchase(input: Record<string, unknown>): PurchaseIntent | undefined {
  const { vendor, amount, currency } = input;
  if (
    typeof vendor === "string" && vendor.length > 0 &&
    typeof amount === "number" && Number.isFinite(amount) &&
    typeof currency === "string" && currency.length > 0
  ) {
    return { vendor, amount, currency };
  }
  return undefined;
}

/** Injected side-effect surface so the loop can be exercised without live services. */
export interface GovernedLoopHooks {
  /** Notified whenever a skill is selected (agent-loaded or user-forced). */
  onSkillSelected?: (event: SkillSelected) => void;
  /** Notified whenever a plan is produced by the governed orchestration. */
  onPlanProduced?: (event: PlanProduced) => void;
  /**
   * Notified when a skill is refused by the planner's gates (#28) — stale, out-of-audience,
   * deprecated, superseded. `reason` carries the planner's own words.
   */
  onSkillRefused?: (skill: SkillSelected, reason: string, admission: SkillAdmission) => void;
  /** Notified whenever a tool call is blocked as non-conformant. */
  onBlocked?: (action: ObservedAction, reason: string) => void;
  /**
   * Notified when a deny-hit refuses an action (RFC-0030) — the §17-style
   * prohibited-attempt event, raised IN ADDITION to `onBlocked`. Notify-only: repeated
   * attempts to do forbidden things is a governance signal, and the signal is only
   * trustworthy because no response to this event can enact the refused action.
   */
  onProhibitedAttempt?: (action: ObservedAction, event: ProhibitedAttempt) => void;
  /**
   * Notified whenever a conformant purchase settles — the mirror of `onBlocked` on the spend
   * path. `event` is the `purchase_settled` audit event carrying the signed receipt (#139).
   */
  onSettled?: (action: ObservedAction, event: AuditEvent) => void;
  /** Notified at `finishTurn` with the turn's complete stage record (#27). */
  onTurnRecorded?: (record: TurnRecord) => void;
  /**
   * Notified at `finishTurn` when the turn was *not* governed — a stage gate broke, or a
   * stage never reported. Pi swallows handler exceptions, so without this the turn would
   * simply look fine. See docs/decisions/0003-governed-runtime.md.
   */
  onUngoverned?: (record: TurnRecord, reason: string) => void;
}

export interface GovernedLoopOptions {
  /** The conformance seam. Defaults to the allow-all pass-through checker. */
  checker?: ConformanceChecker;
  hooks?: GovernedLoopHooks;
  /** The wallet seam used to authorize spends. Defaults to a deterministic {@link MockWallet}. */
  wallet?: WalletProvider;
  /** The payment-execution seam. Defaults to a {@link MockPaymentExecutor} over `wallet`. */
  executor?: PaymentExecutor;
  /** PKCS8 PEM key used to sign settlement receipts. Defaults to the demo key. */
  signingKeyPem?: string;
  /** Key id recorded on signed receipts. Defaults to the demo key id. */
  signingKeyId?: string;
  /** Session id stamped on settlement audit events. Defaults to `"pi-kcp-session"`. */
  sessionId?: string;
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

/** How many completed turn records {@link GovernedLoop} keeps for inspection. */
export const TURN_HISTORY_LIMIT = 20;

export class GovernedLoop {
  private readonly checker: ConformanceChecker;
  private readonly hooks: GovernedLoopHooks;
  private readonly wallet: WalletProvider;
  private readonly executor: PaymentExecutor;
  private readonly signingKeyPem: string;
  private readonly signingKeyId: string;
  private readonly sessionId: string;
  private sequence = 0;
  private turn: TurnContext;
  /**
   * The skill selection in force for the current PROMPT (`input` … `agent_settled`), not
   * the current Pi turn — whether user-forced (`/skill:<name>`) or agent-driven (a
   * `SKILL.md` read).
   *
   * Precedence: a user-forced selection holds until a planner-gate revocation
   * ({@link setTracedUnits}) or the prompt ends ({@link endPrompt}); an agent-driven read
   * only fills this slot when no user force is already in effect (#70 — an agent must not
   * silently displace a deliberate `/skill:` choice; see {@link noteSkillSelected}).
   *
   * {@link beginTurn} does NOT touch this — a Pi turn is one LLM round, and `turn_start`
   * fires again for every round of the same prompt (retries and `continue()` included, via
   * `agent_end` with no new `input` — see docs/extensions.md's agent lifecycle). The
   * genuine boundaries are `input` (a real new prompt clears/replaces it —
   * {@link observeInput}, skipped for a mid-run steer/follow-up) and `agent_settled` (the
   * prompt is truly over — {@link endPrompt}). #67/#71 are two turn/run-scoped stand-ins
   * for this same prompt boundary that predate this field's current lifetime.
   */
  private activeSkill: SkillSelected | undefined;
  private ledger: TurnLedger;
  /** Input digests of tool calls approved this turn, keyed by Pi's toolCallId. */
  private approvals = new Map<string, string>();
  /**
   * Input digests refused by a deny this turn (RFC-0030). {@link noteApproval} refuses to
   * record an approval for any of them, so a prohibited action structurally cannot become
   * an approved one — an execution of it is a violation, never an enactment.
   */
  private prohibitedDigests = new Set<string>();
  /** Recent completed turn records, oldest first. Bounded — this is a window, not a store. */
  private history: TurnRecord[] = [];
  /**
   * The planner's traced units for the current PROMPT (#69) — set once at the plan stage
   * (`before_agent_start`), not cleared per turn, and consulted by every selection made
   * anywhere in the prompt, in whatever round. Cleared at {@link endPrompt}.
   */
  private tracedUnits: TracedUnit[] | undefined;
  /** How much of the cycle this turn is accountable for. */
  private mode: GovernanceMode = "full";

  constructor(options: GovernedLoopOptions = {}) {
    this.checker = options.checker ?? passThroughChecker;
    this.hooks = options.hooks ?? {};
    this.wallet = options.wallet ?? new MockWallet();
    this.executor = options.executor ?? new MockPaymentExecutor(this.wallet);
    this.signingKeyPem = options.signingKeyPem ?? DEMO_SIGNING_KEY_PEM;
    this.signingKeyId = options.signingKeyId ?? DEMO_SIGNING_KEY_ID;
    this.sessionId = options.sessionId ?? "pi-kcp-session";
    this.turn = mintTraceparent();
    this.ledger = new TurnLedger({ turnIndex: 0, correlationId: this.turn.correlationId });
  }

  /** The governance mode in force for the turn now in progress. */
  currentMode(): GovernanceMode {
    return this.mode;
  }

  /**
   * Start a new Pi turn (one LLM round): mint a fresh correlation id and open a ledger
   * scoped to what `mode` is accountable for. Resets only ROUND artifacts — the
   * correlation id, the ledger, this round's approvals and prohibited-input record.
   *
   * Does NOT touch {@link activeSkill} or {@link tracedUnits}: both are prompt-scoped, and
   * `turn_start` is not a prompt boundary — it fires again for every round of the same
   * prompt, including a retry or `continue()` after `agent_end` with no new `input` in
   * between (#71). Clearing and re-selecting them here was the #67/#71 workaround; the
   * actual prompt boundaries are `input` ({@link observeInput}) and `agent_settled`
   * ({@link endPrompt}).
   */
  beginTurn(turnIndex?: number, mode: GovernanceMode = "full"): TurnContext {
    this.turn = mintTraceparent(turnIndex);
    this.mode = mode;
    this.ledger = new TurnLedger({
      turnIndex: turnIndex ?? 0,
      correlationId: this.turn.correlationId,
      expectedStages: expectedStagesFor(mode),
    });
    this.approvals.clear();
    this.prohibitedDigests.clear();
    return this.turn;
  }

  /**
   * Run one stage of the governed cycle, recording its outcome. Never throws — see
   * {@link TurnLedger.run} for why an error must not reach Pi.
   */
  async stage(stage: Stage, body: () => Promise<StageOutcome | void>): Promise<void> {
    await this.ledger.run(stage, body);
  }

  /**
   * Recent completed turns, oldest first, capped at {@link TURN_HISTORY_LIMIT}. A window
   * for inspection — durable evidence belongs in the harness audit log, not in memory.
   */
  recentTurns(): readonly TurnRecord[] {
    return this.history;
  }

  /** The current turn's stage record. */
  turnRecord(): TurnRecord {
    return this.ledger.record();
  }

  /**
   * Whether the runtime's own gate is intact for this turn — no stage has errored yet.
   * Once false, the runtime cannot claim to know what is authorized, which is what the
   * fail-closed posture acts on. Resets at {@link beginTurn}.
   */
  gateHealthy(): boolean {
    return erroredStages(this.ledger.record()).length === 0;
  }

  /**
   * Remember what a tool call looked like when it was approved, keyed by Pi's
   * `toolCallId`. Cleared at {@link beginTurn}.
   *
   * A deny is never grantable (RFC-0030): an input a deny refused this turn cannot be
   * approved, whoever asks — the call is dropped, not recorded, so {@link checkExecuted}
   * reports any execution of it as a violation. The block posture on a deny-hit is not
   * convertible to announce/proceed by any escalation or approval outcome.
   */
  noteApproval(toolCallId: string, inputDigest: string): void {
    if (this.prohibitedDigests.has(inputDigest)) return;
    this.approvals.set(toolCallId, inputDigest);
  }

  /**
   * Compare a tool call as executed against the input this loop approved.
   *
   * Pi hands `beforeToolCall` and `afterToolCall` the same args object and invites
   * extensions to modify a call by mutating it in place, so a call can genuinely change
   * between approval and execution. When it does, the approval no longer describes what
   * ran — and the turn is not governed however healthy every gate looked.
   *
   * An unrecognised `toolCallId` is a violation too: something executed without passing
   * the gate at all.
   */
  checkExecuted(toolCallId: string, executedInput: unknown): StageOutcome {
    const executedDigest = digest(executedInput);
    const approvedDigest = this.approvals.get(toolCallId);

    if (approvedDigest === undefined) {
      return {
        status: "violated",
        reason: `tool call ${toolCallId} executed with no recorded approval`,
        detail: { toolCallId, executedDigest },
      };
    }
    if (approvedDigest !== executedDigest) {
      return {
        status: "violated",
        reason: `input for ${toolCallId} differs from what was approved — the call was modified after the gate`,
        detail: { toolCallId, approvedDigest, executedDigest },
      };
    }
    return { detail: { toolCallId, inputDigest: executedDigest } };
  }

  /**
   * Close the turn: emit its stage record and, when the cycle did not complete under
   * governance, say so explicitly. A turn that quietly skipped the gate is the failure
   * mode this exists to make impossible.
   */
  finishTurn(): TurnRecord {
    const record = this.ledger.record();
    this.history.push(record);
    if (this.history.length > TURN_HISTORY_LIMIT) this.history.shift();
    this.hooks.onTurnRecorded?.(record);
    const reason = ungovernedReason(record);
    if (reason) this.hooks.onUngoverned?.(record, reason);
    return record;
  }

  /** The current turn's correlation context. */
  get turnContext(): TurnContext {
    return this.turn;
  }

  /** The current turn's correlation id (W3C traceparent). */
  currentCorrelationId(): string {
    return this.turn.correlationId;
  }

  /** The skill currently active for this prompt, if any. */
  currentSkill(): SkillSelected | undefined {
    return this.activeSkill;
  }

  /**
   * Install the planner's traced units for the current PROMPT (#69) and re-adjudicate
   * whatever skill is already active. A forced skill is selected at `input`, before the
   * plan stage (`before_agent_start`) runs — so the verdict can arrive after the
   * selection, and must be able to revoke it. Once set, the trace is consulted by every
   * selection anywhere in the prompt (mid-prompt agent reads included), not just the round
   * it was produced in.
   *
   * Returns the skill that was revoked, if any.
   */
  setTracedUnits(units: TracedUnit[]): SkillSelected | undefined {
    this.tracedUnits = units;
    const active = this.activeSkill;
    if (!active) return undefined;

    const admission = this.adjudicateSkill(active);
    if (admission.admitted) return undefined;

    // A revoked selection is ended for the rest of the prompt, not resurrected next
    // turn — there is no re-selection at the turn boundary any more to re-arm it.
    this.activeSkill = undefined;
    this.hooks.onSkillRefused?.(active, admission.reason, admission);
    return active;
  }

  /** The admission verdict for a skill against this prompt's traced units. */
  adjudicateSkill(skill: SkillSelected): SkillAdmission {
    // No trace means the plan stage did not run this prompt, not that everything is
    // refused. Gating is opt-in; a missing verdict must not become a silent denial.
    if (!this.tracedUnits) {
      return { admitted: true, governed: false, reason: "no planner trace for this prompt", failedGates: [] };
    }
    return admitSkill(findTracedUnit(this.tracedUnits, skill), skill);
  }

  /**
   * Record a skill selection and emit it — unless precedence or the planner's gates refuse
   * it, in which case it never becomes active (#28).
   *
   * Precedence (#70): a user-forced selection (`source: "user"`) always takes the slot. An
   * agent-driven selection (`source: "agent"`, a `SKILL.md` read) fills the slot only when
   * no user force is already active — it must not silently displace a deliberate
   * `/skill:` choice. Whichever source wins, it then still needs the planner's admission.
   */
  private noteSkillSelected(event: SkillSelected): SkillSelected | undefined {
    if (event.source === "agent" && this.activeSkill?.source === "user") {
      return undefined;
    }
    const admission = this.adjudicateSkill(event);
    if (!admission.admitted) {
      this.hooks.onSkillRefused?.(event, admission.reason, admission);
      return undefined;
    }
    this.activeSkill = event;
    this.hooks.onSkillSelected?.(event);
    return event;
  }

  /**
   * Observe a user input line for a `/skill:<name>` forced-skill selection.
   * Returns the SkillSelected when detected (also emitted via hooks).
   *
   * Each genuine new prompt stands alone: a new input ends whatever {@link activeSkill}
   * carried over from the previous prompt — forced or agent-driven — and an input without
   * a `/skill:` prefix leaves none in force. Callers must only invoke this for a real
   * prompt boundary, not a mid-run steer/follow-up (Pi's `InputEvent.streamingBehavior`
   * distinguishes them — see `src/index.ts`'s `input` handler); this method itself always
   * resets, so calling it for a steer would wrongly end an in-force selection mid-prompt.
   */
  observeInput(text: string, commands: readonly SlashCommandInfo[] = []): SkillSelected | undefined {
    this.activeSkill = undefined;
    const forced = detectForcedSkill(text, commands);
    return forced ? this.noteSkillSelected(forced) : undefined;
  }

  /**
   * End the prompt: clear whatever {@link activeSkill} and {@link tracedUnits} carried
   * across this prompt's turns, forced or agent-driven. Pairs with Pi's `agent_settled`
   * (fired once the run has *fully* settled — no automatic retry, compaction, or queued
   * continuation will run; unlike `agent_end`, nothing after this reuses prompt state
   * without a new `input`, so this is the only correct place to clear it — see #71).
   */
  endPrompt(): void {
    this.activeSkill = undefined;
    this.tracedUnits = undefined;
  }

  /**
   * Evaluate a tool call at the governance boundary.
   *  - builds an {@link ObservedAction} against whatever skill is ALREADY in force,
   *    stamped with the turn correlation id + skill context,
   *  - runs the injected conformance checker against that action,
   *  - returns a block decision when the checker deems the action non-conformant,
   *  - only once the call is conformant does a detected agent skill load (read of
   *    SKILL.md) take effect (#70): the read is judged by the scope it was issued under,
   *    and a blocked read swaps nothing.
   */
  async evaluateToolCall(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ConformanceContext,
    commands: readonly SlashCommandInfo[] = [],
  ): Promise<GovernanceDecision> {
    const skillLoad = detectAgentSkillLoad(toolName, input, commands);

    // A direct buy is a tool call carrying `{vendor, amount, currency}`. Attaching the
    // purchase facet makes the (purchase-aware) conformance checker adjudicate it against the
    // active skill's `spend` envelope (#139).
    const purchase = detectPurchase(input);

    const action: ObservedAction = {
      toolName,
      input,
      correlationId: this.currentCorrelationId(),
      ...(this.activeSkill ? { skillContext: this.activeSkill } : {}),
      ...(purchase ? { purchase } : {}),
    };

    const verdict = await this.checker.check(action, ctx);
    if (!verdict.conformant) {
      // A deny-hit is refused finally (RFC-0030): remember the prohibited input so no
      // approval can ever record for it, and raise the notify-only event.
      if (verdict.prohibited) {
        this.prohibitedDigests.add(digest(input));
        this.hooks.onProhibitedAttempt?.(action, verdict.prohibited);
      }
      // A non-conformant purchase is blocked here — the wallet is never reached. A
      // non-conformant SKILL.md read is blocked here too, and never becomes a selection.
      this.hooks.onBlocked?.(action, verdict.reason);
      return { block: true, reason: verdict.reason, ...(verdict.prohibited ? { prohibited: verdict.prohibited } : {}) };
    }

    // The read was conformant under whatever skill was already active — now it can take
    // effect as a selection (subject to precedence + planner admission in noteSkillSelected).
    if (skillLoad) this.noteSkillSelected(skillLoad);

    // Conformant buy → authorize with the wallet and settle via the executor, then emit the
    // signed receipt + `onSettled`. Non-purchase actions just pass.
    if (purchase) {
      await this.settlePurchase(action, purchase);
    }
    return { block: false };
  }

  /**
   * Drive the x402 two-request handshake for a request that returned (or will return) a `402`,
   * with conformance running as the governance hook *between* the challenge and the signed
   * retry. On a conformant, settled buy the signed receipt is emitted and `onSettled` fires; on
   * a non-conformant buy the executor aborts before signing and `onBlocked` fires.
   */
  async pay(
    requestFn: PaymentRequestFn,
    ctx: ConformanceContext,
    toolName = "fetch",
  ): Promise<{ response: Response; receipt: PaymentReceipt; settlement?: SettlementResult }> {
    let purchaseAction: ObservedAction | undefined;
    let purchase: PurchaseIntent | undefined;

    const govern = async (req: PaymentRequirements) => {
      purchase = purchaseFromRequirements(req);
      purchaseAction = {
        toolName,
        input: { ...req },
        correlationId: this.currentCorrelationId(),
        ...(this.activeSkill ? { skillContext: this.activeSkill } : {}),
        purchase,
      };
      const verdict = await this.checker.check(purchaseAction, ctx);
      if (!verdict.conformant) {
        // Same finality as the tool boundary: a denied buy raises the prohibited-attempt
        // event, and no grant against it settles the payment (RFC-0030).
        if (verdict.prohibited) this.hooks.onProhibitedAttempt?.(purchaseAction, verdict.prohibited);
        this.hooks.onBlocked?.(purchaseAction, verdict.reason);
      }
      return { approved: verdict.conformant, reason: verdict.reason };
    };

    const { response, receipt } = await this.executor.pay(requestFn, govern);
    const settlement =
      purchaseAction && purchase ? await this.emitSettlement(purchaseAction, purchase, receipt) : undefined;
    return { response, receipt, ...(settlement ? { settlement } : {}) };
  }

  /** Direct-buy settlement: authorize via the wallet, settle via the executor, emit the receipt. */
  private async settlePurchase(action: ObservedAction, purchase: PurchaseIntent): Promise<SettlementResult> {
    const req = requirementsFromPurchase(purchase, action.correlationId);
    const signed = await this.wallet.authorize(req);
    const settlement = await this.executor.settle(signed, req);
    return this.emitSettlement(action, purchase, settlement);
  }

  /**
   * Turn a settled payment into a signed, non-repudiable purchase receipt: build the canonical
   * {@link PurchaseReceiptPayload}, sign it with the harness (`signPurchaseReceipt`, demo key by
   * default), shape it as a `purchase_settled` audit event correlated to the buy, and fire
   * `onSettled`.
   */
  private async emitSettlement(
    action: ObservedAction,
    purchase: PurchaseIntent,
    settlement: PaymentReceipt,
  ): Promise<SettlementResult> {
    const receipt: PurchaseReceiptPayload = {
      id: settlement.txHash ?? `kcp-rcpt-${this.sequence + 1}`,
      vendor: purchase.vendor,
      amount: purchase.amount,
      currency: purchase.currency,
      wallet: await this.wallet.address(),
      timestamp: settlement.settledAt,
    };
    const signature = await signPurchaseReceipt(this.signingKeyPem, receipt, this.signingKeyId);
    const event = buildPurchaseEvent(this.sessionId, ++this.sequence, receipt, signature, action.correlationId);
    this.hooks.onSettled?.(action, event);
    return { settlement, receipt, signature, event };
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
