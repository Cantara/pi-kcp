/**
 * The stage machine for the governed runtime (#26, #27).
 *
 * Pi swallows extension-handler exceptions — every dispatch site in the extension runner
 * wraps handlers in try/catch, collects the error, and continues the turn. A gate that
 * throws therefore does not stop anything; it produces a turn that completes *ungoverned
 * and silent*.
 *
 * So this ledger catches its own errors in order to record them, and treats a stage that
 * never reached it as a defect rather than an absence. Refusal travels as a value
 * (`status: "blocked"`), never as an exception.
 *
 * See docs/decisions/0003-governed-runtime.md.
 */

/** The seven stages of the governed cycle, in cycle order. */
export const ALL_STAGES = [
  "plan",
  "load",
  "synthesize",
  "ground",
  "assess",
  "approve",
  "act",
] as const;

export type Stage = (typeof ALL_STAGES)[number];

/**
 * What the runtime does when its own gate breaks.
 *
 * `announce` keeps the host usable and reports that the guarantee lapsed. `block` fails
 * closed — if the runtime cannot establish what is authorized, it authorizes nothing.
 * Refusal is a returned value either way: Pi swallows thrown exceptions, so throwing
 * would be indistinguishable from not refusing at all.
 */
export type GateFailurePosture = "announce" | "block";

/**
 * `ok` ran and passed · `skipped` deliberately not applicable this turn · `blocked`
 * governance refused (the gate working, not failing) · `errored` the gate itself broke.
 */
export type StageStatus = "ok" | "skipped" | "blocked" | "errored";

export interface StageDecision {
  readonly stage: Stage;
  readonly status: StageStatus;
  readonly correlationId: string;
  readonly reason?: string;
  readonly detail?: Record<string, unknown>;
}

export interface TurnRecord {
  readonly turnIndex: number;
  readonly correlationId: string;
  readonly decisions: readonly StageDecision[];
}

/**
 * What a stage body reports. `errored` is deliberately absent: a stage cannot declare
 * itself broken, that verdict belongs to the ledger's catch.
 */
export interface StageOutcome {
  status?: Exclude<StageStatus, "errored">;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface TurnLedgerOptions {
  turnIndex: number;
  correlationId: string;
}

/** Accumulates one turn's stage decisions. One ledger per turn. */
export class TurnLedger {
  private readonly turnIndex: number;
  private readonly correlationId: string;
  private readonly decisions: StageDecision[] = [];

  constructor(options: TurnLedgerOptions) {
    this.turnIndex = options.turnIndex;
    this.correlationId = options.correlationId;
  }

  /**
   * Run one stage and record its outcome. Never rethrows: an error that escapes to Pi is
   * an error that vanishes, so it is captured as an `errored` decision instead. Later
   * stages still run — a broken stage degrades the turn, it does not abandon it.
   */
  async run(stage: Stage, body: () => Promise<StageOutcome | void>): Promise<void> {
    try {
      const outcome = (await body()) ?? {};
      this.decisions.push({
        stage,
        status: outcome.status ?? "ok",
        correlationId: this.correlationId,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
    } catch (error) {
      this.decisions.push({
        stage,
        status: "errored",
        correlationId: this.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  record(): TurnRecord {
    return {
      turnIndex: this.turnIndex,
      correlationId: this.correlationId,
      decisions: [...this.decisions],
    };
  }
}

/** Stages that produced no decision at all — the runtime's blind spots for this turn. */
export function missingStages(record: TurnRecord): Stage[] {
  return ALL_STAGES.filter((stage) => !record.decisions.some((d) => d.stage === stage));
}

/** Stages whose gate broke. */
export function erroredStages(record: TurnRecord): Stage[] {
  return record.decisions.filter((d) => d.status === "errored").map((d) => d.stage);
}

/**
 * A turn is governed when every stage reported and none of them broke. A `blocked` stage
 * is governance succeeding, so it counts as governed.
 */
export function isGoverned(record: TurnRecord): boolean {
  return erroredStages(record).length === 0 && missingStages(record).length === 0;
}

/** Why a turn was not governed, for the liveness assertion. `undefined` when it was. */
export function ungovernedReason(record: TurnRecord): string | undefined {
  const errored = erroredStages(record);
  if (errored.length > 0) return `stage gate errored: ${errored.join(", ")}`;

  const missing = missingStages(record);
  if (missing.length > 0) return `stage never reached the ledger: ${missing.join(", ")}`;

  return undefined;
}
