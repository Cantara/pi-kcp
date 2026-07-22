// Shared helpers for the pi-kcp defendable-agent demos.
//
// These wrap the REAL published tools — kcp-agent@0.16.0 (CLI) and
// kcp-harness@0.8.0 (library) — installed under demos/node_modules. Nothing
// here mocks governance: kcpAgent() shells out to the real planner binary, and
// the harness demos import the real library exports directly.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

// The published packages export only their entry point, so resolve the package
// entry ("." → dist/index.js) and derive the sibling CLI (dist/cli.js) from it.
function cliFor(pkg) {
  const entry = require.resolve(pkg); // .../<pkg>/dist/index.js
  return join(dirname(entry), "cli.js");
}

/** Absolute path to the installed kcp-agent CLI (dist/cli.js). */
export const KCP_AGENT_CLI = cliFor("kcp-agent");

/** Absolute path to the installed kcp-harness CLI (dist/cli.js). */
export const KCP_HARNESS_CLI = cliFor("kcp-harness");

/**
 * Run the real kcp-agent CLI. Returns { status, stdout, stderr }.
 * @param {string[]} args e.g. ["plan", "task", "--manifest", "x.yaml", "--json"]
 */
export function kcpAgent(args, opts = {}) {
  const res = spawnSync(process.execPath, [KCP_AGENT_CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Run the real kcp-harness CLI. */
export function kcpHarness(args, opts = {}) {
  const res = spawnSync(process.execPath, [KCP_HARNESS_CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

let failures = 0;

export function section(title) {
  console.log("\n" + "─".repeat(72));
  console.log("▶ " + title);
  console.log("─".repeat(72));
}

/** Assert and record; prints PASS/FAIL and keeps a process-wide failure count. */
export function expect(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.log(`  ✘ ${label}${detail ? "  — " + detail : ""}`);
  }
  return condition;
}

/** Call once at the end of a demo; exits non-zero if any expectation failed. */
export function finish(name) {
  console.log("\n" + "═".repeat(72));
  if (failures === 0) {
    console.log(`✅ ${name}: ALL CHECKS GREEN`);
    process.exitCode = 0;
  } else {
    console.log(`❌ ${name}: ${failures} check(s) FAILED`);
    process.exitCode = 1;
  }
}

/** Pretty-print a JSON value indented under a label. */
export function showJson(label, value) {
  console.log(`\n${label}:`);
  console.log(
    JSON.stringify(value, null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n"),
  );
}
