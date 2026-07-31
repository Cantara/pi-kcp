import { describe, expect, it } from "bun:test";
import {
  type ActionScope,
  type ConformanceContext,
  deniesToken,
  evaluateDeny,
  evaluateEffectiveDeny,
  HarnessConformanceChecker,
  type ObservedAction,
  parseDenyScope,
  prohibitedAttempt,
  type ScopeResolver,
  type SkillSelected,
} from "../src/index.js";

const ctx: ConformanceContext = { cwd: "/repo" };
const CID = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const deploySkill: SkillSelected = {
  skillPath: "/repo/skills/deploy/SKILL.md",
  skillName: "deploy",
  source: "agent",
};

/** A resolver that returns a fixed scope (may carry an RFC-0029 `deny` sibling). */
function stubResolver(scope: ActionScope | undefined): ScopeResolver {
  return {
    async resolve() {
      return scope;
    },
  };
}

function action(toolName: string, input: Record<string, unknown>, skill?: SkillSelected): ObservedAction {
  return { toolName, input, correlationId: CID, ...(skill ? { skillContext: skill } : {}) };
}

// The gap: RFC-0029 / KCP 0.31 gives action_scope an optional negative-scope sibling
// `deny` that REFUSES a matching tool/path/capability and OVERRIDES any allow
// (deny-first, deny-overrides, fail-closed). A downstream KCP consumer relies on the
// runtime honouring it. Before this change the runtime ignores `deny` and lets an
// otherwise-allowed action through.
describe("action_scope.deny (RFC-0029 / KCP 0.31) — deny overrides allow", () => {
  it("refuses a tool that the allowlist permits but deny.tools names", async () => {
    // bash is allowed AND denied — deny must win.
    const scope = { tools: ["read", "bash"], paths: ["/repo/**"], deny: { tools: ["bash"] } } as ActionScope;
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(scope) });

    const verdict = await checker.check(action("bash", { command: "ls /repo" }, deploySkill), ctx);
    expect(verdict.conformant).toBe(false);
    expect(verdict.reason).toContain("bash");
    expect(verdict.reason.toLowerCase()).toContain("deny");
  });

  it("refuses a path that the allowlist permits but deny.paths names", async () => {
    const scope = { tools: ["read"], paths: ["/repo/**"], deny: { paths: ["/repo/secrets/**"] } } as ActionScope;
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(scope) });

    const verdict = await checker.check(
      action("read", { path: "/repo/secrets/key.pem" }, deploySkill),
      ctx,
    );
    expect(verdict.conformant).toBe(false);
    expect(verdict.reason).toContain("/repo/secrets/key.pem");
    expect(verdict.reason.toLowerCase()).toContain("deny");
  });

  it("still allows an action that no deny clause matches", async () => {
    const scope = { tools: ["read"], paths: ["/repo/**"], deny: { paths: ["/repo/secrets/**"] } } as ActionScope;
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(scope) });

    const verdict = await checker.check(action("read", { path: "/repo/app.ts" }, deploySkill), ctx);
    expect(verdict.conformant).toBe(true);
  });
});

describe("parseDenyScope", () => {
  it("reads the deny sibling off an action_scope", () => {
    expect(parseDenyScope({ tools: ["read"], deny: { tools: ["bash"], paths: ["/etc/**"] } })).toEqual({
      tools: ["bash"],
      paths: ["/etc/**"],
    });
  });

  it("treats an absent, empty, or wholly-malformed deny as a no-op (undefined)", () => {
    expect(parseDenyScope({ tools: ["read"] })).toBeUndefined();
    expect(parseDenyScope({ deny: {} })).toBeUndefined();
    expect(parseDenyScope({ deny: { tools: [] } })).toBeUndefined();
    expect(parseDenyScope({ deny: { tools: ["", "  "] } })).toBeUndefined();
    expect(parseDenyScope(undefined)).toBeUndefined();
  });

  it("drops malformed entries but keeps usable ones", () => {
    expect(parseDenyScope({ deny: { tools: ["bash", 3, ""] } })).toEqual({ tools: ["bash"] });
  });
});

