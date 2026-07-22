# pi-kcp demos — the defendable-agent stack, runnable and E2E-tested

A suite of small, self-contained, **end-to-end-tested** demos that test-drive
the KCP defendable-agent stack using the **real published tools** — no mocks for
the governance:

- **`kcp-agent@0.16.0`** — the deterministic 13-gate knowledge planner (CLI).
- **`kcp-harness@0.8.0`** — the MCP compliance proxy + conformance / audit /
  export library.

Each demo loads a real KCP `knowledge.yaml`, drives a real governance organ, and
**asserts the governed outcome** — the written reason, the block, the audit
chain. Every demo in this batch is **deterministic and runs without an LLM**.
(A later batch adds the LLM-dependent grounding/confidence demos and the pi-kcp
in-loop runtime demo — see "Not yet in this batch" below.)

## Prerequisites

- **Node.js ≥ 20** (developed on Node 24). No global installs needed.
- The two tools are declared in `demos/package.json` and installed locally:

```bash
cd demos
npm install          # installs kcp-agent@0.16.0, kcp-harness@0.8.0, js-yaml
```

That's it. No KCP daemon, no network, no API key. Demos that *could* call a model
(none in this batch) degrade gracefully and only do so when `ANTHROPIC_API_KEY`
is set.

## Run everything

```bash
cd demos
./run-all.sh          # runs all five demos; exits non-zero if any check fails
```

Or run one at a time:

```bash
node 01-superseded-policy/run.mjs
node 02-poisoned-playbook/run.mjs
node 03-out-of-bounds-conformance/run.mjs
node 04-auditors-thursday/run.mjs
node 05-runaway-contained/run.mjs
```

Each script prints the real governed output and a green/red verdict block, and
exits `0` only if every check passed.

## The demos

| # | Demo | Organ / verdict exercised | LLM? |
|---|------|---------------------------|------|
| 1 | [The Superseded Policy](01-superseded-policy/DEMO.md) | 13-gate planner — **supersession** gate skips a retired policy *with a written reason*; rerun is byte-identical | no |
| 2 | [The Poisoned Playbook](02-poisoned-playbook/DEMO.md) | procedural plane — **skill_eligibility** gate refuses an ungranted/superseded `kind: skill` fail-closed *with a reason* | no |
| 3 | [Out of Bounds](03-out-of-bounds-conformance/DEMO.md) | **conformance** gate (flagship) — `checkConformance()` passes in-scope, blocks out-of-scope with the reason + surfaced gap | no |
| 4 | [The Auditor's Thursday](04-auditors-thursday/DEMO.md) | **decision chains** (#34) + **evidence export** (#37) — one correlationId → full chain → SOC2 / ISO27001 / ISO42001 / EU-AI-Act | no |
| 5 | [The Runaway, Contained](05-runaway-contained/DEMO.md) | **autonomous** run through the real `kcp-harness serve` MCP proxy — an out-of-scope step is blocked *in-loop* + a pending ticket is opened; the run proceeds and reconstructs as one audit chain | no |

## Layout

```
demos/
├── README.md                     ← this file
├── package.json                  ← declares the real tools (npm install)
├── run-all.sh                    ← run every demo E2E
├── lib/
│   └── runner.mjs                ← shared helpers (locate the real CLIs, assert, print)
├── 01-superseded-policy/
│   ├── DEMO.md                   ← numbered walkthrough + real captured output
│   ├── run.mjs
│   └── fixtures/knowledge.yaml
├── 02-poisoned-playbook/
│   ├── DEMO.md · run.mjs · fixtures/knowledge.yaml
├── 03-out-of-bounds-conformance/
│   ├── DEMO.md · run.mjs · fixtures/knowledge.yaml
├── 04-auditors-thursday/
│   ├── DEMO.md · run.mjs
└── 05-runaway-contained/
    ├── DEMO.md · run.mjs
    ├── downstream-server.mjs     ← a real downstream MCP tool server the proxy polices
    └── fixtures/{harness.yaml, knowledge.yaml}
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
- Demo 5 **spawns the real `kcp-harness serve` proxy** and drives it as an MCP
  client over stdio; the only scripted part is the (deterministic) agent's
  sequence of steps — every governance verdict is the published proxy's.

## Not yet in this batch (next up)

- **Grounding** and **confidence** gate demos (`kcp-agent ask` / `harness_assess`)
  — these are LLM-dependent; they will run the deterministic adjudication always
  and only call a model when `ANTHROPIC_API_KEY` is set.
- A **pi-kcp in-loop runtime** demo driving `/kcp plan` / recall through the Pi
  extension itself.
