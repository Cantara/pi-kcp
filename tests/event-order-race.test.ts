// Pi 0.80.6 dispatches `before_agent_start` and `turn_end`/`agent_end` on paths that are
// NOT reliably ordered the way the governed cycle's design assumed — confirmed by tracing
// real timestamps against a real governed session:
//   - `before_agent_start` (plan) fires BEFORE `turn_start` has run, not after — so `mode`/
//     `turnConfig` (set by `turn_start`) are still stale, and `loop`'s ledger is still
//     scoped to whatever turn preceded this one.
//   - `agent_end` (synthesize, ground) fires AFTER `turn_end` has already closed the turn
//     and pushed its record to history, not before.
// `governed-cycle-e2e.test.ts`'s own fake fires events in the OTHER order (turn_start before
// before_agent_start, agent_end before turn_end) — a real, valid order this repo's own
// wrapper-cli tests also assume, and this file does not change or contradict that; it adds
// coverage for the order real Pi actually uses, which the original code silently lost `plan`
// and `synthesize`/`ground` under (see governed-loop.ts's `openRoundFromTurnStart`/
// `openRoundFromBeforeAgentStart`/`recordLateStage` for the fix and full reasoning).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register, { passThroughChecker, type KcpConfig } from "../src/index.js";
import { ALL_STAGES, type TurnRecord, ungovernedReason } from "../src/runtime.js";
import { GovernedLoop } from "../src/governed-loop.js";

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

async function fixture(config: Partial<KcpConfig>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-kcp-event-order-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "kcp.json"), JSON.stringify({ autoRecall: false, ...config }));
  return dir;
}

// `onTurnRecorded` fires exactly once per turn, at `finishTurn` — before a late-arriving
// `agent_end` can possibly patch it (see `recordLateStage`'s doc for why the patch does NOT
// re-fire it: at least one real consumer signs and appends a ledger line on every call, and
// a second notification for the same turn would double-sign it). So these tests assert
// against `loop.recentTurns()` (what `/kcp evidence` actually reads, fresh, every call) —
// not against the hook's necessarily-first-look snapshot, which a late patch never reaches.
function wire(cwd: string) {
  const ungoverned: Array<[TurnRecord, string]> = [];
  const loop = new GovernedLoop({
    checker: passThroughChecker,
    hooks: {
      onUngoverned: (r, reason) => ungoverned.push([r, reason]),
    },
  });
  const pi = new FakePi();
  register(pi.asApi(), { loop });
  return { pi, loop, ungoverned };
}

