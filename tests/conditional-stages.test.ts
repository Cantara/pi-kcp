// A turn that used no tool never reaches `approve` or `act`. Those stages are conditional,
// not missing — and the difference matters enormously once the cycle is on by default:
// a warning that fires on ordinary Q&A is noise, and noise is how a real warning gets missed.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";
import type { TurnRecord } from "../src/runtime.js";

type Handler = (event: any, ctx: any) => any;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, unknown>();
  sent: Array<{ content?: string }> = [];
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
  sendMessage(message: { content?: string }): void {
    this.sent.push(message);
  }
  async exec(): Promise<ExecResult> {
    // No kcp-agent available — the situation most users start in.
    return { stdout: "", stderr: "not found", code: 1, killed: false };
  }
  async fire(event: string, payload: any, cwd: string): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, { cwd, hasUI: false });
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

let dir = "";

function wire() {
  const records: TurnRecord[] = [];
  const ungoverned: string[] = [];
  const loop = new GovernedLoop({
    hooks: {
      onTurnRecorded: (r) => records.push(r),
      onUngoverned: (_r, reason) => ungoverned.push(reason),
    },
  });
  const pi = new FakePi();
  register(pi.asApi(), { loop });
  return { pi, records, ungoverned };
}

/** The commonest turn there is: a question, an answer, no tool. */
async function qAndATurn(pi: FakePi): Promise<void> {
  await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
  await pi.fire("input", { text: "what does this repo do?", source: "user" }, dir);
  await pi.fire(
    "before_agent_start",
    { prompt: "what does this repo do?", systemPrompt: "y", systemPromptOptions: {} },
    dir,
  );
  await pi.fire("context", { messages: [{ role: "user" }] }, dir);
  await pi.fire("agent_end", { messages: [{ role: "assistant" }] }, dir);
  await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, dir);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-kcp-cond-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(
    join(dir, ".pi", "kcp.json"),
    JSON.stringify({ enabled: true, autoRecall: false, governance: "full" }),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a turn that used no tool", () => {
  it("is governed — the tool stages did not apply", async () => {
    const { pi, ungoverned } = wire();
    await qAndATurn(pi);

    expect(ungoverned).toEqual([]);
  });

  it("says nothing to the user", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await qAndATurn(pi);

    expect(pi.sent.filter((m) => (m.content ?? "").includes("ungoverned"))).toEqual([]);
  });

  it("records approve and act as skipped, with a reason — not as absent", async () => {
    const { pi, records } = wire();
    await qAndATurn(pi);

    const byStage = Object.fromEntries(records[0]!.decisions.map((d) => [d.stage, d]));
    expect(byStage.approve).toMatchObject({ status: "skipped" });
    expect(byStage.act).toMatchObject({ status: "skipped" });
    expect(byStage.approve!.reason).toMatch(/no tool call/i);
    expect(records[0]!.decisions).toHaveLength(7);
  });

  it("still reports a genuinely incomplete cycle", async () => {
    const { pi, ungoverned } = wire();
    // No before_agent_start, no context, no agent_end — the cycle really did not run.
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, dir);

    expect(ungoverned).toHaveLength(1);
    expect(ungoverned[0]).toMatch(/plan/);
    expect(ungoverned[0]).toMatch(/load/);
    // The conditional stages are accounted for, so they are not part of the complaint.
    expect(ungoverned[0]).not.toMatch(/approve/);
    expect(ungoverned[0]).not.toMatch(/\bact\b/);
  });
});

describe("a tool call that was blocked", () => {
  it("records act as skipped, saying the call never executed", async () => {
    const records: TurnRecord[] = [];
    const ungoverned: string[] = [];
    const loop = new GovernedLoop({
      checker: { async check() { return { conformant: false, reason: "policy denied" }; } },
      hooks: {
        onTurnRecorded: (r) => records.push(r),
        onUngoverned: (_r, reason) => ungoverned.push(reason),
      },
    });
    const pi = new FakePi();
    register(pi.asApi(), { loop });

    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    await pi.fire(
      "before_agent_start",
      { prompt: "x", systemPrompt: "y", systemPromptOptions: {} },
      dir,
    );
    await pi.fire("context", { messages: [] }, dir);
    await pi.fire("tool_call", { toolCallId: "t1", toolName: "bash", input: { command: "rm -rf /" } }, dir);
    // Blocked, so it never runs and no tool_result arrives.
    await pi.fire("agent_end", { messages: [] }, dir);
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, dir);

    const byStage = Object.fromEntries(records[0]!.decisions.map((d) => [d.stage, d]));
    expect(byStage.approve).toMatchObject({ status: "blocked", reason: "policy denied" });
    expect(byStage.act).toMatchObject({ status: "skipped" });
    expect(byStage.act!.reason).toMatch(/did not execute/i);

    // Governance worked. Blocking a call is the gate succeeding.
    expect(ungoverned).toEqual([]);
  });
});
