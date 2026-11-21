// A prompt that takes more than one round (a tool call, blocked or allowed, then the model's follow-up) used to read as UNGOVERNED on every continuation round:
//   "stage never reached the ledger: plan, synthesize, ground".
// `plan` (before_agent_start) and `synthesize`/`ground` (agent_end) happen once per PROMPT and are attached to the prompt's first round by design (see
// `recordLateStage`), but every round was judged against all seven stages, so a continuation round could never be governed. Found on a real box: a pi-kcp
// governed agent was asked to read a file its role may not read; turn 0 was fully governed with approve=blocked, and the model's answer in turn 1 made the whole
// task read "ungoverned".
//
// A continuation round (a `turn_start` with a turnIndex above 0, after the prompt's first round closed, with no new `before_agent_start`) is judged by the
// stages that belong to a round: load, assess, approve, act. The first round is unchanged and still owes everything. Real Pi 0.80.6 event order throughout.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register, { passThroughChecker, type KcpConfig } from "../src/index.js";
import type { ConformanceChecker } from "../src/conformance.js";
import { ALL_STAGES, expectedStagesFor, type TurnRecord, ungovernedReason } from "../src/runtime.js";
import { GovernedLoop } from "../src/governed-loop.js";

type Handler = (event: any, ctx: any) => any;

class FakePi {
  handlers = new Map<string, Handler[]>();
  registerCommand(): void {}
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
    for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, { cwd, hasUI: false });
    return result;
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

async function fixture(config: Partial<KcpConfig>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-kcp-continuation-"));
  await mkdir(join(dir, ".pi"), { recursive: true });
  await writeFile(join(dir, ".pi", "kcp.json"), JSON.stringify({ autoRecall: false, ...config }));
  return dir;
}

const denyingChecker: ConformanceChecker = { async check() { return { conformant: false, reason: "tool is structurally denied for this role" }; } };

function wire(checker: ConformanceChecker) {
  const ungoverned: Array<[TurnRecord, string]> = [];
  const loop = new GovernedLoop({ checker, hooks: { onUngoverned: (r, reason) => ungoverned.push([r, reason]) } });
  const pi = new FakePi();
  register(pi.asApi(), { loop });
  return { pi, loop, ungoverned };
}

const stagesOf = (r: TurnRecord) => r.decisions.map((d) => `${d.stage}=${d.status}`).join(", ");

describe("expectedStagesFor: a continuation round owes only the stages that belong to a round", () => {
  it("full mode, first round: everything; continuation: no plan, synthesize or ground", () => {
    expect([...expectedStagesFor("full")]).toEqual([...ALL_STAGES]);
    const cont = expectedStagesFor("full", true);
    for (const s of ["plan", "synthesize", "ground"] as const) expect(cont).not.toContain(s);
    for (const s of ["load", "assess", "approve", "act"] as const) expect(cont).toContain(s);
  });
  it("tool and off modes are not changed by it", () => {
    expect([...expectedStagesFor("tool", true)]).toEqual([...expectedStagesFor("tool")]);
    expect([...expectedStagesFor("off", true)]).toEqual([]);
  });
});

describe("a prompt with a continuation round (real Pi 0.80.6 event order)", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await fixture({ enabled: true, governance: "full" });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function twoRounds(pi: FakePi, opts: { loadInRound1: boolean; toolCall: "blocked" | "allowed" }) {
    await pi.fire("before_agent_start", { prompt: "read /etc/hostname", systemPrompt: "you are pi", systemPromptOptions: {} }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);
    await pi.fire("context", { messages: [{ role: "user" }] }, dir);
    const input = { file_path: "/etc/hostname" };
    await pi.fire("tool_call", { toolCallId: "t1", toolName: "read", input }, dir);
    if (opts.toolCall === "allowed") {
      await pi.fire("tool_result", { toolCallId: "t1", toolName: "read", input, content: [], isError: false }, dir);
    }
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, dir);
    // the continuation round of the SAME prompt: turn_start only, no before_agent_start
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, dir);
    if (opts.loadInRound1) await pi.fire("context", { messages: [{ role: "user" }, { role: "assistant" }] }, dir);
    await pi.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, dir);
    // agent_end arrives once, for the whole prompt, after BOTH rounds closed
    await pi.fire("agent_end", { messages: [{ role: "user" }, { role: "assistant" }, { role: "assistant" }] }, dir);
  }

  for (const toolCall of ["blocked", "allowed"] as const) {
    it(`after a ${toolCall} tool call, both rounds read governed and the follow-up round is not announced ungoverned`, async () => {
      const { pi, loop, ungoverned } = wire(toolCall === "blocked" ? denyingChecker : passThroughChecker);
      await twoRounds(pi, { loadInRound1: true, toolCall });
      const [r0, r1] = [loop.recentTurns().find((r) => r.turnIndex === 0)!, loop.recentTurns().find((r) => r.turnIndex === 1)!];
      expect(ungovernedReason(r0), `round 0: ${stagesOf(r0)}`).toBeUndefined();
      expect(ungovernedReason(r1), `round 1: ${stagesOf(r1)}`).toBeUndefined();
      // The at-close announcement for round 0 is honest about what was known then (synthesize/ground arrive late); round 1 must not be announced at all.
      expect(ungoverned.filter(([r]) => r.turnIndex === 1)).toEqual([]);
    });
  }

  it("a continuation round that never loaded its context is STILL reported, naming the missing stage", async () => {
    const { pi, loop } = wire(passThroughChecker);
    await twoRounds(pi, { loadInRound1: false, toolCall: "allowed" });
    const r1 = loop.recentTurns().find((r) => r.turnIndex === 1)!;
    expect(ungovernedReason(r1)).toBe("stage never reached the ledger: load");
  });

  it("the first round still owes plan, synthesize and ground: a prompt whose agent_end never arrives stays ungoverned", async () => {
    const { pi, loop } = wire(passThroughChecker);
    await pi.fire("before_agent_start", { prompt: "x", systemPrompt: "s", systemPromptOptions: {} }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);
    await pi.fire("context", { messages: [{ role: "user" }] }, dir);
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, dir);
    expect(ungovernedReason(loop.recentTurns()[0]!)).toBe("stage never reached the ledger: synthesize, ground");
  });

  it("a second prompt in the same session starts a fresh first round that owes everything again", async () => {
    const { pi, loop } = wire(passThroughChecker);
    await twoRounds(pi, { loadInRound1: true, toolCall: "allowed" });
    await pi.fire("before_agent_start", { prompt: "again", systemPrompt: "s", systemPromptOptions: {} }, dir);
    await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, dir);
    await pi.fire("context", { messages: [{ role: "user" }] }, dir);
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, dir);
    const last = loop.recentTurns()[loop.recentTurns().length - 1]!;
    expect(last.expectedStages).toEqual([...ALL_STAGES]);
    expect(ungovernedReason(last)).toBe("stage never reached the ledger: synthesize, ground");
  });
});
