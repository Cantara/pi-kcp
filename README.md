# pi-kcp

### 🧾 **[Play the interactive demos → cantara.github.io/kcp-playground](https://cantara.github.io/kcp-playground/)**

Sixteen in-browser stations that run the **real** KCP decision code live — drag the controls, watch the adjudicator re-decide, and see each verdict signed and printed as a receipt. Maintained in its own repo, [Cantara/kcp-playground](https://github.com/Cantara/kcp-playground) (the `playground/` directory in *this* repo is an older, unmaintained mirror — don't link to it). Companion to the reveal, [*The AI Agent That Keeps the Receipts*](https://wiki.totto.org/blog/2026/07/22/the-ai-agent-that-keeps-the-receipts/).

---

Open-source KCP agent proficiency and ergonomics for the Pi coding-agent harness.

`pi-kcp` helps both the LLM and the human use Knowledge Context Protocol tools from Pi. It provides agent-facing skills and operating guidance alongside human-facing commands, without replacing MCP or coupling Pi to a particular code-intelligence implementation.

## Design

The project serves two audiences through separate but complementary lanes:

- **Agent-facing:** skills teach the LLM when and how to use kcp-agent, kcp-memory, kcp-harness, and optional code intelligence.
- **Human-facing:** slash commands and diagnostics make the same capabilities explicit and inspectable.

The CLI is the primary interface, for both humans and agents: kcp-agent is invoked as a CLI directly, the same call path whether a human runs it from a terminal or an agent runs it from a plan step. `/kcp` and the other slash commands below are a discovery-and-ergonomics wrapper around that CLI, built for Pi's UX — not a replacement for it, and not the primary way in.

The project deliberately uses separate transport lanes:

- **Pi extension:** human-facing `/kcp` commands and bounded prompt recall.
- **kcp-memory:** HTTP for pre-prompt recall; MCP remains available for explicit LLM queries.
- **kcp-agent:** invoked as a CLI for deterministic knowledge plans.
- **kcp-skill:** owns the [authoring conventions, linter, and conformance vectors](https://github.com/Cantara/kcp-skill) for the governed skill units this extension enforces.
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

`/kcp recall` and `/kcp plan` add their result to the next Pi turn as a context message. Plans are requested from kcp-agent with `--json` and rejected if the response is not structured JSON. Recall-shaped prompts (for example, “what did we decide about deployment?”) are augmented automatically when the local kcp-memory HTTP daemon is available. Recall failures are silent and never block a prompt.

## Install for development

```bash
bun install
bun run build
bun run smoke
pi -e ./dist/src/index.js
```

`bun run smoke` starts Pi in RPC mode and verifies that both the TypeScript source extension and built package extension register `/kcp`. It requires `pi` and `jq` on `PATH` but no KCP daemon.

For full clean-fixture validation with fake kcp-memory and kcp-agent services:

```bash
bun run validate-install
```

Every Pi process in this harness has a hard timeout and is killed as a process group.

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

## Persona-turn wrapper (bridge process transport)

`dist/src/wrapper-cli.js` runs **one governed Pi turn as a subprocess** shaped for Sunstone Atlas's bridge process-transport tools: exactly one JSON object on stdout, exit 0 only when pi-kcp's own verdict (`isGoverned` in `src/runtime.ts`) says the turn was governed *and* its signed ledger entry (`createFileLedgerHook`, #151) was persisted. It drives Pi **in-process** through Pi's SDK (`createAgentSession` with pi-kcp as an inline extension factory — the same path Pi's own `main` takes), not `pi --mode rpc` as a child: that is the only route that reaches `RegisterOptions.loop`, and it needs nothing from stdin, which the bridge leaves open.

```bash
/usr/bin/node /abs/pi-kcp/dist/src/wrapper-cli.js \
  --prompt "<the persona's question>" \
  --cwd /abs/persona-workspace \          # must contain .pi/kcp.json with enabled:true, governance ≠ off
  --model anthropic/claude-sonnet-4-5 \   # provider/id[:thinking]; Pi's built-in catalogue
  --signing-key /abs/persona-a.pem \      # PKCS8 ed25519 private key; entries embed the SPKI public key
  --ledger /abs/ledgers/persona-a.jsonl \ # append-only; verify with verifyLedgerFile()
  [--api-key-env PERSONA_A_KEY]           # default ANTHROPIC_API_KEY — the ONLY env var read
  [--persona <text>|--persona-file <abs>] # replaces Pi's system prompt
  [--grounding <text>|--grounding-file <abs>]  # appended to the system prompt
  [--tools read,grep] [--key-id persona-a] [--timeout-ms 50000]
  [--reply-schema deliberate|deliberate-synthesis   # opt-in structured reply (Atlas deliberate mode)
    [--grounding-doc-ids release-policy,bug-tracker]  # bare ids the grounding text carries as [doc:<id>]
    [--citation-required]]                          # empty cited_docs is refused too
```

Bridge config sketch (every `{param}` follows a literal flag, one argv element each; the credential is delivered via `token_env`, never argv):

```json
{ "system": "pi-kcp-persona",
  "exec": { "command": "/usr/bin/node", "args": ["/abs/pi-kcp/dist/src/wrapper-cli.js"] },
  "tools": { "persona-a-turn": {
    "argv": ["--prompt", "{prompt}", "--grounding", "{grounding}",
             "--cwd", "/abs/persona-a", "--model", "anthropic/claude-sonnet-4-5",
             "--signing-key", "/abs/keys/persona-a.pem", "--ledger", "/abs/ledgers/persona-a.jsonl",
             "--api-key-env", "PERSONA_A_KEY", "--key-id", "persona-a"],
    "token_env": "PERSONA_A_KEY", "side_effect": "read" } } }
```

Exit codes: `0` governed, reply on stdout · `1` turn completed but not governed (stderr carries `ungovernedReason`; the lapse is still on the ledger) · `2` usage/config error, nothing ran and nothing was spent (bad argv, unreadable key, credential unset, unknown model, workspace config missing/`governance:"off"`) · `3` the model turn failed (Pi threw, or the assistant stopped with `error`/`aborted`; under `--reply-schema`, also a reply that does not parse as the schema or fails the citation check — the model ran and was paid for, the turn is on the ledger, and only the *answer* is refused) · `4` the ledger could not be written. A failure is always exit≠0 with an empty stdout — never exit 0 with an error object, which the bridge would sign onto its ledger as a genuine answer.

Success stdout (one line): `{reply, replyDigest, governed:true, model, stopReason, correlationId, turnCount, turns:[{turnIndex, correlationId, stages:[{stage,status,reason?}]}], ledger:{path, entries:[{turnIndex, correlationId, signedAt, keyId?}], publicKey}}`. `correlationId` is the W3C traceparent that joins the reply to its ledger line. With `--reply-schema` the envelope additionally carries, flat and after those: `replySchema, position, argument, cited_docs:[…], dissent_with:[…], confidence, groundingConformance:{ok, verdict:"ALLOW"|"N/A", reason}` and, for `deliberate-synthesis` only, `coverage:[{persona, position_restated, argument_words_seen}]` (always present there, `[]` when the model omitted it). `reply` stays the raw model text and `replyDigest` its digest, so the parse can be re-derived from the bytes. Without the flag not one of these keys is emitted — the envelope is byte-identical to before.

**`--reply-schema` (Sunstone Atlas [#390](https://github.com/exoreaction/Sunstone-Atlas/issues/390) G3/G4).** Relocates the gateway's deliberate-mode reply contract to this side of the process edge, ported from `gateway/src/gateway.mjs` (`DELIBERATE_SYSTEM`, `parseJson`, `sanitizeJsonControlChars`, `sanitizeCoverage`, `runDeliberateAgent`) and `gateway/src/conformance.mjs` (`checkGroundingCitations`) @ Atlas `743f075`; the port lives in `src/wrapper-deliberate.ts`. What it does:

- **Prompt.** The caller's `--persona` + `--grounding` text (joined `\n\n`, in that order — the analogue of the gateway's `groundingText(policy)`: charter, then `[doc:<id>]` blocks) is wrapped in the gateway's own `DELIBERATE_SYSTEM` scaffold, verbatim: `tests/wrapper-cli.test.ts` pins `deliberateSystemPrompt()` byte-for-byte against `tests/fixtures/gateway-deliberate-system.reference.mjs`, a `sed`-extracted copy of the gateway constant. `hasGrounding` (which gates the `cited_docs` instruction line) is "any `--grounding-doc-ids` declared"; `isSynthesis` is `deliberate-synthesis` — the two values mirror the gateway's `mode` vocabulary (`"deliberate"` / `"deliberate-synthesis"`) rather than adding a separate boolean. The whole thing is handed to Pi as one `systemPrompt`; Pi itself still appends its `Current date:` / `Current working directory:` trailer (and any `AGENTS.md` context files in `--cwd`), so the prompt the *model* sees is the gateway's plus that trailer — relevant if you compare the two paths.
- **Parse.** The first `{…}` span of the reply, control-character-sanitized exactly as the gateway does (a live-observed ~1-in-20 Sonnet quirk; without it the wrapper would refuse far more often than the gateway on identical output). Then shape-checked: `position`/`argument` non-empty strings, `confidence` a number in `[0,1]`, `cited_docs`/`dissent_with` arrays of strings when present (absent ⇒ `[]`). Anything else is exit 3 with `rawTextHead2000=` on stderr, mirroring the gateway's fail-safe that treats unparseable output as a refusal, never a coerced position. **Stricter than the gateway on one axis, deliberately:** the gateway reads `position`/`argument`/`confidence` off the object as-is and coerces a non-array `cited_docs` to `[]`; a wrapper whose stdout is bound into later steps (`steps.<id>.argument`, typed by Atlas's `DELIBERATE_JUDGMENT_OUTPUT_FIELDS`) refuses a missing or mistyped field instead. `coverage` is sanitized the gateway's way (entries without a `persona` dropped, wrong-typed sub-fields defaulted) and never refused over.
- **Citations.** `--grounding-doc-ids a,b` declares the bare ids the grounding text carries; a citation must be exactly `doc:<id>` (the gateway's `policy.grounding[].id` → `doc:` convention; passing `doc:a` here is a usage error). Any cited id not in the set is a fabricated citation → exit 3, naming it. `--citation-required` (the charter's `citation_required`) also refuses an empty `cited_docs`. With no doc ids declared, citations are `N/A` and not checked — exactly the gateway's `hasGrounding=false` path — so `--citation-required` without a non-empty `--grounding-doc-ids` is a usage error (every reply would be refused), as are `--grounding-doc-ids`/`--citation-required` without `--reply-schema`: a bridge config author who wrote them believes conformance is on, and silently ignoring them would be the hidden gap this closes. `--citation-required` is a bare flag — fixed in the bridge argv template, never a substituted `{param}`, so it stays inside the template rules.
- **Ordering.** The reply contract is checked last: an ungoverned turn is exit 1 and a ledger failure exit 4 even when the reply is perfect; a refused reply's turn is still signed onto the ledger, as the gateway signs an `outcome:"refuse"` receipt.

Isolation: in-memory auth/settings/session, an empty throwaway agent dir (no global extensions, skills, prompts or themes), `noExtensions` (pi-kcp is the only extension; project `.pi/skills` still load), no tools unless `--tools`, compaction off, the model turn aborted at `--timeout-ms` (default 50 s, under the bridge's fixed 60 s SIGKILL) so the ledger still flushes. The bridge's `expected_sha256` pin covers `exec.command` only (`/usr/bin/node` here), not the script — pinning the wrapper itself would need it packaged as a single executable, which this does not do yet.

**Verification status.** The automated tests (`tests/wrapper-cli.test.ts`, `tests/wrapper-pi-driver.test.ts`) run the real `register()`, `GovernedLoop`, `HarnessConformanceChecker` and signed-ledger hook against a fake Pi, and build the real Pi SDK session with pi-kcp loaded — but they never call a model (no key in CI). Two hand runs of the built artifact under `/usr/bin/node` in an `env -i` shell close that gap:

- **Placeholder key**: Pi built the session, the provider answered 401, the governed turn record was signed to the ledger and verified offline, exit 3.
- **Real key, 2026-09-27**: a genuine exit **0**. `governed:true`, `stopReason:"stop"`, a real assistant reply from `anthropic/claude-sonnet-4-5`, `replyDigest` independently re-derived from the raw reply text (`digest()` from `evidence.ts` — `sha256(JSON.stringify(reply))`, not a raw hash — and confirmed byte-for-byte) and one ledger line that `verifyLedgerFile()` reports `valid: true` against the run's own embedded public key. **The success path is now observed, not just designed.**

To reproduce (needs a real provider key exported as `$KEY`):

```bash
bun run build
mkdir -p /tmp/persona-ws/.pi && echo '{"enabled":true,"autoRecall":false,"governance":"tool"}' > /tmp/persona-ws/.pi/kcp.json
bun -e 'import {DEMO_SIGNING_KEY_PEM} from "./src/wallet.ts"; await Bun.write("/tmp/persona-demo.pem", DEMO_SIGNING_KEY_PEM)'   # demo key — replace in production
env -i PERSONA_KEY="$KEY" /usr/bin/node "$PWD/dist/src/wrapper-cli.js" \
  --prompt "Answer in one sentence: should we ship on Friday?" --cwd /tmp/persona-ws \
  --model anthropic/claude-sonnet-4-5 --signing-key /tmp/persona-demo.pem \
  --ledger /tmp/persona-ledger.jsonl --api-key-env PERSONA_KEY --key-id smoke; echo "exit=$?"
# expect: exit=0, one JSON line on stdout with "governed":true, one verifiable line in /tmp/persona-ledger.jsonl
bun -e 'import {verifyLedgerFile} from "./src/signed-ledger.ts"; console.log(await verifyLedgerFile("/tmp/persona-ledger.jsonl"))'
```

Still open: `governance:"full"` mode is untested under real Pi (only `"tool"` mode has a real-key run); no automated test covers the real-Pi → real-`GovernedLoop` → ledger link end-to-end, only these manual runs prove it.

`--reply-schema` verification status (2026-09-27): **fake-Pi tests only, no real-key run yet.** 20 tests in `tests/wrapper-cli.test.ts` cover the prompt parity against the extracted gateway fixture, a valid reply passing through as flat fields, prose-wrapped and raw-LF replies parsing, non-JSON/truncated/mistyped replies refused with exit 3 and the turn still on the ledger, a fabricated citation refused, `--citation-required` refusing an empty list, synthesis `coverage` sanitization, exit-code precedence, and a regression test that the default path emits exactly the legacy nine keys in the legacy order with no scaffold in the prompt. The built artifact was run under `/usr/bin/node` in an `env -i` shell for the new usage paths (exit 2, before any credential is read). Not yet observed: a real model answering the deliberate scaffold through this wrapper — that is the P2b "M" arm #390 §5 describes, and it has not been run.

`env -i` matters: it reproduces the bridge's stripped child environment (no `PATH`, no `HOME`). Note that Pi's in-memory auth still falls back to `ANTHROPIC_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` from the process env when no override is injected; under the bridge those are absent, and the wrapper always injects the `--api-key-env` value as a runtime override, which outranks the fallback.

## MCP configuration

Pi should continue to expose KCP and code-intelligence servers through `.pi/mcp.json`. Keep those servers lazy and avoid direct tool injection unless there is a deliberate reason to expose every tool in the prompt.

Note that stock Pi ships without an MCP client, so `.pi/mcp.json` takes effect only once an MCP client extension is installed (for example `pi install npm:pi-mcp-adapter`). This extension does not depend on MCP: `/kcp` commands and automatic recall work on stock Pi.

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
