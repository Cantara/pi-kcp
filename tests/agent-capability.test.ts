// pi-kcp#36: `/kcp plan` failed against every released kcp-agent because the loop passed
// `--correlation-id` and the agent's parser fail-closes on unknown options. The flag was
// dropped as the fix, with a note to re-enable it behind a capability probe once kcp-agent
// shipped it (kcp-agent#114). It shipped in v0.22.0, and became visible to `--help` in
// v0.22.1 — which is what a probe can actually see.
//
// The probe asks the installed binary what it supports rather than comparing versions.
// Version inference breaks on forks, prereleases and locally-built agents; the help text is
// the binary's own answer about itself.

import { describe, expect, it } from "bun:test";
import { helpMentionsFlag, supportsFlag } from "../src/agent-capability.js";

const HELP_WITH = `Usage:
  kcp-agent plan     "<task>" --manifest <path|dir|url> [options]
  kcp-agent init     [dir] [--publisher <name>] [--from-llms-txt <url|path>] [--dry-run]

Options:
  --manifest <loc>        manifest path, directory, or URL
  --correlation-id <id>   opaque caller id echoed into the --json envelope (for audit joins)
`;

const HELP_WITHOUT = `Usage:
  kcp-agent plan     "<task>" --manifest <path|dir|url> [options]

Options:
  --manifest <loc>        manifest path, directory, or URL
  --json                  emit the result as JSON
`;

describe("helpMentionsFlag", () => {
  it("finds a flag the agent documents", () => {
    expect(helpMentionsFlag(HELP_WITH, "--correlation-id")).toBe(true);
  });

  it("does not find one it omits", () => {
    expect(helpMentionsFlag(HELP_WITHOUT, "--correlation-id")).toBe(false);
  });

  // `--correlation-id` must not be satisfied by `--correlation-id-source`, nor
  // `--json` by `--json-lines`: a prefix match would report support that is not there and
  // put us straight back in pi-kcp#36, where the agent exits 2 on an unknown option.
  it("does not match a longer flag that merely starts the same", () => {
    expect(helpMentionsFlag("  --correlation-id-source <x>\n", "--correlation-id")).toBe(false);
    expect(helpMentionsFlag("  --json-lines\n", "--json")).toBe(false);
  });

  it("matches regardless of surrounding punctuation or position", () => {
    expect(helpMentionsFlag("[--correlation-id <id>]", "--correlation-id")).toBe(true);
    expect(helpMentionsFlag("...or --correlation-id.", "--correlation-id")).toBe(true);
  });

  it("treats empty help as no support", () => {
    expect(helpMentionsFlag("", "--correlation-id")).toBe(false);
  });
});

describe("supportsFlag", () => {
  const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

  it("reports support when the agent's help lists the flag", async () => {
    expect(await supportsFlag(ok(HELP_WITH), "--correlation-id")).toBe(true);
  });

  it("reports no support when it does not", async () => {
    expect(await supportsFlag(ok(HELP_WITHOUT), "--correlation-id")).toBe(false);
  });

  // Fail closed on anything unexpected. Guessing "supported" costs a hard failure of the
  // whole turn; guessing "unsupported" costs one missing field on an audit record.
  it("reports no support when the probe cannot run", async () => {
    expect(
      await supportsFlag(async () => {
        throw new Error("ENOENT");
      }, "--correlation-id"),
    ).toBe(false);
  });

  it("reports no support on a non-zero exit, even if stdout mentions the flag", async () => {
    expect(
      await supportsFlag(async () => ({ code: 2, stdout: HELP_WITH, stderr: "boom" }), "--correlation-id"),
    ).toBe(false);
  });

  it("reads stderr too, since --help is written there by some CLIs", async () => {
    expect(
      await supportsFlag(async () => ({ code: 0, stdout: "", stderr: HELP_WITH }), "--correlation-id"),
    ).toBe(true);
  });

  it("probes once per binary and caches the answer", async () => {
    let calls = 0;
    const counting = async () => {
      calls++;
      return { code: 0, stdout: HELP_WITH, stderr: "" };
    };
    const key = "cache-test-agent";
    expect(await supportsFlag(counting, "--correlation-id", key)).toBe(true);
    expect(await supportsFlag(counting, "--correlation-id", key)).toBe(true);
    expect(calls, "the probe should not re-run for the same binary").toBe(1);
  });
});
