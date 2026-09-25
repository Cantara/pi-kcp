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
import type { ProhibitedAttempt } from "./deny.js";
import { childContext, mintTraceparent, type TurnContext } from "./correlation.js";
import {
  erroredStages,
  expectedStagesFor,
  type GovernanceMode,
  runStageBody,
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
  private activeSkill: SkillSelected | undefined;
  /**
   * The skill selection in force for the current user prompt, remembered across turn
   * boundaries — whether user-forced (`/skill:<name>`) or agent-driven (a `SKILL.md`
   * read). Pi emits `input` BEFORE the first `turn_start`, and `turn_start` fires again on
   * every tool round — so a selection that lived only in {@link activeSkill} was wiped by
   * {@link beginTurn} before the next round's `tool_call` could ever see it (the
   * `/skill:` forcing feature was unreachable for any RPC-driven client, and an
   * agent-driven selection only ever governed the round it was read in — #28/scope
   * escape). {@link beginTurn} re-selects this after its reset; the next user `input`
   * replaces or clears it (`observeInput`), and a planner-gate revocation via
   * {@link setTracedUnits} ends it early, whichever source it came from.
   */
  private persistentSkill: SkillSelected | undefined;
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
  /** The planner's traced units for this turn, when the plan stage produced them. */
  private tracedUnits: TracedUnit[] | undefined;
  /** How much of the cycle this turn is accountable for. */
  private mode: GovernanceMode = "full";
  /**
   * Which of `turn_start`/`before_agent_start` opened the round now starting, until the
   * OTHER one consumes it — `undefined` the rest of the time (including mid-round, once
   * both have run). See {@link openRoundFromTurnStart}'s doc for why this exists and why it
   * must work regardless of which one fires first.
   */
  private roundOpener: "turn_start" | "before_agent_start" | undefined;
  /**
   * The correlationId `agent_end`'s late-arriving synthesize/ground stages should attach
   * to — see {@link recordLateStage}'s doc for the companion event-ordering surprise this
   * exists for (Pi 0.80.6 fires `agent_end` AFTER `turn_end`, not before). Set once per
   * prompt by whichever of `openRoundFromTurnStart`/`openRoundFromBeforeAgentStart` actually
   * opens the round — NOT by every `beginTurn` (called again for every tool round within one
   * prompt; `agent_end` fires once per prompt, so this must not move with it).
   */
  private promptCorrelationId: string | undefined;
  /**
   * True from {@link finishTurn} until the next {@link beginTurn} — disambiguates, for
   * {@link recordLateStage}, "the live turn" from "the turn `this.turn`/`this.ledger` still
   * happen to reference because nothing newer has begun yet." See that method's doc for why
   * the distinction is load-bearing, not cosmetic.
   */
  private turnClosed = false;

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
   * Start a new turn: mint a fresh correlation id, clear the skill, open a ledger scoped to
   * what `mode` is accountable for.
   *
   * Both a *user-forced* and an *agent-driven* selection are per-prompt, not per-round:
   * `input` fires before the first `turn_start`, and `turn_start` fires again on every
   * tool round — so clearing {@link activeSkill} here without restoring it would wipe a
   * forced selection between detection and the first `tool_call` (with `requireActiveSkill`
   * that turned every forced-skill prompt into a strict-mode refusal), and would leave an
   * agent-driven selection governing only the round its `SKILL.md` read happened in (the
   * scope it declared going unenforced for every later round of the same prompt). Either
   * kind is re-selected here, after the reset — and each turn's plan stage can still
   * refuse or revoke it via {@link setTracedUnits}.
   */
  beginTurn(turnIndex?: number, mode: GovernanceMode = "full"): TurnContext {
    this.turn = mintTraceparent(turnIndex);
    this.activeSkill = undefined;
    this.mode = mode;
    this.turnClosed = false;
    this.ledger = new TurnLedger({
      turnIndex: turnIndex ?? 0,
      correlationId: this.turn.correlationId,
      expectedStages: expectedStagesFor(mode),
    });
    this.approvals.clear();
    this.prohibitedDigests.clear();
    this.tracedUnits = undefined;
    // Re-select the persisted skill for the new turn (the trace was just cleared, so
    // admission defers to this turn's plan stage — gating stays per-turn, not skipped).
    if (this.persistentSkill) this.noteSkillSelected(this.persistentSkill);
    return this.turn;
  }

  /**
   * Open a round from `turn_start`, which alone carries Pi's real per-round `turnIndex`.
   *
   * `turn_start` and `before_agent_start` are dispatched on genuinely different paths —
   * `turn_start` through the generic extension-event pipeline, `before_agent_start` as a
   * direct call inside `prompt()` — with no ordering guarantee between them. Confirmed by
   * tracing real timestamps: Pi 0.80.6 fires `before_agent_start` FIRST; this repo's own
   * test fakes (and plausibly other Pi versions) fire `turn_start` first. Whichever fires
   * first genuinely opens the round; the other must reuse it, not replace it — replacing it
   * unconditionally either way loses whichever stage the first one already recorded (`plan`,
   * if `before_agent_start` went first).
   *
   * If `before_agent_start` already opened this round (with a placeholder index, since that
   * event carries none of its own), this patches in the real one rather than discarding that
   * ledger. Deliberately does NOT touch `promptCorrelationId` (see
   * {@link openRoundFromBeforeAgentStart}'s doc for why only `before_agent_start` may) — a
   * round-2+ call here, for a later tool round of the SAME prompt with no `before_agent_start`
   * firing again, must leave it pointing at round 1, where `agent_end`'s stages belong.
   */
  openRoundFromTurnStart(turnIndex: number, mode: GovernanceMode): TurnContext {
    if (this.roundOpener === "before_agent_start") {
      this.ledger.setTurnIndex(turnIndex);
      this.roundOpener = undefined;
      return this.turn;
    }
    const ctx = this.beginTurn(turnIndex, mode);
    this.roundOpener = "turn_start";
    return ctx;
  }

  /**
   * Open a round from `before_agent_start`, which carries no `turnIndex` of its own — see
   * {@link openRoundFromTurnStart}'s doc for the full mechanism this is the other half of.
   * If `turn_start` already opened this round (this repo's own test fakes' order), reuses it
   * as-is — `turn_start`'s real index is already correct, nothing to patch.
   *
   * Sets `promptCorrelationId` in BOTH branches, unlike `openRoundFromTurnStart`: this is the
   * one call with "fires exactly once per prompt, regardless of how many tool rounds follow"
   * cardinality (`before_agent_start`'s own, real Pi property) — the right, and only reliable,
   * place to mark "this round is where `agent_end`'s late synthesize/ground stages belong."
   */
  openRoundFromBeforeAgentStart(mode: GovernanceMode): TurnContext {
    if (this.roundOpener === "turn_start") {
      this.roundOpener = undefined;
      this.promptCorrelationId = this.turn.correlationId;
      return this.turn;
    }
    const ctx = this.beginTurn(undefined, mode);
    this.roundOpener = "before_agent_start";
    this.promptCorrelationId = this.turn.correlationId;
    return ctx;
  }

  /**
   * Run one stage of the governed cycle, recording its outcome. Never throws — see
   * {@link TurnLedger.run} for why an error must not reach Pi.
   */
  async stage(stage: Stage, body: () => Promise<StageOutcome | void>): Promise<void> {
    await this.ledger.run(stage, body);
  }

  /**
   * Record a stage for the CURRENT prompt's turn, wherever that turn now is — still live,
   * or already closed and pushed to {@link recentTurns}. For `agent_end`'s synthesize/ground
   * stages: Pi 0.80.6 fires `agent_end` AFTER `turn_end`, the same real event-ordering
   * surprise {@link openRoundFromTurnStart}'s doc describes at the other end of the turn, so
   * by the time these stages are ready to record, `finishTurn` has usually already
   * snapshotted and pushed the record they belong in. A plain {@link stage} call would
   * silently land in whatever turn happens to be live NOW — a later tool round of the SAME
   * prompt, or nothing at all — never the turn synthesize/ground actually describe.
   *
   * Correlates by {@link promptCorrelationId} (set once per prompt, only by
   * `openRoundFromBeforeAgentStart` — see its own doc for why only that call may), not by
   * "the current turn," which is exactly the value this exists to not trust for a
   * late-arriving stage. A silent no-op if that turn isn't live and isn't in the (bounded)
   * history window either — aged out, or no turn was ever opened this prompt (mode wasn't
   * `full`) — matching {@link stage}'s own "a broken/absent gate degrades the turn, it does
   * not throw" posture.
   *
   * Deliberately does NOT invoke {@link GovernedLoopHooks.onTurnRecorded} again for a
   * patched, already-closed turn — that hook fires exactly once per turn by contract, and at
   * least one real consumer (`wrapper-cli.ts`'s persona-turn ledger) signs and appends a
   * ledger line on every call; a second notification for the same turn would double-sign it.
   * A late patch is visible to anything that re-reads {@link recentTurns} fresh (this is
   * exactly what `/kcp evidence` does) — not to something that cached the hook's first,
   * possibly-incomplete snapshot.
   */
  async recordLateStage(stage: Stage, body: () => Promise<StageOutcome | void>): Promise<void> {
    const targetId = this.promptCorrelationId;
    if (targetId === undefined) return;
    // `this.turn`/`this.ledger` still reference the target turn in TWO different cases that
    // must not be conflated: genuinely still open (no `finishTurn` yet), and just closed by
    // `finishTurn` with no NEWER turn having begun since (the common single-round case — the
    // multi-round case this was originally verified against masks this, since a second
    // `beginTurn` moves `this.turn` on and correctly forces the history-search branch below;
    // a single-round prompt never does). `turnClosed` disambiguates: true the instant
    // `finishTurn` snapshots and pushes, false again the instant any `beginTurn` runs. Only
    // the genuinely-still-open case may mutate the live ledger directly — mutating it after
    // `finishTurn` already copied its decisions into the pushed history entry would update
    // the live object silently, with nothing readable ever seeing the change.
    if (this.turn.correlationId === targetId && !this.turnClosed) {
      await this.ledger.run(stage, body);
      return;
    }
    const index = this.history.findIndex((record) => record.correlationId === targetId);
    if (index === -1) return;
    const entry = this.history[index];
    const decision = await runStageBody(stage, targetId, body);
    this.history[index] = { ...entry, decisions: [...entry.decisions, decision] };
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
   *
   * `onTurnRecorded`/`onUngoverned` fire exactly once, here, with whatever is known at THIS
   * instant — an honest snapshot, not a final one. `agent_end`'s synthesize/ground stages
   * (see {@link recordLateStage}) routinely arrive after this call, on real Pi 0.80.6, and
   * can complete the picture — but only for a caller that re-reads {@link recentTurns} or
   * calls {@link ungovernedReason} on it fresh afterward. A caller that only ever looks at
   * this call's own hook arguments will not see the completed record.
   */
  finishTurn(): TurnRecord {
    const record = this.ledger.record();
    this.history.push(record);
    if (this.history.length > TURN_HISTORY_LIMIT) this.history.shift();
    this.turnClosed = true;
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

  /** The skill currently active for this turn, if any. */
  currentSkill(): SkillSelected | undefined {
    return this.activeSkill;
  }

  /**
   * Install the planner's traced units for this turn and re-adjudicate whatever skill is
   * already active. A forced skill is selected at `input`, before the plan stage runs — so
   * the verdict can arrive after the selection, and must be able to revoke it.
   *
   * Returns the skill that was revoked, if any.
   */
  setTracedUnits(units: TracedUnit[]): SkillSelected | undefined {
    this.tracedUnits = units;
    const active = this.activeSkill;
    if (!active) return undefined;

    const admission = this.adjudicateSkill(active);
    if (admission.admitted) return undefined;

    this.activeSkill = undefined;
    // A revoked selection is ended, not resurrected, whichever source it came from:
    // without this, beginTurn's re-selection would re-arm it every turn and the gate
    // would refuse it again every turn — a refusal loop instead of a decision.
    if (this.persistentSkill === active) this.persistentSkill = undefined;
    this.hooks.onSkillRefused?.(active, admission.reason, admission);
    return active;
  }

  /** The admission verdict for a skill against this turn's traced units. */
  adjudicateSkill(skill: SkillSelected): SkillAdmission {
    // No trace means the plan stage did not run, not that everything is refused. Gating is
    // opt-in; a missing verdict must not become a silent denial.
    if (!this.tracedUnits) {
      return { admitted: true, governed: false, reason: "no planner trace for this turn", failedGates: [] };
    }
    return admitSkill(findTracedUnit(this.tracedUnits, skill), skill);
  }

  /**
   * Record a skill selection and emit it — unless the planner's gates refuse it, in which
   * case it never becomes active and the written reason is emitted instead (#28).
   *
   * On admission this also becomes {@link persistentSkill}, so it survives the next
   * {@link beginTurn} regardless of source — an agent-driven selection persists across
   * tool rounds exactly like a user-forced one, until `observeInput` or
   * {@link setTracedUnits} ends it.
   */
  private noteSkillSelected(event: SkillSelected): SkillSelected | undefined {
    const admission = this.adjudicateSkill(event);
    if (!admission.admitted) {
      this.hooks.onSkillRefused?.(event, admission.reason, admission);
      return undefined;
    }
    this.activeSkill = event;
    this.persistentSkill = event;
    this.hooks.onSkillSelected?.(event);
    return event;
  }

  /**
   * Observe a user input line for a `/skill:<name>` forced-skill selection.
   * Returns the SkillSelected when detected (also emitted via hooks).
   *
   * Each prompt stands alone: a new input ends whatever {@link persistentSkill} carried
   * over from the previous prompt — forced or agent-driven — and an input without a
   * `/skill:` prefix leaves none in force. The (re-)selected skill, forced or not, governs
   * every turn of the prompt it was issued for, and no further.
   */
  observeInput(text: string, commands: readonly SlashCommandInfo[] = []): SkillSelected | undefined {
    this.persistentSkill = undefined;
    const forced = detectForcedSkill(text, commands);
    return forced ? this.noteSkillSelected(forced) : undefined;
  }

  /**
   * End the prompt: clear whatever {@link persistentSkill} carried across this prompt's
   * tool rounds, forced or agent-driven. Pairs with Pi's `agent_end` (fired once per agent
   * loop, i.e. once per prompt, however many `turn_start` rounds it took).
   *
   * `observeInput` only runs for non-`"extension"` input sources (`src/index.ts`'s
   * `input` handler returns early for `source === "extension"` before calling it) — an
   * extension-driven prompt (Pi's `sendUserMessage`) never reaches `observeInput`, so
   * without this a skill selected in one prompt would leak into the next extension-driven
   * one and, with `requireActiveSkill`, silently satisfy strict mode for it. Calling this
   * unconditionally at `agent_end` closes that gap for both selection sources — it does
   * not change within-prompt persistence (still governed by {@link beginTurn} and
   * {@link setTracedUnits}).
   */
  endPrompt(): void {
    this.persistentSkill = undefined;
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
      // A deny-hit is refused finally (RFC-0030): remember the prohibited input so no
      // approval can ever record for it, and raise the notify-only event.
      if (verdict.prohibited) {
        this.prohibitedDigests.add(digest(input));
        this.hooks.onProhibitedAttempt?.(action, verdict.prohibited);
      }
      // A non-conformant purchase is blocked here — the wallet is never reached.
      this.hooks.onBlocked?.(action, verdict.reason);
      return { block: true, reason: verdict.reason, ...(verdict.prohibited ? { prohibited: verdict.prohibited } : {}) };
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
