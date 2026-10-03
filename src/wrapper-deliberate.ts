/**
 * `--reply-schema deliberate` — the structured-reply contract of Sunstone Atlas's deliberate-mode
 * persona dispatch, relocated to the wrapper's side of the process edge (issue
 * exoreaction/Sunstone-Atlas#390, gaps G3 "no structured reply" and G4 "no citation conformance").
 *
 * Reference: `gateway/src/gateway.mjs` (`DELIBERATE_SYSTEM`, `parseJson`,
 * `sanitizeJsonControlChars`, `sanitizeCoverage`, `runDeliberateAgent`) and
 * `gateway/src/conformance.mjs` (`checkGroundingCitations`) in exoreaction/Sunstone-Atlas @
 * `743f075` (main, 2026-09-27). Everything below is a port of that source, not a re-design:
 *
 *   - {@link deliberateSystemPrompt} is `DELIBERATE_SYSTEM` byte-for-byte (tests pin it against a
 *     verbatim copy). The gateway wraps `groundingText(policy)` — the charter plus its `[doc:<id>]`
 *     blocks — in a fixed scaffold; here the wrapper wraps the caller's `--persona` + `--grounding`
 *     text in the SAME scaffold, so a caller who hands over the same `g` gets the same prompt.
 *   - {@link parseModelJson} is the gateway's `parseJson`: first `{…}` span, raw control characters
 *     inside string literals re-escaped (a live-observed ~1-in-20 Sonnet quirk — without this the
 *     wrapper would refuse far more often than the gateway on identical model output, which would
 *     confound any comparison of the two paths).
 *   - {@link checkGroundingCitations} is `conformance.mjs`'s function with the same verdict
 *     vocabulary (`ALLOW`/`DENY`/`N/A`), pointed at the caller's `--grounding-doc-ids` instead of
 *     `policy.grounding`. `doc:<id>` is the citation convention on both sides.
 *   - {@link sanitizeCoverage} is the gateway's: drop malformed entries, never refuse over them.
 *
 * Where this is STRICTER than the gateway, deliberately: the gateway reads `d.position`,
 * `d.argument`, `d.confidence` off the parsed object as-is and coerces a non-array
 * `cited_docs`/`dissent_with` to `[]`. A wrapper whose stdout is bound into later playbook steps
 * (`steps.<id>.argument`, typed `string` by `DELIBERATE_JUDGMENT_OUTPUT_FIELDS` in
 * `canvas/src/validate.mjs`) must not emit a missing or mistyped field as if it were a governed
 * answer, so {@link parseDeliberateReply} fails closed on a wrong-typed field. Absent optional
 * arrays still default to `[]`, matching the gateway.
 */

export type ReplySchema = "deliberate" | "deliberate-synthesis";

export const REPLY_SCHEMAS: readonly ReplySchema[] = ["deliberate", "deliberate-synthesis"];

// ── DELIBERATE_SYSTEM, verbatim ──────────────────────────────────────────────────────────────
// gateway.mjs:384-395. `hasGrounding` and `isSynthesis` each gate their own text and are
// byte-identical-when-false, exactly as in the source. Do not "improve" the wording here: the
// point is that a future dispatch comparison sees the same prompt on both paths.

/**
 * The gateway's `DELIBERATE_SYSTEM(g, hasGrounding, isSynthesis)`. `g` is the persona's own
 * charter/grounding text (the gateway's `groundingText(policy)`); the fixed scaffold surrounds it.
 */
export const deliberateSystemPrompt = (g: string, hasGrounding = false, isSynthesis = false): string => `You are a GOVERNED deliberation agent taking part in a multi-persona panel discussion. Ground EVERY claim ONLY in the policy/charter below — never use outside knowledge. You may ARGUE a position; you can NEVER execute, write, grant, delete, or act.

${g}

State and argue your position on the question below. Respond with ONLY a JSON object (no prose, no code fence):
{"position":"<your stance, one short phrase or sentence>","argument":"<your reasoning — aim for well under 400 words; be substantive, not padded>","cited_docs":[${hasGrounding ? `"<doc:id, one per GROUNDING DOCUMENT you actually relied on — omit or leave empty if none>"` : ""}],"dissent_with":["<if the request names another persona's stated position you disagree with, name it and the specific fact/trade-off you disagree on — omit or leave empty if none, or if this is round 1>"],"confidence":<0..1>${isSynthesis ? `,"coverage":[{"persona":"<exactly as that persona is named in the facts above>","position_restated":"<your own paraphrase of the position they took>","argument_words_seen":<the actual word count of the argument text you were given for them — count it, do not estimate>}]` : ""}}

Conduct:
- Ground every load-bearing claim in the policy/grounding above; never invent a fact.
- Argue for your own role's position honestly — do not soften it into consensus just because other positions are in front of you.
- confidence = how well-supported your OWN position is by what you were given (1.0 strong; <0.5 weak).
- dissent_with: disagree on a specific fact or value trade-off, never on tone alone; the reader should be able to say what would change your mind.${hasGrounding ? `\n- cited_docs: list ONLY doc:<id> values that literally appear under GROUNDING DOCUMENTS above — never invent one, and never cite a document your argument didn't actually depend on.` : ""}${isSynthesis ? `\n- coverage: report exactly ONE entry per persona whose position/argument appears in the facts you were given above — never skip one, never invent one that isn't there.\n- The bound facts given to you are complete and were NOT truncated. Never assert that a persona's argument was cut off, shortened, or missing — if you are unsure whether you have seen everything, say so as an explicit caveat inside your own argument text, never state it as settled fact.` : ""}`;

