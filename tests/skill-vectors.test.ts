// The kcp-skill conformance vectors as an executable contract.
//
// The vendored fixtures (tests/fixtures/kcp-skill-vectors, from
// Cantara/kcp-skill v0.1.0) carry the linter's expected verdicts; this suite
// runs the EXTENSION's semantics — ManifestScopeResolver + the
// kcp-harness-backed HarnessConformanceChecker — over the same canonical
// manifests. If kcp-skill blesses a shape this extension mishandles (or vice
// versa), this fails CI.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  type ConformanceContext,
  HarnessConformanceChecker,
  ManifestScopeResolver,
  type ObservedAction,
  type SkillSelected,
} from "../src/index.js";

const FIXTURES = join(import.meta.dir, "fixtures", "kcp-skill-vectors");

const ctx: ConformanceContext = { cwd: FIXTURES };

const skill = (name: string): SkillSelected => ({
  skillPath: join(FIXTURES, "skills", name, "SKILL.md"),
  skillName: name,
  source: "agent",
});

const CID = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const action = (toolName: string, input: Record<string, unknown>, active: SkillSelected): ObservedAction => ({
  toolName,
  input,
  correlationId: CID,
  skillContext: active,
});

const checkerFor = (vector: string) =>
  new HarnessConformanceChecker({ manifest: join(vector, "manifest.yaml") });

describe("kcp-skill vectors — extension semantics over the canonical fixtures", () => {
  it("vendored vector set matches the upstream count", () => {
    const dirs = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs.length).toBe(5);
  });

  it("01-minimal-valid: declared envelope resolves and binds — glob paths authorize, everything else is held", async () => {
    const resolver = new ManifestScopeResolver(join("01-minimal-valid", "manifest.yaml"));
    const scope = await resolver.resolve(skill("rotate-signing-key"), ctx);
    expect(scope?.tools).toEqual(["kcp-sign", "git"]);
    expect(scope?.capabilities).toEqual(["key-management"]);

    const checker = checkerFor("01-minimal-valid");
    // §4.3a: paths are globs — schema/** must authorize schema/keys.yaml.
    const inScope = await checker.check(
      action("kcp-sign", { path: "schema/keys.yaml" }, skill("rotate-signing-key")),
      ctx,
    );
    expect(inScope.conformant).toBe(true);

    const outByTool = await checker.check(
      action("rm", { path: "schema/keys.yaml" }, skill("rotate-signing-key")),
      ctx,
    );
    expect(outByTool.conformant).toBe(false);

    const outByPath = await checker.check(
      action("kcp-sign", { path: "src/secrets.env" }, skill("rotate-signing-key")),
      ctx,
    );
    expect(outByPath.conformant).toBe(false);
  });

  it("02-ungoverned-skill: a skill with no action_scope binds an empty envelope — every action held", async () => {
    // The linter flags this SK002; the extension's posture is fail-closed.
    const checker = checkerFor("02-ungoverned-skill");
    const held = await checker.check(action("read", { path: "docs/x.md" }, skill("deploy")), ctx);
    expect(held.conformant).toBe(false);
    expect(held.reason).toContain("declares no action_scope");
  });

  it("03-absolute-path: a hostile envelope still confines targets outside its prefixes", async () => {
    // The linter rejects this envelope outright (SK004). If it ever reaches
    // enforcement, the allowlist is applied as written and nothing more.
    const checker = checkerFor("03-absolute-path");
    const elsewhere = await checker.check(action("bash", { path: "src/main.ts" }, skill("escape")), ctx);
    expect(elsewhere.conformant).toBe(false);
  });

  it("04-bad-field-types: a malformed dimension fail-closes instead of silently vanishing", async () => {
    // tools: "git" (a string, not an array) is SK003 for the linter; the
    // enforcement side must treat it as a constraint that failed to parse,
    // never as an undeclared facet.
    const checker = checkerFor("04-bad-field-types");
    const held = await checker.check(
      action("git", { path: "ok/file.md" }, { skillPath: "skill:sloppy", skillName: "sloppy", source: "user" }),
      ctx,
    );
    expect(held.conformant).toBe(false);
    expect(held.reason).toContain("malformed");
  });

  it("05-non-skill-kinds-untouched: non-skill units never grant an envelope", async () => {
    // policy/schema/unknown kinds are valid manifest units (§4.3a) but not
    // skills — resolving them as an "active skill" yields no scope, and the
    // checker fail-closes rather than inventing authority.
    const checker = checkerFor("05-non-skill-kinds-untouched");
    for (const name of ["security", "api-schema", "mystery"]) {
      const held = await checker.check(
        action("read", { path: "docs/x.md" }, { skillPath: `skill:${name}`, skillName: name, source: "user" }),
        ctx,
      );
      expect(held.conformant).toBe(false);
    }
  });
});
