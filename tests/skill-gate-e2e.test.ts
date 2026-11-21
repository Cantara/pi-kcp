// Procedural governance through the real handlers (#28): the plan stage invokes the
// planner, and a skill the gates refuse never shapes the turn.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import register, { resetCapabilityCache, type KcpConfig } from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";
import type { SkillSelected } from "../src/skill-detection.js";

type Handler = (event: any, ctx: any) => any;

const PLAN_HELP = `Usage: kcp-agent plan "<task>" --manifest <path>

Options:
  --json              Emit JSON
  --trace             Emit per-unit gate verdicts
  --correlation-id    Thread a correlation id`;

function traceJson(gates: Array<{ gate: string; passed: boolean; detail: string }>): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "trace",
    gateSummary: [],
    units: [
      { id: "deploy", path: "skills/deploy/SKILL.md", outcome: "selected", gates },
    ],
  });
}

class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, { handler: Handler }>();
  sent: Array<{ content?: string }> = [];
  execCalls: string[][] = [];
  trace = traceJson([{ gate: "audience", passed: true, detail: "role 'agent' ok" }]);
  traceFlagSupported = true;

  registerCommand(name: string, options: { handler: Handler }): void {
    this.commands.set(name, options);
  }
  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  getCommands(): SlashCommandInfo[] {
    return [{ name: "skill:deploy", description: "", source: "project" } as never];
  }
  getAllTools(): unknown[] {
    return [];
  }
  sendMessage(message: { content?: string }): void {
    this.sent.push(message);
  }
  async exec(command: string, args: string[]): Promise<ExecResult> {
    this.execCalls.push([command, ...args]);
    if (command === "which" || args.includes("--version")) {
      return { stdout: "/usr/local/bin/kcp-agent", stderr: "", code: 0, killed: false };
    }
    if (args.includes("--help")) {
      const help = this.traceFlagSupported ? PLAN_HELP : PLAN_HELP.replace("  --trace             Emit per-unit gate verdicts\n", "");
      return { stdout: help, stderr: "", code: 0, killed: false };
    }
    if (args.includes("--trace")) {
      return { stdout: this.trace, stderr: "", code: 0, killed: false };
    }
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  }
  async fire(event: string, payload: any, cwd: string): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) {
      result = await handler(payload, { cwd, hasUI: false, isIdle: () => true });
    }
    return result;
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

let dir = "";

async function fixture(config: Partial<KcpConfig>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "pi-kcp-gate-"));
  await mkdir(join(d, ".pi"), { recursive: true });
  await writeFile(join(d, ".pi", "kcp.json"), JSON.stringify({ autoRecall: false, ...config }));
  await writeFile(join(d, "knowledge.yaml"), "project: t\nunits: []\n");
  return d;
}

function wire() {
  const refused: Array<[SkillSelected, string]> = [];
  const loop = new GovernedLoop({ hooks: { onSkillRefused: (s, r) => refused.push([s, r]) } });
  const pi = new FakePi();
  register(pi.asApi(), { loop, conformanceChecker: { async check() { return { conformant: true, reason: "" }; } } });
  return { pi, loop, refused };
}

/**
 * Pi's real order: `input` (forces a skill) → `before_agent_start` (the plan stage gates
 * it) → `turn_start` for the first round (not fired here — see below). Firing `turn_start`
 * FIRST, as this helper used to, hid the fact that `beginTurn` cleared
 * `tracedUnits`/`activeSkill` before either had ever been set (ref #69).
 *
 * Deliberately stops at `before_agent_start`: the plan stage's ledger entry is recorded
 * against the ledger current at that moment, and a following `turn_start` immediately
 * replaces it with a fresh one for its round (`beginTurn` resets round artifacts —
 * ledger included — per the target design in #71's follow-up review). Tests that need a
 * `tool_call` after this fire `turn_start` themselves, after making any plan-stage/ledger
 * assertions they need.
 */
async function upToPlan(pi: FakePi): Promise<void> {
  await pi.fire("input", { text: "/skill:deploy ship it", source: "user" }, dir);
  await pi.fire(
    "before_agent_start",
    { prompt: "ship it", systemPrompt: "you are pi", systemPromptOptions: {} },
    dir,
  );
}

