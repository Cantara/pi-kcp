// Phase 4 — procedural governance (#28): a skill runs the planner's gates before it is
// allowed to shape the turn. A stale, out-of-audience, deprecated or superseded procedure
// is refused *with the planner's written reason*, in-loop, before it touches any action.
import { describe, expect, it, mock } from "bun:test";

import { admitSkill, findTracedUnit, parseTrace, type TracedUnit } from "../src/skill-gate.js";
import { GovernedLoop } from "../src/governed-loop.js";
import type { SkillSelected } from "../src/skill-detection.js";

const skill = (name: string, path = `.pi/skills/${name}/SKILL.md`): SkillSelected => ({
  skillPath: path,
  skillName: name,
  source: "agent",
});

function trace(units: Array<Partial<TracedUnit>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "trace",
    gateSummary: [],
    units: units.map((u) => ({ id: "x", path: "x.md", outcome: "selected", gates: [], ...u })),
  });
}

const PASSED = [
  { gate: "audience", passed: true, detail: "role 'agent' in [\"agent\"]" },
  { gate: "deprecated", passed: true, detail: "not deprecated" },
];

describe("reading the planner's trace", () => {
  it("parses units with their gate verdicts", () => {
    const units = parseTrace(trace([{ id: "deploy", gates: PASSED }]));
    expect(units).toHaveLength(1);
    expect(units[0]!.id).toBe("deploy");
    expect(units[0]!.gates[0]).toMatchObject({ gate: "audience", passed: true });
  });

  it("survives output that is not a trace", () => {
    expect(parseTrace("{}")).toEqual([]);
    expect(parseTrace("not json")).toEqual([]);
    expect(parseTrace(JSON.stringify({ units: "nope" }))).toEqual([]);
  });

  it("finds a unit by id, then by path overlap", () => {
    const units = parseTrace(
      trace([
        { id: "other", path: "docs/other.md" },
        { id: "deploy", path: "skills/deploy/SKILL.md" },
      ]),
    );
    expect(findTracedUnit(units, skill("deploy"))!.id).toBe("deploy");
    expect(findTracedUnit(units, skill("unknown", "skills/deploy/SKILL.md"))!.id).toBe("deploy");
    expect(findTracedUnit(units, skill("absent", "nowhere/SKILL.md"))).toBeUndefined();
  });
});

describe("admitting a skill", () => {
  it("admits a unit whose gates all passed", () => {
    const [unit] = parseTrace(trace([{ id: "deploy", gates: PASSED }]));
    const verdict = admitSkill(unit, skill("deploy"));

    expect(verdict.admitted).toBe(true);
    expect(verdict.failedGates).toEqual([]);
  });

  // The whole point of #28: the refusal carries the planner's own words.
  it("refuses a failed gate and quotes the reason", () => {
    const [unit] = parseTrace(
      trace([
        {
          id: "deploy",
          gates: [
            { gate: "audience", passed: true, detail: "ok" },
            { gate: "deprecated", passed: false, detail: "deprecated since 2026-01-01" },
          ],
        },
      ]),
    );
    const verdict = admitSkill(unit, skill("deploy"));

    expect(verdict.admitted).toBe(false);
    expect(verdict.failedGates).toEqual(["deprecated"]);
    expect(verdict.reason).toContain("deprecated");
    expect(verdict.reason).toContain("deprecated since 2026-01-01");
  });

  it("names every failed gate, not just the first", () => {
    const [unit] = parseTrace(
      trace([
        {
          id: "old",
          gates: [
            { gate: "temporal", passed: false, detail: "valid_until 2025-12-31 has passed" },
            { gate: "supersession", passed: false, detail: "superseded by deploy-v2" },
          ],
        },
      ]),
    );
    const verdict = admitSkill(unit, skill("old"));

    expect(verdict.failedGates).toEqual(["temporal", "supersession"]);
    expect(verdict.reason).toContain("deploy-v2");
  });

  // A skill with no declared unit is not a governed procedure. It is admitted so that
  // ordinary editor skills keep working — but the record says why, so "ungoverned" is
  // never mistaken for "checked and fine".
  it("admits an undeclared skill, and says it was not governed", () => {
    const verdict = admitSkill(undefined, skill("ad-hoc"));

    expect(verdict.admitted).toBe(true);
    expect(verdict.governed).toBe(false);
    expect(verdict.reason).toMatch(/no governed procedure declared/i);
  });

  it("marks a gated admission as governed", () => {
    const [unit] = parseTrace(trace([{ id: "deploy", gates: PASSED }]));
    expect(admitSkill(unit, skill("deploy")).governed).toBe(true);
  });
});

