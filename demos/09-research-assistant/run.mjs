#!/usr/bin/env node
// Demo 9 — "The Research Assistant" (the well-behaved counterpart to demo 5)
// Organ: the REAL kcp-harness MCP proxy (spawned via `kcp-harness serve`) +
//        kcp-agent grounding for the cited summary.
//
// A scripted, deterministic, READ-ONLY autonomous agent drives a sequence of
// tool calls THROUGH the real proxy. It loads a `research-topic` skill whose
// action_scope permits read/search tools over research/ docs/ knowledge/ and NO
// writes. Every step lands inside that scope → the governor approves each one
// and the conformance gate holds NONE. The agent then grounds a short cited
// summary, and the whole run reconstructs as ONE clean audit chain with zero
// conformance holds. The point: governance as an ENABLER — a bounded autonomous
// agent runs freely inside its declared box.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { AuditReader } from "kcp-harness";
import { groundAnswer } from "kcp-agent";
import { KCP_HARNESS_CLI, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// --- 1. Isolated workdir: sandbox seeded from the fixture corpus -------------
const wd = mkdtempSync(join(tmpdir(), "kcp-demo9-"));
const sandbox = join(wd, "sandbox");
mkdirSync(sandbox, { recursive: true });
cpSync(join(here, "fixtures", "corpus"), sandbox, { recursive: true }); // research/ docs/ knowledge/
const auditPath = join(wd, "audit.jsonl");
const manifest = join(here, "fixtures", "knowledge.yaml");
const downstream = join(here, "downstream-server.mjs");
const configPath = join(wd, "harness.yaml");
writeFileSync(configPath, readFileSync(join(here, "fixtures", "harness.yaml"), "utf8")
  .replaceAll("__MANIFEST__", manifest)
  .replaceAll("__APPROVALS__", join(wd, "approvals"))
  .replaceAll("__DOWNSTREAM__", downstream)
  .replaceAll("__SANDBOX__", sandbox)
  .replaceAll("__AUDIT__", auditPath));

// --- 2. Minimal MCP client over stdio ----------------------------------------
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

section("Demo 9: The Research Assistant — a bounded READ-ONLY agent runs freely inside its scope");
console.log(`\nspawning: kcp-harness serve --config <config>`);
const child = spawn(process.execPath, [KCP_HARNESS_CLI, "serve", "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
const client = new McpClient(child);

const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "research-agent", version: "1.0.0" } });
client.notify("notifications/initialized");
const tools = (await client.request("tools/list", {})).result.tools.map((t) => t.name);
console.log(`proxy: ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
console.log("governed tool surface: " + tools.join(", ") + "   (read-only — no write tool exists)");

// --- 3. The autonomous READ-ONLY run — every step in-scope -------------------
const steps = [
  ["load research skill", () => client.callTool("Skill", { skill: "research-topic" })],
  ["read market scan",    () => client.callTool("read_file", { path: "research/market-scan.md" })],
  ["read architecture",   () => client.callTool("read_file", { path: "docs/architecture.md" })],
  ["read glossary",       () => client.callTool("read_file", { path: "knowledge/glossary.md" })],
  ["search corpus",       () => client.callTool("search_files", { path: "research/", query: "audit" })],
];

console.log("\nAutonomous read-only run (each step is a real MCP tools/call through the proxy):");
const results = [];
for (const [label, fn] of steps) {
  const r = await fn();
  results.push({ label, ...r });
  console.log(`  ${r.isError ? "⛔ HELD " : "✅ ALLOW"} ${label.padEnd(22)} → ${r.text.split("\n")[0].slice(0, 68)}`);
}

child.stdin.end();
await new Promise((r) => child.on("exit", r));

// --- 4. Ground a short cited summary against the loaded corpus ---------------
const corpus = [
  { id: "architecture-doc", path: "docs/architecture.md" },
  { id: "market-scan", path: "research/market-scan.md" },
  { id: "glossary", path: "knowledge/glossary.md" },
].map((u) => { const content = readFileSync(join(sandbox, u.path), "utf8"); return { id: u.id, sha256: sha256(content), content }; });

const summary = [
  "The harness is a Model Context Protocol proxy that adjudicates governed calls before forwarding them.",
  "Buyers ask first for an audit trail of every autonomous action.",
].join(" ");

const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "as", "on", "in", "every", "by", "for", "that", "before", "them", "its"]);
const toks = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)));
const scriptedVerifier = async ({ claim, units }) => {
  const c = toks(claim); let best = null, bestOverlap = 0;
  for (const u of units) { const ut = toks(u.content); let o = 0; for (const t of c) if (ut.has(t)) o++; if (o > bestOverlap) { bestOverlap = o; best = u.id; } }
  return bestOverlap >= Math.max(2, Math.ceil(c.size * 0.4)) ? { supportedBy: best } : { supportedBy: null, note: "no loaded unit covers this claim" };
};
const grounded = await groundAnswer("Summarize the research corpus.", summary, corpus, { verifier: scriptedVerifier });
showJson("Cited summary — grounded against the units the agent actually read", {
  status: grounded.status,
  grounded: grounded.grounded.map((c) => ({ claim: c.claim, unitId: c.unitId, sha256: c.sha256.slice(0, 12) + "…" })),
  gaps: grounded.gaps,
});

// --- 5. Reconstruct the run as one clean audit chain -------------------------
const reader = new AuditReader(auditPath);
const all = await reader.readAll();
const conformanceEvents = all.filter((e) => e.type === "conformance_verdict");
console.log("\nAudit trail (append-only JSONL, one line per governed event):");
for (const e of all) {
  const detail = e.skill?.reason ?? e.conformance?.reason ?? e.toolCall?.name ?? e.type;
  console.log(`  #${String(e.sequence).padStart(2)} ${e.type.padEnd(20)} ${String(e.outcome).padEnd(10)} ${String(detail ?? "").slice(0, 60)}`);
}
showJson("Audit summary", await reader.summarize());

// --- 6. Verdict --------------------------------------------------------------
section("Verdict");
expect("proxy exposed a read-only surface (read/search, no write tool)",
  tools.includes("read_file") && tools.includes("search_files") && !tools.includes("write_file"));
expect("EVERY autonomous step was ALLOWED (zero blocks)", results.every((r) => !r.isError));
expect("the skill loaded (skill_loaded event present)", all.some((e) => e.type === "skill_loaded"));
expect("conformance verdicts were emitted for the governed actions", conformanceEvents.length >= 1);
expect("NOT ONE conformance hold — nothing left the scope",
  conformanceEvents.every((e) => e.outcome !== "blocked" && e.conformance?.passed !== false));
expect("no approval ticket was opened (nothing needed a human)",
  all.every((e) => e.type !== "approval_requested"));
expect("the cited summary is fully grounded against the read units (no gaps)",
  grounded.status === "grounded" && grounded.grounded.length === 2 && grounded.gaps.length === 0);

console.log(`\n(full run artifacts under ${wd})`);
finish("Demo 9 — The Research Assistant");
