// `/kcp evidence` — the spine has to be readable, or "audit trail" is just a claim.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";

type Handler = (event: any, ctx: any) => any;

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: Handler }>();
  sent: Array<{ content?: string }> = [];
  registerCommand(name: string, options: { handler: Handler }): void {
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
const notices: string[] = [];
const ctx = () => ({ cwd: dir, hasUI: true, ui: { notify: (m: string) => void notices.push(m) } });

async function run(pi: FakePi, args: string): Promise<void> {
  notices.length = 0;
  await pi.commands.get("kcp")!.handler(args, ctx());
}

async function toolTurn(pi: FakePi, turnIndex: number, mutate = false): Promise<void> {
  const input: Record<string, unknown> = { command: "ls" };
  await pi.fire("turn_start", { turnIndex, timestamp: 0 }, dir);
  await pi.fire("tool_call", { toolCallId: `t${turnIndex}`, toolName: "bash", input }, dir);
  if (mutate) input.command = "rm -rf /";
  await pi.fire(
    "tool_result",
    { toolCallId: `t${turnIndex}`, toolName: "bash", input, content: [], isError: false },
    dir,
  );
  await pi.fire("turn_end", { turnIndex, message: {}, toolResults: [] }, dir);
}

describe("/kcp evidence", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-kcp-evidence-"));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "kcp.json"),
      JSON.stringify({ enabled: true, autoRecall: false, governedLoop: true }),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("says so plainly when there is nothing recorded yet", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await run(pi, "evidence");

    expect(notices.join("\n")).toMatch(/no turns recorded/i);
  });

  it("reports the last turn's stages and its correlation id", async () => {
    const loop = new GovernedLoop();
    const pi = new FakePi();
    register(pi.asApi(), { loop });
    await toolTurn(pi, 1);
    await run(pi, "evidence");

    const out = notices.join("\n");
    expect(out).toMatch(/turn 1/);
    expect(out).toMatch(/approve/);
    expect(out).toMatch(/act/);
    expect(out).toMatch(loop.turnRecord().correlationId.slice(0, 20));
  });

  it("names a turn that was not governed, and why", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await toolTurn(pi, 1, true);
    await run(pi, "evidence");

    const out = notices.join("\n");
    expect(out).toMatch(/ungoverned/i);
    expect(out).toMatch(/not honoured/i);
  });

  it("marks a governed turn as governed", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    const input = { file_path: "a.ts" };
    await pi.fire(
      "before_agent_start",
      { prompt: "x", systemPrompt: "y", systemPromptOptions: {} },
      dir,
    );
    await pi.fire("context", { messages: [] }, dir);
    await pi.fire("tool_call", { toolCallId: "t1", toolName: "read", input }, dir);
    await pi.fire(
      "tool_result",
      { toolCallId: "t1", toolName: "read", input, content: [], isError: false },
      dir,
    );
    await pi.fire("agent_end", { messages: [] }, dir);
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, dir);
    await run(pi, "evidence");

    expect(notices.join("\n")).toMatch(/governed/);
    expect(notices.join("\n")).not.toMatch(/ungoverned/i);
  });

  it("keeps a short history rather than only the last turn", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await toolTurn(pi, 1);
    await toolTurn(pi, 2);
    await toolTurn(pi, 3);
    await run(pi, "evidence 3");

    const out = notices.join("\n");
    for (const n of [1, 2, 3]) expect(out).toMatch(new RegExp(`turn ${n}`));
  });

  it("does not grow without bound", async () => {
    const loop = new GovernedLoop();
    const pi = new FakePi();
    register(pi.asApi(), { loop });
    for (let i = 1; i <= 30; i += 1) await toolTurn(pi, i);

    expect(loop.recentTurns().length).toBeLessThanOrEqual(20);
    // The most recent turn is retained; the oldest is the one dropped.
    expect(loop.recentTurns().at(-1)!.turnIndex).toBe(30);
  });

  it("is listed in help", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await run(pi, "help");

    expect(notices.join("\n")).toMatch(/\/kcp evidence/);
  });
});
