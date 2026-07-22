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
  /** Notified whenever a tool call is blocked as non-conformant. */
  onBlocked?: (action: ObservedAction, reason: string) => void;
  /**
   * Notified whenever a conformant purchase settles — the mirror of `onBlocked` on the spend
   * path. `event` is the `purchase_settled` audit event carrying the signed receipt (#139).
   */
  onSettled?: (action: ObservedAction, event: AuditEvent) => void;
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
  private activeSkill: SkillSelected | undefined;

  constructor(options: GovernedLoopOptions = {}) {
    this.checker = options.checker ?? passThroughChecker;
    this.hooks = options.hooks ?? {};
    this.wallet = options.wallet ?? new MockWallet();
    this.executor = options.executor ?? new MockPaymentExecutor(this.wallet);
    this.signingKeyPem = options.signingKeyPem ?? DEMO_SIGNING_KEY_PEM;
    this.signingKeyId = options.signingKeyId ?? DEMO_SIGNING_KEY_ID;
    this.sessionId = options.sessionId ?? "pi-kcp-session";
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
      // A non-conformant purchase is blocked here — the wallet is never reached.
      this.hooks.onBlocked?.(action, verdict.reason);
      return { block: true, reason: verdict.reason };
    }

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
      if (!verdict.conformant) this.hooks.onBlocked?.(purchaseAction, verdict.reason);
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
