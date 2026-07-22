#!/usr/bin/env node
// Demo 12 — "The Shopping Agent (x402)"
// Organ: pi-kcp's REAL runtime seam — GovernedLoop.pay + MockPaymentExecutor
//        (the wallet seam) — over the REAL kcp-harness purchase-conformance gate.
//
// A scripted autonomous agent buys a paid resource through a real x402 handshake.
// It first LOADS a skill (`buy-insight`) that declares an `action_scope.spend`
// envelope { allowed_vendors, max_spend, currency }. It then makes the purchase:
//
//   402 challenge → purchase-conformance gate (REAL kcp-harness checkConformance,
//   vendor+currency+amount vs the skill's spend envelope) → APPROVE → wallet
//   authorizes (real X-PAYMENT header) → signed retry → settlement → a SIGNED
//   `purchase_settled` receipt (real ed25519, harness signPurchaseReceipt).
//
// The 402 handshake is real, the purchase-conformance is real, the receipt
// signature is real. Only the *settlement* is faked (the x402 stub self-facilitates).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { verifyPurchaseReceipt } from "kcp-harness";
import { transpilePiKcp, section, expect, finish, showJson } from "../lib/runner.mjs";
import { startX402Stub } from "../lib/x402-stub.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

section("Demo 12: The Shopping Agent (x402) — a governed buy clears the spend gate");

// --- 0. Load pi-kcp's REAL runtime seam (transpiled from src) ----------------
const built = transpilePiKcp("src/index.ts", "pi-kcp.mjs");
if (!built) {
  console.log("\n⚠ prerequisite: `bun` is needed to transpile pi-kcp's TypeScript seam.");
  console.log("  Install bun (https://bun.sh) and re-run. Skipping cleanly.");
  finish("Demo 12 — The Shopping Agent (x402)  [skipped: bun not present]");
  process.exit(0);
}
const { GovernedLoop, HarnessConformanceChecker, MockWallet, MockPaymentExecutor } =
  await import(pathToFileURL(built).href);

// --- 1. Stand up the real x402 resource server (self-facilitated stub) -------
const stub = await startX402Stub({ payTo: "0xVendorAcmeData", asset: "USDC", price: "250", resource: "/premium/insight" });
console.log(`\nx402 resource: ${stub.url}`);
console.log(`  quotes: ${stub.requirements.maxAmountRequired} ${stub.requirements.asset} → ${stub.requirements.payTo} (network ${stub.requirements.network})`);

// --- 2. Wire the governed loop with the real purchase-conformance checker ----
const checker = new HarnessConformanceChecker({ manifest: "knowledge.yaml" }); // reads fixtures/knowledge.yaml
const wallet = new MockWallet();
const executor = new MockPaymentExecutor(wallet);
const settled = [];
const blocked = [];
const loop = new GovernedLoop({
  checker, wallet, executor,
  hooks: { onSettled: (a, e) => settled.push(e), onBlocked: (a, r) => blocked.push({ tool: a.toolName, reason: r }) },
});
const ctx = { cwd: fixtures };

// --- 3. The autonomous run: load the skill, then buy -------------------------
loop.beginTurn(0);
console.log(`\nAutonomous run:`);
const skillLoad = await loop.evaluateToolCall("read", { path: join(fixtures, "buy-insight", "SKILL.md") }, ctx);
console.log(`  ${skillLoad.block ? "⛔ HELD" : "✅ ALLOW"} load skill  buy-insight   (active scope: spend ≤ 5000 USDC to 0xVendorAcmeData)`);

console.log(`  … purchasing ${stub.url} via x402 (402 → govern → sign → retry → settle)`);
const requestFn = (payment) => fetch(stub.url, { headers: payment ? { "X-PAYMENT": payment.payload } : {} });
const { response, receipt, settlement } = await loop.pay(requestFn, ctx);
const resourceBody = await response.json();
console.log(`  ✅ BOUGHT   resource delivered → "${resourceBody.data}"`);

// --- 4. Inspect the real handshake, receipt, and signature -------------------
console.log("\nx402 handshake the stub actually saw (real two-request protocol):");
stub.requests.forEach((r, i) => console.log(`  ${i + 1}. ${r.phase.padEnd(10)} X-PAYMENT=${r.hadPayment}${r.payer ? `  payer=${r.payer}` : ""}`));

showJson("Settlement receipt (X-PAYMENT-RESPONSE, parsed by the executor)", receipt);
showJson("Signed purchase_settled audit event (onSettled)", settled[0]);

const verified = await verifyPurchaseReceipt(settlement.receipt, settlement.signature);
const tampered = await verifyPurchaseReceipt({ ...settlement.receipt, amount: settlement.receipt.amount + 999 }, settlement.signature);
console.log(`\nreceipt signature (ed25519, harness verifyPurchaseReceipt): genuine=${verified}  tampered=${tampered}`);

await stub.stop();

// --- 5. Verdict --------------------------------------------------------------
section("Verdict");
expect("the skill loaded (in-scope, allowed)", !skillLoad.block);
expect("purchase-conformance ALLOWED the in-scope buy (no block fired)", blocked.length === 0);
expect("the real x402 handshake ran: a 402 challenge THEN a signed retry",
  stub.requests.length === 2 && stub.requests[0].phase === "challenge" && stub.requests[1].phase === "settle");
expect("the wallet's authorization rode the retry (stub saw the wallet as payer)",
  stub.requests[1]?.payer === (await wallet.address()));
expect("settlement cleared with a transaction hash", receipt.success === true && typeof receipt.txHash === "string" && receipt.txHash.length > 0);
expect("a signed purchase_settled receipt was emitted", settled[0]?.type === "purchase_settled" && settled[0]?.purchase?.signed === true);
expect("the receipt records the governed spend (vendor + amount + currency)",
  settled[0]?.purchase?.vendor === "0xVendorAcmeData" && settled[0]?.purchase?.amount === 250 && settled[0]?.purchase?.currency === "USDC");
expect("the ed25519 receipt VERIFIES, and a tampered copy is REJECTED", verified === true && tampered === false);
expect("the agent received the paid resource", typeof resourceBody?.data === "string" && resourceBody.data.length > 0);

finish("Demo 12 — The Shopping Agent (x402)");
