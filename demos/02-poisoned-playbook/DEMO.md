# Demo 2 — The Poisoned Playbook

**Organ / verdict:** kcp-agent procedural plane · the **skill_eligibility** gate (#7).

## What it shows

Skills (procedures, `kind: skill`) **fail closed**. A `kind: skill` unit is
invoke-eligible only with an explicit `load_eligible: true` grant. The manifest
puts three procedures side by side:

- `deploy-procedure` — sanctioned (`load_eligible: true`).
- `poisoned-procedure` — an injected/untrusted procedure with **no** grant (and a
  dangerously broad `action_scope` it wishes it had).
- `retired-procedure` — once blessed, now `superseded_by` the sanctioned one.

The planner must admit only the sanctioned procedure and refuse the other two
**with written reasons**. This is the defense against a prompt-injected or
stale procedure smuggling itself into the agent's procedure set.

> **Naming note.** These units are `kind: skill`, not `kind: playbook`. Each is a single
> procedure with one `action_scope`, and §4.3b's rule of thumb is that steps sitting
> inside one scope belong there as prose — only steps that *span units* with different
> authority requirements are a playbook. The units were once named `*-playbook`, which
> since KCP v0.29 claims a kind they are not. For a genuine composition see
> [Demo 15 — The Governed Composition](../15-governed-composition/DEMO.md).

## Files

- `fixtures/knowledge.yaml` — the three competing skill units.
- `run.mjs` — runs the real `kcp-agent` planner in `--strict` (fail-closed) mode.

## Run it

```bash
cd demos
node 02-poisoned-procedure/run.mjs
```

Underlying tool command:

```bash
node node_modules/.bin/kcp-agent plan "deploy the service to production" \
  --manifest 02-poisoned-procedure/fixtures/knowledge.yaml --as-of 2026-07-22 --trace --strict
```

> `--strict` makes ineligible skills **drop** (fail-closed) rather than merely
> be listed — the same way the harness governor invokes the planner for a real
> skill invocation. Without `--strict` the poisoned unit is still not selected,
> but is listed with its reason instead of dropped.

## Step-by-step

1. **Plan the deploy task in `--strict` mode.** All three procedures score high
   on relevance.
2. **`skill_eligibility` gate fires.** `poisoned-procedure` is rejected:
   `kind: skill not invoke-eligible: no explicit eligibility grant`.
3. **`supersession` gate fires first for the retired one.** `retired-procedure`
   never reaches skill_eligibility — it's rejected earlier at supersession:
   `superseded by deploy-procedure (successor active)`.
4. **Only the sanctioned procedure survives.** `Load plan (1 unit): deploy-procedure`.
5. **Inspect the JSON.** `selected` = `["deploy-procedure"]`; both untrusted
   procedures appear in `skipped` with specific reasons.

## Expected governed output (real, captured)

```
Load plan (1 unit):
  ● 1. deploy-procedure (score 19)  playbooks/deploy.md  free

Skipped (2):
  · poisoned-procedure: kind: skill not invoke-eligible: no explicit eligibility grant
  · retired-procedure: superseded by deploy-procedure (successor active)

Gate summary:
  supersession     2 passed, 1 rejected
  skill_eligibility 1 passed, 1 rejected

● deploy-procedure (score 19) playbooks/deploy.md
  ✓ skill_eligibility kind: skill with explicit eligibility grant
○ poisoned-procedure (score 17) playbooks/poisoned.md
  ✗ skill_eligibility kind: skill not invoke-eligible: no explicit eligibility grant
○ retired-procedure playbooks/retired.md
  ✗ supersession     superseded by deploy-procedure (successor active)
```

JSON skip records:

```json
[
  { "id": "poisoned-procedure", "reason": "kind: skill not invoke-eligible: no explicit eligibility grant" },
  { "id": "retired-procedure",  "reason": "superseded by deploy-procedure (successor active)" }
]
```

Verdict:

```
  ✔ sanctioned deploy-procedure admitted
  ✔ poisoned playbook NOT admitted
  ✔ poisoned playbook skipped fail-closed WITH reason
  ✔ retired (superseded) playbook NOT admitted
  ✔ retired playbook skipped WITH reason
✅ Demo 2 — Poisoned Playbook: ALL CHECKS GREEN
```
