#!/usr/bin/env bash
# Run every pi-kcp defendable-agent demo end-to-end. Exits non-zero if any demo
# fails a check. No LLM required — every demo in this batch is deterministic.
set -uo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/kcp-harness ] || [ ! -d node_modules/kcp-agent ]; then
  echo "Installing the real KCP tools (kcp-agent + kcp-harness)…"
  npm install
fi

demos=(
  "01-superseded-policy/run.mjs"
  "02-poisoned-playbook/run.mjs"
  "03-out-of-bounds-conformance/run.mjs"
  "04-auditors-thursday/run.mjs"
  "05-runaway-contained/run.mjs"
)

fails=0
for d in "${demos[@]}"; do
  echo ""
  echo "########################################################################"
  echo "# $d"
  echo "########################################################################"
  node "$d" || fails=$((fails + 1))
done

echo ""
echo "========================================================================"
if [ "$fails" -eq 0 ]; then
  echo "ALL DEMOS GREEN"
else
  echo "$fails demo(s) FAILED"
fi
exit "$fails"
