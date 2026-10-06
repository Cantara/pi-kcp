import { describe, expect, it } from "bun:test";
import {
  type ConformanceChecker,
  type ConformanceContext,
  GovernedLoop,
  isTraceparent,
  type ObservedAction,
  PassThroughChecker,
} from "../src/index.js";

const ctx: ConformanceContext = { cwd: "/repo" };

/** A stub checker that rejects everything, capturing what it saw. */
class RejectingChecker implements ConformanceChecker {
  seen: ObservedAction | undefined;
  async check(action: ObservedAction) {
    this.seen = action;
    return { conformant: false, reason: "blocked by stub policy" };
  }
}

/** A stub checker that accepts everything, capturing every action it saw, in order. */
class AcceptingChecker implements ConformanceChecker {
  seen: ObservedAction[] = [];
  async check(action: ObservedAction) {
    this.seen.push(action);
    return { conformant: true, reason: "ok" };
  }
}

describe("conformance seam (#27)", () => {
  it("PassThroughChecker allows any action", async () => {
    const result = await new PassThroughChecker().check();
    expect(result.conformant).toBe(true);
  });

  it("a non-conformant checker blocks a tool_call with its reason", async () => {
    const checker = new RejectingChecker();
    const loop = new GovernedLoop({ checker });
    const decision = await loop.evaluateToolCall("bash", { command: "rm -rf /" }, ctx);
    expect(decision).toEqual({ block: true, reason: "blocked by stub policy" });
    expect(checker.seen?.toolName).toBe("bash");
    expect(checker.seen?.input).toEqual({ command: "rm -rf /" });
  });

  it("the default pass-through loop does not block", async () => {
    const loop = new GovernedLoop();
    const decision = await loop.evaluateToolCall("read", { path: "/repo/x.ts" }, ctx);
    expect(decision.block).toBe(false);
  });

  it("stamps the observed action with the turn correlation id and skill context", async () => {
    const checker = new AcceptingChecker();
    const loop = new GovernedLoop({ checker });
    loop.beginTurn(0);
    // The read of a SKILL.md is itself checked with no skill context yet (#70: it is
    // judged by the scope already in force, not the one it is about to establish) — only
    // once it is conformant does the skill become active for calls after it.
    await loop.evaluateToolCall("read", { path: "/repo/skills/deploy/SKILL.md" }, ctx);
    await loop.evaluateToolCall("bash", { command: "ls" }, ctx);
    expect(checker.seen[0]?.skillContext).toBeUndefined();
    expect(checker.seen[1]?.correlationId).toBe(loop.currentCorrelationId());
    expect(isTraceparent(checker.seen[1]!.correlationId)).toBe(true);
    expect(checker.seen[1]?.skillContext?.skillName).toBe("deploy");
  });
});
