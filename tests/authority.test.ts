// Gap 1 — runtime grant_ceiling MIN authority gate (§3.13, RFC-0025).
//
// The runtime parses a manifest's `authority_level_scale` and per-unit / per-step
// `authority_level`, but never resolves an EFFECTIVE ceiling as the minimum across its
// sources, and never fails closed when a required authority exceeds that ceiling. These
// tests pin the pure MIN computation and the fail-closed gate that consumes it.
import { describe, expect, it } from "bun:test";

import {
  resolveEffectiveAuthority,
  authorityGate,
  type AuthoritySource,
} from "../src/authority.js";

const SCALE = ["observe", "explain", "suggest", "prepare", "commit"] as const;

describe("resolveEffectiveAuthority — §3.13 minimum with a named binding source", () => {
  it("takes the minimum across resolved sources", () => {
    const sources: AuthoritySource[] = [
      { id: "org-risk-policy", level: "prepare" },
      { id: "org-data-policy", level: "suggest" },
      { id: "customer-setting", level: "prepare" },
    ];
    const eff = resolveEffectiveAuthority(SCALE, sources);
    expect(eff.effectiveLevel).toBe("suggest");
    expect(eff.bindingSourceIds).toEqual(["org-data-policy"]);
  });

  it("names ALL sources tied for the binding minimum (audit trail, §3.13)", () => {
    const eff = resolveEffectiveAuthority(SCALE, [
      { id: "a", level: "suggest" },
      { id: "b", level: "suggest" },
      { id: "c", level: "commit" },
    ]);
    expect(eff.effectiveLevel).toBe("suggest");
    expect(eff.bindingSourceIds).toEqual(["a", "b"]);
  });

  it("drops sources that do not resolve to a level on the scale (non-binding)", () => {
    const eff = resolveEffectiveAuthority(SCALE, [
      { id: "resolved", level: "prepare" },
      { id: "absent" }, // referenced entity declares no authority_level → non-binding
      { id: "off-scale", level: "root" }, // unknown value → silently ignored
    ]);
    expect(eff.effectiveLevel).toBe("prepare");
    expect(eff.bindingSourceIds).toEqual(["resolved"]);
  });

  it("returns no ceiling when nothing resolves — absence is not itself a grant", () => {
    const eff = resolveEffectiveAuthority(SCALE, [{ id: "absent" }]);
    expect(eff.effectiveLevel).toBeUndefined();
    expect(eff.bindingSourceIds).toEqual([]);
  });
});

describe("authorityGate — fail-closed when required exceeds the effective ceiling", () => {
  it("denies when the required level exceeds the ceiling, naming the binding source", () => {
    const decision = authorityGate(SCALE, "commit", [
      { id: "playbook-ceiling", level: "commit" },
      { id: "tenant-ceiling", level: "prepare" },
    ]);
    expect(decision.allowed).toBe(false);
    expect(decision.effectiveLevel).toBe("prepare");
    expect(decision.bindingSourceIds).toEqual(["tenant-ceiling"]);
    expect(decision.reason).toContain("tenant-ceiling");
    expect(decision.reason).toMatch(/commit/);
  });

  it("allows when the required level is within the ceiling", () => {
    const decision = authorityGate(SCALE, "prepare", [
      { id: "playbook-ceiling", level: "commit" },
    ]);
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveLevel).toBe("commit");
  });

  it("allows when equal to the ceiling", () => {
    const decision = authorityGate(SCALE, "commit", [
      { id: "playbook-ceiling", level: "commit" },
    ]);
    expect(decision.allowed).toBe(true);
  });

  it("fails closed when NO ceiling resolves for a real required authority", () => {
    const decision = authorityGate(SCALE, "observe", [{ id: "absent" }]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/no authority ceiling|fail-closed/i);
  });

  it("does not gate when the unit demands no authority level", () => {
    const decision = authorityGate(SCALE, undefined, [{ id: "x", level: "observe" }]);
    expect(decision.allowed).toBe(true);
  });

  it("silently ignores a required value that is not on the declared scale (§3.13)", () => {
    const decision = authorityGate(SCALE, "superuser", [{ id: "x", level: "commit" }]);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/not on the declared scale|ignored/i);
  });
});
