# pi-kcp

Open-source KCP agent proficiency and ergonomics for the Pi coding-agent harness.

`pi-kcp` helps both the LLM and the human use Knowledge Context Protocol tools from Pi. It provides agent-facing skills and operating guidance alongside human-facing commands, without replacing MCP or coupling Pi to a particular code-intelligence implementation.

## Design

The project serves two audiences through separate but complementary lanes:

- **Agent-facing:** skills teach the LLM when and how to use kcp-agent, kcp-memory, kcp-harness, and optional code intelligence.
- **Human-facing:** slash commands and diagnostics make the same capabilities explicit and inspectable.

The project deliberately uses separate transport lanes:

- **Pi extension:** human-facing `/kcp` commands and bounded prompt recall.
- **kcp-memory:** HTTP for pre-prompt recall; MCP remains available for explicit LLM queries.
- **kcp-agent:** invoked as a CLI for deterministic knowledge plans.
- **kcp-commands:** remains responsible for shell command manifests and hooks.
- **Synthesis or another code-intelligence provider:** accessed through MCP, optionally.

MCP is the compatibility boundary for code intelligence. `pi-kcp` does not import Synthesis or reimplement an MCP client.

## Current commands

Install or load the extension, then use:

```text
/kcp help
/kcp health
/kcp recall <query>
/kcp plan <intent>
/kcp validate
/kcp init
```

`/kcp recall` and `/kcp plan` add their result to the next Pi turn as a context message. Recall-shaped prompts (for example, “what did we decide about deployment?”) are augmented automatically when the local kcp-memory HTTP daemon is available. Recall failures are silent and never block a prompt.

## Install for development

```bash
bun install
bun run build
bun run smoke
pi -e ./dist/src/index.js
```

`bun run smoke` starts Pi in RPC mode and verifies that both the TypeScript source extension and built package extension register `/kcp`. It requires `pi` and `jq` on `PATH` but no KCP daemon.

For a local source reload during development:

```bash
pi -e ./src/index.ts
```

The package can later be installed as a Pi package after its distribution contract is stable.

## Configuration

The extension works with conservative defaults. A project may add `.pi/kcp.json`:

```json
{
  "enabled": true,
  "autoRecall": true,
  "memoryUrl": "http://localhost:7735",
  "maxResults": 3,
  "timeoutMs": 400,
  "manifest": "knowledge.yaml",
  "agentCli": "/path/to/kcp-agent/dist/cli.js"
}
```

All fields are optional. Configuration values are validated; invalid configuration disables automatic behavior and is reported by `/kcp health`. `agentCli` may point to either the JavaScript CLI module or an executable command. Discovery checks the configured path, `KCP_AGENT_CLI`, the documented Homebrew/npm locations, and finally `kcp-agent` on `PATH`.

## Diagnostics

```text
/kcp health
```

The health command reports configuration state, kcp-memory availability, and kcp-agent discovery. Missing configuration uses defaults; invalid configuration fails closed for automatic recall.

## MCP configuration

Pi should continue to expose KCP and code-intelligence servers through `.pi/mcp.json`. Keep those servers lazy and avoid direct tool injection unless there is a deliberate reason to expose every tool in the prompt.

Example:

```json
{
  "mcpServers": {
    "kcp-memory": {
      "command": "bash",
      "args": ["-lc", "exec kcp-memory mcp"],
      "lifecycle": "lazy"
    },
    "synthesis": {
      "command": "bash",
      "args": ["-lc", "exec synthesis-mcp-server --workspace \"$PWD\""],
      "lifecycle": "lazy"
    }
  }
}
```

The Synthesis entry is illustrative, not a dependency or required runtime. See [Optional MCP providers](docs/mcp-providers.md) for provider substitution and `directTools` guidance.

## Development

```bash
bun run typecheck
bun test
bun run build
```

Project-local Pi skills are available under `.pi/skills/`:

- `pi-kcp-development` — architecture and implementation workflow;
- `pr-evaluation` — independent Minimax M3 PR evaluation;
- `installation-validation` — clean-install and integration validation.

Run the provenance-aware PR evaluator with:

```bash
bun run pr-eval -- <PR> [<PR> ...]
bun run pr-eval -- <PR> --comment
```

It defaults to `opencode/minimax-m3`, evaluates current diffs against linked issues, and never merges or applies governance labels.

The pure recall and response-formatting functions are tested independently of a running daemon. Integration tests should use a fake local HTTP server rather than a developer's memory database.

## kcp-commands status

`kcp-commands` remains the owner of shell command manifests, injection, filtering, and its MCP bridge. The `/kcp help` command currently documents pi-kcp itself; it is not a duplicate command-manifest lookup surface. Direct manifest lookup is deferred until real Pi friction or a reusable upstream reader justifies it. See [Decision 0002](docs/decisions/0002-kcp-commands-integration.md).

## Scope boundaries

This project will not:

- become a general-purpose MCP client;
- run Synthesis automatically on every prompt;
- inject plans, memories, or code graphs unconditionally;
- replace kcp-commands' shell hooks;
- require Synthesis to be installed.

## Roadmap

The project is KCP-adopted itself: `knowledge.yaml` describes its agent-facing documentation and skills. The next likely steps are stronger installation validation, explicit command help, and upstream Pi integration in kcp-harness.

## License

Apache-2.0. See [LICENSE](LICENSE).
