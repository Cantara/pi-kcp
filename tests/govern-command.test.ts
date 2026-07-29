// `/kcp govern` — the in-session switch. Turning governance off is itself a governance
// event, so it is announced rather than applied quietly.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";

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
const ctx = () => ({
  cwd: dir,
  hasUI: true,
  ui: { notify: (m: string) => void notices.push(m) },
});

async function govern(pi: FakePi, args: string): Promise<void> {
  notices.length = 0;
  await pi.commands.get("kcp")!.handler(args, ctx());
}

/** A turn that runs no stages — governed cycle on means this reports ungoverned. */
async function emptyTurn(pi: FakePi, turnIndex = 1): Promise<void> {
  await pi.fire("turn_start", { turnIndex, timestamp: 0 }, dir);
  await pi.fire("turn_end", { turnIndex, message: {}, toolResults: [] }, dir);
}

function ungovernedCount(pi: FakePi): number {
  return pi.sent.filter((m) => (m.content ?? "").includes("ungoverned")).length;
}

describe("/kcp govern", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-kcp-govern-"));
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(
      join(dir, ".pi", "kcp.json"),
      JSON.stringify({ enabled: true, autoRecall: false, governedLoop: true }),
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the configured state", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await govern(pi, "govern status");

    expect(notices.join("\n")).toMatch(/on/i);
  });

  it("off stops the cycle running, and says so", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    await emptyTurn(pi, 1);
    expect(ungovernedCount(pi)).toBe(1);

    await govern(pi, "govern off");
    expect(notices.join("\n")).toMatch(/off/i);

    await emptyTurn(pi, 2);
    // Still 1: the cycle is not running, so there is nothing to report as ungoverned.
    expect(ungovernedCount(pi)).toBe(1);
  });

  it("turning governance off is announced, not applied quietly", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await govern(pi, "govern off");

    const announced = pi.sent.find((m) => (m.content ?? "").toLowerCase().includes("governance"));
    expect(announced).toBeDefined();
    expect(announced!.content).toMatch(/off|disabled/i);
  });

  it("on restores the cycle after an off", async () => {
    const pi = new FakePi();
    register(pi.asApi());

    await govern(pi, "govern off");
    await emptyTurn(pi, 1);
    expect(ungovernedCount(pi)).toBe(0);

    await govern(pi, "govern on");
    await emptyTurn(pi, 2);
    expect(ungovernedCount(pi)).toBe(1);
  });

  it("rejects an unknown argument without changing state", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await govern(pi, "govern sideways");

    expect(notices.join("\n")).toMatch(/on\|off\|status/);
    await emptyTurn(pi, 1);
    expect(ungovernedCount(pi)).toBe(1);
  });

  it("is listed in help", async () => {
    const pi = new FakePi();
    register(pi.asApi());
    await govern(pi, "help");

    expect(notices.join("\n")).toMatch(/\/kcp govern/);
  });
});
