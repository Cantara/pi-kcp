# Optional MCP providers

`pi-kcp` does not require a code-intelligence backend. It uses Pi's MCP configuration as the provider boundary.

## Recommended defaults

Keep servers lazy and keep direct tool injection disabled unless the session specifically benefits from putting every server tool in the model's active tool list:

```json
{
  "settings": {
    "toolPrefix": "server",
    "directTools": false
  },
  "mcpServers": {
    "kcp-memory": {
      "command": "bash",
      "args": ["-lc", "exec kcp-memory mcp"],
      "lifecycle": "lazy"
    },
    "code-intelligence": {
      "command": "bash",
      "args": ["-lc", "exec your-code-intelligence-mcp --workspace \"$PWD\""],
      "lifecycle": "lazy"
    }
  }
}
```

Replace `code-intelligence` with Synthesis or another MCP server. The provider name and startup command are configuration; neither is part of the pi-kcp runtime.

## Why lazy MCP servers

Lazy startup avoids paying process and indexing costs in sessions that do not use memory or code intelligence. It also keeps a basic Pi session usable when an optional provider is not installed.

## Why `directTools: false`

With direct tools disabled, Pi exposes the MCP server through its namespaced server surface rather than flattening every provider operation into the primary tool list. This reduces prompt clutter and makes provider availability explicit. Enable direct tools only when a workflow has demonstrated that the extra discoverability is worth the larger tool surface.

## Provider substitution

A provider is compatible with this project when it can be configured as a Pi MCP server. It may be:

- Synthesis;
- another local code-intelligence server;
- a remote MCP endpoint wrapped by a local launcher;
- no provider at all.

`pi-kcp` must not import provider SDKs, inspect provider-specific response formats, or run provider searches automatically on every prompt. Ask the model to use the configured MCP server when code intelligence is needed.

## Transport boundary

The Pi extension cannot invoke MCP tools directly during the input lifecycle. Automatic episodic recall therefore uses the kcp-memory HTTP peer. Explicit model-facing memory and code-intelligence queries remain MCP operations.
