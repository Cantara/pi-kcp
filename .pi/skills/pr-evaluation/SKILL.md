---
name: pr-evaluation
description: Run independent, provenance-aware PR evaluations for pi-kcp with Pi Minimax M3. Use after creating or updating a PR, especially when judging linked issue value, tests, correctness, and scope.
---

# PR evaluation

## Standard command

From the repository root:

```bash
bun run pr-eval -- <PR> [<PR> ...]
```

The script defaults to `opencode/minimax-m3`, captures the linked issue and current PR diff, and requires the evaluator to end with `VERDICT: APPROVE` or `VERDICT: REQUEST-CHANGES`.

To post the report as a PR comment:

```bash
bun run pr-eval -- <PR> --comment
```

Override provider/model only deliberately:

```bash
bun run pr-eval -- <PR> --provider opencode --model minimax-m3
```

## Evaluation boundary

The evaluator is independent of the authoring turn. It receives the current diff and linked issue artifacts. It must judge:

1. value — the right problem, real tests, no dead scaffolding;
2. correctness — logic, types, subprocess/network safety, error handling, docs;
3. scope — focused and self-contained.

A verdict is advisory. This script does not merge PRs and does not hand-apply governance labels.

## Interpretation

- `APPROVE`: record the report; CI and human review still matter.
- `REQUEST-CHANGES`: fix only in-scope defects, push the same PR branch, then rerun the evaluation.
- Missing verdict or evaluator failure: treat as an operational failure, not approval.

Keep evaluator output with the PR comment when `--comment` is used. Do not summarize away material findings.
