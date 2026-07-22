#!/usr/bin/env node
// Demo 5 — AUTONOMOUS: "The Runaway, Contained" (OpenClaw territory)
// Organ: the REAL kcp-harness MCP proxy (spawned via `kcp-harness serve`)
// Gates exercised: skill_eligibility (load) + conformance (#39, in-loop hold)
//
// A scripted, deterministic autonomous agent drives a SEQUENCE of tool calls
// THROUGH the real kcp-harness MCP proxy — we spawn `kcp-harness serve` and act
// as an MCP client over stdio. The proxy front-runs a real downstream MCP tool
// server. Mid-run the agent attempts an out-of-scope action (outside its loaded
// skill's action_scope); the proxy BLOCKS it in-loop and opens a pending
// approval ticket. The rest of the run proceeds. Finally we reconstruct the
// whole run as one audit trail.
//
// The "agent" is deterministic (no LLM). The governance is 100% real.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AuditReader, FileApprovalProvider } from "kcp-harness";
import { KCP_HARNESS_CLI, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// --- 1. Build an isolated workdir (sandbox + audit + approvals + config) -----
const wd = mkdtempSync(join(tmpdir(), "kcp-demo5-"));
const sandbox = join(wd, "sandbox");
mkdirSync(join(sandbox, "ops"), { recursive: true });
writeFileSync(join(sandbox, "ops", "service.conf"), "replicas=3\nregion=eu-north-1\n");
const auditPath = join(wd, "audit.jsonl");
const approvalsDir = join(wd, "approvals");
const manifest = join(here, "fixtures", "knowledge.yaml");
const downstream = join(here, "downstream-server.mjs");

// Render the fixtures/harness.yaml template with absolute paths.
const template = readFileSync(join(here, "fixtures", "harness.yaml"), "utf8");
const configPath = join(wd, "harness.yaml");
writeFileSync(
  configPath,
  template
    .replaceAll("__MANIFEST__", manifest)
    .replaceAll("__APPROVALS__", approvalsDir)
    .replaceAll("__DOWNSTREAM__", downstream)
    .replaceAll("__SANDBOX__", sandbox)
    .replaceAll("__AUDIT__", auditPath),
);

// --- 2. A tiny MCP client that talks to the spawned proxy over stdio ---------
class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.rl = createInterface({ input: child.stdout, terminal: false });
    this.rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg;
      try { msg = JSON.parse(t); } catch { return; }
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); p(msg); }
    });
  }
  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async callTool(name, args) {
    const resp = await this.request("tools/call", { name, arguments: args });
    const r = resp.result ?? {};
    const text = (r.content ?? []).map((c) => c.text).join("\n");
    return { isError: !!r.isError, text };
  }
}

section("Demo 5: The Runaway, Contained — autonomous agent driven THROUGH kcp-harness serve");
console.log(`\nspawning: kcp-harness serve --config ${configPath}`);

const child = spawn(process.execPath, [KCP_HARNESS_CLI, "serve", "--config", configPath], {
  stdio: ["pipe", "pipe", "pipe"],
});
let serveLog = "";
child.stderr.on("data", (d) => (serveLog += d.toString()));
const client = new McpClient(child);

// --- 3. MCP handshake --------------------------------------------------------
const init = await client.request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "runaway-agent", version: "1.0.0" },
});
client.notify("notifications/initialized");
const tools = (await client.request("tools/list", {})).result.tools.map((t) => t.name);
console.log(`\nproxy: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
console.log("governed tool surface: " + tools.join(", "));

// --- 4. The autonomous run: a fixed sequence of steps ------------------------
const steps = [
  ["load skill",              () => client.callTool("Skill", { skill: "deploy-skill" })],
  ["in-scope read",           () => client.callTool("read_file", { path: "ops/service.conf" })],
  ["in-scope write",          () => client.callTool("write_file", { path: "ops/release.log", content: "deployed build 4211\n" })],
  ["OUT-OF-SCOPE read",       () => client.callTool("read_file", { path: "secrets/master.key" })],
  ["in-scope write (resume)", () => client.callTool("write_file", { path: "ops/complete.flag", content: "ok\n" })],
];

console.log("\nAutonomous run (each step is a real MCP tools/call through the proxy):");
const results = [];
for (const [label, fn] of steps) {
  const r = await fn();
  results.push({ label, ...r });
  const tag = r.isError ? "⛔ HELD  " : "✅ ALLOW ";
  console.log(`  ${tag} ${label.padEnd(24)} → ${r.text.replace(/\n/g, " ")}`);
}

// --- 5. Close the proxy and let it flush session_end -------------------------
child.stdin.end();
await new Promise((res) => child.on("exit", res));

// --- 6. Reconstruct the whole run from the real audit log --------------------
const reader = new AuditReader(auditPath);
const all = await reader.readAll();
const summary = await reader.summarize();
const chains = await reader.chains();

console.log("\nAudit trail (append-only JSONL, one line per governed event):");
for (const e of all) {
  const detail = e.skill?.reason ?? e.conformance?.reason ?? e.approval?.policyRef ?? e.toolCall?.name ?? e.type;
  console.log(`  #${String(e.sequence).padStart(2)} ${e.type.padEnd(20)} ${String(e.outcome).padEnd(12)} ${detail ?? ""}`);
}
showJson("Audit summary", summary);

// The pending approval ticket the out-of-scope action opened.
const provider = new FileApprovalProvider(approvalsDir);
const tickets = await provider.list();
showJson("Pending approval tickets (the runaway action, held for a human)", tickets.map((t) => ({
  id: t.request.id,
  state: t.state,
  tool: t.request.toolName,
  target: t.request.target,
  requiredRole: t.request.requiredRole,
  reason: t.request.evidence?.detail,
  conformanceVerdict: t.request.evidence?.conformance?.gate, // the failed verdict is pinned as evidence
})));

// --- 7. Verdict --------------------------------------------------------------
section("Verdict");
const held = results.find((r) => r.label === "OUT-OF-SCOPE read");
const resumed = results.find((r) => r.label === "in-scope write (resume)");
expect("proxy started and listed a governed tool surface", tools.includes("read_file") && tools.includes("Skill"));
expect("skill loaded (in-scope steps allowed)",
  !results[0].isError && !results[1].isError && !results[2].isError);
expect("out-of-scope action BLOCKED in-loop", !!held && held.isError);
expect("block carries the conformance reason (names the violating target)",
  !!held && /CONFORMANCE BLOCKED/.test(held.text) && /secrets\/master\.key/.test(held.text), held?.text);
expect("run PROCEEDS after the hold (next in-scope step allowed)", !!resumed && !resumed.isError);
expect("exactly one pending ticket opened for the held action",
  tickets.length === 1 && tickets[0].state === "pending_review");
expect("ticket targets the out-of-scope resource, pinning the failed verdict as evidence",
  tickets[0]?.request.target === "secrets/master.key" &&
  tickets[0]?.request.evidence?.conformance?.passed === false &&
  /secrets\/master\.key/.test(tickets[0]?.request.evidence?.detail ?? ""));
expect("run reconstructs as an audited chain (skill_loaded + conformance verdicts present)",
  all.some((e) => e.type === "skill_loaded") &&
  all.some((e) => e.type === "conformance_verdict" && e.outcome === "blocked"));

console.log(`\n(full run artifacts under ${wd})`);
finish("Demo 5 — The Runaway, Contained");
