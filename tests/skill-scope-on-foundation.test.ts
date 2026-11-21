// #68 (agent-selected skill persists across tool rounds) replayed on top of the foundation
// merge (#82): pins both behaviours at once, through the real registered handlers, the real
// HarnessConformanceChecker and a real manifest, in the event order Pi 0.80.6 actually emits
// (before_agent_start BEFORE turn_start; agent_end AFTER turn_end).
//
// Also pins the strict-mode (`requireActiveSkill`) bootstrap admission: it exists so an agent
// can START a skill by reading its SKILL.md, and must not be usable as a general read bypass.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";
import { HarnessConformanceChecker } from "../src/harness-conformance.js";
import { isSkillReadPath } from "../src/skill-detection.js";
import { parseTrace } from "../src/skill-gate.js";

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
  async fire(event: string, payload: any, cwd: string, isIdle = true): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) {
      result = await handler(payload, { cwd, hasUI: false, isIdle: () => isIdle });
    }
    return result;
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

const MANIFEST = [
  "project: t",
  "units:",
  "  - id: deploy",
  "    kind: skill",
  "    path: skills/deploy/SKILL.md",
  "    action_scope:",
  "      tools: [read]",
  "",
].join("\n");

let fullDir = "";
let strictDir = "";

async function project(governance: string, requireActiveSkill: boolean): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pi-kcp-foundation-"));
  await mkdir(join(d, ".pi"), { recursive: true });
  await writeFile(
    join(d, ".pi", "kcp.json"),
    JSON.stringify({ enabled: true, governance, requireActiveSkill, autoRecall: false }),
  );
  await writeFile(join(d, "knowledge.yaml"), MANIFEST);
  return d;
}

beforeAll(async () => {
  fullDir = await project("full", false);
  strictDir = await project("tool", true);
});
afterAll(async () => {
  await rm(fullDir, { recursive: true, force: true });
  await rm(strictDir, { recursive: true, force: true });
});

/** One Pi prompt start in the real order: input, before_agent_start, agent_start, turn_start(0). */
async function startPrompt(pi: FakePi, cwd: string, text: string): Promise<void> {
  await pi.fire("input", { text, source: "rpc" }, cwd);
  await pi.fire("before_agent_start", { prompt: text, systemPrompt: "you are pi", systemPromptOptions: {} }, cwd);
  await pi.fire("agent_start", {}, cwd);
  await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, cwd);
}

const toolCall = (pi: FakePi, cwd: string, id: string, toolName: string, input: Record<string, unknown>) =>
  pi.fire("tool_call", { toolCallId: id, toolName, input }, cwd);

describe("agent-selected skill scope across tool rounds, on the foundation (#82) code", () => {
  it("applies the skill's action_scope on the SECOND round, in full governance mode", async () => {
    const pi = new FakePi();
    const loop = new GovernedLoop({ checker: new HarnessConformanceChecker() });
    register(pi.asApi(), { loop });

    await startPrompt(pi, fullDir, "run the deploy checklist");
    expect(loop.currentSkill()).toBeUndefined();

    // Round 0: the agent selects the skill by reading its SKILL.md.
    expect(await toolCall(pi, fullDir, "t1", "read", { path: "skills/deploy/SKILL.md" })).toBeUndefined();
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    await pi.fire("tool_result", { toolCallId: "t1", toolName: "read", input: {}, content: [], isError: false }, fullDir);
    await pi.fire("turn_end", { turnIndex: 0, message: { role: "assistant" }, toolResults: [] }, fullDir);

    // Round 1: foundation used to clear the skill at every turn_start, so this bash call
    // was unscoped. It must now be refused by the skill's tools: [read] scope.
    await pi.fire("turn_start", { turnIndex: 1, timestamp: 0 }, fullDir);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    const bash = await toolCall(pi, fullDir, "t2", "bash", { command: "ls" });
    expect(bash?.block).toBe(true);
    expect(bash.reason).toContain('tool "bash" is outside the skill\'s authorized tools');
    // ... while an in-scope call still passes.
    expect(await toolCall(pi, fullDir, "t3", "read", { path: "src/a.ts" })).toBeUndefined();

    // #82 behaviour intact: the late agent_end stages still record in full mode.
    await pi.fire("turn_end", { turnIndex: 1, message: { role: "assistant" }, toolResults: [] }, fullDir);
    await pi.fire("agent_end", { messages: [{ role: "user" }, { role: "assistant" }] }, fullDir);
    const record = loop.recentTurns()[0]!; // plan/synthesize/ground belong to the prompt's first round
    const stages = record.decisions.map((d) => d.stage);
    expect(stages).toContain("plan");
    expect(stages).toContain("synthesize");
    expect(stages).toContain("ground");

    // The skill survives agent_end (a retry/continuation may follow) ...
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    // ... and is cleared only when the prompt truly settles.
    await pi.fire("agent_settled", {}, fullDir);
    expect(loop.currentSkill()).toBeUndefined();
  });

  it("a skill is really cleared by a NEW user prompt, even if agent_settled never arrived", async () => {
    const pi = new FakePi();
    const loop = new GovernedLoop({ checker: new HarnessConformanceChecker() });
    register(pi.asApi(), { loop });

    await startPrompt(pi, fullDir, "first prompt");
    await toolCall(pi, fullDir, "t1", "read", { path: "skills/deploy/SKILL.md" });
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect((await toolCall(pi, fullDir, "t2", "bash", { command: "ls" }))?.block).toBe(true);

    // No agent_settled. A genuine new prompt (idle) stands alone.
    await startPrompt(pi, fullDir, "an unrelated second prompt");
    expect(loop.currentSkill()).toBeUndefined();
    // The previous prompt's scope no longer binds: bash is unscoped again (lenient mode).
    expect(await toolCall(pi, fullDir, "t3", "bash", { command: "ls" })).toBeUndefined();
  });

  it("a mid-run input (not idle) does NOT clear the in-force skill", async () => {
    const pi = new FakePi();
    const loop = new GovernedLoop({ checker: new HarnessConformanceChecker() });
    register(pi.asApi(), { loop });

    await startPrompt(pi, fullDir, "first prompt");
    await toolCall(pi, fullDir, "t1", "read", { path: "skills/deploy/SKILL.md" });
    await pi.fire("input", { text: "steer", source: "rpc" }, fullDir, false);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
  });
});

