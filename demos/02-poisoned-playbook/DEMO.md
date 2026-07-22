# Demo 2 — The Poisoned Playbook

**Organ / verdict:** kcp-agent procedural plane · the **skill_eligibility** gate (#7).

## What it shows

Skills (procedures, `kind: skill`) **fail closed**. A `kind: skill` unit is
invoke-eligible only with an explicit `load_eligible: true` grant. The manifest
puts three procedures side by side:

- `deploy-playbook` — sanctioned (`load_eligible: true`).
- `poisoned-playbook` — an injected/untrusted procedure with **no** grant (and a
  dangerously broad `action_scope` it wishes it had).
- `retired-playbook` — once blessed, now `superseded_by` the sanctioned one.

The planner must admit only the sanctioned procedure and refuse the other two
**with written reasons**. This is the defense against a prompt-injected or
stale "playbook" smuggling itself into the agent's procedure set.

## Files

- `fixtures/knowledge.yaml` — the three competing skill units.
- `run.mjs` — runs the real `kcp-agent` planner in `--strict` (fail-closed) mode.

## Run it

```bash
cd demos
node 02-poisoned-playbook/run.mjs
```

Underlying tool command:

```bash
node node_modules/.bin/kcp-agent plan "deploy the service to production" \
  --manifest 02-poisoned-playbook/fixtures/knowledge.yaml --as-of 2026-07-22 --trace --strict
```

> `--strict` makes ineligible skills **drop** (fail-closed) rather than merely
> be listed — the same way the harness governor invokes the planner for a real
> skill invocation. Without `--strict` the poisoned unit is still not selected,
> but is listed with its reason instead of dropped.

## Step-by-step

1. **Plan the deploy task in `--strict` mode.** All three procedures score high
   on relevance.
2. **`skill_eligibility` gate fires.** `poisoned-playbook` is rejected:
   `kind: skill not invoke-eligible: no explicit eligibility grant`.
3. **`supersession` gate fires first for the retired one.** `retired-playbook`
   never reaches skill_eligibility — it's rejected earlier at supersession:
   `superseded by deploy-playbook (successor active)`.
4. **Only the sanctioned procedure survives.** `Load plan (1 unit): deploy-playbook`.
5. **Inspect the JSON.** `selected` = `["deploy-playbook"]`; both untrusted
   procedures appear in `skipped` with specific reasons.

## Expected governed output (real, captured)

```
Load plan (1 unit):
  ● 1. deploy-playbook (score 19)  playbooks/deploy.md  free

Skipped (2):
  · poisoned-playbook: kind: skill not invoke-eligible: no explicit eligibility grant
  · retired-playbook: superseded by deploy-playbook (successor active)

Gate summary:
  supersession     2 passed, 1 rejected
  skill_eligibility 1 passed, 1 rejected

● deploy-playbook (score 19) playbooks/deploy.md
  ✓ skill_eligibility kind: skill with explicit eligibility grant
○ poisoned-playbook (score 17) playbooks/poisoned.md
  ✗ skill_eligibility kind: skill not invoke-eligible: no explicit eligibility grant
○ retired-playbook playbooks/retired.md
  ✗ supersession     superseded by deploy-playbook (successor active)
```

JSON skip records:

```json
[
  { "id": "poisoned-playbook", "reason": "kind: skill not invoke-eligible: no explicit eligibility grant" },
  { "id": "retired-playbook",  "reason": "superseded by deploy-playbook (successor active)" }
]
```

Verdict:

```
  ✔ sanctioned deploy-playbook admitted
  ✔ poisoned playbook NOT admitted
  ✔ poisoned playbook skipped fail-closed WITH reason
  ✔ retired (superseded) playbook NOT admitted
  ✔ retired playbook skipped WITH reason
✅ Demo 2 — Poisoned Playbook: ALL CHECKS GREEN
```
