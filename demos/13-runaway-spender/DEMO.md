# Demo 13 — The Runaway Spender, Contained

**Organ / verdict:** pi-kcp's **real** `GovernedLoop` + the **real kcp-harness
purchase-conformance gate**, with held buys routed to **real kcp-harness approval
tickets**. The **commerce twin of demo 5** (out-of-scope containment → over-spend
containment).

## What it shows

The agent loads `buy-insight` (envelope: **≤ 500 USD, USD only, vendor
`acme-data`**) and runs a sequence of buys. An in-scope buy settles. Then it goes
rogue **twice** — a purchase **over `max_spend`**, and a purchase to a
**disallowed vendor**. Both are held **in-loop** by the purchase-conformance gate
with the exact reason, each opens a **pending approval ticket**, and the **wallet
is never asked to authorize** them. The run then **resumes** with another
in-scope buy — containment, not a brick.

```
purchase of 900 USD to "acme-data" exceeds max_spend 500 USD
vendor "sketchy-exfil-co" is outside the skill's authorized vendors [acme-data]
```

## Files

- `fixtures/knowledge.yaml` + `fixtures/buy-insight/SKILL.md` — the tight spend envelope.
- `run.mjs` — transpiles the real seam, drives the run, opens real approval tickets.

## Run it

```bash
cd demos
node 13-runaway-spender/run.mjs          # needs `bun` to transpile the seam; skips cleanly otherwise
```

## Expected governed output (real, captured)

```
Autonomous run (each buy is adjudicated against the skill's spend envelope):
  ✅ ALLOW load skill
  ✅ ALLOW in-scope buy             120 USD → acme-data
  ⛔ HELD  OVER max_spend           900 USD → acme-data          — purchase of 900 USD to "acme-data" exceeds max_spend 500 USD
  ⛔ HELD  DISALLOWED vendor        50 USD → sketchy-exfil-co    — vendor "sketchy-exfil-co" is outside the skill's authorized vendors [acme-data]
  ✅ ALLOW in-scope buy (resume)    80 USD → acme-data

wallet.authorize() calls over the whole run: 2  (only the 2 in-scope buys; the held ones never reached it)
```

Pending approval tickets (real `FileApprovalProvider`, each held buy):

```json
[
  { "state": "pending_review", "tool": "buy", "vendor": "acme-data",       "reason": "purchase of 900 USD to \"acme-data\" exceeds max_spend 500 USD" },
  { "state": "pending_review", "tool": "buy", "vendor": "sketchy-exfil-co", "reason": "vendor \"sketchy-exfil-co\" is outside the skill's authorized vendors [acme-data]" }
]
```

Verdict block:

```
  ✔ the skill loaded and the in-scope buy settled
  ✔ the OVER-max_spend buy was HELD in-loop
  ✔ the hold names the arithmetic (exceeds max_spend)
  ✔ the DISALLOWED-vendor buy was HELD in-loop
  ✔ the hold names the vendor allowlist
  ✔ each held buy opened exactly one pending ticket (2 total)
  ✔ tickets target the runaway vendors, pinning the reason as evidence
  ✔ the WALLET NEVER authorized a held buy (only the 2 in-scope buys)
  ✔ the run PROCEEDS after the holds (the resume buy settles)
✅ Demo 13 — The Runaway Spender, Contained: ALL CHECKS GREEN
```

## Prerequisite

`bun` (to transpile pi-kcp's TypeScript seam on demand). Absent `bun`, the demo
prints the prereq and exits `0`.
