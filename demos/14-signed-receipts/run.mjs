#!/usr/bin/env node
// Demo 14 — "Signed Receipts / Provable Spend"
// Organ: pi-kcp's REAL GovernedLoop.pay (which signs settlement receipts with the
//        harness's REAL signPurchaseReceipt) + kcp-harness verifyPurchaseReceipt,
//        AuditLog / AuditReader (decision chains), and exportEvidence.
//
// Two in-scope purchases settle over real x402 handshakes. Each produces an
// ed25519-SIGNED `purchase_settled` receipt. We then:
//   1. VERIFY a receipt with the harness verifier — and prove a TAMPERED copy is
//      rejected (the signature binds vendor+amount+currency+wallet+timestamp);
//   2. reconstruct each purchase as its own DECISION CHAIN from the audit log;
//   3. export a spend / compliance report (real kcp-harness exportEvidence).
//
// The signatures, the audit chains, and the compliance export are all real.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { AuditLog, AuditReader, buildLifecycleEvent, verifyPurchaseReceipt, exportEvidence } from "kcp-harness";
import { transpilePiKcp, section, expect, finish, showJson } from "../lib/runner.mjs";
import { startX402Stub } from "../lib/x402-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

section("Demo 14: Signed Receipts / Provable Spend — verify, reconstruct, export");

// --- 0. Load pi-kcp's REAL runtime seam (transpiled from src) ----------------
const built = transpilePiKcp("src/index.ts", "pi-kcp.mjs");
if (!built) {
  console.log("\n⚠ prerequisite: `bun` is needed to transpile pi-kcp's TypeScript seam. Skipping cleanly.");
  finish("Demo 14 — Signed Receipts / Provable Spend  [skipped: bun not present]");
  process.exit(0);
}
const { GovernedLoop, HarnessConformanceChecker, MockWallet, MockPaymentExecutor } =
  await import(pathToFileURL(built).href);

// --- 1. Two sanctioned x402 vendors -----------------------------------------
const stubA = await startX402Stub({ payTo: "0xVendorAcmeData", asset: "USDC", price: "250", resource: "/premium/adoption", data: "ACME: regulated-buyer adoption tripled QoQ." });
const stubB = await startX402Stub({ payTo: "0xVendorBetaFeed", asset: "USDC", price: "175", resource: "/premium/forecast", data: "BETA: 3-year governed-agent spend forecast." });

// --- 2. Governed loop + a real audit log ------------------------------------
const wd = mkdtempSync(join(tmpdir(), "kcp-demo14-"));
const auditPath = join(wd, "audit.jsonl");
const audit = new AuditLog(auditPath);
const wallet = new MockWallet();
const loop = new GovernedLoop({
  checker: new HarnessConformanceChecker({ manifest: "knowledge.yaml" }),
  wallet, executor: new MockPaymentExecutor(wallet),
  sessionId: "provable-spend",
  hooks: { onSettled: (a, e) => audit.emit(e) }, // stream each signed receipt into the audit log
});
const ctx = { cwd: fixtures };
audit.emit(buildLifecycleEvent("provable-spend", 0, "session_start", { project: "acme-procurement" }));

// --- 3. Run the two governed purchases (each its own turn → its own chain) ----
console.log("\nSettling two in-scope purchases over real x402 handshakes:");
const settlements = [];
let turn = 1;
for (const stub of [stubA, stubB]) {
  loop.beginTurn(turn++);
  await loop.evaluateToolCall("read", { path: join(fixtures, "buy-insight", "SKILL.md") }, ctx); // (re)load the skill
  const requestFn = (payment) => fetch(stub.url, { headers: payment ? { "X-PAYMENT": payment.payload } : {} });
  const { settlement } = await loop.pay(requestFn, ctx);
  settlements.push(settlement);
  console.log(`  ✅ ${settlement.receipt.vendor.padEnd(18)} ${String(settlement.receipt.amount).padStart(4)} ${settlement.receipt.currency}  receipt ${settlement.receipt.id.slice(0, 18)}…  keyId=${settlement.signature.keyId}`);
}
audit.emit(buildLifecycleEvent("provable-spend", 99, "session_end"));
await stubA.stop(); await stubB.stop();

// --- 4. VERIFY a receipt — and prove a tampered copy is rejected --------------
const r0 = settlements[0];
const genuine = await verifyPurchaseReceipt(r0.receipt, r0.signature);
const tamperAmount = await verifyPurchaseReceipt({ ...r0.receipt, amount: r0.receipt.amount + 1000 }, r0.signature);
const tamperVendor = await verifyPurchaseReceipt({ ...r0.receipt, vendor: "0xAttacker" }, r0.signature);
console.log("\nReceipt verification (real ed25519, harness verifyPurchaseReceipt):");
console.log(`  genuine receipt                      → ${genuine}`);
console.log(`  same receipt, amount +1000 (tampered) → ${tamperAmount}`);
console.log(`  same receipt, vendor swapped         → ${tamperVendor}`);

// --- 5. Reconstruct each purchase as a decision chain ------------------------
const reader = new AuditReader(auditPath);
const chains = await reader.chains();
const purchaseChains = chains.filter((c) => c.events.some((e) => e.type === "purchase_settled"));
console.log("\nDecision chains reconstructed from the audit log (one per purchase):");
for (const c of purchaseChains) {
  const p = c.events.find((e) => e.type === "purchase_settled").purchase;
  console.log(`  chain ${c.correlationId.slice(0, 24)}…  → bought ${p.amount} ${p.currency} from ${p.vendor}  (receipt ${p.receipt.slice(0, 14)}…, signed=${p.signed})`);
}

// --- 6. Spend report + compliance export ------------------------------------
const purchases = (await reader.readAll({ type: "purchase_settled" })).map((e) => e.purchase);
const totalSpend = purchases.reduce((s, p) => s + p.amount, 0);
showJson("Spend report (provable, from signed receipts)", {
  currency: purchases[0]?.currency,
  purchases: purchases.length,
  totalSpend,
  byVendor: purchases.map((p) => ({ vendor: p.vendor, amount: p.amount, receipt: p.receipt.slice(0, 14) + "…", signed: p.signed })),
});

const exportDir = join(wd, "evidence");
const exported = await exportEvidence({ auditPath, outputDir: exportDir, format: "soc2", organization: "ACME Procurement" });
console.log("\nCompliance evidence exported (real kcp-harness exportEvidence):");
exported.files.forEach((f) => console.log(`  • ${f}`));
showJson("Audit summary", exported.summary);

// --- 7. Verdict --------------------------------------------------------------
section("Verdict");
expect("two purchases settled with signed receipts", settlements.length === 2 && settlements.every((s) => s.signature?.algorithm === "ed25519"));
expect("a genuine receipt VERIFIES against its ed25519 signature", genuine === true);
expect("a receipt tampered on amount is REJECTED", tamperAmount === false);
expect("a receipt tampered on vendor is REJECTED", tamperVendor === false);
expect("each purchase reconstructs as its own decision chain", purchaseChains.length === 2);
expect("the chains carry the governed spend (vendor + amount + signed)",
  purchaseChains.every((c) => { const p = c.events.find((e) => e.type === "purchase_settled").purchase; return p.signed === true && p.amount > 0 && p.vendor; }));
expect("the spend report totals the provable spend", totalSpend === 425 && purchases.length === 2);
expect("a compliance evidence bundle was exported", Array.isArray(exported.files) && exported.files.length >= 1);
expect("the audit summary counts both settlements", exported.summary.events >= 4);

console.log(`\n(audit log + evidence under ${wd})`);
finish("Demo 14 — Signed Receipts / Provable Spend");
