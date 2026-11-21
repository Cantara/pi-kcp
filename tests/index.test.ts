import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  agentInvocationForPath,
  extractRecallQuery,
  findAgentInvocation,
  findProjectRoot,
  localNodeModulesBinPaths,
  KCP_HELP,
  formatRecallBlock,
  normalizePlanJson,
  parseConfig,
  parseSearchResults,
  shouldRecall,
} from "../src/index.js";

describe("configuration validation", () => {
  it("accepts a valid project configuration", () => {
    const loaded = parseConfig({
      enabled: false,
      autoRecall: false,
      memoryUrl: "http://localhost:7735",
      maxResults: 5,
      timeoutMs: 500,
      manifest: "knowledge.yaml",
    });
    expect(loaded.status).toBe("configured");
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.errors).toEqual([]);
  });

  it("reports invalid values and disables automatic behavior", () => {
    const loaded = parseConfig({ memoryUrl: "not-a-url", maxResults: 99, timeoutMs: 1 });
    expect(loaded.status).toBe("invalid");
    expect(loaded.config.enabled).toBe(false);
    expect(loaded.errors).toHaveLength(3);
  });

  it("distinguishes non-object configuration", () => {
    expect(parseConfig([]).status).toBe("invalid");
  });
});

describe("kcp-agent invocation discovery", () => {
  it("runs JavaScript CLIs through node", () => {
    expect(agentInvocationForPath("/opt/kcp-agent/dist/cli.js")).toEqual({
      command: "node",
      args: ["/opt/kcp-agent/dist/cli.js"],
      label: "node /opt/kcp-agent/dist/cli.js",
    });
  });

  it("runs executable CLIs directly", () => {
    expect(agentInvocationForPath("/usr/local/bin/kcp-agent")).toEqual({
      command: "/usr/local/bin/kcp-agent",
      args: [],
      label: "/usr/local/bin/kcp-agent",
    });
  });
});

describe("plan JSON contract", () => {
  it("normalizes structured kcp-agent output for context", () => {
    expect(normalizePlanJson('{"task":"deploy","selected":[]}')).toBe(
      '{\n  "task": "deploy",\n  "selected": []\n}',
    );
  });

  it("rejects human-formatted or non-object output", () => {
    expect(() => normalizePlanJson("Load plan (2 units):")).toThrow("invalid --json output");
    expect(() => normalizePlanJson("[]")).toThrow("plan JSON must be an object");
  });

  it("accepts the versioned contract and rejects unknown schema versions", () => {
    expect(normalizePlanJson('{"schemaVersion":1,"kind":"plan","task":"deploy"}')).toContain('"schemaVersion": 1');
    expect(() => normalizePlanJson('{"schemaVersion":2,"task":"deploy"}')).toThrow("unsupported plan schemaVersion 2");
  });
});

describe("command help", () => {
  it("documents every supported command", () => {
    for (const command of ["/kcp help", "/kcp health", "/kcp recall", "/kcp plan", "/kcp validate", "/kcp init"]) {
      expect(KCP_HELP).toContain(command);
    }
  });
});

describe("recall signal detection", () => {
  it("detects retrospective prompts", () => {
    expect(shouldRecall("What did we decide about deployment last time?")).toBe(true);
    expect(shouldRecall("Continue from where we left off")).toBe(true);
    expect(shouldRecall("Fix the type error in compiler.ts")).toBe(false);
  });
});

describe("recall query extraction", () => {
  it("removes conversational prefixes and punctuation", () => {
    expect(extractRecallQuery("Could you remind me what we decided?")).toBe(
      "remind me what we decided",
    );
  });
});

describe("memory response formatting", () => {
  it("accepts the kcp-memory HTTP response shape", () => {
    const sessions = parseSearchResults({
      results: [
        {
          slug: "deploy-debug",
          startedAt: "2026-07-14",
          firstMessage: "Debugged deployment configuration",
        },
      ],
    });

    expect(formatRecallBlock("deployment", sessions)).toContain("Debugged deployment configuration");
    expect(formatRecallBlock("deployment", sessions)).toContain("kcp-memory");
  });

  it("rejects malformed responses", () => {
    expect(parseSearchResults(null)).toEqual([]);
    expect(parseSearchResults({ results: "not an array" })).toEqual([]);
    expect(formatRecallBlock("nothing", [])).toBe("");
  });
});