describe("the loop refuses a skill the gates rejected", () => {
  function loopWithTrace(units: Array<Partial<TracedUnit>>) {
    const refused: Array<[SkillSelected, string]> = [];
    const selected: SkillSelected[] = [];
    const loop = new GovernedLoop({
      hooks: {
        onSkillRefused: (s, reason) => refused.push([s, reason]),
        onSkillSelected: (s) => selected.push(s),
      },
    });
    loop.beginTurn(1);
    loop.setTracedUnits(parseTrace(trace(units)));
    return { loop, refused, selected };
  }

  it("does not make a refused skill active", () => {
    const { loop, refused, selected } = loopWithTrace([
      { id: "deploy", path: "skills/deploy/SKILL.md", gates: [{ gate: "deprecated", passed: false, detail: "retired" }] },
    ]);

    const result = loop.observeInput("/skill:deploy", [
      { name: "skill:deploy", description: "", source: "project" } as never,
    ]);

    expect(loop.currentSkill()).toBeUndefined();
    expect(result).toBeUndefined();
    expect(selected).toEqual([]);
    expect(refused).toHaveLength(1);
    expect(refused[0]![1]).toContain("retired");
  });

  it("makes an admitted skill active as before", () => {
    const { loop, refused, selected } = loopWithTrace([
      { id: "deploy", path: "skills/deploy/SKILL.md", gates: PASSED },
    ]);

    loop.observeInput("/skill:deploy", [
      { name: "skill:deploy", description: "", source: "project" } as never,
    ]);

    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(selected).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it("gates an agent-loaded skill at the tool boundary too", async () => {
    const { loop, refused } = loopWithTrace([
      { id: "deploy", path: "skills/deploy/SKILL.md", gates: [{ gate: "audience", passed: false, detail: "role 'agent' not in [\"human\"]" }] },
    ]);

    await loop.evaluateToolCall("read", { path: "skills/deploy/SKILL.md" }, { cwd: "/repo" });

    expect(loop.currentSkill()).toBeUndefined();
    expect(refused[0]![1]).toContain("human");
  });

  it("admits everything when no trace was set — gating is opt-in, not accidental", () => {
    const refused: unknown[] = [];
    const loop = new GovernedLoop({ hooks: { onSkillRefused: (s, r) => refused.push([s, r]) } });
    loop.beginTurn(1);

    loop.observeInput("/skill:deploy", [
      { name: "skill:deploy", description: "", source: "project" } as never,
    ]);

    expect(loop.currentSkill()?.skillName).toBe("deploy");
    expect(refused).toEqual([]);
  });

  it("clears the trace between turns", () => {
    const { loop } = loopWithTrace([
      { id: "deploy", path: "skills/deploy/SKILL.md", gates: [{ gate: "deprecated", passed: false, detail: "retired" }] },
    ]);
    loop.beginTurn(2);

    loop.observeInput("/skill:deploy", [
      { name: "skill:deploy", description: "", source: "project" } as never,
    ]);

    // No trace for turn 2 → nothing to gate against → admitted rather than silently refused.
    expect(loop.currentSkill()?.skillName).toBe("deploy");
  });

  it("revokes an already-active skill when the trace arrives and refuses it", () => {
    const onSkillRefused = mock();
    const loop = new GovernedLoop({ hooks: { onSkillRefused } });
    loop.beginTurn(1);

    // Forced at `input`, before the plan stage has run.
    loop.observeInput("/skill:deploy", [
      { name: "skill:deploy", description: "", source: "project" } as never,
    ]);
    expect(loop.currentSkill()?.skillName).toBe("deploy");

    // The plan stage then produces the trace, and the gates refuse it.
    const revoked = loop.setTracedUnits(
      parseTrace(
        trace([
          { id: "deploy", path: "skills/deploy/SKILL.md", gates: [{ gate: "temporal", passed: false, detail: "expired" }] },
        ]),
      ),
    );

    expect(revoked?.skillName).toBe("deploy");
    expect(loop.currentSkill()).toBeUndefined();
    expect(onSkillRefused).toHaveBeenCalled();
  });
});
