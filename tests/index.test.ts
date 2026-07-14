import { describe, expect, it } from "bun:test";
import {
  agentInvocationForPath,
  extractRecallQuery,
  formatRecallBlock,
  parseSearchResults,
  shouldRecall,
} from "../src/index.js";

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
