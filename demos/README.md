# pi-kcp demos — the defendable-agent stack, runnable and E2E-tested

A suite of small, self-contained, **end-to-end-tested** demos that test-drive
the KCP defendable-agent stack using the **real published tools** — no mocks for
the governance:

- **`kcp-agent@0.16.0`** — the deterministic 13-gate knowledge planner (CLI) +
  the grounding / confidence gates.
- **`kcp-harness@0.8.0`** — the MCP compliance proxy + conformance / audit /
  export library.
- **`kcp-memory@0.33.0`** — the episodic-memory daemon (Java) with the recall
  gate (demo 8 only).

Each demo loads a real KCP `knowledge.yaml`, drives a real governance organ, and
**asserts the governed outcome** — the written reason, the block, the audit
chain, the recall gate. Every governance verdict is the published tool's; nothing
governance-critical is mocked.

## The two batches

| Batch | Demos | Character |
|-------|-------|-----------|
| **1 — deterministic core** | 01–05 | No LLM, no external service. Planner gates, conformance, decision chains, evidence export, and an autonomous run contained in-loop. |
| **2 — output gates + depth** | 06–10 | The **grounding** and **confidence** gates (LLM-optional), a real **memory** daemon over HTTP, governance as an **enabler**, and one adjudicator proven identical at two **depths**. |

Every batch-2 demo **degrades gracefully**:

- **06 / 07** always run their deterministic adjudication (a scripted
  verifier / evaluator); they *additionally* call a real model **only when
  `ANTHROPIC_API_KEY` is set**, and print which path ran.
- **08** runs the real kcp-memory (Java) daemon over HTTP; if Java or the jar is
  unavailable it prints exactly what's missing and **exits 0** (never fails the
  suite).
- **10** transpiles pi-kcp's real conformance checker with `bun` if present, and
  otherwise falls back to the same shared adjudicator.

## Prerequisites

- **Node.js ≥ 20** (developed on Node 24). No global installs needed.
- The two JS tools are declared in `demos/package.json` and installed locally:

```bash
cd demos
npm install          # installs kcp-agent@0.16.0, kcp-harness@0.8.0, js-yaml
```

Optional, per demo:

- **`ANTHROPIC_API_KEY`** — lets demos 6 & 7 additionally run a live model
  (they run their deterministic adjudication with or without it).
- **Java 21+** and the **kcp-memory daemon jar** — for demo 8's live HTTP run.
  Default source `/src/cantara/kcp-memory/java` (auto-built with `mvn package`);
  override with `KCP_MEMORY_JAR` / `KCP_MEMORY_SRC`. Skipped cleanly if absent.
- **`bun`** — demo 10 uses it to transpile pi-kcp's real TypeScript checker; it
  falls back to the shared adjudicator without it.

## Run everything

```bash
cd demos
./run-all.sh          # runs all ten demos; exits non-zero if any check fails
```

Or run one at a time:

```bash
node 01-superseded-policy/run.mjs
node 02-poisoned-playbook/run.mjs
node 03-out-of-bounds-conformance/run.mjs
node 04-auditors-thursday/run.mjs
node 05-runaway-contained/run.mjs
node 06-cite-or-it-didnt-happen/run.mjs
node 07-confident-fool/run.mjs
node 08-forgotten-memory/run.mjs
node 09-research-assistant/run.mjs
node 10-two-depths-one-verdict/run.mjs
```

Each script prints the real governed output and a green/red verdict block, and
exits `0` only if every check passed.

## The demos

**Batch 1 — deterministic core**

