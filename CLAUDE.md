# pi-kcp

Open-source Pi coding-agent extension that gives both the LLM and the human KCP
(Knowledge Context Protocol) proficiency: agent-facing skills plus bounded, fail-open
kcp-memory recall on one side, human-facing `/kcp` slash commands on the other. It is a
thin adapter — it invokes `kcp-agent`/`kcp-memory` as CLI/HTTP/MCP peers and does not
reimplement planning, memory, or code intelligence itself.

## Start here

Read `knowledge.yaml` first — it is this repo's own KCP manifest and the canonical
agent-navigable index of README, AGENTS.md, architecture docs, and local skills. Query it
the same way any KCP consumer would:

```bash
kcp-agent plan '<intent>' --manifest knowledge.yaml --json
```

For governed-skill authoring conventions shared across the KCP family (unit shape,
`PROFILE.md`, `action_scope` as a firewall rule, SK00x lint rules) see
[kcp-skill](https://github.com/Cantara/kcp-skill) — do not copy that content here.

## Local skills (`.pi/skills/`)

Repo-specific procedures only: `pi-kcp-development` (implementation workflow and
transport boundaries), `installation-validation` (clean-install / fixture validation),
`pr-evaluation` (independent PR verdict via `bun run pr-eval`).

## Gotchas

- `knowledge.yaml.sig` verification is relative to wherever the manifest is read from —
  do not point `serving.manifest` at a stale branch/host or `--require-signature`
  consumers fail closed against an old signature.
- `kcp-agent` is invoked as a CLI, not imported; don't copy planner logic into this repo.
- Never merge from an agent session — one issue, one branch, one PR, human merges.
