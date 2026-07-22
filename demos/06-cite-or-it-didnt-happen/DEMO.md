# Demo 6 — Cite or it didn't happen (grounding)

**Organ / verdict:** kcp-agent's **grounding** gate — the real exported
`groundAnswer(task, answer, units, { verifier })`.

## What it shows

The planner decides what may be *loaded*; grounding decides what may be
*asserted*. Every sentence of a synthesized answer must be attributed to a
**loaded, hash-pinned** unit or it is surfaced as an explicit **gap**. A claim a
loaded unit supports grounds — with that unit's **sha256 pinned** as the
citation. A claim no loaded unit supports comes back as a gap and the whole
answer is `status: partial-unsupported`.

Attribution is only a *proposal* (an LLM in production, a scripted verifier
here). Grounding is *adjudicated* deterministically: `groundAnswer` confirms the
cited unit was actually loaded and records its sha256 — so a verifier that
mis-attributes a claim to a unit that was never loaded can **never** ground it
(fail-closed).

## LLM behaviour

- The **deterministic** adjudication (scripted token-overlap verifier) **always
  runs** — it is the governed outcome.
- When `ANTHROPIC_API_KEY` is set, the demo **additionally** runs the same
  `groundAnswer` with a **live model verifier** (`makeVerifier()`), and prints
  which path ran. The live model reaches the same verdict (SOC 2 claim = gap).

## Files

- `fixtures/knowledge.yaml` + `fixtures/knowledge/*.md` — two loadable units
  (key rotation, incident severity).
- `run.mjs` — hashes the units, grounds a 3-sentence answer, shows the
  fail-closed unloaded-citation case, and runs the live verifier if a key is set.

## Run it

```bash
cd demos
node 06-cite-or-it-didnt-happen/run.mjs
# optional: ANTHROPIC_API_KEY=sk-... node 06-cite-or-it-didnt-happen/run.mjs
```

## Step-by-step

1. **Load + hash** the two units the agent was allowed to load → `GroundUnit
   {id, sha256, content}`.
2. **Ground** a 3-sentence answer. Sentences 1–2 are supported by loaded units;
   sentence 3 (a SOC 2 claim) is supported by none.
3. **Fail-closed**: a "compromised" verifier that cites `ghost-unit` (never
   loaded) grounds nothing — membership is adjudicated, not proposed.
4. **Live** (key only): the same answer through a real model verifier.

## Expected governed output (real, captured)

Deterministic verdict:

```json
{
  "status": "partial-unsupported",
  "grounded": [
    { "claim": "Production API keys are rotated every 90 days.", "unitId": "key-rotation", "sha256": "d6ec4749ecf89247…" },
    { "claim": "A SEV-1 incident pages the on-call SRE immediately.", "unitId": "incident-severity", "sha256": "58c93b0a1482c38e…" }
  ],
  "gaps": [
    { "claim": "The platform is certified SOC 2 Type II as of 2026.", "reason": "unsupported: no loaded unit covers this claim" }
  ]
}
```

Fail-closed (verifier cites an unloaded unit):

```json
{
  "status": "partial-unsupported",
  "claims": [
    { "claim": "Production API keys are rotated every 90 days.", "grounded": false,
      "reason": "verifier cited unit 'ghost-unit' that was not loaded — fail-closed" }
  ]
}
```

Live verifier (with `ANTHROPIC_API_KEY`) — same shape, model-written gap reason:

```json
{
  "status": "partial-unsupported",
  "gaps": [
    { "claim": "The platform is certified SOC 2 Type II as of 2026.",
      "reason": "unsupported: No loaded unit contains information about SOC 2 Type II certification status or timeline. The loaded units cover key rotation policy and incident severity definitions only." }
  ]
}
```

Verdict block:

```
  ✔ answer is NOT fully grounded — a gap is surfaced, not swallowed
  ✔ the key-rotation claim grounds to a loaded unit
  ✔ the grounded claim pins the unit's sha256 (citation is byte-pinned)
  ✔ the SEV-1 claim grounds to the incident-severity unit
  ✔ the unsupported compliance claim is a GAP (no loaded unit)
  ✔ exactly one gap surfaced
  ✔ fail-closed: a claim attributed to an unloaded unit does NOT ground
  ✔ live verifier ran and produced a verdict over the same units
✅ Demo 6 — Cite or it didn't happen (grounding): ALL CHECKS GREEN
```