| # | Demo | Organ / verdict exercised | LLM? |
|---|------|---------------------------|------|
| 1 | [The Superseded Policy](01-superseded-policy/DEMO.md) | 13-gate planner — **supersession** gate skips a retired policy *with a written reason*; rerun is byte-identical | no |
| 2 | [The Poisoned Playbook](02-poisoned-playbook/DEMO.md) | procedural plane — **skill_eligibility** gate refuses an ungranted/superseded `kind: skill` fail-closed *with a reason* | no |
| 3 | [Out of Bounds](03-out-of-bounds-conformance/DEMO.md) | **conformance** gate (flagship) — `checkConformance()` passes in-scope, blocks out-of-scope with the reason + surfaced gap | no |
| 4 | [The Auditor's Thursday](04-auditors-thursday/DEMO.md) | **decision chains** (#34) + **evidence export** (#37) — one correlationId → full chain → SOC2 / ISO27001 / ISO42001 / EU-AI-Act | no |
| 5 | [The Runaway, Contained](05-runaway-contained/DEMO.md) | **autonomous** run through the real `kcp-harness serve` MCP proxy — an out-of-scope step is blocked *in-loop* + a pending ticket is opened; the run proceeds and reconstructs as one audit chain | no |

**Batch 2 — output gates + depth**

| # | Demo | Organ / verdict exercised | LLM? |
|---|------|---------------------------|------|
| 6 | [Cite or it didn't happen](06-cite-or-it-didnt-happen/DEMO.md) | **grounding** gate — `groundAnswer()`: a claim grounds to a loaded, **sha-pinned** unit; an unsupported claim is a surfaced **gap**; a claim citing an unloaded unit fails closed | optional |
| 7 | [The Confident Fool](07-confident-fool/DEMO.md) | **confidence** gate — `assess()`: a cocky self-report (0.92) + an independent skeptic (0.35), **min-aggregated** vs a 0.70 threshold → **held**; the no-signal case fails closed | optional |
| 8 | [The Forgotten Memory](08-forgotten-memory/DEMO.md) | **recall** gate — the real **kcp-memory** daemon over HTTP: an expired/forgotten memory is skipped; a live one is returned with provenance | Java daemon |
| 9 | [The Research Assistant](09-research-assistant/DEMO.md) | governance as **enabler** — a bounded READ-ONLY autonomous agent runs freely through `kcp-harness serve`: several in-scope reads/searches, **zero blocks**, a grounded cited summary, one clean audit chain | no |
| 10 | [Two Depths, One Verdict](10-two-depths-one-verdict/DEMO.md) | the **same** `checkConformance` adjudicator at proxy depth (`kcp-harness serve`) and runtime depth (pi-kcp's `HarnessConformanceChecker`) → **identical** verdict + reason | no |

## Layout

```
demos/
├── README.md                     ← this file
├── package.json                  ← declares the real tools (npm install)
├── run-all.sh                    ← run every demo E2E
├── lib/runner.mjs                ← shared helpers (locate the real CLIs, assert, print)
├── 01-superseded-policy/         ← DEMO.md · run.mjs · fixtures/knowledge.yaml
├── 02-poisoned-playbook/         ← DEMO.md · run.mjs · fixtures/knowledge.yaml
├── 03-out-of-bounds-conformance/ ← DEMO.md · run.mjs · fixtures/knowledge.yaml
├── 04-auditors-thursday/         ← DEMO.md · run.mjs
├── 05-runaway-contained/         ← DEMO.md · run.mjs · downstream-server.mjs · fixtures/
├── 06-cite-or-it-didnt-happen/   ← DEMO.md · run.mjs · fixtures/{knowledge.yaml, knowledge/*.md}
├── 07-confident-fool/            ← DEMO.md · run.mjs
├── 08-forgotten-memory/          ← DEMO.md · run.mjs · MemoryGovDemoServer.java · (.gen/ built)
├── 09-research-assistant/        ← DEMO.md · run.mjs · downstream-server.mjs · fixtures/{harness.yaml, knowledge.yaml, corpus/**}
└── 10-two-depths-one-verdict/    ← DEMO.md · run.mjs · fixtures/{harness.yaml, knowledge.yaml} · (.gen/ built)
```

Each demo directory is self-contained: a runnable script, the fixtures it needs
(a `knowledge.yaml` with `kind: skill` + `action_scope` where relevant), and a
`DEMO.md` with the exact commands, the expected governed output, and which
organ/verdict it exercises.

## What "no mocks for the governance" means here

- Demos 1–2 shell out to the **real `kcp-agent` binary** and parse its stable
  `--json` / `--trace` output.
- Demo 3 imports the **real `checkConformance`** export.
- Demo 4 uses the **real** `AuditLog` / `AuditReader` / `exportEvidence`.
- Demos 5, 9, 10 **spawn the real `kcp-harness serve` proxy** and drive it as an
  MCP client over stdio; only the (deterministic) agent's step sequence is
  scripted — every verdict is the published proxy's.
- Demos 6–7 call the **real** `groundAnswer` / `assess` gates; only the
  verifier/evaluator *signal* is scripted for the deterministic path (a real
  model is used when `ANTHROPIC_API_KEY` is set).
- Demo 8 runs the **real kcp-memory daemon handlers** over real HTTP against real
  SQLite — on an isolated port + DB so the user's daemon is never touched.
- Demo 10's runtime-depth leg runs pi-kcp's **real** `src/harness-conformance.ts`
  (transpiled on demand), not a re-implementation.
