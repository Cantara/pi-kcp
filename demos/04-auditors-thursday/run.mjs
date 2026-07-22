#!/usr/bin/env node
// Demo 4 — "One Correlation ID → The Auditor's Thursday"
// Organs: kcp-harness decision-record chains (#34) + evidence export (#37)
// APIs (all REAL kcp-harness exports):
//   AuditLog + buildEvent/buildSkillEvent/buildConformanceEvent/buildApprovalEvent
//   AuditReader.decisionChain(correlationId)   ← reconstruct the chain
//   exportEvidence({ format })                 ← SOC2 / ISO27001 / ISO42001 / EU-AI-Act
//
// We drive a handful of governed events for one intercepted tool call, stamp
// them all with ONE correlationId, reconstruct the full verdict cascade from
// the append-only JSONL log, then export SOC2 / ISO27001 / ISO42001 / EU-AI-Act
// evidence bundles. No LLM: every event and every artifact is deterministic.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLog,
  AuditReader,
  buildLifecycleEvent,
  buildSkillEvent,
  buildEvent,
  buildApprovalEvent,
  buildConformanceEvent,
  classify,
  checkConformance,
  exportEvidence,
  InMemoryApprovalProvider,
  newRequest,
} from "kcp-harness";
import { section, expect, finish, showJson } from "../lib/runner.mjs";

const workdir = mkdtempSync(join(tmpdir(), "kcp-demo4-"));
const auditPath = join(workdir, "audit.jsonl");
const log = new AuditLog(auditPath);

const SESSION = "sess-2026-07-22-release";
const CID = "corr-thursday-0001"; // ONE correlation id for one intercepted call
const SCOPE = { tools: ["read_file", "write_file"], paths: ["ops/"] };
let seq = 0;

section("Demo 4: The Auditor's Thursday — one correlationId, full chain, evidence export");

// --- Drive the verdict cascade for ONE tool call, all sharing one CID -------
// 0. Session opens.
log.emit(buildLifecycleEvent(SESSION, seq++, "session_start"));

// 1. A governed skill is loaded (skill_eligibility passed).
log.emit(
  buildSkillEvent(SESSION, seq++, true, {
    id: "deploy-runbook",
    reason: "kind: skill with explicit eligibility grant",
    gate: "skill_eligibility",
    manifest: "ops/knowledge.yaml",
    actionScope: SCOPE,
  }, CID),
);

// 2. The tool call the skill makes — an in-scope write, approved.
const cls = classify("write_file", { path: "ops/release.log" }, []);
log.emit(buildEvent(SESSION, seq++, "write_file", { path: "ops/release.log" }, cls, undefined, "approved", 4, undefined, CID));

// 3. A conformance verdict for that action (in scope → passed).
const okVerdict = checkConformance({ tool: "write_file", paths: ["ops/release.log"] }, SCOPE);
log.emit(buildConformanceEvent(SESSION, seq++, "deploy-runbook", okVerdict, undefined, CID));

// 4. The SAME call later reaches out of scope → held, and a human-approval
//    ticket is opened. Both the approval and the conformance hold share the CID.
const badVerdict = checkConformance({ tool: "read_file", paths: ["/etc/shadow"] }, SCOPE);
const approvals = new InMemoryApprovalProvider();
const ticket = newRequest({
  sessionId: SESSION,
  toolName: "read_file",
  target: "/etc/shadow",
  task: 'conformance: skill "deploy-runbook"',
  requiredRole: "sre-lead",
  evidence: { policyRef: "SEC-OOB-1", detail: badVerdict.reason, conformance: badVerdict },
});
await approvals.submit(ticket);
const status = await approvals.check(ticket.id);
log.emit(buildApprovalEvent(SESSION, seq++, "approval_requested", status, CID));
log.emit(buildConformanceEvent(SESSION, seq++, "deploy-runbook", badVerdict, ticket.id, CID));

// 5. Session closes (no CID — lifecycle events are not part of a decision chain).
log.emit(buildLifecycleEvent(SESSION, seq++, "session_end"));

// --- Reconstruct the decision-record chain from the log (#34) ---------------
const reader = new AuditReader(auditPath);
const chain = await reader.decisionChain(CID);
console.log(`\nReconstructed decision chain for correlationId "${CID}":`);
console.log(`  session: ${chain.sessionId} · events: ${chain.events.length} · blocked: ${chain.blocked}`);
console.log("  cascade: " + chain.events.map((e) => e.type).join("  →  "));
showJson("Chain events (type · outcome · deciding detail)", chain.events.map((e) => ({
  seq: e.sequence,
  type: e.type,
  outcome: e.outcome,
  detail:
    e.skill?.reason ??
    e.conformance?.reason ??
    e.approval?.policyRef ??
    e.toolCall?.name,
  ticket: e.conformance?.ticketId ?? e.approval?.id,
})));

const summary = await reader.summarize();
showJson("Audit summary", summary);

// --- Export compliance evidence to all four frameworks (#37) ----------------
section("Evidence export → SOC2 / ISO27001 / ISO42001 / EU-AI-Act");
const frameworks = ["soc2", "iso27001", "iso42001", "euaiact"];
const exports = {};
// A "control artifact" is a per-control JSON — everything except the top-level
// manifest.json and the raw/ statistics dump.
const isControl = (f) => /\.json$/.test(f) && f !== "manifest.json" && !f.startsWith("raw/");
for (const fmt of frameworks) {
  const outputDir = join(workdir, "evidence", fmt);
  const res = await exportEvidence({ auditPath, outputDir, format: fmt, organization: "ACME Corp" });
  exports[fmt] = { res, outputDir };
  const controls = res.files.filter(isControl);
  console.log(`\n  ${fmt.toUpperCase()} → ${res.files.length} files, ${controls.length} control artifacts:`);
  for (const f of res.files) console.log("    " + f);
}

// Show one real exported control artifact end-to-end.
const euExport = exports.euaiact;
const artRel = euExport.res.files.find((f) => /Art\.14/.test(f));
console.log(`\nSample EU-AI-Act control artifact (${artRel}):`);
console.log(readFileSync(join(euExport.outputDir, artRel), "utf8").split("\n").map((l) => "  " + l).join("\n"));

section("Verdict");
expect("chain reconstructed from one correlationId", !!chain && chain.correlationId === CID);
expect("chain stitches skill_loaded → tool_call → conformance → approval → conformance",
  chain.events.map((e) => e.type).join(",") ===
    "skill_loaded,tool_call,conformance_verdict,approval_requested,conformance_verdict");
expect("chain is flagged blocked (it contains a held action)", chain.blocked === true);
expect("held conformance event carries the approval ticket id",
  chain.events.some((e) => e.type === "conformance_verdict" && e.conformance?.ticketId === ticket.id));
for (const fmt of frameworks) {
  expect(`${fmt} export produced control artifacts`, exports[fmt].res.files.some(isControl));
}

console.log(`\n(evidence bundles written under ${workdir}/evidence/)`);
finish("Demo 4 — The Auditor's Thursday");
