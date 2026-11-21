/**
 * `pi-kcp persona-turn` — one governed Pi turn as a bridge-shaped subprocess.
 *
 * Sunstone Atlas's bridge dispatches a persona-panel turn to a *process-transport* tool: it
 * spawns `exec.command exec.args… tools[id].argv…` with a stripped environment, buffers stdout,
 * and accepts the result only when the process exits 0 AND stdout is exactly one JSON object.
 * This module is that process for pi-kcp: it drives a real Pi session in-process (Pi's SDK,
 * `createAgentSession` + an inline extension factory — the same path Pi's own `main` takes),
 * with pi-kcp registered as the *only* extension, for exactly one prompt, and persists the
 * turn's signed `TurnRecord` through {@link createFileLedgerHook} (#151).
 *
 * The contract this file honours, item by item (from the bridge's `exec.mjs`/`bridge.mjs`):
 *
 *   - stdout is ONE `JSON.parse`-able OBJECT and nothing else — every diagnostic goes to stderr.
 *   - exit 0 is the only success; a failure is exit≠0 with stderr diagnostics, NEVER exit 0 with
 *     `{"error":…}` (that would be signed onto the ledger as a genuine answer).
 *   - stdin is never read (the bridge leaves it open and unended; a reader hangs until SIGKILL).
 *   - the child env is `{[token_env]: value}` only — no PATH/HOME — so every path is taken from
 *     argv, absolute, and the only env var consulted is `--api-key-env` (default
 *     `ANTHROPIC_API_KEY`). No credential ever appears in argv.
 *   - every `{param}` the bridge substitutes must follow a literal `--flag`, one argv element
 *     each; hence the flag-per-value CLI below (`--prompt {prompt}`, `--grounding {grounding}`).
 *   - hard ceiling 60 s wall clock, SIGKILL, no retry: the wrapper aborts the model turn itself
 *     at `--timeout-ms` (default 50 000) so the ledger still flushes before the bridge's kill.
 *
 * Exit codes: 0 governed turn, reply emitted · 1 turn completed but NOT governed (pi-kcp's own
 * `isGoverned`/`ungovernedReason`, runtime.ts — no second governedness check lives here) ·
 * 2 usage/configuration error, nothing was run (bad argv, unreadable key, credential unset,
 * unknown model) · 3 the model turn failed (Pi threw, or the assistant stopped with
 * `error`/`aborted`; under `--reply-schema`, also: the model answered but its reply does not
 * parse as the schema or cites a grounding document it was never given — the turn ran and was
 * paid for, so this is honestly a model-turn failure, never a usage error) · 4 the signed
 * ledger could not be persisted.
 *
 * `--reply-schema deliberate|deliberate-synthesis` (exoreaction/Sunstone-Atlas#390 G3/G4) is
 * opt-in and additive: the system prompt becomes the gateway's own `DELIBERATE_SYSTEM` scaffold
 * around the caller's persona/grounding text, the reply is parsed as the deliberate JSON shape,
 * `cited_docs` is checked against `--grounding-doc-ids` (and `--citation-required`), and the
 * parsed fields join the success envelope as flat fields NEXT TO `reply`. Absent the flag, every
 * byte of the existing behaviour is unchanged (see `wrapper-deliberate.ts`).
 *
 * The Pi driver is an injected seam ({@link PersonaTurnDriver}) for the same reason
 * `GovernedLoop` takes an injected wallet/checker and `register()` takes an injected loop: the
 * tests run the REAL `register()` + REAL `GovernedLoop` + REAL signed-ledger hook against a fake
 * Pi that fires the lifecycle events, and only the model call is faked. The real driver lives
 * in `wrapper-pi-driver.ts` and is the default in `main()`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import register, { parseConfig, type KcpConfig } from "./index.js";
import { GovernedLoop } from "./governed-loop.js";
import { HarnessConformanceChecker } from "./harness-conformance.js";
import { isGoverned, ungovernedReason, type TurnRecord } from "./runtime.js";
import { createFileLedgerHook, type SignedTurnEntry } from "./signed-ledger.js";
import { digest } from "./evidence.js";
import {
  checkGroundingCitations,
  deliberateSystemPrompt,
  DeliberateReplyError,
  NO_GROUNDING_CONFORMANCE,
  parseDeliberateReply,
  REPLY_SCHEMAS,
  type DeliberateReply,
  type GroundingConformance,
  type ReplySchema,
} from "./wrapper-deliberate.js";

export const EXIT_GOVERNED = 0;
export const EXIT_UNGOVERNED = 1;
export const EXIT_USAGE = 2;
export const EXIT_MODEL = 3;
export const EXIT_LEDGER = 4;

/** Default `--timeout-ms`: under the bridge's fixed 60 s SIGKILL with room to flush the ledger. */
export const DEFAULT_TIMEOUT_MS = 50_000;
export const DEFAULT_API_KEY_ENV = "ANTHROPIC_API_KEY";
/** How long to wait for the fire-and-forget ledger hook to settle after the turn. */
const LEDGER_FLUSH_TIMEOUT_MS = 5_000;

