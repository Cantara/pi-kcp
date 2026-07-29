// The governed cycle running end-to-end through Pi's lifecycle (#27). Registration is not
// evidence that the loop runs — this drives the real handlers over a real turn and asserts
// the resulting stage record.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register, { passThroughChecker, type KcpConfig } from "../src/index.js";
import { ALL_STAGES, type TurnRecord } from "../src/runtime.js";
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

/** Drive one complete turn through the registered handlers. */
async function runTurn(pi: FakePi, cwd: string, turnIndex = 1): Promise<void> {
  await pi.fire("turn_start", { turnIndex, timestamp: 0 }, cwd);
  await pi.fire("input", { text: "add a health check", source: "user" }, cwd);
  await pi.fire(
    "before_agent_start",
    { prompt: "add a health check", systemPrompt: "you are pi", systemPromptOptions: {} },
    cwd,
  );
  await pi.fire("context", { messages: [{ role: "user" }, { role: "assistant" }] }, cwd);
  await pi.fire("tool_call", { toolName: "read", input: { file_path: "a.ts" } }, cwd);
  await pi.fire(
    "tool_result",
    { toolCallId: "t1", toolName: "read", input: {}, content: [], isError: false },
    cwd,
  );
  await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, cwd);
  await pi.fire("turn_end", { turnIndex, message: { role: "assistant" }, toolResults: [] }, cwd);
}

async function fixture(config: Partial<KcpConfig>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-kcp-cycle-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "kcp.json"), JSON.stringify({ autoRecall: false, ...config }));
  return dir;
}

describe("the governed cycle, end to end", () => {
  let onDir = "";
  let offDir = "";

  beforeAll(async () => {
    onDir = await fixture({ enabled: true, governedLoop: true });
    offDir = await fixture({ enabled: true, governedLoop: false });
  });
  afterAll(async () => {
    await rm(onDir, { recursive: true, force: true });
    await rm(offDir, { recursive: true, force: true });
  });

  function wire() {
    const records: TurnRecord[] = [];
    const ungoverned: Array<[TurnRecord, string]> = [];
    const loop = new GovernedLoop({
      checker: passThroughChecker,
      hooks: {
        onTurnRecorded: (r) => records.push(r),
        onUngoverned: (r, reason) => ungoverned.push([r, reason]),
      },
    });
    const pi = new FakePi();
    register(pi.asApi(), { loop });
    return { pi, records, ungoverned };
  }

  it("records every stage of the cycle in order", async () => {
    const { pi, records } = wire();
    await runTurn(pi, onDir);

    expect(records).toHaveLength(1);
    const stages = records[0]!.decisions.map((d) => d.stage);
    // approve/act fire at the tool boundary, which precedes agent_end in a real turn.
    expect(stages).toEqual(["plan", "load", "approve", "act", "synthesize", "ground", "assess"]);
    expect(new Set(stages)).toEqual(new Set(ALL_STAGES));
  });

  it("reports the turn as governed", async () => {
    const { pi, records, ungoverned } = wire();
    await runTurn(pi, onDir);

    expect(ungoverned).toEqual([]);
    expect(records[0]!.decisions.every((d) => d.status === "ok")).toBe(true);
  });

  it("stamps every decision with the turn correlation id", async () => {
    const { pi, records } = wire();
    await runTurn(pi, onDir);

    const ids = new Set(records[0]!.decisions.map((d) => d.correlationId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(records[0]!.correlationId);
  });

  it("stays out of the way when governedLoop is off", async () => {
    const { pi, records, ungoverned } = wire();
    await runTurn(pi, offDir);

    expect(records).toEqual([]);
    expect(ungoverned).toEqual([]);
  });

  // The whole point: a turn where a stage never reported must say so, because Pi would
  // otherwise let it complete silently.
  it("reports ungoverned when the cycle is cut short", async () => {
    const { pi, ungoverned } = wire();
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, onDir);
    await pi.fire(
      "before_agent_start",
      { prompt: "x", systemPrompt: "y", systemPromptOptions: {} },
      onDir,
    );
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, onDir);

    expect(ungoverned).toHaveLength(1);
    const [, reason] = ungoverned[0]!;
    expect(reason).toMatch(/never reached/);
    for (const stage of ["load", "synthesize", "ground", "approve", "act"]) {
      expect(reason).toContain(stage);
    }
  });

  it("records a blocked tool call as the approve stage refusing", async () => {
    const records: TurnRecord[] = [];
    const loop = new GovernedLoop({
      checker: { async check() { return { conformant: false, reason: "policy denied" }; } },
      hooks: { onTurnRecorded: (r) => records.push(r) },
    });
    const pi = new FakePi();
    register(pi.asApi(), { loop });

    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, onDir);
    const blocked = await pi.fire(
      "tool_call",
      { toolName: "bash", input: { command: "rm -rf /" } },
      onDir,
    );
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, onDir);

    expect(blocked).toEqual({ block: true, reason: "policy denied" });
    const approve = records[0]!.decisions.find((d) => d.stage === "approve");
    expect(approve).toMatchObject({ status: "blocked", reason: "policy denied" });
  });
});
