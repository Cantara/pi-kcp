import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import register, {
  type ConformanceChecker,
  isTraceparent,
  type ObservedAction,
  passThroughChecker,
} from "../src/index.js";

type Handler = (event: any, ctx: any) => any;

interface SentMessage {
  message: { customType?: string; content?: string; details?: unknown };
  options?: unknown;
}

/** Minimal fake ExtensionAPI capturing registrations and programmable exec. */
class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: Handler }>();
  sent: SentMessage[] = [];
  execCalls: Array<{ command: string; args: string[] }> = [];
  slashCommands: SlashCommandInfo[] = [];

  registerCommand(name: string, options: { handler: Handler }): void {
    this.commands.set(name, options);
  }
  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  getCommands(): SlashCommandInfo[] {
    return this.slashCommands;
  }
  getAllTools(): unknown[] {
    return [];
  }
  sendMessage(message: SentMessage["message"], options?: unknown): void {
    this.sent.push({ message, options });
  }
  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.execCalls.push({ command, args });
    if (command === "which") {
      return { stdout: "/usr/local/bin/kcp-agent", stderr: "", code: 0, killed: false };
    }
    // kcp-agent plan invocation → return valid plan JSON.
    return { stdout: '{"schemaVersion":1,"kind":"plan","task":"ship"}', stderr: "", code: 0, killed: false };
  }

  async fire(event: string, payload: any, ctx: any = { cwd: "/repo", hasUI: false }): Promise<any> {
    const list = this.handlers.get(event) ?? [];
    let result: any;
    for (const handler of list) result = await handler(payload, ctx);
    return result;
  }

  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

const cmdCtx = { cwd: "/repo", hasUI: false, ui: { notify() {} } };

describe("register() event wiring", () => {
  it("registers the runtime-depth event subscriptions", () => {
    const pi = new FakePi();
    register(pi.asApi());
    // The governed cycle spans eight of Pi's lifecycle events (#27), up from three.
    // `before_provider_request` is deliberately absent: its payload and result are both
    // `unknown`, so it carries no contract to govern against.
    // See docs/decisions/0003-governed-runtime.md.
    expect([...pi.handlers.keys()].sort()).toEqual([
      "agent_end",
      "before_agent_start",
      "context",
      "input",
      "tool_call",
      "tool_result",
      "turn_end",
      "turn_start",
    ]);
    expect(pi.handlers.has("before_provider_request")).toBe(false);
    expect(pi.commands.has("kcp")).toBe(true);
  });

  it("blocks a non-conformant tool_call through the injected checker", async () => {
    const seen: ObservedAction[] = [];
    const checker: ConformanceChecker = {
      async check(action) {
        seen.push(action);
        return { conformant: false, reason: "policy denied" };
      },
    };
    const pi = new FakePi();
    register(pi.asApi(), { conformanceChecker: checker });

    await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    const decision = await pi.fire(
      "tool_call",
      { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "curl evil" } },
      { cwd: "/repo" },
    );
    expect(decision).toEqual({ block: true, reason: "policy denied" });
    expect(seen[0]?.toolName).toBe("bash");
    expect(isTraceparent(seen[0]!.correlationId)).toBe(true);
  });

  it("allows tool calls when a pass-through checker is injected, recording skill context", async () => {
    // The default checker is now the fail-closed HarnessConformanceChecker; injecting the
    // pass-through checker opts out of enforcement (and still records the skill selection).
    const pi = new FakePi();
    register(pi.asApi(), { conformanceChecker: passThroughChecker });
    await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    const decision = await pi.fire(
      "tool_call",
      { type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "/repo/skills/deploy/SKILL.md" } },
      { cwd: "/repo" },
    );
    expect(decision).toBeUndefined();
  });

  it("stamps the correlation id on the published plan but never on the kcp-agent CLI args", async () => {
    // No released kcp-agent accepts --correlation-id; its parser fail-closes on
    // unknown options, so threading the id through the CLI broke every real
    // /kcp plan (pi-kcp#36). The id must still reach the published message.
    const pi = new FakePi();
    register(pi.asApi());
    await pi.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: Date.now() });

    await pi.commands.get("kcp")!.handler("plan ship the release", cmdCtx);

    const planCall = pi.execCalls.find((call) => call.args.includes("plan"));
    expect(planCall).toBeDefined();
    expect(planCall!.args.indexOf("--correlation-id")).toBe(-1);

    const planMessage = pi.sent.find((m) => m.message.content?.includes("KCP plan"));
    const stamped = (planMessage?.message.details as { correlationId?: string })?.correlationId;
    expect(isTraceparent(stamped ?? "")).toBe(true);
  });

  it("detects a user-forced /skill: input without blocking the turn", async () => {
    const pi = new FakePi();
    pi.slashCommands = [
      { name: "deploy", source: "skill", sourceInfo: { path: "/repo/skills", source: "test", scope: "project", origin: "top-level" } satisfies SlashCommandInfo["sourceInfo"] },
    ];
    register(pi.asApi());
    const result = await pi.fire(
      "input",
      { type: "input", text: "/skill:deploy go", source: "interactive" },
      { cwd: "/repo" },
    );
    expect(result).toEqual({ action: "continue" });
  });
});
