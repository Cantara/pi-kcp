/**
 * Skill-selection detector (#28, observation half).
 *
 * Runtime-depth governance needs to know which skill (if any) an action is being taken
 * under. Two ways a skill enters play in the Pi harness:
 *
 *   1. The agent loads a skill itself by reading its `SKILL.md` (a `read` tool call whose
 *      `input.path` ends in `SKILL.md`).
 *   2. The user forces a skill with a `/skill:<name>` input.
 *
 * This module is pure observation: it emits `SkillSelected` records. Governance (blocking,
 * gating) lives at the conformance seam / governed loop, not here.
 */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/** How a skill came to be selected for the current turn. */
export type SkillSource = "agent" | "user";

/** An observed skill selection. Emitted internally; never leaves the runtime as-is. */
export interface SkillSelected {
  /** The SKILL.md path the agent read, or a synthetic `skill:<name>` marker for forced skills. */
  readonly skillPath: string;
  /** The resolved skill name (from getCommands() when available, else derived from the path). */
  readonly skillName: string;
  /** Whether the agent self-loaded the skill or the user forced it. */
  readonly source: SkillSource;
}

const SKILL_FILE = "SKILL.md";
const FORCED_SKILL_PREFIX = "/skill:";

/** True when a `read` tool call path points at a skill definition file. */
export function isSkillReadPath(path: string): boolean {
  return path.endsWith(SKILL_FILE);
}

/** Derive a skill name from a `.../<skill-name>/SKILL.md` path (the containing directory). */
export function skillNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  const fileIndex = segments.lastIndexOf(SKILL_FILE);
  if (fileIndex > 0) return segments[fileIndex - 1];
  // Fall back to the file's parent segment, or the raw path if unstructured.
  return segments.length >= 2 ? segments[segments.length - 2] : normalized;
}

/**
 * Resolve a human skill name, preferring a registered `source: "skill"` command whose name
 * matches the path-derived name (case-insensitive). Falls back to the path-derived name.
 */
export function resolveSkillName(path: string, commands: readonly SlashCommandInfo[]): string {
  const derived = skillNameFromPath(path);
  const skillCommands = commands.filter((command) => command.source === "skill");
  const match = skillCommands.find((command) => command.name.toLowerCase() === derived.toLowerCase());
  return match?.name ?? derived;
}

/**
 * Detect an agent-driven skill load from a tool call.
 * Returns a `SkillSelected` when `toolName === "read"` and the path is a `SKILL.md`.
 */
export function detectAgentSkillLoad(
  toolName: string,
  input: Record<string, unknown>,
  commands: readonly SlashCommandInfo[] = [],
): SkillSelected | undefined {
  if (toolName !== "read") return undefined;
  const path = input.path;
  if (typeof path !== "string" || !isSkillReadPath(path)) return undefined;
  return {
    skillPath: path,
    skillName: resolveSkillName(path, commands),
    source: "agent",
  };
}

/**
 * Detect a user-forced skill from an input line beginning with `/skill:<name>`.
 * Returns a `SkillSelected` with a synthetic `skill:<name>` path.
 */
export function detectForcedSkill(
  text: string,
  commands: readonly SlashCommandInfo[] = [],
): SkillSelected | undefined {
  if (!text.startsWith(FORCED_SKILL_PREFIX)) return undefined;
  const remainder = text.slice(FORCED_SKILL_PREFIX.length).trim();
  const name = remainder.split(/\s+/, 1)[0]?.trim();
  if (!name) return undefined;
  const skillCommands = commands.filter((command) => command.source === "skill");
  const match = skillCommands.find((command) => command.name.toLowerCase() === name.toLowerCase());
  return {
    skillPath: `skill:${match?.name ?? name}`,
    skillName: match?.name ?? name,
    source: "user",
  };
}
