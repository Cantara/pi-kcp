---
name: installation-validation
description: Validate a fresh pi-kcp installation and its KCP integrations without relying on personal daemons, Synthesis, or provider credentials. Use for release readiness, installation debugging, or issue #15.
---

# Installation validation

## Deterministic local checks

```bash
bun install
bun run typecheck
bun test
bun run build
```

When available, `bun run smoke` loads both `src/index.ts` and the built extension through Pi RPC mode and verifies `/kcp` registration. The smoke check must not mutate global Pi settings. Until that target is present, use the equivalent explicit Pi RPC check from the installation-validation issue.

## Service-backed checks

Use local fakes before real services:

- fake kcp-memory HTTP server for `/search` and `/health`;
- deterministic fake `kcp-agent` executable for `/kcp plan`;
- temporary `.pi/kcp.json` in a fixture project.

Cover healthy responses, empty results, malformed responses, timeout behavior, invalid configuration, disabled configuration, and fail-open automatic recall.

## Optional provider checks

Synthesis and other code-intelligence MCP providers are optional. Validate their Pi MCP wiring separately from the deterministic suite. Never require private provider API keys in CI and never use a developer's personal memory database as a test fixture.

## Evidence

Record:

- runtime and Pi versions;
- exact commands;
- pass/fail counts;
- whether services were fakes or real;
- known gaps.

Do not claim installation readiness from a source-only unit test. The packaged artifact and a clean fixture must also load successfully.
