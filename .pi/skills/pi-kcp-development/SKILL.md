---
name: pi-kcp-development
description: "Develop pi-kcp safely: understand the thin KCP adapter boundary, choose the right transport, run focused Bun verification, and keep provider-specific code out of the extension. Use for implementation, refactoring, or architecture decisions in this repository."
---

# pi-kcp development

`pi-kcp` is dual-audience: agent-facing skills and MCP operating guidance are first-class, while slash commands and diagnostics serve humans. Do not optimize one surface by making the other opaque.

## Before changing code

Read `AGENTS.md` and the relevant section of `docs/architecture.md`. Keep the design simple:

- Pi extension commands and prompt-boundary behavior belong here.
- LLM-facing KCP and code intelligence belong behind MCP.
- HTTP is used only for pre-prompt kcp-memory recall because Pi extensions cannot invoke MCP directly.
- `kcp-agent`, `kcp-memory`, `kcp-commands`, and Synthesis remain independently replaceable.

## Implementation rules

- TypeScript strict mode, ESM, Bun tooling.
- Keep automatic context bounded and fail-open.
- Use `pi.exec()` with argument arrays for subprocesses; never interpolate user input into shell commands.
- Bound network requests with an abort timeout.
- Prefer pure functions for parsing, validation, signal detection, and formatting.
- Do not add automatic Synthesis searches, an MCP client, or a duplicate kcp-commands manifest reader without a concrete issue and evidence.

## Verification

```bash
bun run typecheck
bun test
bun run build
```

For Pi loading changes:

```bash
bun run smoke
```

The smoke test requires `pi` and `jq`, but no personal KCP daemon or provider credentials.

## Change shape

One issue should produce one focused branch and PR. Do not merge from an agent session. Use `ref #NNN` in commits and PRs, never automatic-closing keywords.
