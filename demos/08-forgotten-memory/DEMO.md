# Demo 8 — The Forgotten Memory (memory governance / recall gate)

**Organ / verdict:** the real **kcp-memory** daemon (Java 21) — its **recall
gate** exercised over **real HTTP** against real SQLite.

## What it shows

A memory whose **retention window has expired** (`valid_until` in the past), or
that has been **explicitly forgotten** (right-to-forget tombstone), is **skipped
by recall** — while a live memory is still returned **with its provenance**. The
gate is the same one the KCP planner uses temporally, here in the episodic-memory
layer. `GET /governance/audit` explains every decision; the forgotten memory's
row is **retained** (tombstoned, not deleted) so the forget is itself auditable.

## Prerequisite (this is the one external-service demo)

- **Java 21+** and the built **kcp-memory daemon jar**.
  - Default source: `/src/cantara/kcp-memory/java` → build with
    `mvn -q -DskipTests package` (the demo does this automatically if needed).
  - Override with `KCP_MEMORY_JAR=/path/to/kcp-memory-daemon.jar` or
    `KCP_MEMORY_SRC=/path/to/java`.
- If Java or the jar is unavailable, the demo **prints exactly what's missing and
  exits 0** — it never fails the suite.

## Isolation (important)

The shipped `kcp-memory daemon` command **hard-binds port 7735**, which on a dev
box is already held by the user's own daemon pointing at the real
`~/.kcp/memory.db`. This demo instead wires the **same published handlers**
(`HealthHandler`, `SearchHandler`, `GovernanceHandler`, `IngestHandler`,
`ListHandler`) via a tiny launcher (`MemoryGovDemoServer.java`) onto a **free
ephemeral port** over an **isolated temp DB**. It never touches the user's daemon
or data. Only the bootstrap port/DB differ — every governance decision is the
real daemon's code. Seeding uses the real `SessionStore.upsert()` (the exact call
the scanner makes), so seeded memories carry auto-derived provenance.

## Files

- `MemoryGovDemoServer.java` — the isolated launcher (real handlers, free port).
- `run.mjs` — finds a free port, (builds +) compiles + starts the daemon, then
  drives the recall gate over HTTP with `fetch`.

## Run it

```bash
cd demos
node 08-forgotten-memory/run.mjs
```

## Step-by-step (all over real HTTP)

1. Seed three memories, all matching `authentication`.
2. `GET /search?q=authentication` → **all three** recalled, each with provenance.
3. `POST /governance/retention {sess-expired, valid_until: 2000-01-01…}` and
   `POST /governance/forget {sess-forgotten, reason: …}`.
4. `GET /search?q=authentication` → **only the live memory** survives.
5. `GET /governance/audit?q=authentication` → 3 candidates, 2 skipped **with
   reasons**; `GET /governance?session=…` → provenance + the retained tombstone.

## Expected governed output (real, captured)

```
daemon health: status=ok version=0.33.0 sessions=3

(1) GET /search?q=authentication  → 3 memories recalled (pre-gate):
      sess-expired     "Draft the authentication service Q2 rollout timeline"  prov=claude-code:acme-auth#sess-expired
      sess-forgotten   "Record the authentication service break-glass admin credentials"  prov=claude-code:acme-auth#sess-forgotten
      sess-live        "Implement OAuth2 PKCE login for the authentication service"  prov=claude-code:acme-auth#sess-live

(2) POST /governance/retention {sess-expired, valid_until:2000-01-01T00:00:00Z}  → {"session":"sess-expired","valid_until":"2000-01-01T00:00:00Z"}
    POST /governance/forget    {sess-forgotten}                    → {"session":"sess-forgotten","forgotten":"true","reason":"user exercised right-to-forget (sensitive credentials)"}

(3) GET /search?q=authentication  → 1 memory recalled (post-gate):
      sess-live        "Implement OAuth2 PKCE login for the authentication service"  prov=claude-code:acme-auth#sess-live
```

Recall-gate audit:

```json
{
  "candidates": 3, "skipped": 2,
  "results": [
    { "sessionId": "sess-expired",   "allowed": false, "reason": "retention window expired at 2000-01-01T00:00:00Z (now 2026-07-22T…)" },
    { "sessionId": "sess-forgotten", "allowed": false, "reason": "forgotten at 2026-07-22T… (user exercised right-to-forget (sensitive credentials))" },
    { "sessionId": "sess-live",      "allowed": true,  "reason": null }
  ]
}
```

Provenance + retained tombstone:

```json
{ "sessionId": "sess-live",      "provenance": "claude-code:acme-auth#sess-live",      "validUntil": null, "forgottenAt": null,          "forgetReason": null }
{ "sessionId": "sess-forgotten", "provenance": "claude-code:acme-auth#sess-forgotten", "validUntil": null, "forgottenAt": "2026-07-22T…", "forgetReason": "user exercised right-to-forget (sensitive credentials)" }
```

Verdict block:

```
  ✔ pre-gate: all three memories are recalled
  ✔ every recalled memory carries provenance
  ✔ retention + forget were applied over HTTP
  ✔ post-gate: exactly ONE memory survives recall
  ✔ the survivor is the live memory, returned WITH its provenance
  ✔ the expired + forgotten memories are NOT recalled
  ✔ audit surfaces all 3 candidates incl. the gated-out ones
  ✔ audit reason for the expired memory says 'expired'
  ✔ audit reason for the forgotten memory says 'forgotten' + the reason
  ✔ the live memory is allowed by the gate
  ✔ the forgotten memory's ROW is retained (tombstone auditable)
  ✔ the live memory has provenance and no tombstone/expiry
✅ Demo 8 — The Forgotten Memory: ALL CHECKS GREEN
```
