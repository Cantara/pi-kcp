// A user-forced skill must survive the turn boundary (#28, forced-skill lifecycle).
//
// Pi emits `input` BEFORE the first `turn_start` (agent-session `prompt()`: input event,
// then the agent run that emits turn_start per tool round). pi-kcp detects a forced
// `/skill:<name>` at `input` — but GovernedLoop.beginTurn used to clear the active skill
// unconditionally at every `turn_start`, which always fires next. So a user-forced skill
// could NEVER reach the first `tool_call`, and with `requireActiveSkill: true` every
// forced-skill prompt fail-closed with the strict no-active-skill refusal. The existing
// wiring test fired `input` alone (never followed by `turn_start`) and the enforcement
// e2e tests activate via the agent-driven SKILL.md-read path, so nothing replayed the
// real sequence. This file replays it — input → turn_start → tool_call — through the
// real registered handlers with the real HarnessConformanceChecker over a real manifest.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";
import { parseTrace, type TracedUnit } from "../src/skill-gate.js";
import type { SkillSelected } from "../src/skill-detection.js";

type Handler = (event: any, ctx: any) => any;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, unknown>();
  registerCommand(name: string, options: unknown): void {
    this.commands.set(name, options);
  }
  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  getCommands(): SlashCommandInfo[] {
    return [];
  }
  getAllTools(): unknown[] {
    return [];
  }
  sendMessage(): void {}
  async exec(): Promise<ExecResult> {
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  }
  async fire(event: string, payload: any, cwd: string): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) {
      result = await handler(payload, { cwd, hasUI: false });
    }
    return result;
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-kcp-forced-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  // Strict mode: only ever act within a declared skill. This is the configuration under
  // which the bug was observed in production (an RPC-driven Pi consumer).
  await writeFile(
    join(dir, ".pi", "kcp.json"),
    JSON.stringify({ enabled: true, governance: "tool", requireActiveSkill: true, autoRecall: false }),
  );
  // The real manifest the HarnessConformanceChecker resolves action_scope from.
  await writeFile(
    join(dir, "knowledge.yaml"),
    [
      "project: t",
      "units:",
      "  - id: deploy",
      "    kind: skill",
      "    path: skills/deploy/SKILL.md",
      "    action_scope:",
      "      tools: [read]",
      "",
    ].join("\n"),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STRICT_REFUSAL = "no active skill — fail-closed (requireActiveSkill)";

describe("a user-forced skill survives the input → turn_start → tool_call sequence", () => {
  it("keeps the forced skill active at the first tool_call and enforces its action_scope", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    // The REAL event order a live prompt produces: input first, then turn_start.
    await pi.fire("input", { text: "/skill:deploy run the deploy checklist", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);

    // In-scope call passes — under strict mode this is only possible if the forced skill
    // is still active (with no skill, the same call fail-closes).
    const inScope = await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: "docs/deploy.md" } },
      dir,
    );
    expect(inScope).toBeUndefined();

    // Out-of-scope call is refused with the harness's scope reason — a string only
    // reachable once a skill is active and its action_scope actually resolved. This is
    // the positive-activation evidence, distinct from the strict no-skill refusal.
    const outOfScope = await pi.fire(
      "tool_call",
      { toolCallId: "t2", toolName: "bash", input: { command: "ls" } },
      dir,
    );
    expect(outOfScope.block).toBe(true);
    expect(outOfScope.reason).toContain('tool "bash" is outside the skill\'s authorized tools');
    expect(outOfScope.reason).not.toContain(STRICT_REFUSAL);
  });

  it("keeps governing later tool rounds of the same prompt (turn_start fires per round)", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    await pi.fire("input", { text: "/skill:deploy go", source: "rpc" }, dir);
    for (const turnIndex of [0, 1, 2]) {
      await pi.fire("turn_start", { turnIndex, timestamp: 0 }, dir);
      const decision = await pi.fire(
        "tool_call",
        { toolCallId: `t${turnIndex}`, toolName: "read", input: { path: "docs/deploy.md" } },
        dir,
      );
      expect(decision).toBeUndefined();
    }
  });

  it("fail-closes the same sequence when no skill was forced (the control)", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    await pi.fire("input", { text: "run the deploy checklist", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);

    const decision = await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: "docs/deploy.md" } },
      dir,
    );
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain(STRICT_REFUSAL);
  });

  it("ends the forced selection at the next input without a /skill: prefix", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    // Prompt 1: forced skill governs its turn.
    await pi.fire("input", { text: "/skill:deploy go", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);
    const first = await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: "docs/deploy.md" } },
      dir,
    );
    expect(first).toBeUndefined();

    // Prompt 2 stands alone: no prefix, no forced skill, strict mode fail-closes again.
    await pi.fire("input", { text: "now something unrelated", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    const second = await pi.fire(
      "tool_call",
      { toolCallId: "t2", toolName: "read", input: { path: "docs/deploy.md" } },
      dir,
    );
    expect(second.block).toBe(true);
    expect(second.reason).toContain(STRICT_REFUSAL);
  });
});

