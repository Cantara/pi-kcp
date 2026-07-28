#!/usr/bin/env bash
# Run every pi-kcp defendable-agent demo end-to-end. Exits non-zero if any demo
# fails a check.
#
# Batch 1 (01–05) is fully deterministic — no LLM, no external service.
# Batch 2 (06–10) adds the LLM-dependent gates + external-service demos; each
# DEGRADES GRACEFULLY:
#   • 06/07 always run their deterministic adjudication; they additionally call a
#     real model only when ANTHROPIC_API_KEY is set.
#   • 08 runs the real kcp-memory (Java) daemon over HTTP; if Java/the jar is
#     unavailable it prints the prereq and exits 0 (never fails the suite).
#   • 10 transpiles pi-kcp's real conformance checker with `bun` if present,
#     otherwise falls back to the same shared adjudicator.
# Batch 3 (11–14) is the COMMERCE batch — governed value transfer (#139):
#   • 11 is fully deterministic (the real planner's money_budget gate).
#   • 12/13/14 transpile pi-kcp's real wallet + governed-loop seam with `bun`; if
#     `bun` is absent they print the prereq and exit 0 (never fail the suite).
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
  "06-cite-or-it-didnt-happen/run.mjs"
  "07-confident-fool/run.mjs"
  "08-forgotten-memory/run.mjs"
  "09-research-assistant/run.mjs"
  "10-two-depths-one-verdict/run.mjs"
  "11-budgeted-researcher/run.mjs"
  "12-shopping-agent-x402/run.mjs"
  "13-runaway-spender/run.mjs"
  "14-signed-receipts/run.mjs"
  "15-governed-composition/run.mjs"
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