export const USAGE = `usage: pi-kcp-persona-turn --prompt <text> --cwd <abs dir> --model <provider/id[:thinking]>
                          --signing-key <abs .pem> --ledger <abs .jsonl>
                          [--persona <text>] [--persona-file <abs path>]
                          [--grounding <text>] [--grounding-file <abs path>]
                          [--tools <a,b,c>] [--key-id <id>] [--api-key-env <NAME>]
                          [--timeout-ms <n>]
                          [--reply-schema deliberate|deliberate-synthesis
                           [--grounding-doc-ids <id,id,…>] [--citation-required]]

One governed pi-kcp turn, bridge-shaped: exactly one JSON object on stdout, exit 0 only when the
turn was governed and its signed ledger entry was persisted. Never reads stdin. Reads exactly one
environment variable (--api-key-env, default ${DEFAULT_API_KEY_ENV}).

--reply-schema wraps the persona/grounding text in Sunstone Atlas's DELIBERATE_SYSTEM scaffold,
requires the reply to be its JSON shape ({position, argument, cited_docs, dissent_with,
confidence[, coverage]}), and refuses (exit 3) a reply that does not parse or that cites a doc id
not listed in --grounding-doc-ids (bare ids; the model cites them as doc:<id>).
--citation-required additionally refuses an empty cited_docs.`;

/** Parsed argv — pure data, nothing read from disk yet. */
export interface WrapperArgs {
  prompt: string;
  cwd: string;
  model: string;
  signingKeyPath: string;
  ledgerPath: string;
  keyId?: string;
  apiKeyEnv: string;
  persona?: string;
  personaFile?: string;
  grounding?: string;
  groundingFile?: string;
  tools: string[];
  timeoutMs: number;
  /** `--reply-schema`; absent ⇒ the free-text reply contract, byte-identical to before it existed. */
  replySchema?: ReplySchema;
  /** `--grounding-doc-ids`, bare ids; only meaningful (and only accepted) with `--reply-schema`. */
  groundingDocIds: string[];
  /** `--citation-required`; only accepted with `--reply-schema` and a non-empty `--grounding-doc-ids`. */
  citationRequired: boolean;
}

/** Thrown for anything that maps to {@link EXIT_USAGE}: nothing has run, nothing was spent. */
export class WrapperUsageError extends Error {}

/**
 * Flags that take no value. The bridge only ever substitutes `{param}`s after a literal `--flag`,
 * and these are never substituted — they are fixed in the argv template — so a bare flag is
 * still inside the bridge's template rules.
 */
const BOOLEAN_FLAGS: Record<string, keyof WrapperArgs> = {
  "--citation-required": "citationRequired",
};

const VALUE_FLAGS: Record<string, keyof WrapperArgs> = {
  "--prompt": "prompt",
  "--cwd": "cwd",
  "--model": "model",
  "--signing-key": "signingKeyPath",
  "--ledger": "ledgerPath",
  "--key-id": "keyId",
  "--api-key-env": "apiKeyEnv",
  "--persona": "persona",
  "--persona-file": "personaFile",
  "--grounding": "grounding",
  "--grounding-file": "groundingFile",
  "--tools": "tools",
  "--timeout-ms": "timeoutMs",
  "--reply-schema": "replySchema",
  "--grounding-doc-ids": "groundingDocIds",
};