describe("real Pi 0.80.6 event order — before_agent_start before turn_start, agent_end after turn_end", () => {
  let onDir = "";

  beforeAll(async () => {
    onDir = await fixture({ enabled: true, governance: "full" });
  });
  afterAll(async () => {
    await rm(onDir, { recursive: true, force: true });
  });

  it("records plan even though before_agent_start fires before turn_start has run, and the turn reads governed once agent_end's late stages land", async () => {
    const { pi, loop, ungoverned } = wire(onDir);

    // The real order: before_agent_start arrives with no turn open yet for this prompt.
    await pi.fire(
      "before_agent_start",
      { prompt: "add a health check", systemPrompt: "you are pi", systemPromptOptions: {} },
      onDir,
    );
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, onDir);
    await pi.fire("context", { messages: [{ role: "user" }] }, onDir);
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, onDir);

    // finishTurn (inside turn_end) fires onUngoverned synchronously, honestly, with whatever
    // is known at THAT instant — synthesize/ground haven't arrived yet, so it correctly says
    // so. This is not a bug this fix claims to close (see finishTurn's own doc): the hook is
    // a one-time, at-close signal, not re-fired by a later patch — real consumers that DO
    // re-fire on every notification (wrapper-cli.ts's signing ledger) would double-sign a
    // turn if this hook fired twice for it.
    expect(ungoverned).toHaveLength(1);
    expect(ungoverned[0]![1]).toBe("stage never reached the ledger: synthesize, ground");

    // agent_end arrives late, after turn_end already closed and pushed the record — and
    // completes it. A FRESH read (what `/kcp evidence` actually does) now sees the whole
    // picture, even though the one-time hook notification above didn't and never will.
    await pi.fire("agent_end", { messages: [{ role: "user" }, { role: "assistant" }] }, onDir);
    expect(ungovernedReason(loop.recentTurns()[0]!)).toBeUndefined();
  });

  it("records all seven stages, including plan/synthesize/ground, in this order", async () => {
    const { pi, loop } = wire(onDir);

    await pi.fire(
      "before_agent_start",
      { prompt: "add a health check", systemPrompt: "you are pi", systemPromptOptions: {} },
      onDir,
    );
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, onDir);
    await pi.fire("context", { messages: [{ role: "user" }, { role: "assistant" }] }, onDir);
    const input = { file_path: "a.ts" };
    await pi.fire("tool_call", { toolCallId: "t1", toolName: "read", input }, onDir);
    await pi.fire(
      "tool_result",
      { toolCallId: "t1", toolName: "read", input, content: [], isError: false },
      onDir,
    );
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, onDir);
    await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, onDir);

    expect(loop.recentTurns()).toHaveLength(1);
    expect(new Set(loop.recentTurns()[0]!.decisions.map((d) => d.stage))).toEqual(new Set(ALL_STAGES));
  });

  it("keeps turn_start's real turnIndex, not before_agent_start's placeholder", async () => {
    const { pi, loop } = wire(onDir);

    await pi.fire(
      "before_agent_start",
      { prompt: "add a health check", systemPrompt: "you are pi", systemPromptOptions: {} },
      onDir,
    );
    await pi.fire("turn_start", { turnIndex: 7, timestamp: 0 }, onDir);
    await pi.fire("turn_end", { turnIndex: 7, message: { role: "assistant" }, toolResults: [] }, onDir);
    await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, onDir);

    expect(loop.recentTurns()).toHaveLength(1);
    expect(loop.recentTurns()[0]!.turnIndex).toBe(7);
  });

  it("does not attach a later round's late-arriving synthesize/ground to plan's round, or vice versa", async () => {
    const { pi, loop } = wire(onDir);

    // Round 0: before_agent_start fires once for the whole prompt.
    await pi.fire(
      "before_agent_start",
      { prompt: "add a health check", systemPrompt: "you are pi", systemPromptOptions: {} },
      onDir,
    );
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, onDir);
    const input = { file_path: "a.ts" };
    await pi.fire("tool_call", { toolCallId: "t1", toolName: "read", input }, onDir);
    await pi.fire(
      "tool_result",
      { toolCallId: "t1", toolName: "read", input, content: [], isError: false },
      onDir,
    );
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, onDir);

    // Round 1: a second tool round of the SAME prompt — turn_start only, no before_agent_start.
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, onDir);
    await pi.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, onDir);

    // agent_end finally arrives — once, for the whole prompt, after BOTH rounds closed.
    await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, onDir);

    expect(loop.recentTurns()).toHaveLength(2);
    const round0 = loop.recentTurns().find((r) => r.turnIndex === 0)!;
    const round1 = loop.recentTurns().find((r) => r.turnIndex === 1)!;
    expect(round0.decisions.some((d) => d.stage === "plan")).toBe(true);
    expect(round0.decisions.some((d) => d.stage === "synthesize")).toBe(true);
    expect(round0.decisions.some((d) => d.stage === "ground")).toBe(true);
    // Round 1 legitimately has neither — before_agent_start/agent_end are once-per-prompt,
    // not once-per-round, and this is round 1's own, correctly-reported ungoverned-for-those-
    // stages status, not a bug this fix is meant to close.
    expect(round1.decisions.some((d) => d.stage === "plan")).toBe(false);
    expect(round1.decisions.some((d) => d.stage === "synthesize")).toBe(false);
    expect(round1.decisions.some((d) => d.stage === "ground")).toBe(false);
  });

  it("is a silent no-op if agent_end arrives with no turn ever opened for the prompt (mode was not full)", async () => {
    const offDir = await fixture({ enabled: true, governance: "tool" });
    try {
      const { pi, loop, ungoverned } = wire(offDir);
      await pi.fire(
        "before_agent_start",
        { prompt: "add a health check", systemPrompt: "you are pi", systemPromptOptions: {} },
        offDir,
      );
      await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, offDir);
      await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, offDir);
      await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, offDir);

      expect(loop.recentTurns()).toHaveLength(1);
      expect(loop.recentTurns()[0]!.decisions.some((d) => d.stage === "plan")).toBe(false);
      expect(loop.recentTurns()[0]!.decisions.some((d) => d.stage === "synthesize")).toBe(false);
      // `tool` mode's own expectedStages never claims plan/synthesize/ground, so this is not
      // reported ungoverned for them (the existing "judged against what it promised" rule).
      expect(ungoverned).toEqual([]);
    } finally {
      await rm(offDir, { recursive: true, force: true });
    }
  });
});