describe("the plan stage gates skills through the planner", () => {
  beforeAll(async () => {
    dir = await fixture({ enabled: true, governance: "full" });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    // The capability cache is module-level: leaving it warm changes how later test files
    // see kcp-agent's flags.
    resetCapabilityCache();
  });
  beforeEach(() => resetCapabilityCache());

  it("invokes the planner with --trace", async () => {
    const { pi } = wire();
    await upToPlan(pi);

    const traced = pi.execCalls.find((c) => c.includes("--trace"));
    expect(traced).toBeDefined();
    expect(traced).toContain("--json");
    expect(traced).toContain("plan");
  });

  // A skill forced at `input` is active before the plan stage runs. The verdict arrives
  // after the selection and has to be able to undo it.
  it("revokes a forced skill the gates refuse, before it shapes anything", async () => {
    const { pi, loop, refused } = wire();
    pi.trace = traceJson([
      { gate: "temporal", passed: false, detail: "valid_until 2026-01-01 has passed" },
    ]);

    await pi.fire("input", { text: "/skill:deploy ship it", source: "user" }, dir);
    expect(loop.currentSkill()?.skillName).toBe("deploy");

    await pi.fire(
      "before_agent_start",
      { prompt: "ship it", systemPrompt: "y", systemPromptOptions: {} },
      dir,
    );

    expect(loop.currentSkill()).toBeUndefined();
    expect(refused).toHaveLength(1);
    expect(refused[0]![1]).toContain("valid_until 2026-01-01 has passed");
  });

  it("keeps a skill the gates admit", async () => {
    const { pi, loop, refused } = wire();
    await upToPlan(pi);

    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(refused).toEqual([]);
  });

  it("records the gating outcome on the plan stage", async () => {
    const { pi, loop } = wire();
    pi.trace = traceJson([{ gate: "deprecated", passed: false, detail: "retired 2026-02" }]);
    await upToPlan(pi);

    const plan = loop.turnRecord().decisions.find((d) => d.stage === "plan")!;
    expect(plan.status).toBe("ok");
    expect(plan.detail).toMatchObject({ gated: true, units: 1, revokedSkill: "deploy" });
  });

  // An agent that predates --trace must not turn every turn into a governance failure.
  it("records gated:false rather than erroring when --trace is unsupported", async () => {
    const { pi, loop, refused } = wire();
    pi.traceFlagSupported = false;
    await upToPlan(pi);

    const plan = loop.turnRecord().decisions.find((d) => d.stage === "plan")!;
    expect(plan.status).toBe("ok");
    expect(plan.detail).toMatchObject({ gated: false });
    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(refused).toEqual([]);
  });

  it("announces a refusal to the user by default", async () => {
    resetCapabilityCache();
    const pi = new FakePi();
    pi.trace = traceJson([{ gate: "supersession", passed: false, detail: "superseded by deploy-v2" }]);
    register(pi.asApi());
    await upToPlan(pi);

    const notice = pi.sent.find((m) => (m.content ?? "").includes("was not loaded"));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain("deploy-v2");
  });

  it("does not leak a previous prompt's trace into a new prompt's forced skill (#71 stale-trace fix)", async () => {
    const { pi, loop } = wire();
    pi.trace = traceJson([{ gate: "temporal", passed: false, detail: "expired" }]);

    // Prompt 1: forced, then refused by its OWN plan stage's trace.
    await upToPlan(pi);
    expect(loop.currentSkill()).toBeUndefined();

    await pi.fire("agent_start", {}, dir);
    await pi.fire("agent_settled", {}, dir);

    // Prompt 2: the SAME forced skill, before ITS OWN plan stage has run. Prompt 1's
    // refusing trace must not still apply to it — `input` clears the stale trace, so the
    // force is admitted (ungoverned) until this prompt's own `before_agent_start` sets a
    // fresh one.
    await pi.fire("input", { text: "/skill:deploy ship it again", source: "user" }, dir);
    expect(loop.currentSkill()?.skillName).toBe("deploy");
  });

  it("a settle race does not let a stale trace leak into the newer prompt (#71 follow-up)", async () => {
    const { pi, loop } = wire();
    pi.trace = traceJson([{ gate: "temporal", passed: true, detail: "ok" }]);

    await upToPlan(pi);
    await pi.fire("agent_start", {}, dir);
    expect(loop.currentSkill()?.skillName).toBe("deploy");

    // Before run A's own `agent_settled` handler runs, prompt B's `input` AND
    // `before_agent_start` already ran — as if an earlier-registered extension's
    // `agent_settled` handler started B synchronously before ours executed. A different
    // force, with no declared unit for it in A's (or B's, same fixture) trace at all —
    // proving its admission came from ITS OWN (trace-less-for-it) plan stage, not a
    // leftover from A.
    await pi.fire("input", { text: "/skill:narrow look around", source: "user" }, dir);
    await pi.fire(
      "before_agent_start",
      { prompt: "look around", systemPrompt: "y", systemPromptOptions: {} },
      dir,
    );
    expect(loop.currentSkill()?.skillName).toBe("narrow");

    // Run A's delayed settle now runs. It must not wipe B's just-installed selection.
    await pi.fire("agent_settled", {}, dir);
    expect(loop.currentSkill()?.skillName).toBe("narrow");
  });
});