describe("deniesToken", () => {
  it("matches tools and capabilities by exact membership", () => {
    const deny = { tools: ["bash"], capabilities: ["network"] };
    expect(deniesToken(deny, "tools", "bash")).toBe("bash");
    expect(deniesToken(deny, "tools", "read")).toBeUndefined();
    expect(deniesToken(deny, "capabilities", "network")).toBe("network");
  });

  it("matches paths by glob (** crosses boundaries) and prefix", () => {
    const deny = { paths: ["/repo/secrets/**"] };
    expect(deniesToken(deny, "paths", "/repo/secrets/keys/prod.pem")).toBe("/repo/secrets/**");
    expect(deniesToken(deny, "paths", "/repo/app.ts")).toBeUndefined();
    // Prefix at a directory boundary, and a normalised traversal escape.
    expect(deniesToken({ paths: ["/repo/secrets"] }, "paths", "/repo/secrets/x")).toBe("/repo/secrets");
    expect(deniesToken({ paths: ["/repo/secrets/**"] }, "paths", "/repo/app/../secrets/x")).toBe("/repo/secrets/**");
  });

  it("refuses nothing when the deny is undefined or the dimension is undeclared", () => {
    expect(deniesToken(undefined, "tools", "bash")).toBeUndefined();
    expect(deniesToken({ paths: ["/x/**"] }, "tools", "bash")).toBeUndefined();
  });
});

// Pinned: the §4.3a v0.32.1 errata case (knowledge-context-protocol #189). The spec's own
// reference validator adjudicated `deny.paths` by exact string equality, so a declared
// `legal/hold/**` never fired against `legal/hold/2025/case.pdf` and the paths dimension of
// a deny was unenforced. pi-kcp matches paths structurally (glob: `**` crosses segment
// boundaries, `*` stays within one, literals escaped) — these tests pin that so a
// regression to exact-string comparison cannot land silently.
describe("deny.paths are patterns, not literals (§4.3a v0.32.1 errata)", () => {
  const deny = { paths: ["legal/hold/**"] };

  it("deniesToken: `legal/hold/**` glob-matches a nested relative path", () => {
    expect(deniesToken(deny, "paths", "legal/hold/2025/case.pdf")).toBe("legal/hold/**");
    // `**` binds to the declared subtree only — a sibling directory is untouched.
    expect(deniesToken(deny, "paths", "legal/holdings/2025/case.pdf")).toBeUndefined();
    // `*` stays within one segment: it may not cross into `2025/`.
    expect(deniesToken({ paths: ["legal/hold/*"] }, "paths", "legal/hold/case.pdf")).toBe("legal/hold/*");
    expect(deniesToken({ paths: ["legal/hold/*"] }, "paths", "legal/hold/2025/case.pdf")).toBeUndefined();
  });

  it("evaluateEffectiveDeny: the request is refused and shapes a notify-only prohibited_attempt", () => {
    const match = evaluateEffectiveDeny(
      [{ id: "skill:deletion-agent", deny }],
      { tool: "read", paths: ["legal/hold/2025/case.pdf"] },
    );
    expect(match?.dimension).toBe("paths");
    expect(match?.pattern).toBe("legal/hold/**");
    expect(match?.token).toBe("legal/hold/2025/case.pdf");

    const event = prohibitedAttempt(match!);
    expect(event.record).toBe("prohibited_attempt");
    expect(event.grantable).toBe(false);
  });

  it("HarnessConformanceChecker: the conformance gate refuses with the prohibited_attempt event", async () => {
    // The allowlist grants the whole `legal/**` subtree; the deny carves out the hold.
    const scope = { tools: ["read"], paths: ["legal/**"], deny } as ActionScope;
    const checker = new HarnessConformanceChecker({ resolveScope: stubResolver(scope) });

    const verdict = await checker.check(
      action("read", { path: "legal/hold/2025/case.pdf" }, deploySkill),
      ctx,
    );
    expect(verdict.conformant).toBe(false);
    expect(verdict.prohibited?.record).toBe("prohibited_attempt");
    expect(verdict.prohibited?.pattern).toBe("legal/hold/**");
    expect(verdict.prohibited?.grantable).toBe(false);
  });
});

describe("evaluateDeny (deny-first ordering + capability dimension)", () => {
  it("denies a capability the action asserts", () => {
    const match = evaluateDeny({ capabilities: ["network"] }, { tool: "fetch", capabilities: ["network"] });
    expect(match?.dimension).toBe("capabilities");
    expect(match?.reason).toContain("network");
    expect(match?.reason.toLowerCase()).toContain("deny");
  });

  it("returns the tool match first when both a tool and a path are denied", () => {
    const match = evaluateDeny(
      { tools: ["bash"], paths: ["/etc/**"] },
      { tool: "bash", paths: ["/etc/passwd"] },
    );
    expect(match?.dimension).toBe("tools");
  });

  it("returns undefined when nothing matches", () => {
    expect(evaluateDeny({ tools: ["bash"] }, { tool: "read", paths: ["/repo/a"] })).toBeUndefined();
    expect(evaluateDeny(undefined, { tool: "read" })).toBeUndefined();
  });
});