describe("the agent-driven skill lifecycle is unchanged (per-turn, tied to the SKILL.md read)", () => {
  it("activates at the SKILL.md read, governs the rest of the turn, and is cleared at the next turn_start", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    await pi.fire("input", { text: "run the deploy checklist", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);

    // The agent loads the skill itself: a read of its SKILL.md, inside the turn. The
    // selection lands before the conformance check, so the read is adjudicated in-scope.
    const load = await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: `${dir}/skills/deploy/SKILL.md` } },
      dir,
    );
    expect(load).toBeUndefined();

    // Active for the remainder of this turn.
    const sameTurn = await pi.fire(
      "tool_call",
      { toolCallId: "t2", toolName: "read", input: { path: "docs/deploy.md" } },
      dir,
    );
    expect(sameTurn).toBeUndefined();

    // But NOT the next: an agent-driven selection is per-turn — the next turn_start
    // clears it exactly as before this fix.
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    const nextTurn = await pi.fire(
      "tool_call",
      { toolCallId: "t3", toolName: "read", input: { path: "docs/deploy.md" } },
      dir,
    );
    expect(nextTurn.block).toBe(true);
    expect(nextTurn.reason).toContain(STRICT_REFUSAL);
  });
});

describe("re-selection at the turn boundary stays gated per turn", () => {
  const trace = (units: Array<Partial<TracedUnit>>): TracedUnit[] =>
    parseTrace(
      JSON.stringify({
        schemaVersion: 1,
        kind: "trace",
        gateSummary: [],
        units: units.map((u) => ({ id: "x", path: "x.md", outcome: "selected", gates: [], ...u })),
      }),
    );
  const commands = [{ name: "skill:deploy", description: "", source: "project" } as never];

  it("re-selects a user-forced skill after beginTurn, agent-loaded is not re-selected", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(0);

    // Agent-loaded: gone at the next turn boundary.
    await loop.evaluateToolCall("read", { path: "skills/deploy/SKILL.md" }, { cwd: "/repo" });
    expect(loop.currentSkill()?.source).toBe("agent");
    loop.beginTurn(1);
    expect(loop.currentSkill()).toBeUndefined();

    // User-forced: survives it.
    loop.observeInput("/skill:deploy go", commands);
    expect(loop.currentSkill()?.source).toBe("user");
    loop.beginTurn(2);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(loop.currentSkill()?.source).toBe("user");
  });

  it("a planner-gate revocation ends a forced selection — it is not resurrected next turn", () => {
    const refused: Array<[SkillSelected, string]> = [];
    const loop = new GovernedLoop({ hooks: { onSkillRefused: (s, r) => refused.push([s, r]) } });
    loop.beginTurn(0);
    loop.observeInput("/skill:deploy go", commands);
    expect(loop.currentSkill()?.skillName).toBe("deploy");

    // The plan stage's trace arrives and the gates refuse the skill: revoked.
    const revoked = loop.setTracedUnits(
      trace([{ id: "deploy", path: "skills/deploy/SKILL.md", gates: [{ gate: "temporal", passed: false, detail: "expired" }] }]),
    );
    expect(revoked?.skillName).toBe("deploy");
    expect(loop.currentSkill()).toBeUndefined();
    expect(refused).toHaveLength(1);

    // The next turn boundary must not re-arm what the gate revoked (that would be a
    // per-turn refusal loop, not a decision).
    loop.beginTurn(1);
    expect(loop.currentSkill()).toBeUndefined();
    expect(refused).toHaveLength(1);
  });
});
