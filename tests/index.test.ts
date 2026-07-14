import { describe, expect, it } from "bun:test";
import {
  agentInvocationForPath,
  extractRecallQuery,
  KCP_HELP,
  formatRecallBlock,
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
