# Demo 12 — The Shopping Agent (x402)

**Organ / verdict:** pi-kcp's **real** runtime seam — `GovernedLoop.pay` +
`MockPaymentExecutor` (the wallet seam, transpiled from `src/`) — over the **real
kcp-harness purchase-conformance gate** (`checkConformance`, spend-aware, #139).

## What it shows

A scripted autonomous agent buys a paid resource through a **real x402
handshake**. It first loads a skill (`buy-insight`) that declares an
`action_scope.spend` envelope `{ allowed_vendors, max_spend, currency }`. The
purchase (in-scope vendor, under `max_spend`, right currency) then runs:

```
402 challenge → purchase-conformance gate (real checkConformance: vendor+currency+amount
vs the skill's spend envelope) → APPROVE → wallet authorizes (real X-PAYMENT header)
→ signed retry → settlement → a SIGNED purchase_settled receipt (real ed25519)
```

The 402 handshake is real, the purchase-conformance is real, the ed25519 receipt
signature is real. Only the **settlement** is faked — the x402 stub
self-facilitates and mints a synthetic transaction hash.

## Files

- `fixtures/knowledge.yaml` + `fixtures/buy-insight/SKILL.md` — the sanctioned
  shopping skill and its spend envelope (≤ 5000 USDC to `0xVendorAcmeData`).
- `../lib/x402-stub.mjs` — the self-facilitated x402 resource server (shared).
- `run.mjs` — transpiles the real seam, drives the buy, verifies the receipt.

## Run it

```bash
cd demos
node 12-shopping-agent-x402/run.mjs      # needs `bun` to transpile the seam; skips cleanly otherwise
```

## Expected governed output (real, captured)

```
Autonomous run:
  ✅ ALLOW load skill  buy-insight   (active scope: spend ≤ 5000 USDC to 0xVendorAcmeData)
  … purchasing http://127.0.0.1:PORT/premium/insight via x402 (402 → govern → sign → retry → settle)
  ✅ BOUGHT   resource delivered → "PREMIUM INSIGHT: governed-agent adoption tripled QoQ across regulated buyers."

x402 handshake the stub actually saw (real two-request protocol):
  1. challenge  X-PAYMENT=false
  2. settle     X-PAYMENT=true  payer=0xf6b3cfad3344799adf8ef9c36ba89d1df4d0b4a4
```

The signed `purchase_settled` audit event (`onSettled`):

```json
{
  "type": "purchase_settled",
  "correlationId": "00-…-…-01",
  "outcome": "approved",
  "purchase": {
    "vendor": "0xVendorAcmeData",
    "amount": 250,
    "currency": "USDC",
    "receipt": "0x…",
    "signed": true,
    "signature": "…base64 ed25519…",
    "keyId": "kcp-demo"
  }
}
```

```
receipt signature (ed25519, harness verifyPurchaseReceipt): genuine=true  tampered=false
```

Verdict block:

```
  ✔ the skill loaded (in-scope, allowed)
  ✔ purchase-conformance ALLOWED the in-scope buy (no block fired)
  ✔ the real x402 handshake ran: a 402 challenge THEN a signed retry
  ✔ the wallet's authorization rode the retry (stub saw the wallet as payer)
  ✔ settlement cleared with a transaction hash
  ✔ a signed purchase_settled receipt was emitted
  ✔ the receipt records the governed spend (vendor + amount + currency)
  ✔ the ed25519 receipt VERIFIES, and a tampered copy is REJECTED
  ✔ the agent received the paid resource
✅ Demo 12 — The Shopping Agent (x402): ALL CHECKS GREEN
```

## Prerequisite

`bun` (to transpile pi-kcp's TypeScript seam on demand, as demo 10 does). Absent
`bun`, the demo prints the prereq and exits `0` — it never fails the suite.
