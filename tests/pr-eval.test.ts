import { describe, expect, it } from "bun:test";
import { buildEvaluationPrompt, extractIssueNumbers, parseVerdict } from "../scripts/pr-eval.js";

describe("PR evaluation helpers", () => {
  it("extracts unique issue references from PR text", () => {
    expect(extractIssueNumbers("ref #16 and issue: #16; ref #15")).toEqual([16, 15]);
  });

  it("accepts only the required terminal verdicts", () => {
    expect(parseVerdict("Notes\nVERDICT: APPROVE\n")).toBe("APPROVE");
    expect(parseVerdict("VERDICT: REQUEST-CHANGES")).toBe("REQUEST-CHANGES");
    expect(parseVerdict("No verdict")).toBeUndefined();
  });

  it("builds a prompt containing linked intent and the current diff", () => {
    const prompt = buildEvaluationPrompt(
      { number: 16, title: "Tooling", body: "ref #16" },
      "{\"number\":16,\"body\":\"test it\"}",
      "diff --git a/file.ts b/file.ts",
      "opencode/minimax-m3",
    );
    expect(prompt).toContain("PR #16: Tooling");
    expect(prompt).toContain("test it");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("opencode/minimax-m3");
  });
});
