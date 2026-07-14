#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v pi >/dev/null || { echo "pi is required for the extension smoke test" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required for the extension smoke test" >&2; exit 1; }

bun run build >/dev/null

for extension in src/index.ts dist/src/index.js; do
  response="$(printf '%s\n' '{"id":"commands","type":"get_commands"}' | pi --mode rpc --no-session -e "./$extension" 2>/dev/null)"
  if ! jq -e '.type == "response" and .command == "get_commands" and .success == true and (.data.commands | any(.name == "kcp"))' <<<"$response" >/dev/null; then
    echo "Extension command registration failed for $extension" >&2
    echo "$response" >&2
    exit 1
  fi
  if ! bun -e 'const modulePath = process.argv[1]; const { KCP_HELP } = await import(modulePath); for (const command of ["/kcp help", "/kcp health", "/kcp recall", "/kcp plan", "/kcp validate", "/kcp init"]) if (!KCP_HELP.includes(command)) process.exit(1);' "./$extension"; then
    echo "Help contract is incomplete for $extension" >&2
    exit 1
  fi
  echo "ok: $extension loads, registers /kcp, and exposes complete help"
done
