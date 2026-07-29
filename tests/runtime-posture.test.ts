// Phase 2 — the runtime's posture when its own gate breaks.
//
// Phase 1 gave the cycle a liveness signal (`onUngoverned`) but the default wiring in
// register() built a loop with no hooks, so in the production path that signal fired into
// nothing. An ungoverned turn was still silent. These tests hold that shut.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register, { type KcpConfig } from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";

type Handler = (event: any, ctx: any) => any;

interface Sent {
  content?: string;
  customType?: string;
}

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: Handler }>();
  sent: Sent[] = [];
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
  sendMessage(message: Sent): void {
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

async function fixture(config: Partial<KcpConfig>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-kcp-posture-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "kcp.json"), JSON.stringify({ autoRecall: false, ...config }));
  return dir;
}

/** A turn that ends without the cycle having run — the silent-ungoverned case. */
async function cutShortTurn(pi: FakePi, cwd: string): Promise<void> {
  await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, cwd);
  await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, cwd);
}

describe("an ungoverned turn reaches the user by default", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await fixture({ enabled: true, governedLoop: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("announces when a turn completed without the cycle running", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await cutShortTurn(pi, dir);

    const warning = pi.sent.find((m) => (m.content ?? "").includes("ungoverned"));
    expect(warning).toBeDefined();
    expect(warning!.content).toMatch(/never reached/);
  });

  it("says nothing when the turn was governed", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    await pi.fire(
      "before_agent_start",
      { prompt: "x", systemPrompt: "y", systemPromptOptions: {} },
      dir,
    );
    await pi.fire("context", { messages: [] }, dir);
    const input = {};
    await pi.fire("tool_call", { toolCallId: "t1", toolName: "read", input }, dir);
    await pi.fire(
      "tool_result",
      { toolCallId: "t1", toolName: "read", input, content: [], isError: false },
      dir,
    );
    await pi.fire("agent_end", { messages: [] }, dir);
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, dir);

    expect(pi.sent.filter((m) => (m.content ?? "").includes("ungoverned"))).toEqual([]);
  });

  it("stays quiet when the governed cycle is off", async () => {
    const off = await fixture({ enabled: true, governedLoop: false });
    const pi = new FakePi();
    register(pi.asApi());
    await cutShortTurn(pi, off);

    expect(pi.sent.filter((m) => (m.content ?? "").includes("ungoverned"))).toEqual([]);
    await rm(off, { recursive: true, force: true });
  });
});

describe("gate-failure posture", () => {
  const brokenGate = {
    async check(): Promise<never> {
      throw new Error("conformance backend unreachable");
    },
  };

  it("gateHealthy() turns false once a stage has errored this turn", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    expect(loop.gateHealthy()).toBe(true);

    await loop.stage("plan", async () => {
      throw new Error("planner down");
    });
    expect(loop.gateHealthy()).toBe(false);
  });

  it("resets on the next turn", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(1);
    await loop.stage("plan", async () => {
      throw new Error("planner down");
    });
    loop.beginTurn(2);
    expect(loop.gateHealthy()).toBe(true);
  });

  // "announce" keeps the host usable and says the guarantee lapsed.
  it("announce: a broken gate does not block the tool call", async () => {
    const dir = await fixture({
      enabled: true,
      governedLoop: true,
      gateFailurePosture: "announce",
    });
    const pi = new FakePi();
    register(pi.asApi(), { conformanceChecker: brokenGate });

    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    const decision = await pi.fire("tool_call", { toolCallId: "t1", toolName: "bash", input: {} }, dir);

    expect(decision).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  // "block" is the fail-closed posture: if the runtime cannot establish what is
  // authorized, it does not authorize. `tool_call` is the one lever Pi honours.
  it("block: a broken gate refuses subsequent tool calls, with a reason", async () => {
    const dir = await fixture({
      enabled: true,
      governedLoop: true,
      gateFailurePosture: "block",
    });
    const pi = new FakePi();
    register(pi.asApi(), { conformanceChecker: brokenGate });

    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    // First call breaks the gate (checker throws) and is itself refused.
    const first = await pi.fire("tool_call", { toolCallId: "t1", toolName: "bash", input: {} }, dir);
    expect(first).toMatchObject({ block: true });
    expect(first.reason).toMatch(/could not be established|unreachable/i);

    // The gate stays broken for the rest of the turn.
    const second = await pi.fire("tool_call", { toolCallId: "t2", toolName: "read", input: {} }, dir);
    expect(second).toMatchObject({ block: true });
  });

  it("block: a healthy gate still passes conformant calls", async () => {
    const dir = await fixture({
      enabled: true,
      governedLoop: true,
      gateFailurePosture: "block",
    });
    const pi = new FakePi();
    register(pi.asApi(), {
      conformanceChecker: { async check() { return { conformant: true, reason: "" }; } },
    });

    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    expect(await pi.fire("tool_call", { toolCallId: "t1", toolName: "read", input: {} }, dir)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects an unknown posture in config", async () => {
    const { parseConfig } = await import("../src/index.js");
    const loaded = parseConfig({ gateFailurePosture: "ignore" });
    expect(loaded.status).toBe("invalid");
    expect(loaded.errors.join(" ")).toMatch(/gateFailurePosture/);
  });
});
