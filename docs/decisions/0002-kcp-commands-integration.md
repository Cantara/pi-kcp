# Decision 0002: defer direct kcp-commands manifest lookup

**Status:** Deferred pending observed user friction

## Context

`kcp-commands` already owns command manifests, shell-hook injection, output filtering, and its MCP bridge. A Pi-specific `/kcp help <command>` feature would be useful only if Pi users repeatedly fail to discover or invoke commands despite those existing surfaces.

## Decision

Do not add a second manifest reader or automatic command-help injection to `pi-kcp` now.

The current `/kcp help` command remains extension usage help. It does not claim to be `kcp-commands` lookup.

## Rationale

- Duplicating YAML parsing would create two implementations of manifest semantics.
- Automatic injection would add prompt noise and repeat the existing hook's responsibility.
- MCP already provides the provider-neutral place for model-facing command knowledge.
- The smallest reversible next step is to observe concrete Pi friction before adding a new surface.

## Revisit criteria

Reopen this decision when at least one of these is true:

- Pi users report repeated command syntax failures that kcp-commands would have prevented;
- the kcp-commands project exposes a stable manifest-reader library or MCP operation suitable for reuse;
- a measured workflow shows that explicit `/kcp help <command>` materially reduces failed tool calls.

If revisited, prefer an upstream shared manifest reader over copying `commands/*.yaml` parsing into this repository.
