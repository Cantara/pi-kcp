// A skill selection must survive the whole PROMPT, not just one Pi turn/round (#28, #67,
// #69, #70, #71 — the prompt-scoped skill lifecycle).
//
// Pi's real event order is `input` → `before_agent_start` → `turn_start(0)` → `tool_call`
// → ... → `turn_start(N)` → ... → `agent_end` → possibly `turn_start` again with NO new
// `input` in between (retry/compaction/queued continuation —
// `while (_handlePostAgentRun()) agent.continue()` in agent-session.js) → eventually
// `agent_settled`, which is the only event Pi guarantees means "this prompt is truly over."
// `GovernedLoop.beginTurn()` (called from `turn_start`) resets only ROUND artifacts —
// the correlation id, the ledger, this round's approvals — and does not touch the active
// skill or the planner's traced units, which live from `input`/`before_agent_start` through
// `agent_settled` (`GovernedLoop.endPrompt()`). This file replays that real sequence
// through the actually-registered handlers, with the real `HarnessConformanceChecker` over
// a real manifest.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";
import { HarnessConformanceChecker } from "../src/harness-conformance.js";
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
let dirLenient = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-kcp-forced-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  // Strict mode: only ever act within a declared skill. This is the configuration under
  // which the original bug was observed in production (an RPC-driven Pi consumer).
  await writeFile(
    join(dir, ".pi", "kcp.json"),
    JSON.stringify({ enabled: true, governance: "tool", requireActiveSkill: true, autoRecall: false }),
  );
  // The real manifest the HarnessConformanceChecker resolves action_scope from. `narrow`
  // deliberately excludes `read`, so a SKILL.md read attempted while it is active is
  // itself non-conformant — the fixture the no-swap-on-block test needs.
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
      "  - id: narrow",
      "    kind: skill",
      "    path: skills/narrow/SKILL.md",
      "    action_scope:",
      "      tools: [bash]",
      "",
    ].join("\n"),
  );

  // Lenient (default) mode: no active skill passes conformance, unscoped. Used where a
  // test needs to bootstrap a skill purely by an agent SKILL.md read with nothing already
  // active — under strict mode that first read is itself fail-closed (#70's fix means a
  // read is judged by whatever skill is ALREADY in force, and none is, yet).
  dirLenient = await mkdtemp(join(tmpdir(), "pi-kcp-forced-lenient-"));
  await mkdir(join(dirLenient, ".pi"), { recursive: true });
  await writeFile(
    join(dirLenient, ".pi", "kcp.json"),
    JSON.stringify({ enabled: true, governance: "tool", requireActiveSkill: false, autoRecall: false }),
  );
  await writeFile(
    join(dirLenient, "knowledge.yaml"),
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
  await rm(dirLenient, { recursive: true, force: true });
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

describe("an agent-driven skill selection survives the whole prompt (ref #67, #71)", () => {
  it(
    "stays scoped across turn_start rounds and an agent_end continuation, " +
      "and clears only at agent_settled — never at agent_end",
    async () => {
      const pi = new FakePi();
      register(pi.asApi());

      // A write is outside deploy's action_scope (`tools: [read]`) — a clean probe for
      // "is a skill active and scoped" vs. "nothing active, unscoped" under lenient mode:
      // blocked means deploy is still in force, undefined means it is not.
      const probe = (toolCallId: string) =>
        pi.fire("tool_call", { toolCallId, toolName: "write", input: { path: "/tmp/x", content: "x" } }, dirLenient);

      await pi.fire("input", { text: "run the deploy checklist", source: "rpc" }, dirLenient);
      await pi.fire(
        "before_agent_start",
        { prompt: "run the deploy checklist", systemPrompt: "you are pi", systemPromptOptions: {} },
        dirLenient,
      );
      await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dirLenient);

      // The agent loads the skill itself: a read of its SKILL.md. No skill was active
      // before it, so under lenient mode the read itself passes conformance, and only
      // THEN does it take effect as a selection (#70).
      const load = await pi.fire(
        "tool_call",
        { toolCallId: "t1", toolName: "read", input: { path: `${dirLenient}/skills/deploy/SKILL.md` } },
        dirLenient,
      );
      expect(load).toBeUndefined();
      expect((await probe("t2")).block).toBe(true);

      // A second round of the SAME prompt: turn_start fires again, and the skill is
      // still scoped (ref #67 — this used to be wiped here).
      await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dirLenient);
      expect((await probe("t3")).block).toBe(true);

      // agent_end: NOT the prompt boundary (ref #71). Pi may retry/compact/continue after
      // this with no new `input`. The skill must still be scoped in that continuation.
      await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, dirLenient);
      await pi.fire("turn_start", { turnIndex: 2, timestamp: 0 }, dirLenient);
      expect((await probe("t4")).block).toBe(true);

      // agent_settled: the true prompt boundary. Only now does the skill clear.
      await pi.fire("agent_settled", {}, dirLenient);
      await pi.fire("input", { text: "now something else", source: "extension" }, dirLenient);
      await pi.fire("turn_start", { turnIndex: 3, timestamp: 0 }, dirLenient);
      expect(await probe("t5")).toBeUndefined();
    },
  );

  it("a later SKILL.md read for a different skill replaces it mid-prompt", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(0);
    await loop.evaluateToolCall("read", { path: "skills/deploy/SKILL.md" }, { cwd: "/repo" });
    expect(loop.currentSkill()?.skillName).toBe("deploy");

    loop.beginTurn(1);
    await loop.evaluateToolCall("read", { path: "skills/other/SKILL.md" }, { cwd: "/repo" });
    expect(loop.currentSkill()?.skillName).toBe("other");
  });

  it("ends at the next input that does not re-select it", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    await pi.fire("input", { text: "run the deploy checklist", source: "rpc" }, dirLenient);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dirLenient);
    await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: `${dirLenient}/skills/deploy/SKILL.md` } },
      dirLenient,
    );

    // New prompt, no SKILL.md read in it: the prior agent-driven selection must not
    // survive into it — a write outside deploy's scope now passes unscoped.
    await pi.fire("input", { text: "now something unrelated", source: "rpc" }, dirLenient);
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dirLenient);
    const decision = await pi.fire(
      "tool_call",
      { toolCallId: "t2", toolName: "write", input: { path: "/tmp/x", content: "x" } },
      dirLenient,
    );
    expect(decision).toBeUndefined();
  });
});

