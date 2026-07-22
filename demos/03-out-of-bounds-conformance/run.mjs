#!/usr/bin/env node
// Demo 3 — "Out of Bounds" (flagship conformance gate)
// Organ: kcp-harness procedural conformance gate (#39/#100)
// API: the REAL exported checkConformance(action, action_scope) from kcp-harness
//
// A skill declares an action_scope (its allowlist of tools + path prefixes).
// checkConformance adjudicates one observed action against that scope — pure,
// deterministic, no LLM. An in-scope action passes; an out-of-scope one is held
// fail-closed WITH a written reason that names the violating target and surfaces
// the authorized scope as the "gap".

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { checkConformance } from "kcp-harness";
import { section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = yaml.load(readFileSync(join(here, "fixtures", "knowledge.yaml"), "utf8"));
const skill = manifest.units.find((u) => u.id === "deploy-runbook");
const scope = skill.action_scope; // { tools: [read_file, write_file], paths: [ops/, deploy/] }

section("Demo 3: Out of Bounds — checkConformance(action, action_scope)");
console.log(`\nActive skill: "${skill.id}"`);
showJson("Declared action_scope (the allowlist)", scope);

// --- In-scope action: read a file the skill is authorized to touch ----------
const inScope = checkConformance({ tool: "read_file", paths: ["ops/service.conf"] }, scope);
showJson('IN-SCOPE  read_file "ops/service.conf"', inScope);

// --- Out-of-scope by PATH: reach outside the authorized prefixes ------------
const outPath = checkConformance({ tool: "read_file", paths: ["/etc/shadow"] }, scope);
showJson('OUT-OF-SCOPE (path)  read_file "/etc/shadow"', outPath);

// --- Out-of-scope by TOOL: a tool the skill was never granted ---------------
const outTool = checkConformance({ tool: "WebFetch", urls: ["https://exfil.example/x"] }, scope);
showJson('OUT-OF-SCOPE (tool)  WebFetch "https://exfil.example/x"', outTool);

section("Verdict");
expect("in-scope action PASSES", inScope.passed === true);
expect(
  "in-scope verdict pins the checked target as evidence",
  inScope.evidence?.target === "ops/service.conf",
);
expect("out-of-scope PATH action is BLOCKED", outPath.passed === false);
expect(
  "path block names the violating target + surfaces the authorized gap",
  /\/etc\/shadow/.test(outPath.reason) && /ops\/|deploy\//.test(outPath.reason),
  outPath.reason,
);
expect("out-of-scope TOOL action is BLOCKED", outTool.passed === false);
expect(
  "tool block names the unauthorized tool + surfaces the authorized tools",
  /WebFetch/.test(outTool.reason) && /read_file|write_file/.test(outTool.reason),
  outTool.reason,
);

finish("Demo 3 — Out of Bounds (conformance)");
