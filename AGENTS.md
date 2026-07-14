# pi-kcp agent instructions

## Purpose

`pi-kcp` is a small, open-source Pi extension that improves access to KCP development tools. It is an adapter and ergonomics layer, not a replacement for KCP services or MCP.

## Architectural invariants

1. Keep the Pi extension thin and optional.
2. Use MCP for LLM-facing KCP and code-intelligence tools.
3. Use HTTP only where the extension must enrich a prompt before the LLM turn starts.
4. Invoke `kcp-agent` as a CLI; do not copy its planner logic into this repository.
5. Do not import or depend directly on Synthesis. Synthesis is an optional MCP provider.
6. Keep automatic context bounded, relevant, and fail-open.
7. Prefer pure functions for signal detection, query extraction, response normalization, and formatting.
8. Do not add a broad “dev context” abstraction until repeated concrete use cases justify it.

## User experience

The supported command surface is:

```text
/kcp help
/kcp health
/kcp recall <query>
/kcp plan <intent>
```

Explicit recall and plan results are placed into the next Pi turn. Automatic recall only activates for clear temporal or retrospective language and must never block a prompt when kcp-memory is unavailable.

## Code conventions

- TypeScript, strict mode, ESM.
- Bun is the local test/build runner.
- Keep runtime dependencies minimal.
- Use Pi's `pi.exec()` for subprocesses and `AbortSignal` for cancellable network work.
- Bound all network calls and truncate context sent to the model.
- Never print credentials, environment secrets, or full MCP process configuration.

## Commands

```bash
bun install
bun run typecheck
bun test
bun run build
```

Run the extension locally with:

```bash
pi -e ./src/index.ts
```

## Testing expectations

Unit-test pure functions without requiring kcp-memory, kcp-agent, Synthesis, or a configured Pi session. Integration tests should use local fakes and explicitly cover unavailable daemons, timeouts, malformed responses, empty results, and oversized results.

## Change discipline

Before expanding scope, check whether the behavior belongs in an existing upstream project (`kcp-memory`, `kcp-agent`, `kcp-commands`, or Pi itself). Prefer a small adapter change over a new service or protocol.
