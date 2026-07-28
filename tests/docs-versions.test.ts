// The docs name the versions a reader will install. demos/README.md advertised
// kcp-agent@0.17.0 and kcp-harness@0.9.0 while demos/package.json pinned newer ones, and
// USERGUIDE.md named 0.16.0 / 0.10.1. A version in a doc is a claim like any other, and
// these had nothing checking them.
//
// It is not cosmetic here: the demos are the thing a reader runs to decide whether any of
// this works, and demo 15 fails against a kcp-agent older than 0.21.0 — the release that
// made eligibility stop composing. Telling someone to install an older one hands them a
// broken demo and the impression that the product is broken.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const declared: Record<string, string> = (() => {
  const pkg = JSON.parse(read("demos/package.json"));
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
})();

describe("the docs name the versions the demos actually install", () => {
  it("finds the pins at all (guards the scrape)", () => {
    expect(declared["kcp-agent"], "demos/package.json has no kcp-agent pin").toBeTruthy();
    expect(declared["kcp-harness"], "demos/package.json has no kcp-harness pin").toBeTruthy();
  });

  for (const pkg of ["kcp-agent", "kcp-harness"]) {
    it(`demos/README.md names the pinned ${pkg}`, () => {
      const found = [...read("demos/README.md").matchAll(new RegExp(`${pkg}@(\\d+\\.\\d+\\.\\d+)`, "g"))]
        .map((m) => m[1]);
      expect(found.length, `demos/README.md never names ${pkg}`).toBeGreaterThan(0);
      for (const v of found) {
        expect(v, `README says ${pkg}@${v}, package.json pins ${declared[pkg]}`).toBe(declared[pkg]);
      }
    });
  }

  it("USERGUIDE.md names the pinned kcp-agent", () => {
    const m = read("USERGUIDE.md").match(/\*\*kcp-agent\*\* CLI \(`(\d+\.\d+\.\d+)`\)/);
    expect(m, "USERGUIDE.md no longer names a kcp-agent version").toBeTruthy();
    expect(m![1]).toBe(declared["kcp-agent"]);
  });

  it("USERGUIDE.md names the pinned kcp-harness", () => {
    const m = read("USERGUIDE.md").match(/\*\*kcp-harness\*\* \(`(\d+\.\d+\.\d+)`\)/);
    expect(m, "USERGUIDE.md no longer names a kcp-harness version").toBeTruthy();
    expect(m![1]).toBe(declared["kcp-harness"]);
  });
});