const REQUIRED: Array<[keyof WrapperArgs, string]> = [
  ["prompt", "--prompt"],
  ["cwd", "--cwd"],
  ["model", "--model"],
  ["signingKeyPath", "--signing-key"],
  ["ledgerPath", "--ledger"],
];

/**
 * Parse `argv` (without the interpreter/script prefix). Flag-per-value only — the bridge's
 * template rules require each substituted value to immediately follow a literal `--flag`.
 * Unknown flags and missing values fail closed rather than being ignored: an argv the bridge
 * config author did not mean is not something to guess about.
 */
export function parseWrapperArgs(argv: readonly string[]): WrapperArgs {
  const raw: Partial<Record<keyof WrapperArgs, string>> = {};
  const flags = new Set<keyof WrapperArgs>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--help" || flag === "-h") throw new WrapperUsageError(USAGE);
    const boolKey = BOOLEAN_FLAGS[flag];
    if (boolKey) {
      if (flags.has(boolKey)) throw new WrapperUsageError(`${flag} given twice`);
      flags.add(boolKey);
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (!key) throw new WrapperUsageError(`unknown argument: ${flag}\n\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined) throw new WrapperUsageError(`${flag} requires a value\n\n${USAGE}`);
    if (raw[key] !== undefined) throw new WrapperUsageError(`${flag} given twice`);
    raw[key] = value;
    i++;
  }
  for (const [key, flag] of REQUIRED) {
    if (!raw[key] || raw[key]!.trim() === "") throw new WrapperUsageError(`${flag} is required\n\n${USAGE}`);
  }
  for (const [key, flag] of [
    ["cwd", "--cwd"],
    ["signingKeyPath", "--signing-key"],
    ["ledgerPath", "--ledger"],
    ["personaFile", "--persona-file"],
    ["groundingFile", "--grounding-file"],
  ] as const) {
    const value = raw[key];
    // The bridge spawns with no PATH and an inherited, unspecified cwd — relative paths would
    // resolve against whatever directory the bridge happens to run in.
    if (value !== undefined && !isAbsolute(value)) throw new WrapperUsageError(`${flag} must be an absolute path (got ${JSON.stringify(value)})`);
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined) {
    timeoutMs = Number(raw.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
      throw new WrapperUsageError(`--timeout-ms must be an integer ≥ 1000 (got ${JSON.stringify(raw.timeoutMs)})`);
    }
  }
  const apiKeyEnv = raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new WrapperUsageError(`--api-key-env is not a valid environment variable name: ${JSON.stringify(apiKeyEnv)}`);

  // ── --reply-schema and its dependants. Each is meaningless without the one above it, and a
  //    config author who wrote `--citation-required` believes citations are being enforced —
  //    silently ignoring it would be exactly the hidden gap this feature exists to close. ──
  let replySchema: ReplySchema | undefined;
  if (raw.replySchema !== undefined) {
    if (!(REPLY_SCHEMAS as readonly string[]).includes(raw.replySchema)) {
      throw new WrapperUsageError(`--reply-schema must be one of ${REPLY_SCHEMAS.join("|")} (got ${JSON.stringify(raw.replySchema)})`);
    }
    replySchema = raw.replySchema as ReplySchema;
  }
  const groundingDocIds = (raw.groundingDocIds ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (raw.groundingDocIds !== undefined && !replySchema) throw new WrapperUsageError("--grounding-doc-ids requires --reply-schema (there is no cited_docs field to check without one)");
  for (const id of groundingDocIds) {
    // The wrapper prefixes `doc:` itself, exactly as the gateway does with policy.grounding[].id;
    // an already-prefixed id would become `doc:doc:<id>` and every honest citation would be
    // refused as fabricated.
    if (id.startsWith("doc:")) throw new WrapperUsageError(`--grounding-doc-ids takes bare ids, not ${JSON.stringify(id)} — the model cites them as doc:<id>`);
  }
  const citationRequired = flags.has("citationRequired");
  if (citationRequired && !replySchema) throw new WrapperUsageError("--citation-required requires --reply-schema");
  if (citationRequired && groundingDocIds.length === 0) {
    throw new WrapperUsageError("--citation-required needs a non-empty --grounding-doc-ids — with nothing citable, every reply would be refused");
  }
  return {
    prompt: raw.prompt!,
    cwd: raw.cwd!,
    model: raw.model!,
    signingKeyPath: raw.signingKeyPath!,
    ledgerPath: raw.ledgerPath!,
    ...(raw.keyId ? { keyId: raw.keyId } : {}),
    apiKeyEnv,
    ...(raw.persona ? { persona: raw.persona } : {}),
    ...(raw.personaFile ? { personaFile: raw.personaFile } : {}),
    ...(raw.grounding ? { grounding: raw.grounding } : {}),
    ...(raw.groundingFile ? { groundingFile: raw.groundingFile } : {}),
    tools: (raw.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    timeoutMs,
    ...(replySchema ? { replySchema } : {}),
    groundingDocIds,
    citationRequired,
  };
}

/** What the Pi driver is asked to do. `extension` is pi-kcp, already bound to the governed loop. */
export interface DriverInput {
  cwd: string;
  model: string;
  prompt: string;
  apiKey: string;
  /** Replaces Pi's default system prompt when set (the persona brief). */
  systemPrompt?: string;
  /** Appended to the system prompt (grounding text for this turn). */
  appendSystemPrompt?: string;
  /** Tool allowlist; empty means no tools at all. */
  tools: readonly string[];
  /** Abort the model turn after this long so the ledger can still flush before SIGKILL. */
  timeoutMs: number;
  extension: (pi: ExtensionAPI) => void | Promise<void>;
}

export type DriverStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "none";

export interface DriverResult {
  /** The assistant's text content, `text` parts joined — the same extraction Pi's print mode does. */
  reply: string;
  stopReason: DriverStopReason;
  errorMessage?: string;
  /** `provider/id` of the model that actually ran. */
  model: string;
}

/** The seam: run one Pi prompt with the given extension installed and report what came back. */
export type PersonaTurnDriver = (input: DriverInput) => Promise<DriverResult>;

export interface RunDeps {
  driver: PersonaTurnDriver;
  /** The process environment to read the credential from. Injected so tests never touch the real one. */
  env: Readonly<Record<string, string | undefined>>;
  /** Signing-time clock for the ledger. Defaults to real time. */
  now?: () => string;
}

/**
 * The single stdout document on success — a flat object so playbook steps can reference its fields.
 *
 * With `--reply-schema` the parsed deliberate fields are ADDED, flat, after the existing ones:
 * `reply` stays the raw model text (and `replyDigest` its digest), so the pre-existing fields keep
 * their meaning and a consumer can re-derive the parse from the bytes the model actually produced.
 * Field names are the model's own (`cited_docs`, `dissent_with`) — the names Atlas's
 * `DELIBERATE_JUDGMENT_OUTPUT_FIELDS` types and `steps.<id>.<field>` bindings reference.
 */
export interface PersonaTurnResponse {
  reply: string;
  replyDigest: string;
  governed: true;
  model: string;
  stopReason: DriverStopReason;
  /** The first turn's correlation id — the join key into the ledger and Pi's own audit trail. */
  correlationId: string;
  turnCount: number;
  turns: Array<{
    turnIndex: number;
    correlationId: string;
    stages: Array<{ stage: string; status: string; reason?: string }>;
  }>;
  ledger: {
    path: string;
    entries: Array<{ turnIndex: number; correlationId: string; signedAt: string; keyId?: string }>;
    /** SPKI PEM the entries were signed with — what an auditor pins in `verifyLedgerFile`. */
    publicKey: string;
  };
  /** Only with `--reply-schema`: which schema the fields below were parsed and checked against. */
  replySchema?: ReplySchema;
  position?: string;
  argument?: string;
  cited_docs?: string[];
  dissent_with?: string[];
  confidence?: number;
  /** Only with `--reply-schema deliberate-synthesis`; always present there, even as `[]`. */
  coverage?: DeliberateReply["coverage"];
  /**
   * Only with `--reply-schema`: the citation check's verdict — the gateway's `groundingConformance`
   * shape (`ALLOW`/`DENY`/`N/A`). On exit 0 this is never `DENY`; it is emitted so a consumer can
   * tell "checked and passed" (`ALLOW`) from "nothing was citable" (`N/A`), as Atlas's scorecard does.
   */
  groundingConformance?: GroundingConformance;
}

export interface RunOutcome {
  exitCode: number;
  /** Exactly `JSON.stringify(response) + "\n"` on exit 0, otherwise empty. */
  stdout: string;
  stderr: string;
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new WrapperUsageError(`could not read ${what} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Read the workspace's `.pi/kcp.json` the same way `register()` does — via the exported parser. */
function loadWorkspaceConfig(cwd: string): KcpConfig {
  const path = `${cwd}/.pi/kcp.json`;
  if (!existsSync(path)) throw new WrapperUsageError(`${path} not found — a persona workspace must declare its governance config (at minimum {"enabled":true,"governance":"tool"})`);
  const loaded = parseConfig(JSON.parse(readText(path, "workspace config")));
  if (loaded.status === "invalid") throw new WrapperUsageError(`invalid ${path}: ${loaded.errors.join("; ")}`);
  if (!loaded.config.enabled) throw new WrapperUsageError(`${path} has enabled:false — no turn can be governed`);
  if (loaded.config.governance === "off") throw new WrapperUsageError(`${path} has governance:"off" — no turn can be governed`);
  return loaded.config;
}

function stagesOf(record: TurnRecord) {
  return record.decisions.map((d) => ({ stage: d.stage, status: d.status, ...(d.reason ? { reason: d.reason } : {}) }));
}

/**
 * Run one persona turn. Returns what the process should do (exit code + the two streams) instead
 * of doing it, so tests can assert the bridge contract byte-for-byte without spawning.
 */
export async function runPersonaTurn(args: WrapperArgs, deps: RunDeps): Promise<RunOutcome> {
  const errLines: string[] = [];
  const fail = (exitCode: number, message: string): RunOutcome => {
    errLines.push(`pi-kcp persona-turn: ${message}`);
    return { exitCode, stdout: "", stderr: errLines.join("\n") + "\n" };
  };

  // ── 1. Configuration — everything that can be checked before anything runs or is spent. ──
  let signingKeyPem: string;
  let config: KcpConfig;
  let persona: string | undefined;
  let grounding: string | undefined;
  try {
    if (!existsSync(args.cwd) || !statSync(args.cwd).isDirectory()) throw new WrapperUsageError(`--cwd is not a directory: ${args.cwd}`);
    config = loadWorkspaceConfig(args.cwd);
    signingKeyPem = readText(args.signingKeyPath, "signing key");
    try {
      createPrivateKey(signingKeyPem);
    } catch (error) {
      throw new WrapperUsageError(`--signing-key is not a parseable PKCS8 private key: ${error instanceof Error ? error.message : String(error)}`);
    }
    persona = [args.persona, args.personaFile ? readText(args.personaFile, "persona file") : undefined]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join("\n\n") || undefined;
    grounding = [args.grounding, args.groundingFile ? readText(args.groundingFile, "grounding file") : undefined]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join("\n\n") || undefined;
  } catch (error) {
    if (error instanceof WrapperUsageError) return fail(EXIT_USAGE, error.message);
    throw error;
  }

  // The credential is the ONLY thing read from the environment, and its absence stops the run
  // before Pi is even constructed: "never calling unauthenticated where a credential is
  // configured" is the bridge's rule, and it holds one level down too.
  const apiKey = deps.env[args.apiKeyEnv];
  if (!apiKey || apiKey.trim() === "") {
    return fail(EXIT_USAGE, `credential env var ${args.apiKeyEnv} is unset or empty — refusing to run an unauthenticated turn`);
  }

  // ── 2. Governance wiring — real loop, real checker, real signed ledger. ──
  const records: TurnRecord[] = [];
  const ungoverned: string[] = [];
  const appended: SignedTurnEntry[] = [];
  const writeErrors: string[] = [];
  let settleLedger: (() => void) | undefined;
  const settled = () => appended.length + writeErrors.length;
  const ledgerHook = createFileLedgerHook({
    signingKeyPem,
    ...(args.keyId ? { signingKeyId: args.keyId } : {}),
    path: args.ledgerPath,
    ...(deps.now ? { now: deps.now } : {}),
    // Same append the hook does by default (mkdir -p + line append), plus a record of what was
    // actually written — the response reports the ledger from the bytes on disk, not from intent.
    appendLine: (path, line) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line + "\n", "utf8");
      appended.push(JSON.parse(line) as SignedTurnEntry);
      settleLedger?.();
    },
    onWriteError: (error, record) => {
      writeErrors.push(`turn ${record.turnIndex} (${record.correlationId}): ${error instanceof Error ? error.message : String(error)}`);
      settleLedger?.();
    },
  });
  const loop = new GovernedLoop({
    // The same fail-closed checker `register()` installs by default; with an injected loop the
    // checker is the loop's own concern, and `requireActiveSkill` is honoured from the
    // workspace config exactly as register() would.
    checker: new HarnessConformanceChecker({ manifest: config.manifest, requireActiveSkill: config.requireActiveSkill }),
    hooks: {
      onTurnRecorded: (record) => {
        records.push(record);
        ledgerHook(record);
      },
      onUngoverned: (record, reason) => ungoverned.push(`turn ${record.turnIndex}: ${reason}`),
    },
  });

  // ── 3. The one model turn. ──
  //
  // Under --reply-schema the caller's persona + grounding play the role of the gateway's
  // `groundingText(policy)` (charter text, then the `[doc:<id>]` blocks) and are wrapped in the
  // SAME fixed DELIBERATE_SYSTEM scaffold — so for the same `g` the wrapper hands Pi the same
  // system prompt the gateway hands Anthropic. Built as one systemPrompt (not split across
  // systemPrompt/appendSystemPrompt) so the parity holds by construction here, not by Pi's join.
  // `hasGrounding` is "were any doc ids declared", the analogue of `policy.grounding.length > 0`.
  const hasGrounding = args.groundingDocIds.length > 0;
  const systemPrompt = args.replySchema
    ? deliberateSystemPrompt([persona, grounding].filter((s): s is string => Boolean(s)).join("\n\n"), hasGrounding, args.replySchema === "deliberate-synthesis")
    : persona;
  const appendSystemPrompt = args.replySchema ? undefined : grounding;
  let result: DriverResult;
  try {
    result = await deps.driver({
      cwd: args.cwd,
      model: args.model,
      prompt: args.prompt,
      apiKey,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      tools: args.tools,
      timeoutMs: args.timeoutMs,
      extension: (pi) => register(pi, { loop }),
    });
  } catch (error) {
    if (error instanceof WrapperUsageError) return fail(EXIT_USAGE, error.message);
    return fail(EXIT_MODEL, `Pi turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }

  // ── 4. Flush the ledger. The hook is fire-and-forget by design (signing is async); the
  //       process must not exit — and must not claim persistence — until it has settled. ──
  if (settled() < records.length) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LEDGER_FLUSH_TIMEOUT_MS);
      settleLedger = () => {
        if (settled() >= records.length) {
          clearTimeout(timer);
          resolve();
        }
      };
      settleLedger();
    });
  }

  // ── 5. Verdicts, most fundamental first. ──
  for (const reason of ungoverned) errLines.push(`pi-kcp persona-turn: ungoverned — ${reason}`);
  for (const error of writeErrors) errLines.push(`pi-kcp persona-turn: ledger write failed — ${error}`);

  if (result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "none") {
    return fail(EXIT_MODEL, `model turn ended with stopReason=${result.stopReason}${result.errorMessage ? `: ${result.errorMessage}` : ""}`);
  }
  if (records.length === 0) {
    return fail(EXIT_UNGOVERNED, "no turn record was produced — the governed cycle never ran (is pi-kcp loaded and governance on for this workspace?)");
  }
  const notGoverned = records.filter((r) => !isGoverned(r));
  if (notGoverned.length > 0) {
    return fail(
      EXIT_UNGOVERNED,
      `${notGoverned.length} of ${records.length} turn(s) not governed: ${notGoverned.map((r) => `turn ${r.turnIndex}: ${ungovernedReason(r)}`).join("; ")}`,
    );
  }
  if (writeErrors.length > 0 || appended.length < records.length) {
    return fail(EXIT_LEDGER, `signed ledger not persisted: ${appended.length}/${records.length} entries written to ${args.ledgerPath}`);
  }

  // ── 6. The reply contract (only under --reply-schema). Checked LAST: the turn above was
  //       governed and is on the ledger — what is refused here is the answer, not the turn, the
  //       same way the gateway signs an outcome:"refuse" receipt for an unparseable or
  //       fabricated-citation reply rather than pretending the call never happened. ──
  let deliberate: DeliberateReply | undefined;
  let groundingConformance: GroundingConformance | undefined;
  if (args.replySchema) {
    try {
      deliberate = parseDeliberateReply(result.reply, args.replySchema);
    } catch (error) {
      if (!(error instanceof DeliberateReplyError)) throw error;
      // Same diagnostic the gateway keeps server-side (stderr, bounded, never on the reply
      // object): the raw text is what makes an "unparseable" refusal diagnosable at all.
      return fail(EXIT_MODEL, `reply does not match --reply-schema ${args.replySchema}: ${error.message} — refusing (fail-safe); rawTextHead2000=${JSON.stringify(result.reply.slice(0, 2000))}`);
    }
    groundingConformance = hasGrounding
      ? checkGroundingCitations(deliberate.cited_docs, args.groundingDocIds, { required: args.citationRequired })
      : NO_GROUNDING_CONFORMANCE;
    if (!groundingConformance.ok) {
      return fail(EXIT_MODEL, `grounding citation conformance ${groundingConformance.verdict}: ${groundingConformance.reason} — refusing (fail-safe); cited_docs=${JSON.stringify(deliberate.cited_docs)} provided=${JSON.stringify(args.groundingDocIds.map((id) => `doc:${id}`))}`);
    }
  }

  const response: PersonaTurnResponse = {
    reply: result.reply,
    replyDigest: digest(result.reply),
    governed: true,
    model: result.model,
    stopReason: result.stopReason,
    correlationId: records[0]!.correlationId,
    turnCount: records.length,
    turns: records.map((r) => ({ turnIndex: r.turnIndex, correlationId: r.correlationId, stages: stagesOf(r) })),
    ledger: {
      path: args.ledgerPath,
      entries: appended.map((e) => ({
        turnIndex: e.turnIndex,
        correlationId: e.correlationId,
        signedAt: e.signedAt,
        ...(e.signature.keyId ? { keyId: e.signature.keyId } : {}),
      })),
      publicKey: appended[0]!.signature.publicKey,
    },
    // Additive and gated on --reply-schema only: absent the flag, not one key below is emitted,
    // so the envelope stays byte-identical to before this existed.
    ...(args.replySchema && deliberate && groundingConformance
      ? {
          replySchema: args.replySchema,
          position: deliberate.position,
          argument: deliberate.argument,
          cited_docs: deliberate.cited_docs,
          dissent_with: deliberate.dissent_with,
          confidence: deliberate.confidence,
          ...(deliberate.coverage !== undefined ? { coverage: deliberate.coverage } : {}),
          groundingConformance,
        }
      : {}),
  };
  return { exitCode: EXIT_GOVERNED, stdout: JSON.stringify(response) + "\n", stderr: errLines.length ? errLines.join("\n") + "\n" : "" };
}

/** Process entry: parse argv, run with the real Pi driver, write the streams, exit. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: WrapperArgs;
  try {
    args = parseWrapperArgs(argv);
  } catch (error) {
    process.stderr.write(`pi-kcp persona-turn: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }
  // The real driver is loaded lazily: it imports Pi's SDK at runtime, which is a devDependency
  // of this package (pi-kcp normally runs *inside* Pi). Importing it only here keeps every other
  // entry point loadable without Pi installed.
  const { runPiPersonaTurn } = await import("./wrapper-pi-driver.js");
  // Belt and braces under the bridge's SIGKILL: if the driver's own abort did not return in
  // time, exit with a diagnostic rather than be killed silently with nothing on stderr.
  const hardStop = setTimeout(() => {
    process.stderr.write(`pi-kcp persona-turn: hard stop — the turn did not finish within ${args.timeoutMs + 5_000} ms\n`);
    process.exit(EXIT_MODEL);
  }, args.timeoutMs + 5_000);
  try {
    const outcome = await runPersonaTurn(args, { driver: runPiPersonaTurn, env: process.env });
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    if (outcome.stdout) process.stdout.write(outcome.stdout);
    return outcome.exitCode;
  } finally {
    clearTimeout(hardStop);
  }
}

function isEntrypoint(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`pi-kcp persona-turn: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(EXIT_MODEL);
    },
  );
}
