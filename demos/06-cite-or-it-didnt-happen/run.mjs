#!/usr/bin/env node
// Demo 6 — "Cite or it didn't happen" (grounding)
// Organ: kcp-agent's grounding gate — the REAL exported groundAnswer(task, answer, units, {verifier})
// API: groundAnswer + GroundUnit {id, sha256, content}; verifiers are injectable
//      (deterministic here; a live model verifier via makeVerifier() only when a key is set).
//
// The planner decides what may be *loaded*; grounding decides what may be *asserted*.
// Each sentence of a synthesized answer must be attributed to a LOADED, hash-pinned unit
// or it is surfaced as an explicit gap. Attribution is a *proposal* (an LLM in production,
// a scripted verifier here); membership + the sha pin are *adjudicated* deterministically —
// so a verifier that cites a unit that was never loaded can never ground a claim.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { groundAnswer, makeVerifier } from "kcp-agent";
import { section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// --- 1. Load the units the agent was allowed to load, hash-pinned ------------
const manifest = yaml.load(readFileSync(join(here, "fixtures", "knowledge.yaml"), "utf8"));
const loaded = manifest.units.map((u) => {
  const content = readFileSync(join(here, "fixtures", u.path), "utf8");
  return { id: u.id, sha256: sha256(content), content };
});

section("Demo 6: Cite or it didn't happen — groundAnswer(task, answer, loadedUnits, { verifier })");
console.log("\nLoaded, hash-pinned units (the only things a claim may cite):");
for (const u of loaded) console.log(`  ${u.id.padEnd(20)} sha256:${u.sha256.slice(0, 16)}…`);

const task = "Summarize the key-rotation cadence, SEV-1 handling, and compliance posture.";

// A synthesized answer. Two sentences are supported by loaded units; the third
// (a compliance claim) is supported by NO loaded unit — the honest gap.
const answer = [
  "Production API keys are rotated every 90 days.",
  "A SEV-1 incident pages the on-call SRE immediately.",
  "The platform is certified SOC 2 Type II as of 2026.",
].join(" ");
console.log(`\nSynthesized answer under audit:\n  "${answer}"`);

// --- 2. A deterministic, scripted verifier -----------------------------------
// Honest token-overlap: it proposes the loaded unit that shares the claim's
// distinctive tokens (nothing is hardcoded per-claim). It can only ever NAME a
// unit id — grounding membership + the sha pin are adjudicated by groundAnswer.
const STOP = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "as", "on", "in", "every", "by", "for"]);
const toks = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)));
function scriptedVerifier() {
  return async ({ claim, units }) => {
    const c = toks(claim);
    let best = null;
    let bestOverlap = 0;
    for (const u of units) {
      const ut = toks(u.content);
      let overlap = 0;
      for (const t of c) if (ut.has(t)) overlap++;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = u.id; }
    }
    // Require a real majority of the claim's distinctive tokens to be present —
    // tangential overlap is not support (fail-closed on weak matches).
    return bestOverlap >= Math.max(2, Math.ceil(c.size * 0.5))
      ? { supportedBy: best }
      : { supportedBy: null, note: "no loaded unit covers this claim" };
  };
}

// --- 3. Deterministic adjudication (always runs) -----------------------------
const detVerdict = await groundAnswer(task, answer, loaded, { verifier: scriptedVerifier() });
showJson("Deterministic grounding verdict (scripted verifier)", {
  status: detVerdict.status,
  grounded: detVerdict.grounded.map((c) => ({ claim: c.claim, unitId: c.unitId, sha256: c.sha256.slice(0, 16) + "…" })),
  gaps: detVerdict.gaps,
});

// --- 4. Fail-closed: a verifier that cites an UNLOADED unit grounds nothing ---
const compromised = async () => ({ supportedBy: "ghost-unit" }); // never in the loaded set
const failClosed = await groundAnswer(task, "Production API keys are rotated every 90 days.", loaded, {
  verifier: compromised,
});
showJson("Fail-closed: verifier cites 'ghost-unit' (never loaded)", {
  status: failClosed.status,
  claims: failClosed.claims,
});

// --- 5. Live model verifier — ONLY when a key is present ----------------------
const liveKey = process.env.ANTHROPIC_API_KEY;
let liveVerdict;
if (liveKey) {
  section("Live verifier (ANTHROPIC_API_KEY set) — a real model call adjudicated the same way");
  const liveVerifier = makeVerifier(process.env.KCP_GROUND_MODEL); // default claude-haiku-4-5
  liveVerdict = await groundAnswer(task, answer, loaded, { verifier: liveVerifier });
  showJson("Live grounding verdict", {
    status: liveVerdict.status,
    grounded: liveVerdict.grounded.map((c) => ({ claim: c.claim, unitId: c.unitId })),
    gaps: liveVerdict.gaps,
  });
} else {
  console.log("\n(ANTHROPIC_API_KEY not set — skipped the live model verifier; the deterministic");
  console.log(" adjudication above is the governed outcome. Set ANTHROPIC_API_KEY to also run a real model.)");
}

// --- 6. Verdict --------------------------------------------------------------
section("Verdict");
const rotated = detVerdict.claims.find((c) => /rotated every 90/.test(c.claim));
const sev1 = detVerdict.claims.find((c) => /SEV-1/.test(c.claim));
const soc2 = detVerdict.claims.find((c) => /SOC 2/.test(c.claim));

expect("answer is NOT fully grounded — a gap is surfaced, not swallowed", detVerdict.status === "partial-unsupported");
expect("the key-rotation claim grounds to a loaded unit", rotated?.grounded === true && rotated.unitId === "key-rotation");
expect("the grounded claim pins the unit's sha256 (citation is byte-pinned)",
  rotated?.sha256 === loaded.find((u) => u.id === "key-rotation").sha256);
expect("the SEV-1 claim grounds to the incident-severity unit", sev1?.grounded === true && sev1.unitId === "incident-severity");
expect("the unsupported compliance claim is a GAP (no loaded unit)", soc2?.grounded === false);
expect("exactly one gap surfaced", detVerdict.gaps.length === 1 && /SOC 2/.test(detVerdict.gaps[0].claim));
expect("fail-closed: a claim attributed to an unloaded unit does NOT ground",
  failClosed.status === "partial-unsupported" &&
  failClosed.claims[0].grounded === false &&
  /ghost-unit.*not loaded|not loaded.*fail-closed/.test(failClosed.claims[0].reason),
  failClosed.claims[0].reason);
if (liveKey) {
  expect("live verifier ran and produced a verdict over the same units", !!liveVerdict && Array.isArray(liveVerdict.claims));
}

finish("Demo 6 — Cite or it didn't happen (grounding)");
