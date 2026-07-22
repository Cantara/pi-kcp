#!/usr/bin/env node
// Demo 10 — "Two Depths, One Verdict"
// The SAME out-of-scope action, caught by the SAME checkConformance adjudicator
// at two different depths of the stack, with an IDENTICAL verdict + reason:
//
//   (a) PROXY depth   — driven through the real `kcp-harness serve` MCP proxy
//                        (as demo 5); the proxy resolves the skill's action_scope
//                        and adjudicates with checkConformance.
//   (b) RUNTIME depth  — pi-kcp's real `HarnessConformanceChecker` (the seam its
//                        Pi extension wires at the tool_call boundary) resolves the
//                        SAME skill's action_scope from the SAME manifest and calls
//                        the SAME pure checkConformance.
//
// pi-kcp's in-loop Pi hook needs the `pi` binary (not installed here), so we exercise
// the shared adjudicator programmatically — the equivalence is what matters: governance
// verdicts do not depend on WHERE in the stack the action is observed.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AuditReader } from "kcp-harness";
import { KCP_HARNESS_CLI, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", ".."); // pi-kcp repo root (demos/ is inside it)
const fixtures = join(here, "fixtures");
const manifest = join(fixtures, "knowledge.yaml");
// The one action both depths adjudicate: an out-of-scope read the loaded skill was never scoped for.
const OOS = { tool: "read_file", path: "secrets/master.key" };

section("Demo 10: Two Depths, One Verdict — one action, one adjudicator, two depths");
console.log(`\nSkill:            deploy-skill   (action_scope → tools:[read_file,write_file] paths:[ops/])`);
console.log(`Out-of-scope act: ${OOS.tool} "${OOS.path}"   (secrets/ is NOT in the skill's scope)`);

// ============================================================================
// (a) PROXY DEPTH — through the real kcp-harness serve MCP proxy
// ============================================================================
class McpClient {
  constructor(child) {
    this.child = child; this.nextId = 1; this.pending = new Map();
    this.rl = createInterface({ input: child.stdout, terminal: false });
    this.rl.on("line", (line) => {
      const t = line.trim(); if (!t) return;
      let msg; try { msg = JSON.parse(t); } catch { return; }
      const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); p(msg); }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((res) => { this.pending.set(id, res); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  async callTool(name, args) {
    const r = (await this.request("tools/call", { name, arguments: args })).result ?? {};
    return { isError: !!r.isError, text: (r.content ?? []).map((c) => c.text).join("\n") };
  }
}

const wd = mkdtempSync(join(tmpdir(), "kcp-demo10-"));
const sandbox = join(wd, "sandbox");
mkdirSync(join(sandbox, "ops"), { recursive: true });
writeFileSync(join(sandbox, "ops", "service.conf"), "replicas=3\n");
const auditPath = join(wd, "audit.jsonl");
const configPath = join(wd, "harness.yaml");
const downstream = join(here, "..", "05-runaway-contained", "downstream-server.mjs"); // reuse the real fs tool server
writeFileSync(configPath, readFileSync(join(fixtures, "harness.yaml"), "utf8")
  .replaceAll("__MANIFEST__", manifest)
  .replaceAll("__APPROVALS__", join(wd, "approvals"))
  .replaceAll("__DOWNSTREAM__", downstream)
  .replaceAll("__SANDBOX__", sandbox)
  .replaceAll("__AUDIT__", auditPath));

console.log(`\n(a) PROXY DEPTH — spawning: kcp-harness serve --config <config>`);
const child = spawn(process.execPath, [KCP_HARNESS_CLI, "serve", "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
const client = new McpClient(child);
await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "demo10", version: "1.0.0" } });
client.notify("notifications/initialized");
await client.request("tools/list", {});
await client.callTool("Skill", { skill: "deploy-skill" });            // load the skill
const proxyBlocked = await client.callTool(OOS.tool, { path: OOS.path }); // the out-of-scope action
child.stdin.end();
await new Promise((r) => child.on("exit", r));

// Pull the harness's own conformance verdict out of the append-only audit log.
const events = await new AuditReader(auditPath).readAll();
const proxyVerdictEvent = events.find((e) => e.type === "conformance_verdict" && e.outcome === "blocked");
const proxyVerdict = proxyVerdictEvent?.conformance; // { gate, passed, reason }
console.log(`  proxy tool result: ${proxyBlocked.isError ? "⛔ HELD" : "allowed"} — ${proxyBlocked.text.replace(/\n/g, " ")}`);
showJson("Proxy-depth conformance verdict (from the audit log)", proxyVerdict);

// ============================================================================
// (b) RUNTIME DEPTH — pi-kcp's real HarnessConformanceChecker (same adjudicator)
// ============================================================================
console.log(`\n(b) RUNTIME DEPTH — pi-kcp HarnessConformanceChecker over the SAME action + manifest`);

// Transpile pi-kcp's REAL source (src/harness-conformance.ts) with bun — its only
// non-type imports are kcp-harness + js-yaml, kept external and resolved from
// demos/node_modules. (The pi-coding-agent imports are type-only and stripped.)
function buildRealChecker() {
  const bun = spawnSync("bash", ["-lc", "command -v bun"], { encoding: "utf8" });
  if (bun.status !== 0 || !bun.stdout.trim()) return null;
  const genDir = join(here, ".gen");
  mkdirSync(genDir, { recursive: true });
  const out = join(genDir, "harness-conformance.mjs");
  const src = join(repoRoot, "src", "harness-conformance.ts");
  const res = spawnSync(bun.stdout.trim(),
    ["build", src, "--target=node", "--format=esm", "--external", "kcp-harness", "--external", "js-yaml", "--outfile", out],
    { encoding: "utf8" });
  if (res.status !== 0 || !existsSync(out)) { console.log("  (bun build failed:\n" + (res.stderr || res.stdout) + ")"); return null; }
  return out;
}

let runtimeVerdict; // { passed, reason }
let runtimePath;    // which path ran
const observed = {
  toolName: OOS.tool,
  input: { path: OOS.path },
  skillContext: { skillName: "deploy-skill", skillPath: "playbooks/deploy-skill.md", source: "agent" },
};

const builtChecker = buildRealChecker();
if (builtChecker) {
  const { HarnessConformanceChecker } = await import(pathToFileURL(builtChecker).href);
  // Default ManifestScopeResolver reads knowledge.yaml under ctx.cwd — the SAME manifest.
  const checker = new HarnessConformanceChecker({ manifest: "knowledge.yaml" });
  const result = await checker.check(observed, { cwd: fixtures });
  runtimeVerdict = { passed: result.conformant, reason: result.reason };
  runtimePath = "REAL pi-kcp HarnessConformanceChecker (transpiled from src/harness-conformance.ts)";
} else {
  // Fallback (no bun to transpile the TS wrapper): call the SAME shared adjudicator
  // the wrapper delegates to — kcp-harness's real checkConformance + extractTargets.
  const { checkConformance, extractTargets } = await import("kcp-harness");
  const yaml = (await import("js-yaml")).default;
  const m = yaml.load(readFileSync(manifest, "utf8"));
  const scope = m.units.find((u) => u.id === "deploy-skill").action_scope;
  const targets = extractTargets(observed.toolName, observed.input);
  const v = checkConformance({ tool: observed.toolName, paths: targets.paths, urls: targets.urls }, scope);
  runtimeVerdict = { passed: v.passed, reason: v.reason };
  runtimePath = "shared kcp-harness checkConformance adjudicator (bun not present to transpile the pi-kcp wrapper class)";
}
console.log(`  ran via: ${runtimePath}`);
showJson("Runtime-depth conformance verdict", runtimeVerdict);

// ============================================================================
// Verdict — the two depths must agree, byte for byte
// ============================================================================
section("Verdict");
expect("proxy depth BLOCKED the out-of-scope action in-loop", proxyBlocked.isError === true);
expect("proxy depth emitted a conformance verdict (passed:false)", proxyVerdict?.passed === false);
expect("runtime depth also holds the action (passed:false)", runtimeVerdict.passed === false);
expect("SAME passed verdict at both depths", proxyVerdict?.passed === runtimeVerdict.passed);
expect("SAME written reason at both depths (identical adjudication)",
  proxyVerdict?.reason === runtimeVerdict.reason,
  `proxy="${proxyVerdict?.reason}"  runtime="${runtimeVerdict.reason}"`);
expect("the shared reason names the violating target + the authorized scope",
  /secrets\/master\.key/.test(runtimeVerdict.reason) && /ops\//.test(runtimeVerdict.reason),
  runtimeVerdict.reason);

console.log(`\n(proxy run artifacts under ${wd})`);
finish("Demo 10 — Two Depths, One Verdict");
