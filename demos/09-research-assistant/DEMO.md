# Demo 9 — The Research Assistant (governance as an enabler)

**Organ / verdict:** the real **kcp-harness** MCP proxy (`kcp-harness serve`) +
kcp-agent **grounding** — the well-behaved, autonomous, READ-ONLY counterpart to
demo 5.

## What it shows

Demo 5 shows governance **containing** a runaway. This shows the other half:
governance as an **enabler**. A scripted, deterministic, read-only autonomous
agent loads a `research-topic` skill whose `action_scope` permits read/search
tools over `research/ docs/ knowledge/` and **no writes**. It then does several
in-scope reads and a search — **every one allowed, zero blocks** — grounds a
short **cited** summary, and the whole run reconstructs as **one clean audit
chain with no conformance holds and no approval tickets**. A bounded autonomous
agent runs freely inside its declared box.

No LLM required: the agent and the grounding verifier are deterministic.

## Files

- `fixtures/knowledge.yaml` — the read-only `research-topic` skill + the corpus
  units (one per file the agent reads, plus a `research/` index unit that backs
  the in-scope search).
- `fixtures/corpus/**` — the research corpus, copied into an isolated sandbox.
- `fixtures/harness.yaml` — the proxy config (governed paths + skill tool).
- `downstream-server.mjs` — a real **read-only** MCP tool server (`read_file`,
  `search_files`, `Skill` — no write tool exists).
- `run.mjs` — spawns the proxy, drives the run over MCP/stdio, grounds the
  summary, and reconstructs the audit chain.

## Run it

```bash
cd demos
node 09-research-assistant/run.mjs
```

## Step-by-step

1. Spawn `kcp-harness serve`; note the governed surface exposes read/search and
   **no write tool**.
2. Load the `research-topic` skill.
3. `read_file` on `research/`, `docs/`, `knowledge/` files; `search_files` over
   `research/` — **all in-scope, all allowed**.
4. Ground a two-sentence summary against the units actually read → fully grounded.
5. Reconstruct the audit chain: `skill_loaded` + one `conformance_verdict` per
   action, **all `approved`, zero `blocked`**, no approval ticket.

## Expected governed output (real, captured)

```
governed tool surface: … read_file, search_files, Skill   (read-only — no write tool exists)

Autonomous read-only run (each step is a real MCP tools/call through the proxy):
  ✅ ALLOW load research skill    → [downstream] skill "research-topic" loaded
  ✅ ALLOW read market scan       → # Market scan — governed autonomous agents (Q3 2026)
  ✅ ALLOW read architecture      → # Architecture — the proxy sits between the agent and its tools
  ✅ ALLOW read glossary          → # Glossary
  ✅ ALLOW search corpus          → research/market-scan.md: first for an audit trail: every autonomous
```

Cited summary — fully grounded, no gaps:

```json
{
  "status": "grounded",
  "grounded": [
    { "claim": "The harness is a Model Context Protocol proxy that adjudicates governed calls before forwarding them.", "unitId": "architecture-doc", "sha256": "c96d8d3cd6f3…" },
    { "claim": "Buyers ask first for an audit trail of every autonomous action.", "unitId": "market-scan", "sha256": "386c2d5ce357…" }
  ],
  "gaps": []
}
```

Audit trail — every governed action `approved`, nothing `blocked`:

```
  # 1 session_start        approved   session_start
  # 3 skill_loaded         approved   kind: skill with explicit eligibility grant
  # 5 conformance_verdict  approved   action "read_file" on research/market-scan.md is within the active skill's declared action_scope
  # 7 conformance_verdict  approved   action "read_file" on docs/architecture.md is within …
  # 9 conformance_verdict  approved   action "read_file" on knowledge/glossary.md is within …
  #11 conformance_verdict  approved   action "search_files" on research/ is within …
  #12 session_end          approved   session_end
```

```json
{ "sessions": 1, "events": 12, "governed": 5, "blocked": 0, "budgetExceeded": 0, "drifts": 0, "signatureBlocked": 0 }
```

Verdict block:

```
  ✔ proxy exposed a read-only surface (read/search, no write tool)
  ✔ EVERY autonomous step was ALLOWED (zero blocks)
  ✔ the skill loaded (skill_loaded event present)
  ✔ conformance verdicts were emitted for the governed actions
  ✔ NOT ONE conformance hold — nothing left the scope
  ✔ no approval ticket was opened (nothing needed a human)
  ✔ the cited summary is fully grounded against the read units (no gaps)
✅ Demo 9 — The Research Assistant: ALL CHECKS GREEN
```