describe("findAgentInvocation — local node_modules/.bin resolution", () => {
  // findAgentInvocation's only local candidates were two hardcoded GLOBAL install paths
  // (Homebrew, ~/.npm-global) plus a bare `which kcp-agent` — so a project that installs
  // kcp-agent as an ordinary (possibly transitive) dependency, the way this repo's own
  // devDependency on kcp-harness does, had no candidate that could ever match, and fell
  // through to "not found" even with a real, working install two directories away.

  // A fake that throws if called: these tests assert the local node_modules/.bin path
  // resolves WITHOUT ever needing to shell out to `which` or invoke the agent — proving
  // it wins on its own, not merely that it's present among other paths that also work.
  const explodingPi = {
    exec: async () => {
      throw new Error("exec should not have been called — the local node_modules/.bin candidate should have resolved first");
    },
  } as unknown as ExtensionAPI;

  const baseConfig = parseConfig({}).config;

  function makeProjectWithLocalAgent(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "pi-kcp-agent-path-test-"));
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const target = join(root, "node_modules", "kcp-agent-stub.js");
    writeFileSync(target, "#!/usr/bin/env node\n// stub, never actually invoked by this test\n", { mode: 0o755 });
    symlinkSync(target, join(binDir, "kcp-agent"));
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("finds kcp-agent installed locally under node_modules/.bin, cwd == project root", async () => {
    const { root, cleanup } = makeProjectWithLocalAgent();
    try {
      const invocation = await findAgentInvocation(explodingPi, root, baseConfig);
      expect(invocation).toEqual({
        command: join(root, "node_modules", ".bin", "kcp-agent"),
        args: [],
        label: join(root, "node_modules", ".bin", "kcp-agent"),
      });
    } finally {
      cleanup();
    }
  });

  it("finds it from a nested working directory, walking up to the project root (monorepo case)", async () => {
    const { root, cleanup } = makeProjectWithLocalAgent();
    try {
      mkdirSync(join(root, ".git")); // project root marker: the walk stops here
      const nested = join(root, "packages", "some-package", "src");
      mkdirSync(nested, { recursive: true });
      const invocation = await findAgentInvocation(explodingPi, nested, baseConfig);
      expect(invocation?.command).toBe(join(root, "node_modules", ".bin", "kcp-agent"));
    } finally {
      cleanup();
    }
  });

  it("an explicit agentCli config still wins over a local node_modules/.bin install", async () => {
    const { root, cleanup } = makeProjectWithLocalAgent();
    try {
      const configuredPath = join(root, "node_modules", "kcp-agent-stub.js");
      const invocation = await findAgentInvocation(explodingPi, root, { ...baseConfig, agentCli: configuredPath });
      expect(invocation?.command).toBe("node");
      expect(invocation?.args).toEqual([configuredPath]);
    } finally {
      cleanup();
    }
  });

  it("falls through to undefined when nothing local, global, or on PATH resolves", async () => {
    const noWhichPi = {
      exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    } as unknown as ExtensionAPI;
    const emptyDir = mkdtempSync(join(tmpdir(), "pi-kcp-agent-path-test-empty-"));
    try {
      const invocation = await findAgentInvocation(noWhichPi, emptyDir, baseConfig);
      expect(invocation).toBeUndefined();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("local kcp-agent lookup is bounded to the project root", () => {
  const noWhichPi = {
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  } as unknown as ExtensionAPI;
  const baseConfig = parseConfig({}).config;

  function plantAgent(dir: string): string {
    const bin = join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const file = join(bin, "kcp-agent");
    // Planted binary: never executed by these tests, only its path is inspected.
    writeFileSync(file, "#!/bin/sh\necho allow\n", { mode: 0o755 });
    return file;
  }

  function sandbox(): { base: string; cleanup: () => void } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-kcp-bound-test-")));
    return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it("findProjectRoot returns the nearest ancestor with .git (directory or file)", () => {
    const { base, cleanup } = sandbox();
    try {
      mkdirSync(join(base, "repo", ".git"), { recursive: true });
      mkdirSync(join(base, "repo", "a", "b"), { recursive: true });
      expect(findProjectRoot(join(base, "repo", "a", "b"))).toBe(join(base, "repo"));
      mkdirSync(join(base, "wt", "sub"), { recursive: true });
      writeFileSync(join(base, "wt", ".git"), "gitdir: /elsewhere\n"); // worktree-style file
      expect(findProjectRoot(join(base, "wt", "sub"))).toBe(join(base, "wt"));
    } finally {
      cleanup();
    }
  });

  it("does NOT use a binary planted in a directory above the project root", async () => {
    const { base, cleanup } = sandbox();
    try {
      const planted = plantAgent(base); // ancestor of the repo
      const repo = join(base, "clones", "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      plantAgent(join(base, "clones"));
      expect(localNodeModulesBinPaths(repo, "kcp-agent")).not.toContain(planted);
      expect(localNodeModulesBinPaths(repo, "kcp-agent")).toEqual([]);
      const invocation = await findAgentInvocation(noWhichPi, repo, { ...baseConfig, agentCli: undefined });
      expect(invocation?.command).not.toBe(planted);
    } finally {
      cleanup();
    }
  });

  it("uses a binary inside the project root and in a nested workspace package", () => {
    const { base, cleanup } = sandbox();
    try {
      const repo = join(base, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const rootBin = plantAgent(repo);
      const pkgDir = join(repo, "packages", "app");
      mkdirSync(pkgDir, { recursive: true });
      const pkgBin = plantAgent(pkgDir);
      expect(localNodeModulesBinPaths(pkgDir, "kcp-agent")).toEqual([pkgBin, rootBin]);
      expect(localNodeModulesBinPaths(repo, "kcp-agent")).toEqual([rootBin]);
    } finally {
      cleanup();
    }
  });

  it("without any .git only cwd is searched", () => {
    const { base, cleanup } = sandbox();
    try {
      plantAgent(base);
      const cwd = join(base, "plain", "dir");
      mkdirSync(cwd, { recursive: true });
      const own = plantAgent(cwd);
      expect(findProjectRoot(cwd)).toBe(cwd);
      expect(localNodeModulesBinPaths(cwd, "kcp-agent")).toEqual([own]);
      const bare = join(base, "bare");
      mkdirSync(bare);
      expect(localNodeModulesBinPaths(bare, "kcp-agent")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("rejects a symlink inside the project root whose real path leaves it", () => {
    const { base, cleanup } = sandbox();
    try {
      const repo = join(base, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const outside = join(base, "outside-agent.js");
      writeFileSync(outside, "// planted\n", { mode: 0o755 });
      const bin = join(repo, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      symlinkSync(outside, join(bin, "kcp-agent"));
      expect(localNodeModulesBinPaths(repo, "kcp-agent")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("accepts a symlink that stays inside the project root (normal .bin layout)", () => {
    const { base, cleanup } = sandbox();
    try {
      const repo = join(base, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const target = join(repo, "node_modules", "kcp-agent", "dist");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "cli.js"), "// stub\n");
      const bin = join(repo, "node_modules", ".bin");
      mkdirSync(bin, { recursive: true });
      symlinkSync(join(target, "cli.js"), join(bin, "kcp-agent"));
      expect(localNodeModulesBinPaths(repo, "kcp-agent")).toEqual([join(bin, "kcp-agent")]);
    } finally {
      cleanup();
    }
  });

  it("configured agentCli and KCP_AGENT_CLI keep priority over a local binary", async () => {
    const { base, cleanup } = sandbox();
    const saved = process.env.KCP_AGENT_CLI;
    try {
      const repo = join(base, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      plantAgent(repo);
      const cfgPath = join(base, "configured-cli.js");
      const envPath = join(base, "env-cli.js");
      writeFileSync(cfgPath, "// cfg\n");
      writeFileSync(envPath, "// env\n");
      delete process.env.KCP_AGENT_CLI;
      expect((await findAgentInvocation(noWhichPi, repo, { ...baseConfig, agentCli: cfgPath }))?.args).toEqual([cfgPath]);
      process.env.KCP_AGENT_CLI = envPath;
      expect((await findAgentInvocation(noWhichPi, repo, { ...baseConfig, agentCli: undefined }))?.args).toEqual([envPath]);
    } finally {
      if (saved === undefined) delete process.env.KCP_AGENT_CLI;
      else process.env.KCP_AGENT_CLI = saved;
      cleanup();
    }
  });
});
