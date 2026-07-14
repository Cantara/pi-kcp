# Architecture

## Problem

Pi can access MCP servers, but the operator still has to remember which KCP surface answers which question. Automatic context injection is also useful for episodic recall, but only when it is clearly relevant.

## Decision

`pi-kcp` has two responsibilities:

1. expose a small, explicit `/kcp` command surface;
2. perform bounded, signal-based kcp-memory recall before a prompt is sent.

It does not aggregate every KCP service into one tool.

## Transport matrix

| Capability | Pi extension | MCP | HTTP |
|---|---:|---:|---:|
| Explicit memory query by the model |  | yes | optional |
| Prompt-boundary memory recall | yes | no | yes |
| Deterministic knowledge plan | command invokes CLI | optional |  |
| Shell command manifest help |  | existing bridge | existing hooks |
| Code intelligence |  | yes | provider-specific |

Pi extensions currently have no MCP client API. The HTTP path for pre-prompt recall is therefore intentional. It must remain a small peer integration, not a second MCP implementation.

## Optional code intelligence

Synthesis is treated as one possible MCP provider. The extension does not know whether the provider is Synthesis, another implementation, local-only, or absent. Future Synthesis open-sourcing does not require a design change.

## Configuration and diagnostics

`.pi/kcp.json` is optional. Missing configuration uses defaults. Invalid configuration is reported by `/kcp health` and disables automatic behavior rather than silently applying partial values.

## Failure behavior

- kcp-memory unavailable: leave the prompt unchanged.
- malformed search response: leave the prompt unchanged and report only through diagnostics when explicitly requested.
- kcp-agent unavailable: `/kcp plan` returns an actionable error; no automatic fallback planner is introduced.
- oversized output: truncate before adding context to Pi.

## Deferred decisions

- whether to distribute through npm, a Pi package registry, or both;
- whether `kcp-agent` should provide a stable library/JSON interface; the current CLI contract is `plan <intent> --manifest <path>`;
- whether kcp-commands should expose a shared manifest reader for Pi;
- whether a capability-discovery command is valuable beyond MCP's existing discovery.
