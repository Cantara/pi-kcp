import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult, ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import register, {
  type ActionScope,
  type CheckConformanceFn,
  type ConformanceContext,
  HarnessConformanceChecker,
  ManifestScopeResolver,
  matchSkillUnit,
  type ObservedAction,
  type ScopeResolver,
  type SkillSelected,
  toHarnessAction,
} from "../src/index.js";

const ctx: ConformanceContext = { cwd: "/repo" };
const CID = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const deploySkill: SkillSelected = {
  skillPath: "/repo/skills/deploy/SKILL.md",
  skillName: "deploy",
  source: "agent",
};

/** A resolver that returns a fixed scope and counts how often it was asked. */
function stubResolver(scope: ActionScope | undefined): ScopeResolver & { calls: number } {
  return {
    calls: 0,
    async resolve() {
      this.calls += 1;
      return scope;
    },
  };
}

function action(toolName: string, input: Record<string, unknown>, skill?: SkillSelected): ObservedAction {
  return { toolName, input, correlationId: CID, ...(skill ? { skillContext: skill } : {}) };
}

describe("HarnessConformanceChecker (#28 enforcement)", () => {
  it("allows an in-scope tool_call and blocks an out-of-scope one with the harness reason", async () => {
    const resolver = stubResolver({ tools: ["read"], paths: ["/repo/deploy"] });
    const checker = new HarnessConformanceChecker({ resolveScope: resolver });

    const inScope = await checker.check(action("read", { path: "/repo/deploy/config.yaml" }, deploySkill), ctx);
    expect(inScope.conformant).toBe(true);
    expect(inScope.reason).toContain("within the active skill's declared action_scope");

    const outByPath = await checker.check(action("read", { path: "/etc/passwd" }, deploySkill), ctx);
    expect(outByPath.conformant).toBe(false);
    // The harness names the specific violating target.
    expect(outByPath.reason).toContain("/etc/passwd");
    expect(outByPath.reason).toContain("outside the skill's authorized paths");

    const outByTool = await checker.check(action("bash", { command: "curl evil.example" }, deploySkill), ctx);
    expect(outByTool.conformant).toBe(false);
    expect(outByTool.reason).toContain('tool "bash" is outside the skill\'s authorized tools');
  });

  it("fail-closes when there is no active skill", async () => {
    const resolver = stubResolver({ tools: ["read"] });
    const checker = new HarnessConformanceChecker({ resolveScope: resolver });
    const result = await checker.check(action("read", { path: "/repo/x.ts" }), ctx);
    expect(result.conformant).toBe(false);
    expect(result.reason).toContain("no active skill");
    // No skill → no scope resolution attempted.
    expect(resolver.calls).toBe(0);
  });

  it("fail-closes when the active skill declares no action_scope", async () => {
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(undefined) });
    const result = await checker.check(action("read", { path: "/repo/x.ts" }, deploySkill), ctx);
    expect(result.conformant).toBe(false);
    expect(result.reason).toContain("fail-closed");
  });

  it("delegates the decision to checkConformance (spy) with the mapped action + scope", async () => {
    let calls = 0;
    let seenTool: string | undefined;
    let seenScope: ActionScope | undefined;
    const spy: CheckConformanceFn = (observed, scope) => {
      calls += 1;
      seenTool = observed.tool;
      seenScope = scope;
      return { gate: "conformance", passed: true, reason: "spy-approved" };
    };
    const scope: ActionScope = { tools: ["read"], paths: ["/repo"] };
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(scope), check: spy });

    const result = await checker.check(action("read", { path: "/repo/x.ts" }, deploySkill), ctx);
    expect(calls).toBe(1);
    expect(seenTool).toBe("read");
    expect(seenScope).toEqual(scope);
    expect(result).toEqual({ conformant: true, reason: "spy-approved" });
  });

  it("caches the resolved scope per active skill", async () => {
    const resolver = stubResolver({ tools: ["read"] });
    const checker = new HarnessConformanceChecker({ resolveScope: resolver });
    await checker.check(action("read", { path: "/repo/a.ts" }, deploySkill), ctx);
    await checker.check(action("read", { path: "/repo/b.ts" }, deploySkill), ctx);
    expect(resolver.calls).toBe(1);
  });
});

describe("toHarnessAction mapping", () => {
  it("maps a pi lowercase read (input.path) to a harness action target", () => {
    const mapped = toHarnessAction(action("read", { path: "/repo/x.ts" }, deploySkill));
    expect(mapped).toEqual({ tool: "read", paths: ["/repo/x.ts"] });
  });

  it("maps a Claude-Code Write (file_path) and a WebFetch (url)", () => {
    expect(toHarnessAction(action("Write", { file_path: "/repo/y.ts" }))).toEqual({
      tool: "Write",
      paths: ["/repo/y.ts"],
    });
    expect(toHarnessAction(action("WebFetch", { url: "https://x.example/a" }))).toEqual({
      tool: "WebFetch",
      urls: ["https://x.example/a"],
    });
  });
});

