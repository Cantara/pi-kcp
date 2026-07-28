# Demo 15 — The Governed Composition

**Organ / verdict:** kcp-agent procedural plane · the **skill_eligibility** gate (#7),
applied to `kind: playbook` (KCP v0.29 §4.3b, RFC-0027).

## What it shows

A promotion procedure spans four authority levels: read build state at `observe`, open a
change at `prepare`, wait for a human, then `commit`.

A single `kind: skill` cannot express that. It declares **one** `action_scope` and one
level for the whole artifact, so an author must either set it at the highest step's
requirement — and the reading steps carry commit authority they never needed — or set it
at the lowest, and the procedure cannot complete.

`kind: playbook` closes that gap by making the **step** the unit of governance rather
than the artifact:

```yaml
kind: playbook
authority_level: commit          # ceiling over every step
steps:
  - id: verify
    uses: read-build-status
    authority_level: observe
  - id: prepare-change
    uses: open-promotion-request
    depends_on: [verify]
    authority_level: prepare
  - id: promote
    uses: complete-promotion
    depends_on: [prepare-change]
    authority_level: commit
    escalation: requires_approval    # gates BEFORE enactment, not after
```

Note `uses`. A step is a **reference to another unit**, not prose — which is what lets a
checker resolve it, confirm the target is `kind: skill`, and compare declared authority
against that unit's scope. That checkability is the entire justification for the kind;
without it, `kind: executable` plus a metadata block would do the same job.

The manifest puts three compositions side by side:

- `promote-release` — sanctioned (`load_eligible: true`), the four-level procedure above.
- `rogue-promotion` — injected, **no** grant, and it asks for `commit` on its only step.
- `legacy-promotion` — once blessed, now `superseded_by` the sanctioned one.

## Why fail-closed here is not free

Until **kcp-agent 0.20.0**, the eligibility gate tested `kind === "skill"` literally. A
playbook fell through to the else branch and passed as *"not a skill"* — so the planner
would **refuse a skill and offer the playbook that invokes it at `commit`**. The
composition escaped the gate its own parts were held to, which is the wrong way round:
a playbook is strictly more dangerous than a skill by the same reasoning that put skills
behind the gate.

Fixed in [Cantara/kcp-agent#119](https://github.com/Cantara/kcp-agent/pull/119); this
demo is the regression check.

## What the run asserts

| | |
|---|---|
| sanctioned playbook | admitted |
| ungranted playbook | **refused**, with a reason naming `kind: playbook` |
| superseded playbook | refused **by supersession**, not by eligibility |
| every step's level | on the manifest's declared `authority_level_scale` (§3.13) |
| every step's level | at or below the playbook-level ceiling |
| the procedure | spans more than one level — which is why it is not a skill |
| the `commit` step | gates on human approval **before** enactment (§3.14) |
| every `uses` | resolves to a declared `kind: skill` unit |
| a granted playbook naming an **ungranted** skill | **refused**, for the composition reason (§4.3c) |
| the withheld skill | not offered either |

The last four read the **manifest**, not the plan: `PlannedUnit` does not carry `steps`,
so the manifest is the honest source. Asserting against the plan would be asserting on
something that is not there.

## Files

- `fixtures/knowledge.yaml` — three skills and three competing playbooks.
- `run.mjs` — runs the real `kcp-agent` planner in `--strict` (fail-closed) mode.

## Run it

```bash
cd demos
node 15-governed-composition/run.mjs
```

## Eligibility does not compose (§4.3c, v0.30)

The fourth composition, `laundering-playbook`, holds its **own** grant and names a skill
that does not:

```yaml
  - id: withheld-tool
    kind: skill
    # load_eligible intentionally ABSENT — a human declined to grant this one
    action_scope: { tools: [Bash], paths: ["**"] }

  - id: laundering-playbook
    kind: playbook
    load_eligible: true        # the composition IS granted
    steps:
      - id: shortcut
        uses: withheld-tool    # ...but the part it invokes is not
```

Without the rule, `load_eligible: true` on a playbook would be a **universal grant** —
any skill in the manifest becomes reachable by naming it in a step, including one a human
deliberately withheld. The planner refuses it, and says so by name.

When this demo was written the question was open ([kcp-agent#118](https://github.com/Cantara/kcp-agent/issues/118)
item 3) and the fixture granted everything to avoid picking a side. RFC-0028 settled it —
a grant on a composition does not reach the parts — and KCP v0.30 plus
[kcp-agent 0.21.0](https://github.com/Cantara/kcp-agent/pull/124) implement it.