// ── parseJson, verbatim ──────────────────────────────────────────────────────────────────────
// gateway.mjs:314-338. Walks the matched JSON text with JSON's own string/escape state machine
// and re-escapes any RAW control character strictly inside a string literal. Never touches
// anything outside a string, never touches an already-escaped sequence.
const CONTROL_ESCAPES: Record<number, string> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };

export function sanitizeJsonControlChars(s: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      const code = s.charCodeAt(i);
      if (code < 0x20) { out += CONTROL_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`; continue; }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/** The gateway's `parseJson(text)`: the first `{…}` span of the model text, control-char-sanitized. */
export function parseModelJson(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in model output");
  return JSON.parse(sanitizeJsonControlChars(m[0]));
}

// ── The parsed reply ─────────────────────────────────────────────────────────────────────────

export interface CoverageEntry {
  persona: string;
  position_restated: string;
  argument_words_seen: number;
}

/** The deliberate reply as the wrapper emits it — field names as the model produced them. */
export interface DeliberateReply {
  position: string;
  argument: string;
  cited_docs: string[];
  dissent_with: string[];
  confidence: number;
  /** Present (possibly `[]`) only for `deliberate-synthesis`. */
  coverage?: CoverageEntry[];
}

/** Thrown when the model's text is not a usable deliberate reply. The turn ran; its output is refused. */
export class DeliberateReplyError extends Error {}

/** gateway.mjs:512-523 — `persona` is required, malformed entries are dropped, never refused over. */
export function sanitizeCoverage(arr: unknown): CoverageEntry[] {
  if (!Array.isArray(arr)) return [];
  const out: CoverageEntry[] = [];
  for (const e of arr) {
    if (e && typeof e === "object" && typeof (e as { persona?: unknown }).persona === "string" && (e as { persona: string }).persona) {
      const entry = e as { persona: string; position_restated?: unknown; argument_words_seen?: unknown };
      out.push({
        persona: entry.persona,
        position_restated: typeof entry.position_restated === "string" ? entry.position_restated : "",
        argument_words_seen: typeof entry.argument_words_seen === "number" && Number.isFinite(entry.argument_words_seen) ? entry.argument_words_seen : 0,
      });
    }
  }
  return out;
}

function stringArrayField(obj: Record<string, unknown>, field: string): string[] {
  const value = obj[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new DeliberateReplyError(`${field} is not an array`);
  for (const [i, entry] of value.entries()) {
    if (typeof entry !== "string") throw new DeliberateReplyError(`${field}[${i}] is not a string`);
  }
  return value as string[];
}

/**
 * Parse and shape-check one raw model reply against the deliberate contract. Fails closed
 * ({@link DeliberateReplyError}) on: no JSON object, unparseable JSON, a non-object, a missing or
 * empty `position`/`argument`, a `confidence` outside `[0, 1]`, or a `cited_docs`/`dissent_with`
 * that is present but not an array of strings. `coverage` is only read (and only emitted) for
 * `deliberate-synthesis`, sanitized the gateway's way.
 */
export function parseDeliberateReply(text: string, schema: ReplySchema): DeliberateReply {
  let parsed: unknown;
  try {
    parsed = parseModelJson(text);
  } catch (error) {
    throw new DeliberateReplyError(`model output unparseable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DeliberateReplyError("model output is not a JSON object");
  const obj = parsed as Record<string, unknown>;
  const { position, argument, confidence } = obj;
  if (typeof position !== "string" || position.trim() === "") throw new DeliberateReplyError("position is missing or not a non-empty string");
  if (typeof argument !== "string" || argument.trim() === "") throw new DeliberateReplyError("argument is missing or not a non-empty string");
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new DeliberateReplyError(`confidence is not a number in [0, 1] (got ${JSON.stringify(confidence)})`);
  }
  return {
    position,
    argument,
    cited_docs: stringArrayField(obj, "cited_docs"),
    dissent_with: stringArrayField(obj, "dissent_with"),
    confidence,
    ...(schema === "deliberate-synthesis" ? { coverage: sanitizeCoverage(obj.coverage) } : {}),
  };
}

// ── checkGroundingCitations, verbatim ────────────────────────────────────────────────────────

export interface GroundingConformance {
  ok: boolean;
  verdict: "ALLOW" | "DENY" | "N/A";
  reason: string;
}

/**
 * `conformance.mjs:70-83`. `groundingDocIds` are the bare ids (the gateway's `policy.grounding[].id`);
 * a citation must be exactly `doc:<id>`. An empty list under `required` is a `DENY`; an empty list
 * otherwise is `N/A`; any id not backed by a provided document is a `DENY` naming the fabrications.
 */
export function checkGroundingCitations(citations: unknown, groundingDocIds: readonly string[], { required = false } = {}): GroundingConformance {
  if (!Array.isArray(citations) || citations.length === 0) {
    if (required) {
      return { ok: false, verdict: "DENY", reason: "the charter requires every decision to cite at least one grounding document (citation_required), and this decision cited none" };
    }
    return { ok: true, verdict: "N/A", reason: "no grounding citations to verify" };
  }
  const validIds = new Set(groundingDocIds.filter((id) => typeof id === "string" && id).map((id) => `doc:${id}`));
  const fabricated = citations.filter((c) => !validIds.has(c));
  if (fabricated.length > 0) {
    return { ok: false, verdict: "DENY", reason: `citation(s) not backed by a grounding document actually provided in this request: ${fabricated.join(", ")}` };
  }
  return { ok: true, verdict: "ALLOW", reason: "every grounding citation matches a document actually provided" };
}

/** The gateway's `groundingConf` when the policy has no grounding documents (`hasGrounding` false). */
export const NO_GROUNDING_CONFORMANCE: GroundingConformance = { ok: true, verdict: "N/A", reason: "policy has no grounding documents" };
