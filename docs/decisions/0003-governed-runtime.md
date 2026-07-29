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
3. **Evidence integrity.** Record what was *actually* sent — post-injection context,
   post-mutation tool input — not what was planned. `correlationKey()` already joins the
   hops; this fills them in.
4. **Procedural depth (#28).** Gate skill selection through the planner's 13 gates; drop the
   conformance `ScopeResolver`'s re-read of `knowledge.yaml` now that `action_scope` reaches
   `plan --json`.

## Consequences

- pi-kcp is on the critical path of every turn in its host. Latency and correctness are ours.
- A silent gate becomes a testable defect rather than an invisible one.
- The seven stages become one sequence with one evidence spine, which is what #26 asks for.