describe("SKILL.md-read precedence and no-swap-on-block (ref #70)", () => {
  it("an agent-driven read cannot override an active user-forced skill", async () => {
    const pi = new FakePi();
    // A pre-built loop bypasses register()'s own checker construction (its `checker` is
    // fixed at construction time), so wire it with the real HarnessConformanceChecker
    // here to actually exercise scope enforcement, matching `dir`'s strict fixture.
    const loop = new GovernedLoop({ checker: new HarnessConformanceChecker({ requireActiveSkill: true }) });
    register(pi.asApi(), { loop });

    await pi.fire("input", { text: "/skill:deploy go", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(loop.currentSkill()?.source).toBe("user");

    // A read of a different skill's SKILL.md is itself a `read` call, which is IN scope
    // for `deploy` (tools: [read]) — so it is conformant and would normally take effect...
    const read = await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: "skills/narrow/SKILL.md" } },
      dir,
    );
    expect(read).toBeUndefined();

    // ...but precedence refuses the swap: a user force holds until revocation or prompt
    // end, and an agent read never displaces it.
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(loop.currentSkill()?.source).toBe("user");
  });

  it("a non-conformant SKILL.md read does not swap the skill", async () => {
    const pi = new FakePi();
    const loop = new GovernedLoop({ checker: new HarnessConformanceChecker({ requireActiveSkill: true }) });
    register(pi.asApi(), { loop });

    // `narrow`'s scope is `tools: [bash]` — it does not authorize `read` at all, so
    // reading ANY SKILL.md while it is active, including a wider one, is itself blocked.
    await pi.fire("input", { text: "/skill:narrow go", source: "rpc" }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);
    expect(loop.currentSkill()?.skillName).toBe("narrow");

    const read = await pi.fire(
      "tool_call",
      { toolCallId: "t1", toolName: "read", input: { path: "skills/deploy/SKILL.md" } },
      dir,
    );
    expect(read.block).toBe(true);

    // No swap happened: `narrow` is still active, and its scope (bash-only) still governs
    // — a bash call passes, proving the loop did not fall back to "no skill" either.
    expect(loop.currentSkill()?.skillName).toBe("narrow");
    const bash = await pi.fire(
      "tool_call",
      { toolCallId: "t2", toolName: "bash", input: { command: "ls" } },
      dir,
    );
    expect(bash).toBeUndefined();
  });
});

describe("the skill and the planner trace persist across beginTurn (no per-round reset)", () => {
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

  it("both a user-forced and an agent-loaded skill survive beginTurn unchanged", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(0);

    await loop.evaluateToolCall("read", { path: "skills/deploy/SKILL.md" }, { cwd: "/repo" });
    expect(loop.currentSkill()?.source).toBe("agent");
    loop.beginTurn(1);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(loop.currentSkill()?.source).toBe("agent");

    // A subsequent /skill: input ends the agent-driven persistence and takes over.
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

    // The next turn boundary must not re-arm what the gate revoked — there is no
    // re-selection at the turn boundary any more to do that.
    loop.beginTurn(1);
    expect(loop.currentSkill()).toBeUndefined();
    expect(refused).toHaveLength(1);
  });

  it("the trace itself is prompt-scoped: it survives beginTurn, and only endPrompt clears it (ref #69)", () => {
    const loop = new GovernedLoop();
    loop.beginTurn(0);
    loop.setTracedUnits(
      trace([{ id: "deploy", path: "skills/deploy/SKILL.md", gates: [{ gate: "temporal", passed: false, detail: "expired" }] }]),
    );

    // The trace refuses `deploy` — this still holds after a turn boundary with no new
    // trace, because beginTurn does not clear it.
    loop.beginTurn(1);
    loop.observeInput("/skill:deploy go", commands);
    expect(loop.currentSkill()).toBeUndefined();

    // Only the prompt boundary clears it, so a fresh prompt with no trace is admitted
    // rather than silently refused by a stale one.
    loop.endPrompt();
    loop.beginTurn(2);
    loop.observeInput("/skill:deploy go", commands);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
  });
});
