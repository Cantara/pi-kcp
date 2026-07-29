import { describe, expect, it, mock } from "bun:test";

import {
  ALL_STAGES,
  TurnLedger,
  isGoverned,
  missingStages,
  ungovernedReason,
} from "../src/runtime.js";

const CID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function ledger(): TurnLedger {
  return new TurnLedger({ turnIndex: 1, correlationId: CID });
}

describe("TurnLedger — stage decisions", () => {
  it("records a stage outcome against the turn correlation id", async () => {
    const l = ledger();
    await l.run("plan", async () => ({ detail: { units: 3 } }));

    expect(l.record().decisions).toEqual([
      { stage: "plan", status: "ok", correlationId: CID, detail: { units: 3 } },
    ]);
  });

  it("preserves stage order as run", async () => {
    const l = ledger();
    await l.run("plan", async () => ({}));
    await l.run("load", async () => ({}));
    await l.run("approve", async () => ({}));

    expect(l.record().decisions.map((d) => d.stage)).toEqual(["plan", "load", "approve"]);
  });

  it("records an explicit skip as a decision, not an absence", async () => {
    const l = ledger();
    await l.run("load", async () => ({ status: "skipped", reason: "no units planned" }));

    const [d] = l.record().decisions;
    expect(d.status).toBe("skipped");
    expect(d.reason).toBe("no units planned");
    expect(missingStages(l.record())).not.toContain("load");
  });

  it("records a block with its reason", async () => {
    const l = ledger();
    await l.run("approve", async () => ({ status: "blocked", reason: "outside action_scope" }));

    expect(l.record().decisions[0]).toMatchObject({
      stage: "approve",
      status: "blocked",
      reason: "outside action_scope",
    });
  });
});

describe("TurnLedger — the gate cannot fail silently", () => {
  // Pi swallows handler exceptions (runner.js:68, :539). If the runtime lets an error
  // escape, the turn proceeds ungoverned with nothing recorded anywhere. So the ledger
  // catches its own errors in order to record them.
  it("records a thrown stage as errored and does not rethrow", async () => {
    const l = ledger();

    await expect(l.run("ground", async () => {
      throw new Error("kcp-agent not found");
    })).resolves.toBeUndefined();

    expect(l.record().decisions[0]).toMatchObject({
      stage: "ground",
      status: "errored",
      reason: "kcp-agent not found",
    });
  });

  it("records a non-Error throw", async () => {
    const l = ledger();
    await l.run("plan", async () => {
      throw "string failure";
    });

    expect(l.record().decisions[0]).toMatchObject({ status: "errored", reason: "string failure" });
  });

  it("keeps running later stages after one errors", async () => {
    const l = ledger();
    const after = mock(async () => ({}));

    await l.run("plan", async () => {
      throw new Error("boom");
    });
    await l.run("load", after);

    expect(after).toHaveBeenCalled();
    expect(l.record().decisions.map((d) => d.status)).toEqual(["errored", "ok"]);
  });

  it("an errored stage makes the turn ungoverned", async () => {
    const l = ledger();
    for (const s of ALL_STAGES) await l.run(s, async () => ({}));
    expect(isGoverned(l.record())).toBe(true);

    const bad = ledger();
    for (const s of ALL_STAGES) {
      await bad.run(s, async () => (s === "assess" ? Promise.reject(new Error("x")) : {}));
    }
    expect(isGoverned(bad.record())).toBe(false);
    expect(ungovernedReason(bad.record())).toMatch(/assess/);
  });
});

describe("governance liveness — silence is never evidence", () => {
  it("a turn missing stages is not governed, and names them", async () => {
    const l = ledger();
    await l.run("plan", async () => ({}));

    expect(missingStages(l.record())).toEqual(
      ALL_STAGES.filter((s) => s !== "plan"),
    );
    expect(isGoverned(l.record())).toBe(false);
    expect(ungovernedReason(l.record())).toMatch(/never reached/);
  });

  it("an empty turn is ungoverned rather than vacuously fine", () => {
    const l = ledger();
    expect(isGoverned(l.record())).toBe(false);
    expect(missingStages(l.record())).toEqual([...ALL_STAGES]);
  });

  it("covers every stage of the cycle", () => {
    expect(ALL_STAGES).toEqual([
      "plan",
      "load",
      "synthesize",
      "ground",
      "assess",
      "approve",
      "act",
    ]);
  });
});