describe("strict-mode bootstrap SKILL.md admission (requireActiveSkill)", () => {
  async function strictPi(): Promise<{ pi: FakePi; loop: GovernedLoop }> {
    const pi = new FakePi();
    const loop = new GovernedLoop({ checker: new HarnessConformanceChecker({ requireActiveSkill: true }) });
    register(pi.asApi(), { loop });
    await startPrompt(pi, strictDir, "do the thing");
    return { pi, loop };
  }

  it.each([
    ["an ordinary file", "read", { path: "/etc/passwd" }],
    ["a file that merely ends in SKILL.md", "read", { path: "/etc/shadow-SKILL.md" }],
    ["a name that ends in SKILL.md", "read", { path: "MYSKILL.md" }],
    ["a SKILL.md backup", "read", { path: "skills/deploy/SKILL.md.bak" }],
    ["a different tool carrying a SKILL.md path", "bash", { path: "skills/deploy/SKILL.md", command: "cat /etc/passwd" }],
    ["a write to a SKILL.md", "write", { path: "skills/deploy/SKILL.md", content: "x" }],
  ])("refuses %s and activates no skill", async (_label, toolName, input) => {
    const { pi, loop } = await strictPi();
    const verdict = await toolCall(pi, strictDir, "t1", toolName, input as Record<string, unknown>);
    expect(verdict?.block).toBe(true);
    expect(verdict.reason).toContain("no active skill — fail-closed (requireActiveSkill)");
    expect(loop.currentSkill()).toBeUndefined();
  });

  it("a refused attempt does not satisfy the requirement for later actions", async () => {
    const { pi, loop } = await strictPi();
    await toolCall(pi, strictDir, "t1", "read", { path: "/etc/shadow-SKILL.md" });
    const next = await toolCall(pi, strictDir, "t2", "read", { path: "src/a.ts" });
    expect(next?.block).toBe(true);
    expect(loop.currentSkill()).toBeUndefined();
  });

  it("a genuine SKILL.md read whose skill the planner refuses is not an activation", async () => {
    const { pi, loop } = await strictPi();
    loop.setTracedUnits(
      parseTrace(
        JSON.stringify({
          units: [{ id: "deploy", path: "skills/deploy/SKILL.md", outcome: "selected",
            gates: [{ gate: "temporal", passed: false, detail: "expired" }] }],
        }),
      ),
    );
    // The SKILL.md read itself is allowed (it only reads a skill file) ...
    expect(await toolCall(pi, strictDir, "t1", "read", { path: "skills/deploy/SKILL.md" })).toBeUndefined();
    // ... but no skill is in force, so the strict requirement is still unmet.
    expect(loop.currentSkill()).toBeUndefined();
    const next = await toolCall(pi, strictDir, "t2", "read", { path: "src/a.ts" });
    expect(next?.block).toBe(true);
  });

  it("isSkillReadPath requires the final segment to be exactly SKILL.md", () => {
    expect(isSkillReadPath("skills/deploy/SKILL.md")).toBe(true);
    expect(isSkillReadPath("SKILL.md")).toBe(true);
    expect(isSkillReadPath("C:\\skills\\deploy\\SKILL.md")).toBe(true);
    expect(isSkillReadPath("/etc/shadow-SKILL.md")).toBe(false);
    expect(isSkillReadPath("MYSKILL.md")).toBe(false);
    expect(isSkillReadPath("skills/SKILL.md/other.txt")).toBe(false);
  });
});
