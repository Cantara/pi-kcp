# Automatic recall evaluation

The recall corpus in `tests/recall-quality.test.ts` contains generic development prompts only. It deliberately does not contain private session transcripts, project names, or user data.

Current thresholds:

- precision: at least 0.90 on the checked-in corpus;
- recall: at least 0.90 on the checked-in corpus;
- signal classification: under 50 ms for 10,000 fixture evaluations;
- injected memory block: at most 12,000 UTF-8 bytes.

The corpus is a regression guard, not a claim that regex classification is universally correct. When a real false positive or false negative is found, anonymize the wording and add a fixture. If the desired behavior is ambiguous, discuss it before changing the threshold or signal rules.
