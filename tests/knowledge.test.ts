import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("project KCP manifest", () => {
  it("declares the agent-facing entry points", () => {
    const manifest = readFileSync(resolve(import.meta.dir, "../knowledge.yaml"), "utf8");
    expect(manifest).toContain("project: pi-kcp");
    expect(manifest).toContain("path: AGENTS.md");
    expect(manifest).toContain("path: .pi/skills/pi-kcp-development/SKILL.md");
    expect(manifest).toContain("path: .pi/skills/installation-validation/SKILL.md");
  });
});
