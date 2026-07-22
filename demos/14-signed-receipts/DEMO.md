# Demo 14 — Signed Receipts / Provable Spend

**Organ / verdict:** pi-kcp's **real** `GovernedLoop.pay` (which signs settlement
receipts with the harness's real `signPurchaseReceipt`) + kcp-harness
`verifyPurchaseReceipt`, `AuditLog` / `AuditReader` (decision chains), and
`exportEvidence`.

## What it shows

Two in-scope purchases settle over **real x402 handshakes**; each produces an
**ed25519-signed `purchase_settled` receipt**. The demo then:

1. **verifies** a receipt with the harness verifier — and proves a **tampered**
   copy (amount bumped, or vendor swapped) is **rejected** (the signature binds
   `{ vendor, amount, currency, wallet, timestamp }`);
2. reconstructs each purchase as its own **decision chain** from the audit log
   (grouped by correlation id);
3. exports a **spend / compliance report** with real kcp-harness `exportEvidence`
   (a SOC2 evidence bundle).

The signatures, the audit chains, and the compliance export are all real.

## Files

- `fixtures/knowledge.yaml` + `fixtures/buy-insight/SKILL.md` — a spend envelope
  covering two sanctioned vendors (≤ 5000 USDC each).
- `../lib/x402-stub.mjs` — the self-facilitated x402 resource server (shared).
- `run.mjs` — transpiles the real seam, settles two buys, verifies + exports.

## Run it

```bash
cd demos
node 14-signed-receipts/run.mjs          # needs `bun` to transpile the seam; skips cleanly otherwise
```

## Expected governed output (real, captured)

```
Settling two in-scope purchases over real x402 handshakes:
  ✅ 0xVendorAcmeData    250 USDC  receipt 0x…  keyId=kcp-demo
  ✅ 0xVendorBetaFeed    175 USDC  receipt 0x…  keyId=kcp-demo

Receipt verification (real ed25519, harness verifyPurchaseReceipt):
  genuine receipt                      → true
  same receipt, amount +1000 (tampered) → false
  same receipt, vendor swapped         → false

Decision chains reconstructed from the audit log (one per purchase):
  chain 00-…  → bought 250 USDC from 0xVendorAcmeData  (receipt 0x…, signed=true)
  chain 00-…  → bought 175 USDC from 0xVendorBetaFeed  (receipt 0x…, signed=true)
```

Spend report + exported compliance evidence:

```json
{ "currency": "USDC", "purchases": 2, "totalSpend": 425 }
```

```
Compliance evidence exported (real kcp-harness exportEvidence):
  • manifest.json
  • raw/sessions.json
  • raw/statistics.json
  • soc2/CC6.1-logical-access.json
  • soc2/CC6.3-authorized-access.json
  • soc2/CC6.6-system-boundaries.json
  • soc2/CC7.2-monitoring.json
  • soc2/CC8.1-change-management.json
  • soc2/summary.md
```

Verdict block:

```
  ✔ two purchases settled with signed receipts
  ✔ a genuine receipt VERIFIES against its ed25519 signature
  ✔ a receipt tampered on amount is REJECTED
  ✔ a receipt tampered on vendor is REJECTED
  ✔ each purchase reconstructs as its own decision chain
  ✔ the chains carry the governed spend (vendor + amount + signed)
  ✔ the spend report totals the provable spend
  ✔ a compliance evidence bundle was exported
  ✔ the audit summary counts both settlements
✅ Demo 14 — Signed Receipts / Provable Spend: ALL CHECKS GREEN
```

## Prerequisite

`bun` (to transpile pi-kcp's TypeScript seam on demand). Absent `bun`, the demo
prints the prereq and exits `0`.
