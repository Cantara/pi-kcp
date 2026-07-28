// The manifest version tracked package.json until 0.1.0 — both moved together on
// 2026-07-14 — and then stopped while the package went to 0.3.x. Anything reading this
// repo's manifest to learn which pi-kcp it is talking to got an answer three releases old,
// which is the one thing a self-describing repo must not get wrong.
//
// Same drift found and gated in kcp-agent and kcp-harness the same day; this is the third.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? ".", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const pkgVersion = (JSON.parse(read("package.json")) as { version: string }).version;

describe("the repo describes its own version honestly", () => {
  it("knowledge.yaml matches package.json", () => {
    const declared = read("knowledge.yaml").match(/^version:\s*"?([\d.]+)"?/m);
    expect(declared, "knowledge.yaml has no version").toBeTruthy();
    expect(declared![1]).toBe(pkgVersion);
  });

  // The release workflow checks out `inputs.target`, and this repo does not release from
  // main — that branch is where v0.3.3 was cut and has not moved since. A default pointing
  // at it would tag stale code as a new release, with nothing failing to say so.
  it("the release workflow defaults to the branch this repo releases from", () => {
    const wf = read(".github/workflows/release.yml");
    const target = wf.match(/target:[\s\S]*?default:\s*"([^"]+)"/);
    expect(target, "release.yml has no target default").toBeTruthy();
    expect(target![1]).toBe("feature/foundation");
  });
});

// The shipped signature must actually verify. It did not: sign-kcp.yml listed only
// main/master while every commit lands on feature/foundation, so the workflow had never
// run — the manifest moved to KCP 0.30 and its signature stayed behind. `kcp-agent validate`
// reports the manifest valid either way; only a plan under --require-signature fails, which
// is to say only a consumer finds out.
describe("the shipped manifest signature verifies", () => {
  it("knowledge.yaml.sig matches knowledge.yaml", async () => {
    const { existsSync } = await import("node:fs");
    const sig = join(ROOT, "knowledge.yaml.sig");
    if (!existsSync(sig)) return; // unsigned manifests are allowed; a stale signature is not

    const proc = Bun.spawnSync([
      "node",
      "/src/cantara/kcp-agent/dist/cli.js",
      "plan",
      "how does the governed loop work?",
      "--manifest",
      join(ROOT, "knowledge.yaml"),
      "--require-signature",
    ]);
    const err = new TextDecoder().decode(proc.stderr) + new TextDecoder().decode(proc.stdout);
    expect(err, "the shipped signature does not verify — re-run sign-kcp").not.toMatch(/signature invalid/);
  });
});
