# kcp-skill conformance vectors (vendored)

Source: https://github.com/Cantara/kcp-skill `vectors/` at **v0.1.0**.

Canonical fixtures for producers/consumers of governed `kind: skill`
units. The `expected.json` verdicts are the linter's contract;
`tests/skill-vectors.test.ts` runs this EXTENSION's semantics — scope
resolution via ManifestScopeResolver and enforcement via
HarnessConformanceChecker (kcp-harness checkConformance) — over the
same manifests, so drift between what kcp-skill blesses and what this
extension enforces fails CI.

To re-sync after a kcp-skill release:
  cp -r <kcp-skill checkout>/vectors/. tests/fixtures/kcp-skill-vectors/
and update the version above.
