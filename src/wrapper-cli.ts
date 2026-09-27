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
 * `error`/`aborted`) · 4 the signed ledger could not be persisted.
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

One governed pi-kcp turn, bridge-shaped: exactly one JSON object on stdout, exit 0 only when the
turn was governed and its signed ledger entry was persisted. Never reads stdin. Reads exactly one
environment variable (--api-key-env, default ${DEFAULT_API_KEY_ENV}).`;

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
}

/** Thrown for anything that maps to {@link EXIT_USAGE}: nothing has run, nothing was spent. */
export class WrapperUsageError extends Error {}

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
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--help" || flag === "-h") throw new WrapperUsageError(USAGE);
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

/** The single stdout document on success — a flat object so playbook steps can reference its fields. */
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
  let result: DriverResult;
  try {
    result = await deps.driver({
      cwd: args.cwd,
      model: args.model,
      prompt: args.prompt,
      apiKey,
      ...(persona ? { systemPrompt: persona } : {}),
      ...(grounding ? { appendSystemPrompt: grounding } : {}),
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
