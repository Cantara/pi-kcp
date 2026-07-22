import { describe, expect, it } from "bun:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
  detectAgentSkillLoad,
  detectForcedSkill,
  isSkillReadPath,
  resolveSkillName,
  skillNameFromPath,
} from "../src/index.js";

const sourceInfo: SlashCommandInfo["sourceInfo"] = {
  path: "/repo/skills",
  source: "test",
  scope: "project",
  origin: "top-level",
};

const skillCommand = (name: string): SlashCommandInfo => ({
  name,
  description: `${name} skill`,
  source: "skill",
  sourceInfo,
});

describe("skill read-path detection", () => {
  it("recognizes SKILL.md paths", () => {
    expect(isSkillReadPath("/repo/.pi/skills/deploy/SKILL.md")).toBe(true);
    expect(isSkillReadPath("/repo/src/index.ts")).toBe(false);
  });

  it("derives the skill name from the containing directory", () => {
    expect(skillNameFromPath("/repo/.pi/skills/deploy-runbook/SKILL.md")).toBe("deploy-runbook");
    expect(skillNameFromPath(".claude/skills/mynder-ui-review/SKILL.md")).toBe("mynder-ui-review");
  });
});

describe("agent skill-load detection (#28)", () => {
  it("emits SkillSelected when the agent reads a SKILL.md", () => {
    const selected = detectAgentSkillLoad("read", { path: "/repo/.pi/skills/deploy/SKILL.md" }, []);
    expect(selected).toEqual({
      skillPath: "/repo/.pi/skills/deploy/SKILL.md",
      skillName: "deploy",
      source: "agent",
    });
  });

  it("prefers a registered skill command name over the derived name", () => {
    const commands = [skillCommand("Deploy"), { ...skillCommand("other"), source: "prompt" as const }];
    const selected = detectAgentSkillLoad("read", { path: "/repo/skills/deploy/SKILL.md" }, commands);
    expect(selected?.skillName).toBe("Deploy");
  });

  it("ignores non-read tools and non-SKILL paths", () => {
    expect(detectAgentSkillLoad("bash", { path: "SKILL.md" }, [])).toBeUndefined();
    expect(detectAgentSkillLoad("read", { path: "/repo/README.md" }, [])).toBeUndefined();
    expect(detectAgentSkillLoad("read", {}, [])).toBeUndefined();
  });
});

describe("user-forced skill detection (#28)", () => {
  it("parses /skill:<name> input", () => {
    const selected = detectForcedSkill("/skill:deploy ship it", []);
    expect(selected).toEqual({ skillPath: "skill:deploy", skillName: "deploy", source: "user" });
  });

  it("resolves the canonical command name when available", () => {
    const selected = detectForcedSkill("/skill:deploy", [skillCommand("Deploy")]);
    expect(selected?.skillName).toBe("Deploy");
    expect(selected?.skillPath).toBe("skill:Deploy");
  });

  it("ignores non-skill input and empty names", () => {
    expect(detectForcedSkill("/kcp plan deploy", [])).toBeUndefined();
    expect(detectForcedSkill("/skill:", [])).toBeUndefined();
  });
});

describe("resolveSkillName", () => {
  it("falls back to the path-derived name when no command matches", () => {
    expect(resolveSkillName("/repo/skills/unknown/SKILL.md", [skillCommand("deploy")])).toBe("unknown");
  });
});
