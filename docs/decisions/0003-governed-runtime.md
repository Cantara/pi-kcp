# 0003 — pi-kcp as a governed runtime

**Status:** accepted
**Date:** 2026-07-29
**Issues:** #26, #27, #28, #29

## Context

`GovernedLoop.orchestrate()` runs recall → plan → publish: two of the seven stages #27
describes. The rest exist as methods (`evaluateToolCall`, `pay`, `observeInput`) that Pi's
event handlers call independently. Nothing sequences them, so there is no *loop* — there are
ergonomic entry points.

pi-kcp hooks 3 of Pi's 13 extension events: `turn_start`, `input`, `tool_call`.

The decision recorded here is that pi-kcp becomes a **runtime**, not a demonstrator: every
model call and tool call in the host flows through it, and it owns the resulting latency and
failure modes.

## The constraint that shapes everything

**Pi swallows handler exceptions.** Every dispatch site in
`@earendil-works/pi-coding-agent/dist/core/extensions/runner.js` (`:68`, `:539`, and ten
more) wraps handlers in `try`/`catch`, pushes to an `errors` array, and continues:

```js
try { const handlerResult = await handler(event, ctx); ... }
catch (error) { errors.push({ extensionPath, event: event.type, error: ... }); }
```

So **pi-kcp cannot fail closed by throwing.** A crashing gate does not stop the turn; it
produces a turn that completes *ungoverned and silent*. That is the same failure mode as a
green timer that publishes nothing — success reported, work not done.

Three consequences, and they are requirements, not preferences:

1. **Refusal is a return value.** `{ block: true, reason }` — never an exception.
2. **pi-kcp catches its own errors** so it can *record* them. An error that reaches Pi is an
   error that vanishes.
3. **An ungoverned turn must be detectable.** The absence of a stage decision is itself a
   fact the runtime records and can be asserted on. Silence is never evidence of governance.

## Stage → event mapping

Every stage anchors on a typed, documented Pi contract. `before_provider_request` is
explicitly *not* used: its payload and result are both `unknown` — an untyped escape hatch,
the wrong foundation for a runtime.

| Stage | Event | Mechanism |
|---|---|---|
| plan | `before_agent_start` | `prompt`, `systemPromptOptions` — inspect what Pi loaded without re-discovering it |
| load | `context` | `ContextEventResult.messages` — context replacement |
| synthesize | *(provider)* | not ours; Pi owns the model call |
| ground | `agent_end` | `messages` — claims against loaded units |
| assess | `turn_end` | `message`, `toolResults` |
| approve | `tool_call` | `{ block, reason }` — already built |
| act → observe | `tool_result` | `{ content, details, isError }` — closes the loop |

`before_agent_start` chains `systemPrompt` across extensions, so pi-kcp composes with other
Pi extensions rather than displacing them.

## Cost

`kcp-agent plan` against pi-kcp's own manifest: **57ms mean** over 5 runs (52–64ms), measured
2026-07-29 with kcp-agent 0.22.1. Against a 1–30s provider call this is noise. Per-turn
planning is affordable; caching is for determinism, not speed.

## Phases

1. **The loop runs.** *(done — #53)* A stage sequencer with a decision record per stage per
   turn. Adopt `before_agent_start`, `context`, `agent_end`, `turn_end`, `tool_result`
   (3 events → 8).
2. **Runtime posture.** *(done)* Explicit `block` for every refusal; governance-liveness
   assertions; a kill switch that disables governance loudly rather than by crashing.

   Phase 1 shipped the liveness signal, but `register()` built its loop with **no hooks** —
   so in the default path `onUngoverned` fired into nothing and an ungoverned turn was
   silent again. The default hooks are load-bearing, not decoration.

   `gateFailurePosture` decides what happens when the runtime's own gate breaks:
   `"announce"` (default) reports the lapse and keeps the host usable; `"block"` fails
   closed at `tool_call`, the only refusal Pi honours. `/kcp govern <on|off|status>` is the
   in-session switch, and turning governance *off* is announced — disabling a guarantee is
   a governance decision, not a preference.
3. **Evidence integrity.** *(done)* Record what was *actually* sent — post-injection
   context, post-mutation tool input — not what was planned.

   Pi hands `beforeToolCall` and `afterToolCall` the same args object and invites
   extensions to modify a call by mutating it in place, so a call can genuinely change
   between approval and execution. The `approve` stage digests the input the gate decided
   on, keyed by Pi's `toolCallId`; `act` digests what actually ran and compares. Divergence
   — or a call reaching `act` with no recorded approval — is `violated`, a fifth stage
   status meaning the gate decided and was not honoured.

   A violated turn is not a governed turn, and outranks a missing stage in the reason: a
   gate that was overridden is worse news than one that never reported.
4. **Procedural depth (#28).** *(done)* Gate skill selection through the planner's gates.

   The plan stage runs `kcp-agent plan --trace --json`, which adjudicates every declared
   unit against **14** gates — audience, not_for, temporal, deprecated, supersession,
   relevance, skill_eligibility, attestation, payment, access, strict, max_units,
   money_budget, context_budget — and reports a written verdict per gate. A skill whose
   unit failed one is refused with the planner's own words, before it shapes any action.
   "deprecated since 2026-01-01" is evidence; "skill not allowed" is not.

   A forced skill is selected at `input`, *before* the plan stage runs, so the verdict can
   arrive after the selection and must be able to revoke it. It can.

   A skill with no declared unit is admitted but recorded as `governed: false` — ordinary
   editor skills keep working, and "ungoverned" is never mistaken for "checked and fine".
   A missing trace (no kcp-agent, or one predating `--trace`) means *not gated*, not *gate
   broken*: an absent tool must not turn every turn into a governance failure.

   **Correction to an earlier claim in this document:** `action_scope` does **not** reach
   `plan --json`. Measured 2026-07-29 against kcp-agent 0.22.1: zero occurrences in the
   output, and none in pi-kcp's own `knowledge.yaml` either. `harness-conformance.ts` said
   so in its own module doc all along. The `ScopeResolver` keeps reading the manifest, and
   dropping that read stays open until the planner exposes scope.

   **Dogfooding (#28 point 3)** found a real gap: pi-kcp shipped `pr-evaluation` as a skill
   that was not a declared unit — an ungoverned procedure in the repo that defines the
   plane. Now declared.

## Consequences

- pi-kcp is on the critical path of every turn in its host. Latency and correctness are ours.
- A silent gate becomes a testable defect rather than an invisible one.
- The seven stages become one sequence with one evidence spine, which is what #26 asks for.
