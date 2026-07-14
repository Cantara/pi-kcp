# Contributing to pi-kcp

## Before opening a change

- Read [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md).
- Prefer a focused issue and a small change.
- Check whether the behavior belongs upstream in `kcp-memory`, `kcp-agent`, `kcp-commands`, or Pi itself.

## Verification

```bash
bun install
bun run typecheck
bun test
bun run build
```

Do not require a running personal kcp-memory daemon for unit tests. Use a local fake server for integration tests.

## Pull requests

Explain the user-facing problem, the selected transport, failure behavior, and how the change avoids unnecessary prompt or tool clutter.
