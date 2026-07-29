// Phase 3 — the record has to describe what actually happened, not what was intended.
//
// Pi hands `beforeToolCall` and `afterToolCall` the *same* args object, and tells
// extensions to modify arguments by mutating `event.input` in place. So a later extension
// can change a call after pi-kcp approved it. An audit trail that records the approved
// input and calls it done is recording a wish.
import { describe, expect, it } from "bun:test";

import { canonicalJson, digest } from "../src/evidence.js";
import { GovernedLoop } from "../src/governed-loop.js";
import { ALL_STAGES, isGoverned, ungovernedReason, violatedStages } from "../src/runtime.js";

describe("canonical form", () => {
  it("is stable under key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("is stable at depth, and inside arrays", () => {
    const x = { outer: { z: 1, a: [{ q: 1, b: 2 }] } };
    const y = { outer: { a: [{ b: 2, q: 1 }], z: 1 } };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it("preserves array order — sequence is meaning, not layout", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("distinguishes values that differ", () => {
    expect(digest({ path: "a.ts" })).not.toBe(digest({ path: "b.ts" }));
    expect(digest({ path: "a.ts" })).toBe(digest({ path: "a.ts" }));
  });

  it("is labelled with its algorithm", () => {
    expect(digest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("does not confuse a missing key with an undefined one", () => {
    expect(digest({ a: 1 })).toBe(digest({ a: 1, b: undefined }));
  });
});

describe("approve → act integrity", () => {
  const CALL = "call-1";

  async function turnWith(approved: unknown, executed: unknown) {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    await loop.stage("approve", async () => {
      loop.noteApproval(CALL, digest(approved));
      return { detail: { toolCallId: CALL, inputDigest: digest(approved) } };
    });
    await loop.stage("act", async () => loop.checkExecuted(CALL, executed));
    return loop;
  }

  it("records a matching call as ok, carrying the join key", async () => {
    const loop = await turnWith({ file_path: "a.ts" }, { file_path: "a.ts" });
    const act = loop.turnRecord().decisions.find((d) => d.stage === "act")!;

    expect(act.status).toBe("ok");
    expect(act.detail).toMatchObject({ toolCallId: CALL });
  });

  // The case that makes the record worth keeping.
  it("records a mutated call as violated, with both digests", async () => {
    const loop = await turnWith({ command: "ls" }, { command: "rm -rf /" });
    const act = loop.turnRecord().decisions.find((d) => d.stage === "act")!;

    expect(act.status).toBe("violated");
    expect(act.reason).toMatch(/differs from what was approved/i);
    expect(act.detail).toMatchObject({
      toolCallId: CALL,
      approvedDigest: digest({ command: "ls" }),
      executedDigest: digest({ command: "rm -rf /" }),
    });
  });

  it("a violated turn is not a governed turn", async () => {
    const loop = await turnWith({ command: "ls" }, { command: "rm -rf /" });
    for (const stage of ALL_STAGES) {
      if (stage !== "approve" && stage !== "act") await loop.stage(stage, async () => ({}));
    }
    const record = loop.turnRecord();

    expect(violatedStages(record)).toEqual(["act"]);
    expect(isGoverned(record)).toBe(false);
    expect(ungovernedReason(record)).toMatch(/act/);
  });

  // A violation is worse than a gap: it means the gate ran, decided, and was overridden.
  it("a violation outranks a missing stage in the reason", async () => {
    const loop = await turnWith({ a: 1 }, { a: 2 });
    const reason = ungovernedReason(loop.turnRecord())!;

    expect(reason).toMatch(/approval was not honoured/i);
    expect(reason.indexOf("not honoured")).toBeLessThan(
      reason.indexOf("never reached") === -1 ? Infinity : reason.indexOf("never reached"),
    );
  });

  it("an unapproved call is a violation, not a pass", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    await loop.stage("act", async () => loop.checkExecuted("never-approved", { x: 1 }));
    const act = loop.turnRecord().decisions[0]!;

    expect(act.status).toBe("violated");
    expect(act.reason).toMatch(/no recorded approval/i);
  });

  it("approvals do not leak across turns", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    loop.noteApproval(CALL, digest({ a: 1 }));
    loop.beginTurn(2);

    await loop.stage("act", async () => loop.checkExecuted(CALL, { a: 1 }));
    expect(loop.turnRecord().decisions[0]!.status).toBe("violated");
  });

  it("pairs the right call when several are in flight", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    loop.noteApproval("a", digest({ n: 1 }));
    loop.noteApproval("b", digest({ n: 2 }));

    await loop.stage("act", async () => loop.checkExecuted("b", { n: 2 }));
    expect(loop.turnRecord().decisions[0]!.status).toBe("ok");

    await loop.stage("act", async () => loop.checkExecuted("a", { n: 2 }));
    expect(loop.turnRecord().decisions[1]!.status).toBe("violated");
  });
});
