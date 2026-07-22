# Demo 4 — One Correlation ID → The Auditor's Thursday

**Organs / verdicts:** kcp-harness **decision-record chains** (#34) +
**evidence export** (#37).

## What it shows

Every verdict a single intercepted tool call produces — skill load → tool call →
conformance → approval → conformance — shares **one correlation id**. From the
append-only JSONL audit log, `AuditReader.decisionChain(correlationId)`
reconstructs the whole cascade in order, without re-running anything. Then
`exportEvidence` turns the same log into auditor-ready control artifacts for
**SOC2, ISO 27001, ISO 42001, and the EU AI Act**. This is the "an auditor asks
about one action on a Thursday and you hand them the whole chain plus the
framework mapping" property. No LLM: every event and artifact is deterministic.

## Files

- `run.mjs` — drives the events through the real audit API, stamps one
  correlationId, reconstructs the chain, and exports all four frameworks.

Real kcp-harness exports used: `AuditLog`, `buildSkillEvent`, `buildEvent`,
`buildConformanceEvent`, `buildApprovalEvent`, `AuditReader.decisionChain()`,
`exportEvidence()`.

## Run it

```bash
cd demos
node 04-auditors-thursday/run.mjs
```

## Step-by-step

1. **Open an append-only audit log** (`AuditLog` → JSONL file).
2. **Emit the verdict cascade for one call**, all stamped `correlationId
   "corr-thursday-0001"`: `skill_loaded` → `tool_call` (approved in-scope write)
   → `conformance_verdict` (passed) → the same call later reaches out of scope →
   `approval_requested` (ticket opened) → `conformance_verdict` (blocked, carries
   the ticket id).
3. **Reconstruct the chain** with `reader.decisionChain(CID)` — 5 events, in
   sequence order, `blocked: true`.
4. **Summarize the log** with `reader.summarize()`.
5. **Export evidence** for each framework with `exportEvidence({ format })`,
   producing per-control JSON artifacts + a `summary.md` per framework.
6. **Open one real artifact end-to-end** (EU AI Act Art.14(1)) to show the
   control text and the mapped evidence event.

> The correlation id `corr-thursday-0001` and the frameworks/controls are stable.
> Ticket UUIDs and timestamps vary per run; the run below is one real capture.

## Expected governed output (real, captured)

Reconstructed chain:

```
Reconstructed decision chain for correlationId "corr-thursday-0001":
  session: sess-2026-07-22-release · events: 5 · blocked: true
  cascade: skill_loaded  →  tool_call  →  conformance_verdict  →  approval_requested  →  conformance_verdict
```

Held leg of the chain (ticket id varies):

```json
{
  "seq": 4, "type": "approval_requested", "outcome": "blocked",
  "detail": "SEC-OOB-1", "ticket": "4d384649-9dc6-40b5-b03e-547a987fb469"
},
{
  "seq": 5, "type": "conformance_verdict", "outcome": "blocked",
  "detail": "target \"/etc/shadow\" is outside the skill's authorized paths [ops/]",
  "ticket": "4d384649-9dc6-40b5-b03e-547a987fb469"
}
```

Evidence export (file layout is stable):

```
  SOC2 → 9 files, 5 control artifacts:
    soc2/CC6.1-logical-access.json
    soc2/CC6.3-authorized-access.json
    soc2/CC6.6-system-boundaries.json
    soc2/CC7.2-monitoring.json
    soc2/CC8.1-change-management.json
  ISO27001 → A.8.3 / A.8.4 / A.8.15 / A.8.16 / A.5.23
  ISO42001 → A.6.2.6 / A.6.2.8 / A.9.2 / A.6.2.2 / A.9.4 / A.6.2.4
  EUAIACT  → Art.12-1 / Art.12-2 / Art.14-1 / Art.14-4 / Art.14-4c
```

One real EU-AI-Act control artifact:

```json
{
  "controlId": "Art.14(1)",
  "controlName": "Human Oversight — Approval Gates",
  "description": "High-risk AI systems shall be designed so they can be effectively overseen by natural persons. Human approval is requested and resolved before gated operations proceed.",
  "evidenceCount": 1,
  "events": [
    { "timestamp": "…", "sessionId": "sess-2026-07-22-release", "type": "approval_requested", "outcome": "blocked", "detail": "approval_requested [pending_review]: sre-lead" }
  ]
}
```

Verdict:

```
  ✔ chain reconstructed from one correlationId
  ✔ chain stitches skill_loaded → tool_call → conformance → approval → conformance
  ✔ chain is flagged blocked (it contains a held action)
  ✔ held conformance event carries the approval ticket id
  ✔ soc2 / iso27001 / iso42001 / euaiact exports produced control artifacts
✅ Demo 4 — The Auditor's Thursday: ALL CHECKS GREEN
```
