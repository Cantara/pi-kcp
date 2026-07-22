#!/usr/bin/env node
// Demo 13 — "The Runaway Spender, Contained" (the commerce twin of demo 5)
// Organ: pi-kcp's REAL GovernedLoop + the REAL kcp-harness purchase-conformance
//        gate, with held purchases routed to REAL kcp-harness approval tickets.
//
// The agent loads `buy-insight` (spend envelope: ≤ 500 USD, USD only, vendor
// "acme-data") and runs a sequence of buys. An in-scope buy settles. Then it goes
// rogue twice — a purchase OVER max_spend, and a purchase to a DISALLOWED vendor.
// Both are held IN-LOOP by the purchase-conformance gate with the exact reason,
// each opens a pending approval ticket, and the WALLET IS NEVER ASKED TO AUTHORIZE
// them. The run then resumes with another in-scope buy. Containment, not a brick.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { FileApprovalProvider, newRequest } from "kcp-harness";
import { transpilePiKcp, section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

section("Demo 13: The Runaway Spender, Contained — the purchase-conformance gate holds the buy");

// --- 0. Load pi-kcp's REAL runtime seam (transpiled from src) ----------------
const built = transpilePiKcp("src/index.ts", "pi-kcp.mjs");
if (!built) {
  console.log("\n⚠ prerequisite: `bun` is needed to transpile pi-kcp's TypeScript seam. Skipping cleanly.");
  finish("Demo 13 — The Runaway Spender, Contained  [skipped: bun not present]");
  process.exit(0);
}
const { GovernedLoop, HarnessConformanceChecker, MockWallet, MockPaymentExecutor } =
  await import(pathToFileURL(built).href);

// A wallet that COUNTS authorize() calls — so we can prove a held buy never reaches it.
class CountingWallet {
  authorizeCalls = 0;
  constructor(inner) { this.inner = inner; }
  address() { return this.inner.address(); }
  authorize(req) { this.authorizeCalls += 1; return this.inner.authorize(req); }
}

// --- 1. Wire the governed loop; route every block to a REAL approval ticket ---
const approvalsDir = mkdtempSync(join(tmpdir(), "kcp-demo13-"));
const approvals = new FileApprovalProvider(approvalsDir);
const wallet = new CountingWallet(new MockWallet());
const executor = new MockPaymentExecutor(wallet);
const settled = [];
const ticketWrites = [];
const openTicket = (action, reason) => approvals.submit(newRequest({
  sessionId: "demo13",
  toolName: action.toolName,
  target: action.purchase?.vendor ?? action.toolName,
  task: "autonomous purchase under buy-insight",
  requiredRole: "account-owner",
  evidence: { manifest: "knowledge.yaml", policyRef: "action_scope.spend", detail: reason },
}));
const loop = new GovernedLoop({
  checker: new HarnessConformanceChecker({ manifest: "knowledge.yaml" }),
  wallet, executor,
  hooks: {
    onSettled: (a, e) => settled.push(e),
    onBlocked: (action, reason) => ticketWrites.push(openTicket(action, reason)),
  },
});
const ctx = { cwd: fixtures };

// --- 2. The autonomous run ---------------------------------------------------
loop.beginTurn(0);
const steps = [
  ["load skill",            "read", { path: join(fixtures, "buy-insight", "SKILL.md") }],
  ["in-scope buy",          "buy",  { vendor: "acme-data", amount: 120, currency: "USD" }],
  ["OVER max_spend",        "buy",  { vendor: "acme-data", amount: 900, currency: "USD" }],
  ["DISALLOWED vendor",     "buy",  { vendor: "sketchy-exfil-co", amount: 50, currency: "USD" }],
  ["in-scope buy (resume)", "buy",  { vendor: "acme-data", amount: 80, currency: "USD" }],
];

console.log("\nAutonomous run (each buy is adjudicated against the skill's spend envelope):");
const results = [];
for (const [label, tool, input] of steps) {
  const d = await loop.evaluateToolCall(tool, input, ctx);
  results.push({ label, ...d });
  const money = input.amount != null ? `${input.amount} ${input.currency} → ${input.vendor}` : "";
  console.log(`  ${d.block ? "⛔ HELD " : "✅ ALLOW"} ${label.padEnd(24)} ${money.padEnd(28)} ${d.block ? "— " + d.reason : ""}`);
}

await Promise.all(ticketWrites);
const tickets = await approvals.list();

showJson("Pending approval tickets (each runaway buy, held for a human)", tickets.map((t) => ({
  id: t.request.id, state: t.state, tool: t.request.toolName, vendor: t.request.target,
  requiredRole: t.request.requiredRole, reason: t.request.evidence?.detail,
})));
console.log(`\nwallet.authorize() calls over the whole run: ${wallet.authorizeCalls}  (only the ${settled.length} in-scope buys; the held ones never reached it)`);

// --- 3. Verdict --------------------------------------------------------------
section("Verdict");
const over = results.find((r) => r.label === "OVER max_spend");
const vendorBad = results.find((r) => r.label === "DISALLOWED vendor");
const resume = results.find((r) => r.label === "in-scope buy (resume)");
expect("the skill loaded and the in-scope buy settled",
  !results[0].block && !results[1].block && settled.length >= 1);
expect("the OVER-max_spend buy was HELD in-loop", !!over && over.block === true);
expect("the hold names the arithmetic (exceeds max_spend)",
  !!over && /purchase of 900 USD to "acme-data" exceeds max_spend 500 USD/.test(over.reason), over?.reason);
expect("the DISALLOWED-vendor buy was HELD in-loop", !!vendorBad && vendorBad.block === true);
expect("the hold names the vendor allowlist",
  !!vendorBad && /vendor "sketchy-exfil-co" is outside the skill's authorized vendors \[acme-data\]/.test(vendorBad.reason), vendorBad?.reason);
expect("each held buy opened exactly one pending ticket (2 total)",
  tickets.length === 2 && tickets.every((t) => t.state === "pending_review"));
expect("tickets target the runaway vendors, pinning the reason as evidence",
  tickets.some((t) => /exceeds max_spend/.test(t.request.evidence?.detail ?? "")) &&
  tickets.some((t) => /authorized vendors/.test(t.request.evidence?.detail ?? "")));
expect("the WALLET NEVER authorized a held buy (only the 2 in-scope buys)",
  wallet.authorizeCalls === 2 && settled.length === 2);
expect("the run PROCEEDS after the holds (the resume buy settles)", !!resume && !resume.block);

console.log(`\n(approval tickets under ${approvalsDir})`);
finish("Demo 13 — The Runaway Spender, Contained");
