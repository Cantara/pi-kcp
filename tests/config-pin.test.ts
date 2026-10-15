// covers: AL-0b-21 R-121 R-122 R-195
//
// The config pin: `.pi/kcp.json` is read once per session and cwd. An agent that can write the
// file must not be able to switch governance off, repoint `memoryUrl` or stop recall mid-session.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";

type Handler = (event: any, ctx: any) => any;

interface Sent {
  content?: string;
}

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: Handler }>();
  sent: Sent[] = [];
  notes: string[] = [];
  sessionId = "session-1";
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
  private ctx(cwd: string): any {
    const id = this.sessionId;
    return {
      cwd,
      hasUI: true,
      ui: { notify: (m: string) => this.notes.push(m) },
      sessionManager: { getSessionId: () => id },
    };
  }
  async fire(event: string, payload: any, cwd: string): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, this.ctx(cwd));
    return result;
  }
  async command(args: string, cwd: string): Promise<void> {
    await this.commands.get("kcp")!.handler(args, this.ctx(cwd));
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

// Two loopback kcp-memory servers: the original (A) and the one a rewritten file would name (B).
const hits = { a: 0, b: 0 };
let servers: Array<ReturnType<typeof Bun.serve>> = [];
let urlA = "";
let urlB = "";

function memoryServer(counter: "a" | "b"): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      hits[counter] += 1;
      return Response.json({ results: [{ slug: `from-${counter}`, firstMessage: `answer from ${counter}` }] });
    },
  });
}

beforeAll(() => {
  const a = memoryServer("a");
  const b = memoryServer("b");
  servers = [a, b];
  urlA = `http://localhost:${a.port}`;
  urlB = `http://localhost:${b.port}`;
});
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const dirs: string[] = [];
afterEach(async () => {
  hits.a = 0;
  hits.b = 0;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function fixture(config: Record<string, unknown> | undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-kcp-pin-"));
  dirs.push(dir);
  await mkdir(join(dir, ".pi"), { recursive: true });
  if (config) await writeConfig(dir, config);
  return dir;
}

async function writeConfig(dir: string, config: Record<string, unknown> | string): Promise<void> {
  await writeFile(join(dir, ".pi", "kcp.json"), typeof config === "string" ? config : JSON.stringify(config));
}

const PROMPT = "what did we decide yesterday about deployment";
const GOVERNED = { enabled: true, governance: "full", autoRecall: true, timeoutMs: 1000 };

/** A turn that ends without the cycle having run: warns `ungoverned` only when the mode is not off. */
async function cutShortTurn(pi: FakePi, cwd: string): Promise<boolean> {
  const before = pi.sent.length;
  await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, cwd);
  await pi.fire("before_agent_start", { prompt: "x", systemPrompt: "y", systemPromptOptions: {} }, cwd);
  await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, cwd);
  return pi.sent.slice(before).some((m) => (m.content ?? "").includes("ungoverned"));
}

async function recalled(pi: FakePi, cwd: string): Promise<boolean> {
  const result = await pi.fire("input", { text: PROMPT, source: "interactive" }, cwd);
  return result?.action === "transform";
}

