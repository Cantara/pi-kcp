import { describe, expect, it, mock } from "bun:test";

import { GovernedLoop } from "../src/governed-loop.js";
import { ALL_STAGES, type TurnRecord } from "../src/runtime.js";

describe("GovernedLoop — per-turn ledger", () => {
  it("opens a ledger on beginTurn, stamped with the turn correlation id", () => {
    const loop = new GovernedLoop();
    loop.beginTurn(3);

    const record = loop.turnRecord();
    expect(record.turnIndex).toBe(3);
    expect(record.correlationId).toBe(loop.currentCorrelationId());
    expect(record.decisions).toEqual([]);
  });

  it("records stages run through the loop", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);

    await loop.stage("plan", async () => ({ detail: { units: 2 } }));
    await loop.stage("approve", async () => ({ status: "blocked", reason: "out of scope" }));

    expect(loop.turnRecord().decisions).toMatchObject([
      { stage: "plan", status: "ok", detail: { units: 2 } },
      { stage: "approve", status: "blocked", reason: "out of scope" },
    ]);
  });

  it("starts a clean ledger on the next turn", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    await loop.stage("plan", async () => ({}));
    loop.beginTurn(2);

    expect(loop.turnRecord().decisions).toEqual([]);
    expect(loop.turnRecord().turnIndex).toBe(2);
  });
});

describe("GovernedLoop — finishTurn asserts governance liveness", () => {
  async function runAllStages(loop: GovernedLoop) {
    for (const stage of ALL_STAGES) await loop.stage(stage, async () => ({}));
  }

  it("emits the turn record", async () => {
    const onTurnRecorded = mock();
    const loop = new GovernedLoop({ hooks: { onTurnRecorded } });
    loop.beginTurn(1);
    await runAllStages(loop);
    loop.finishTurn();

    expect(onTurnRecorded).toHaveBeenCalledTimes(1);
    const record = onTurnRecorded.mock.calls[0]![0] as TurnRecord;
    expect(record.decisions).toHaveLength(ALL_STAGES.length);
  });

  it("does not report ungoverned when every stage decided", async () => {
    const onUngoverned = mock();
    const loop = new GovernedLoop({ hooks: { onUngoverned } });
    loop.beginTurn(1);
    await runAllStages(loop);
    loop.finishTurn();

    expect(onUngoverned).not.toHaveBeenCalled();
  });

  // The failure Pi's swallowed exceptions would otherwise hide: a turn that completed
  // normally while the gate was absent. It has to surface as a fact, not as silence.
  it("reports ungoverned when a stage never reached the ledger", async () => {
    const onUngoverned = mock();
    const loop = new GovernedLoop({ hooks: { onUngoverned } });
    loop.beginTurn(1);
    await loop.stage("plan", async () => ({}));
    loop.finishTurn();

    expect(onUngoverned).toHaveBeenCalledTimes(1);
    const [record, reason] = onUngoverned.mock.calls[0]! as [TurnRecord, string];
    expect(reason).toMatch(/never reached/);
    expect(reason).toMatch(/approve/);
    expect(record.turnIndex).toBe(1);
  });

  it("reports ungoverned when a stage gate broke", async () => {
    const onUngoverned = mock();
    const loop = new GovernedLoop({ hooks: { onUngoverned } });
    loop.beginTurn(1);
    for (const stage of ALL_STAGES) {
      await loop.stage(stage, async () => {
        if (stage === "ground") throw new Error("planner unavailable");
        return {};
      });
    }
    loop.finishTurn();

    expect(onUngoverned).toHaveBeenCalledTimes(1);
    expect(onUngoverned.mock.calls[0]![1]).toMatch(/errored: ground/);
  });

  it("a blocked stage is governance working, not failing", async () => {
    const onUngoverned = mock();
    const loop = new GovernedLoop({ hooks: { onUngoverned } });
    loop.beginTurn(1);
    for (const stage of ALL_STAGES) {
      await loop.stage(stage, async () =>
        stage === "approve" ? { status: "blocked" as const, reason: "denied" } : {},
      );
    }
    loop.finishTurn();

    expect(onUngoverned).not.toHaveBeenCalled();
  });
});