describe("ManifestScopeResolver (knowledge.yaml direct fallback)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempManifest(yaml: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pi-kcp-manifest-"));
    dirs.push(dir);
    await writeFile(join(dir, "knowledge.yaml"), yaml, "utf8");
    return dir;
  }

  it("reads the skill unit's action_scope from knowledge.yaml (matched by id)", async () => {
    const dir = await tempManifest(
      [
        "project: demo",
        "version: 1.0.0",
        "units:",
        "  - id: deploy",
        "    path: skills/deploy/SKILL.md",
        "    intent: deploy the service",
        "    audience: [agent]",
        "    triggers: [deploy]",
        "    kind: skill",
        "    action_scope:",
        "      tools: [read, bash]",
        "      paths: [src/deploy]",
        "",
      ].join("\n"),
    );
    const resolver = new ManifestScopeResolver();
    const scope = await resolver.resolve(deploySkill, { cwd: dir });
    expect(scope).toEqual({ tools: ["read", "bash"], paths: ["src/deploy"] });
  });

  it("returns undefined when the manifest is missing or the unit has no scope", async () => {
    const missing = new ManifestScopeResolver();
    expect(await missing.resolve(deploySkill, { cwd: "/nonexistent-dir-xyz" }).catch(() => "threw")).toBe("threw");

    const dir = await tempManifest(
      ["project: demo", "version: 1.0.0", "units:", "  - id: deploy", "    path: p", "    intent: i", "    audience: [agent]", "    triggers: [t]", ""].join("\n"),
    );
    expect(await new ManifestScopeResolver().resolve(deploySkill, { cwd: dir })).toBeUndefined();
  });
});

describe("matchSkillUnit", () => {
  it("prefers an exact id match, then a path overlap", () => {
    const units = [
      { id: "other", path: "skills/other/SKILL.md" },
      { id: "deploy", path: "skills/deploy/SKILL.md", action_scope: { tools: ["read"] } },
    ];
    expect(matchSkillUnit(units, deploySkill)?.id).toBe("deploy");

    const byPath = matchSkillUnit([{ id: "renamed", path: "skills/deploy/SKILL.md" }], deploySkill);
    expect(byPath?.id).toBe("renamed");
  });
});

// End-to-end through register(): the default (harness) checker fail-closes an out-of-scope
// call and admits an in-scope one, resolving action_scope from a real knowledge.yaml.
describe("register() default wiring is harness-backed and fail-closed", () => {
  type Handler = (event: any, ctx: any) => any;
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  class FakePi {
    handlers = new Map<string, Handler[]>();
    commands = new Map<string, { handler: Handler }>();
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
    sendMessage(): void {}
    async exec(): Promise<ExecResult> {
      return { stdout: "", stderr: "", code: 1, killed: false };
    }
    async fire(event: string, payload: any, fireCtx: any): Promise<any> {
      let result: any;
      for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, fireCtx);
      return result;
    }
    asApi(): ExtensionAPI {
      return this as unknown as ExtensionAPI;
    }
  }

  it("blocks an out-of-scope tool_call and allows an in-scope one after a forced skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-kcp-e2e-"));
    dirs.push(dir);
    await writeFile(
      join(dir, "knowledge.yaml"),
      [
        "project: demo",
        "version: 1.0.0",
        "units:",
        "  - id: deploy",
        "    path: skills/deploy/SKILL.md",
        "    intent: deploy",
        "    audience: [agent]",
        "    triggers: [deploy]",
        "    kind: skill",
        "    action_scope:",
        `      tools: [read]`,
        `      paths: [${join(dir, "src")}]`,
        "",
      ].join("\n"),
      "utf8",
    );

    const pi = new FakePi();
    pi.slashCommands = [
      {
        name: "deploy",
        source: "skill",
        sourceInfo: { path: `${dir}/skills`, source: "test", scope: "project", origin: "top-level" },
      } satisfies SlashCommandInfo,
    ];
    register(pi.asApi());

    await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, { cwd: dir });
    // Force the skill via input (sets the active skill without going through the gate).
    await pi.fire("input", { type: "input", text: "/skill:deploy", source: "interactive" }, { cwd: dir });

    const allowed = await pi.fire(
      "tool_call",
      { type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: join(dir, "src/app.ts") } },
      { cwd: dir },
    );
    expect(allowed).toBeUndefined();

    const blocked = await pi.fire(
      "tool_call",
      { type: "tool_call", toolCallId: "t2", toolName: "read", input: { path: "/etc/shadow" } },
      { cwd: dir },
    );
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside the skill's authorized paths");
  });
});