describe("config pin", () => {
  it("AL-0b-21 [config-pin][local]: rewriting kcp.json to enabled=false does not change the next turn's mode", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);
    expect(await cutShortTurn(pi, dir)).toBe(true);

    await writeConfig(dir, { enabled: false });
    expect(await cutShortTurn(pi, dir)).toBe(true);
  });

  it("AL-0b-21 [config-pin][local]: rewriting memoryUrl does not change where the next input recalls", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await writeConfig(dir, { ...GOVERNED, memoryUrl: urlB });
    expect(await recalled(pi, dir)).toBe(true);
    expect(hits.a).toBe(1);
    expect(hits.b).toBe(0);
  });

  it("AL-0b-21 [config-pin][local]: before_agent_start firing before turn_start resolves the pinned mode", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await writeConfig(dir, { enabled: false });
    // Real Pi order: before_agent_start runs before turn_start for the first round.
    await pi.fire("before_agent_start", { prompt: "x", systemPrompt: "y", systemPromptOptions: {} }, dir);
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    await pi.fire("turn_end", { turnIndex: 1, message: {}, toolResults: [] }, dir);
    const warning = pi.sent.find((m) => (m.content ?? "").includes("ungoverned"));
    expect(warning).toBeDefined();
    expect(warning!.content).toContain("plan: ok"); // the plan stage ran under the pinned mode
  });

  it("AL-0b-21 [config-pin][local]: rewriting autoRecall does not stop recall", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await writeConfig(dir, { ...GOVERNED, memoryUrl: urlA, autoRecall: false });
    expect(await recalled(pi, dir)).toBe(true);
    expect(hits.a).toBe(1);
  });

  it("AL-0b-21 [config-pin][local]: invalid JSON mid-session does not invalidate the session", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await writeConfig(dir, "{ not json");
    expect(await cutShortTurn(pi, dir)).toBe(true);
    expect(await recalled(pi, dir)).toBe(true);
    await pi.command("health", dir);
    expect(pi.notes.at(-1)).toContain("config: configured");
    expect(pi.notes.at(-1)).not.toContain("invalid");
  });

  it("AL-0b-21 [config-pin][local]: deleting the file does not reset to defaults", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await unlink(join(dir, ".pi", "kcp.json"));
    expect(await cutShortTurn(pi, dir)).toBe(true);
    expect(await recalled(pi, dir)).toBe(true);
    expect(hits.a).toBe(1);
  });

  it("AL-0b-21 [config-pin][local]: a file absent at session start and created mid-session leaves the session at its pinned defaults", async () => {
    const dir = await fixture(undefined);
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await writeConfig(dir, { ...GOVERNED, memoryUrl: urlB });
    await pi.command("health", dir);
    expect(pi.notes.at(-1)).toContain("config: defaults");
    expect(await recalled(pi, dir)).toBe(false);
    expect(hits.b).toBe(0);
  });

  it("AL-0b-21 [config-pin][local]: session_start after the first turn_start of the same session keeps the pin, and a mid-session rewrite in between is ignored", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    expect(await cutShortTurn(pi, dir)).toBe(true); // lazy pin, no session_start yet

    await writeConfig(dir, { enabled: false });
    await pi.fire("session_start", { reason: "startup" }, dir); // same session id, arrives late
    expect(await cutShortTurn(pi, dir)).toBe(true);
  });

  it("AL-0b-21 [config-pin][local]: session_start with a new session id re-reads", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);
    expect(await cutShortTurn(pi, dir)).toBe(true);

    await writeConfig(dir, { enabled: false });
    pi.sessionId = "session-2";
    await pi.fire("session_start", { reason: "new" }, dir);
    expect(await cutShortTurn(pi, dir)).toBe(false);
  });

  it("AL-0b-21 [config-pin][local]: cwd values pin independently", async () => {
    const one = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const two = await fixture({ enabled: false });
    const pi = new FakePi();
    register(pi.asApi());
    expect(await cutShortTurn(pi, one)).toBe(true);
    expect(await cutShortTurn(pi, two)).toBe(false);

    await writeConfig(one, { enabled: false });
    await writeConfig(two, { ...GOVERNED, memoryUrl: urlA });
    expect(await cutShortTurn(pi, one)).toBe(true);
    expect(await cutShortTurn(pi, two)).toBe(false);
  });

  it("AL-0b-21 [config-pin][local]: lazy pin when session_start never fires", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    expect(await cutShortTurn(pi, dir)).toBe(true);

    await writeConfig(dir, { enabled: false });
    expect(await cutShortTurn(pi, dir)).toBe(true);
  });

  it("AL-0b-21 [config-pin][local]: /kcp health and /kcp recall use the pinned config", async () => {
    const dir = await fixture({ ...GOVERNED, memoryUrl: urlA });
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("session_start", { reason: "startup" }, dir);

    await writeConfig(dir, { enabled: false, memoryUrl: urlB });
    await pi.command("health", dir);
    expect(pi.notes.at(-1)).toContain("config: configured");
    expect(pi.notes.at(-1)).toContain("kcp-memory: ok");
    await pi.command("recall deployment", dir);
    expect(hits.a).toBe(1);
    expect(hits.b).toBe(0);
    expect(pi.notes.at(-1)).not.toContain("disabled");
  });
});
