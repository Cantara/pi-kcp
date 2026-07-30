import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { type GovernanceDecision, GovernedLoop } from "./governed-loop.js";
import { missingStages, type GateFailurePosture, type GovernanceMode, TOOL_STAGES, type TurnRecord, ungovernedReason } from "./runtime.js";
import { digest } from "./evidence.js";
import { parseTrace } from "./skill-gate.js";
import type { SkillSelected } from "./skill-detection.js";
import { type ConformanceChecker } from "./conformance.js";
import { HarnessConformanceChecker } from "./harness-conformance.js";
import { supportsFlag } from "./agent-capability.js";
import { MockPaymentExecutor, MockWallet, type PaymentExecutor, type WalletProvider } from "./wallet.js";

export { PassThroughChecker, passThroughChecker } from "./conformance.js";
export type { ConformanceChecker, ConformanceContext, ConformanceResult, ObservedAction } from "./conformance.js";
export {
  HarnessConformanceChecker,
  ManifestScopeResolver,
  matchSkillUnit,
  toHarnessAction,
} from "./harness-conformance.js";
export type { CheckConformanceFn, HarnessConformanceOptions, ScopeResolver } from "./harness-conformance.js";
export type { ActionScope, ConformanceVerdict } from "kcp-harness";
export { GovernedLoop, detectPurchase } from "./governed-loop.js";
export type { GovernanceDecision, PlanProduced, PurchaseIntent, SettlementResult, GovernedLoopHooks, GovernedLoopOptions } from "./governed-loop.js";
export {
  MockWallet,
  NoopWallet,
  MockPaymentExecutor,
  PaymentDeniedError,
  mockWallet,
  requirementsFromPurchase,
  purchaseFromRequirements,
  parsePaymentRequirements,
  DEMO_SIGNING_KEY_PEM,
  DEMO_SIGNING_KEY_ID,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
} from "./wallet.js";
export type {
  WalletProvider,
  PaymentExecutor,
  PaymentRequirements,
  SignedPayment,
  PaymentReceipt,
  PaymentRequestFn,
  PaymentGovernFn,
  PaymentGovernanceDecision,
} from "./wallet.js";
export { ALL_STAGES, TOOL_STAGES, expectedStagesFor, isGoverned, missingStages, erroredStages, violatedStages, ungovernedReason } from "./runtime.js";
export { TURN_HISTORY_LIMIT } from "./governed-loop.js";
export { canonicalJson, digest } from "./evidence.js";
export { admitSkill, findTracedUnit, parseTrace } from "./skill-gate.js";
export type { GateVerdict, SkillAdmission, TracedUnit } from "./skill-gate.js";
// §3.13 runtime grant_ceiling MIN authority gate (Gap 1).
export { resolveEffectiveAuthority, authorityGate } from "./authority.js";
export type { AuthorityLevelScale, AuthoritySource, EffectiveAuthority, AuthorityDecision } from "./authority.js";
// §4.3b kind:playbook step-orchestrator (Gap 2).
export { orderSteps, planPlaybook, checkStepConformance } from "./playbook.js";
export type { ManifestStep, ManifestUnitLike, PlaybookManifest, GatedStep, PlaybookPlan, PlanPlaybookOptions } from "./playbook.js";
export type { GateFailurePosture, GovernanceMode, Stage, StageDecision, StageStatus, TurnRecord } from "./runtime.js";
export { childContext, isTraceparent, mintTraceparent, traceIdOf } from "./correlation.js";
export type { TurnContext } from "./correlation.js";
export {
  detectAgentSkillLoad,
  detectForcedSkill,
  isSkillReadPath,
  resolveSkillName,
  skillNameFromPath,
} from "./skill-detection.js";
export type { SkillSelected, SkillSource } from "./skill-detection.js";

/** Options for {@link register}; lets tests / embedders inject a conformance checker. */
export interface RegisterOptions {
  /**
   * The conformance seam wired at the tool_call boundary. Defaults to the real
   * {@link HarnessConformanceChecker} (kcp-harness-backed). Inject
   * {@link passThroughChecker} to disable enforcement, or a stub for tests.
   */
  conformanceChecker?: ConformanceChecker;
  /**
   * Strict conformance mode for the built-in checker (default `false`). When `true`, tool
   * calls taken with **no active skill** are fail-closed instead of passing through to the
   * other gates. When provided here it pins the value; otherwise the built-in checker reads
   * `requireActiveSkill` from `.pi/kcp.json` at each turn. Ignored when a custom
   * `conformanceChecker` is injected.
   */
  requireActiveSkill?: boolean;
  /**
   * The wallet seam used to authorize governed spends at the tool_call boundary (#139).
   * Defaults to a deterministic {@link MockWallet}. Inject a real signer in production, or a
   * {@link NoopWallet}/stub in tests.
   */
  walletProvider?: WalletProvider;
  /**
   * The payment-execution seam that runs the x402 handshake and settlement. Defaults to a
   * {@link MockPaymentExecutor} over `walletProvider`.
   */
  paymentExecutor?: PaymentExecutor;
  /**
   * The governed loop to drive. Defaults to one built from the options above. Inject to
   * observe the cycle via {@link GovernedLoopHooks} — `onTurnRecorded` / `onUngoverned`
   * are how an embedder learns whether a turn was actually governed (#27).
   */
  loop?: GovernedLoop;
}

const DEFAULT_MEMORY_URL = "http://localhost:7735";
const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_MAX_RESULTS = 3;
const MAX_CONTEXT_BYTES = 12_000;
const CONFIG_FILE = ".pi/kcp.json";

/** Strength ordering, so a session override can tell weakening from strengthening. */
const RANK: Record<GovernanceMode, number> = { off: 0, tool: 1, full: 2 };

export interface KcpConfig {
  enabled: boolean;
  autoRecall: boolean;
  memoryUrl: string;
  maxResults: number;
  timeoutMs: number;
  manifest: string;
  /**
   * Strict conformance mode (default `false`). When `true`, the built-in conformance checker
   * fail-closes tool calls taken with no active skill; when `false`, such general actions pass
   * conformance and defer to the other gates + approval.
   */
  requireActiveSkill: boolean;
  /**
   * How much of the governed cycle runs (#27).
   *
   * - `"tool"` (default) — the governance boundary: conformance at `tool_call`, integrity
   *   at `tool_result`, both recorded and asserted. No planner invocation and no
   *   dependency on kcp-agent being installed.
   * - `"full"` — all seven stages, including the per-turn planner trace that gates skill
   *   selection (#28). Requires kcp-agent.
   * - `"off"` — no cycle and no records. Conformance at `tool_call` still runs; it
   *   predates the cycle, and "no cycle" does not mean "no enforcement".
   */
  governance: GovernanceMode;
  /**
   * What the runtime does when its own gate breaks — a stage errored, so it can no longer
   * establish what is authorized.
   *
   * - `"announce"` (default) — report the lapse prominently and keep the host usable.
   * - `"block"` — fail closed: refuse tool calls for the rest of the turn. `tool_call` is
   *   the only lever Pi honours, so this is the only real enforcement available.
   *
   * Throwing is never an option: Pi swallows handler exceptions, so a thrown refusal is
   * indistinguishable from no refusal at all.
   */
  gateFailurePosture: GateFailurePosture;
  agentCli?: string;
}

export type ConfigStatus = "defaults" | "configured" | "invalid";

export interface LoadedConfig {
  config: KcpConfig;
  status: ConfigStatus;
  errors: string[];
}

export interface MemorySession {
  sessionId?: string;
  projectDir?: string;
  gitBranch?: string;
  slug?: string;
  startedAt?: string;
  firstMessage?: string;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  label: string;
}

/** The plan --json contract this extension understands (kcp-agent stamps schemaVersion since 0.13). */
export const SUPPORTED_PLAN_SCHEMA_VERSION = 1;

export function normalizePlanJson(output: string): string {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("plan JSON must be an object");
    }
    const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (version !== undefined && version !== SUPPORTED_PLAN_SCHEMA_VERSION) {
      throw new Error(`unsupported plan schemaVersion ${String(version)} (this extension understands ${SUPPORTED_PLAN_SCHEMA_VERSION}; update pi-kcp or pin kcp-agent)`);
    }
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    throw new Error(`kcp-agent returned invalid --json output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface SearchResponse {
  results?: unknown;
}

export const KCP_HELP = `pi-kcp — KCP agent proficiency and ergonomics

/kcp help                 Show this help
/kcp health               Check configuration and local services
/kcp recall <query>       Add episodic memory to the next turn
/kcp plan <intent>        Add a deterministic knowledge plan to the next turn
/kcp validate             Validate the project's knowledge.yaml
/kcp init                 Create knowledge.yaml without overwriting an existing file
/kcp govern <full|tool|off|status>  Set how much of the governed cycle runs
/kcp evidence [n]         Show the stage record for the last n governed turns`;

const RECALL_SIGNALS = [
  /\byesterday\b/i,
  /\blast\s+(?:time|week|month)\b/i,
  /\b(?:previously|recently)\b/i,
  /\bwhat\s+did\s+(?:i|we)\b/i,
  /\bdo\s+you\s+remember\b/i,
  /\bcontinue\s+from\s+where\s+(?:we|i)\s+left\s+off\b/i,
  /\b\d+\s+(?:days?|weeks?|months?)\s+ago\b/i,
];

export const defaultConfig: KcpConfig = {
  enabled: true,
  autoRecall: true,
  memoryUrl: DEFAULT_MEMORY_URL,
  maxResults: DEFAULT_MAX_RESULTS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  manifest: "knowledge.yaml",
  requireActiveSkill: false,
  governance: "tool",
  gateFailurePosture: "announce",
};

export function shouldRecall(prompt: string): boolean {
  return RECALL_SIGNALS.some((signal) => signal.test(prompt));
}

export function extractRecallQuery(prompt: string): string {
  const cleaned = prompt
    .replace(/^\s*(?:can you|please|could you)\s+/i, "")
    .replace(/[?]+\s*$/, "")
    .trim();
  return cleaned || prompt.trim();
}

export function parseSearchResults(value: unknown): MemorySession[] {
  if (!value || typeof value !== "object") return [];
  const results = (value as SearchResponse).results;
  if (!Array.isArray(results)) return [];

  return results.filter((item): item is MemorySession => {
    return Boolean(item && typeof item === "object");
  });
}

function truncate(text: string, maxBytes = MAX_CONTEXT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let output = text;
  while (Buffer.byteLength(`${output}…`, "utf8") > maxBytes) {
    output = output.slice(0, Math.max(0, output.length - 256));
  }
  return `${output}…`;
}

export function formatRecallBlock(query: string, sessions: MemorySession[]): string {
  if (sessions.length === 0) return "";

  const lines = sessions.map((session) => {
    const date = session.startedAt ? ` (${session.startedAt})` : "";
    const project = session.projectDir ? ` [${session.projectDir}]` : "";
    const branch = session.gitBranch ? ` {${session.gitBranch}}` : "";
    const summary = session.firstMessage || session.slug || "session without an opening message";
    return `- ${truncate(summary, 2_000)}${date}${project}${branch}`;
  });

  return truncate(
    [
      "## Episodic Memory",
      `Relevant past sessions for: ${query}`,
      ...lines,
      "",
      "Source: kcp-memory. Treat this as a lead and verify against current files.",
    ].join("\n"),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseConfig(value: unknown): LoadedConfig {
  if (!isRecord(value)) {
    return {
      config: { ...defaultConfig, enabled: false, autoRecall: false },
      status: "invalid",
      errors: ["configuration must be a JSON object"],
    };
  }

  const errors: string[] = [];
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") errors.push("enabled must be a boolean");
  if (value.autoRecall !== undefined && typeof value.autoRecall !== "boolean") errors.push("autoRecall must be a boolean");
  if (value.memoryUrl !== undefined) {
    if (typeof value.memoryUrl !== "string") errors.push("memoryUrl must be a string");
    else {
      try {
        const url = new URL(value.memoryUrl);
        if (!['http:', 'https:'].includes(url.protocol)) errors.push("memoryUrl must use http or https");
      } catch {
        errors.push("memoryUrl must be a valid URL");
      }
    }
  }
  if (value.maxResults !== undefined && (!Number.isInteger(value.maxResults) || Number(value.maxResults) < 1 || Number(value.maxResults) > 10)) {
    errors.push("maxResults must be an integer from 1 to 10");
  }
  if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 50 || Number(value.timeoutMs) > 5_000)) {
    errors.push("timeoutMs must be an integer from 50 to 5000");
  }
  if (value.manifest !== undefined && (typeof value.manifest !== "string" || value.manifest.trim() === "")) errors.push("manifest must be a non-empty string");
  if (value.requireActiveSkill !== undefined && typeof value.requireActiveSkill !== "boolean") errors.push("requireActiveSkill must be a boolean");
  if (
    value.governance !== undefined &&
    value.governance !== "full" &&
    value.governance !== "tool" &&
    value.governance !== "off"
  ) {
    errors.push('governance must be "full", "tool" or "off"');
  }
  if (value.gateFailurePosture !== undefined && value.gateFailurePosture !== "announce" && value.gateFailurePosture !== "block") {
    errors.push('gateFailurePosture must be "announce" or "block"');
  }
  if (value.agentCli !== undefined && (typeof value.agentCli !== "string" || value.agentCli.trim() === "")) errors.push("agentCli must be a non-empty string");

  if (errors.length > 0) {
    return {
      config: { ...defaultConfig, enabled: false, autoRecall: false },
      status: "invalid",
      errors,
    };
  }

  return { config: { ...defaultConfig, ...value } as KcpConfig, status: "configured", errors: [] };
}

async function loadConfig(cwd: string): Promise<LoadedConfig> {
  try {
    return parseConfig(JSON.parse(await readFile(resolve(cwd, CONFIG_FILE), "utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { config: { ...defaultConfig }, status: "defaults", errors: [] };
    }
    return {
      config: { ...defaultConfig, enabled: false, autoRecall: false },
      status: "invalid",
      errors: [`could not read .pi/kcp.json: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function recall(memoryUrl: string, query: string, config: KcpConfig, correlationId?: string): Promise<MemorySession[]> {
  const url = new URL("/search", `${memoryUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(config.maxResults));
  if (correlationId) url.searchParams.set("traceparent", correlationId);
  return parseSearchResults(await fetchJson(url.toString(), config.timeoutMs));
}

export type MemoryLookup = (query: string, config: KcpConfig) => Promise<MemorySession[]>;

export async function augmentPrompt(
  prompt: string,
  config: KcpConfig,
  lookup: MemoryLookup = (query, currentConfig) => recall(currentConfig.memoryUrl, query, currentConfig),
): Promise<string> {
  if (!config.enabled || !config.autoRecall || !shouldRecall(prompt)) return prompt;

  try {
    const query = extractRecallQuery(prompt);
    const block = formatRecallBlock(query, await lookup(query, config));
    return block ? `${block}\n\n${prompt}` : prompt;
  } catch {
    return prompt;
  }
}

export function agentInvocationForPath(path: string): AgentInvocation {
  const isJavaScript = path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs");
  return isJavaScript
    ? { command: "node", args: [path], label: `node ${path}` }
    : { command: path, args: [], label: path };
}

async function commandInvocation(pi: ExtensionAPI, command: string): Promise<AgentInvocation | undefined> {
  const result = await pi.exec("which", [command], { timeout: 2_000 });
  if (result.code !== 0) return undefined;
  const path = result.stdout.trim();
  return path ? agentInvocationForPath(path.split("\n")[0]) : undefined;
}

async function findAgentInvocation(pi: ExtensionAPI, config: KcpConfig): Promise<AgentInvocation | undefined> {
  const configured = [config.agentCli, process.env.KCP_AGENT_CLI]
    .filter((candidate): candidate is string => Boolean(candidate));
  const knownPaths = [
    "/opt/homebrew/lib/node_modules/kcp-harness/node_modules/kcp-agent/dist/cli.js",
    `${process.env.HOME ?? ""}/.npm-global/lib/node_modules/kcp-harness/node_modules/kcp-agent/dist/cli.js`,
  ];

  for (const candidate of [...configured, ...knownPaths]) {
    if (!candidate.includes("/") && !/\.(?:cjs|mjs|js)$/.test(candidate)) {
      const invocation = await commandInvocation(pi, candidate);
      if (invocation) return invocation;
      continue;
    }
    try {
      await access(candidate, constants.R_OK);
      return agentInvocationForPath(candidate);
    } catch {
      // Try the next configured or known installation location.
    }
  }

  return commandInvocation(pi, "kcp-agent");
}

function agentNotFoundMessage(config: KcpConfig): string {
  const configured = config.agentCli ? ` Configured path: ${config.agentCli}.` : "";
  return `kcp-agent CLI was not found.${configured} Set agentCli in .pi/kcp.json, set KCP_AGENT_CLI, or install the kcp-agent executable.`;
}

async function runKcpAgent(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  config: KcpConfig,
  correlationId?: string,
): Promise<string> {
  const invocation = await findAgentInvocation(pi, config);
  if (!invocation) throw new Error(agentNotFoundMessage(config));

  // The turn's correlation id goes to the agent only if the installed agent documents the
  // flag. kcp-agent's parser fail-closes on unknown options, so passing it blind killed the
  // whole turn against every agent before 0.22.0 (pi-kcp#36). The probe reads that binary's
  // own help rather than comparing versions, and fails closed: an agent we cannot ask is an
  // agent we do not pass the flag to.
  const extra: string[] = [];
  if (correlationId) {
    const supported = await supportsFlag(
      // `plan --help`, not a bare `--help`: the bare form prints only the usage summary,
      // while the option reference — where --correlation-id is listed — comes from the
      // subcommand form. Probing the wrong one reports "unsupported" forever.
      () => pi.exec(invocation.command, [...invocation.args, "plan", "--help"], { timeout: 10_000 }),
      "--correlation-id",
      `${invocation.command} ${invocation.args.join(" ")}`,
    );
    if (supported) extra.push("--correlation-id", correlationId);
  }

  const result = await pi.exec(
    invocation.command,
    [...invocation.args, ...args, ...extra],
    { timeout: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `kcp-agent exited with code ${result.code}`);
  }
  return result.stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function runPlan(
  pi: ExtensionAPI,
  cwd: string,
  intent: string,
  config: KcpConfig,
  correlationId?: string,
): Promise<string> {
  const output = await runKcpAgent(
    pi,
    cwd,
    ["plan", intent, "--manifest", resolve(cwd, config.manifest), "--json"],
    config,
    correlationId,
  );
  return normalizePlanJson(output);
}

/**
 * Ask the planner to adjudicate every declared unit against its gates (#28).
 *
 * Returns `undefined` when the trace simply isn't available — no kcp-agent, or a build
 * that predates `--trace`. That is "not gated", not "gate broken": an agent that isn't
 * installed must not turn every turn into a governance failure. A *present* agent that
 * fails is a real error and is allowed to throw.
 */
async function runSkillTrace(
  pi: ExtensionAPI,
  cwd: string,
  intent: string,
  config: KcpConfig,
  correlationId?: string,
): Promise<string | undefined> {
  const invocation = await findAgentInvocation(pi, config);
  if (!invocation) return undefined;

  const supported = await supportsFlag(
    () => pi.exec(invocation.command, [...invocation.args, "plan", "--help"], { timeout: 10_000 }),
    "--trace",
    `${invocation.command} ${invocation.args.join(" ")}`,
  );
  if (!supported) return undefined;

  return runKcpAgent(
    pi,
    cwd,
    ["plan", intent, "--manifest", resolve(cwd, config.manifest), "--trace", "--json"],
    config,
    correlationId,
  );
}

async function runValidate(pi: ExtensionAPI, cwd: string, config: KcpConfig): Promise<string> {
  return runKcpAgent(pi, cwd, ["validate", resolve(cwd, config.manifest), "--json"], config);
}

async function runInit(pi: ExtensionAPI, cwd: string, config: KcpConfig): Promise<string> {
  if (config.manifest !== "knowledge.yaml") {
    throw new Error("/kcp init only creates the default knowledge.yaml; set manifest to knowledge.yaml first.");
  }
  const manifest = resolve(cwd, config.manifest);
  if (await pathExists(manifest)) {
    throw new Error(`Manifest already exists at ${manifest}; /kcp init will not overwrite it.`);
  }
  return runKcpAgent(pi, cwd, ["init", cwd], config);
}

function show(ctx: { hasUI: boolean; ui: { notify(message: string, level: "info" | "warning" | "error"): void } }, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message.slice(0, 3_000), level);
  else console.log(message);
}

/**
 * Report that a turn completed without the cycle governing it. This is the whole point of
 * the ledger: Pi swallows handler exceptions, so a broken or absent gate otherwise looks
 * exactly like a healthy one. Delivered as a visible message rather than a log line.
 */
function announceUngoverned(pi: ExtensionAPI, record: TurnRecord, reason: string): void {
  const decided = record.decisions.map((d) => `${d.stage}: ${d.status}`).join(", ");
  pi.sendMessage(
    {
      customType: "pi-kcp",
      content: `## KCP — turn ${record.turnIndex} completed **ungoverned**\n\n${reason}\n\nStages that did report: ${decided || "none"}.\n\nActions this turn were not covered by the governance guarantee.`,
      display: true,
      details: { correlationId: record.correlationId, reason },
    },
    { deliverAs: "nextTurn" },
  );
}

/**
 * Render one turn's spine for reading. Digests are truncated — they are here to be
 * compared, and a mismatch is legible long before 64 hex characters.
 */
function renderTurnRecord(record: TurnRecord): string {
  const reason = ungovernedReason(record);
  const head = reason
    ? `turn ${record.turnIndex} — UNGOVERNED: ${reason}`
    : `turn ${record.turnIndex} — governed`;

  const lines = record.decisions.map((d) => {
    const detail = d.detail ?? {};
    const bits = Object.entries(detail)
      .map(([k, v]) => `${k}=${typeof v === "string" && v.startsWith("sha256:") ? `${v.slice(7, 15)}…` : String(v)}`)
      .join(" ");
    return `  ${d.stage.padEnd(11)} ${d.status.padEnd(9)} ${bits}${d.reason ? ` — ${d.reason}` : ""}`;
  });

  return [head, `  correlation: ${record.correlationId}`, ...lines].join("\n");
}

/**
 * Report that a skill was refused by the planner's gates. Carries the planner's own words:
 * "deprecated since 2026-01-01" is evidence, "skill not allowed" is not.
 */
function announceSkillRefused(pi: ExtensionAPI, skill: SkillSelected, reason: string): void {
  pi.sendMessage(
    {
      customType: "pi-kcp",
      content: `## KCP — skill **${skill.skillName}** was not loaded\n\n${reason}\n\nIt did not shape this turn.`,
      display: true,
      details: { skill: skill.skillName, reason },
    },
    { deliverAs: "nextTurn" },
  );
}

function publish(pi: ExtensionAPI, title: string, content: string, correlationId?: string): void {
  pi.sendMessage(
    {
      customType: "pi-kcp",
      content: `## ${title}\n\n${truncate(content)}`,
      display: true,
      ...(correlationId ? { details: { correlationId } } : {}),
    },
    { deliverAs: "nextTurn" },
  );
}

export default function register(pi: ExtensionAPI, options: RegisterOptions = {}): void {
  // Runtime-depth governed loop: holds the per-turn correlation id (#29), observes skill
  // selection (#28), and gates tool calls through the conformance seam (#27, Wave 3). The
  // default checker is the kcp-harness-backed HarnessConformanceChecker: once a skill is
  // active, a real out-of-scope tool call is blocked in-loop with the harness's written
  // reason (fail-closed). With no skill active it defers to the other gates unless strict
  // mode (requireActiveSkill) is on.
  //
  // requireActiveSkill precedence: an explicit RegisterOptions value pins strict mode; when
  // omitted, the built-in checker reads it from `.pi/kcp.json` at each turn boundary.
  const builtInChecker = options.conformanceChecker
    ? undefined
    : new HarnessConformanceChecker({ requireActiveSkill: options.requireActiveSkill ?? false });
  // Payment-execution seam (#139): the wallet authorizes a conformant spend and the executor
  // settles it. Both default to deterministic, no-chain mocks; the executor shares the wallet.
  const wallet = options.walletProvider ?? new MockWallet();
  const executor = options.paymentExecutor ?? new MockPaymentExecutor(wallet);
  // The loop itself is injectable so an embedder (or a test) can observe the governed
  // cycle through its hooks. When injected, the checker/wallet/executor options above are
  // the injected loop's own concern.
  //
  // The default hooks are load-bearing, not decoration: without a listener the liveness
  // signal fires into nothing and an ungoverned turn is silent again — the exact failure
  // the cycle exists to prevent.
  const loop =
    options.loop ??
    new GovernedLoop({
      checker: options.conformanceChecker ?? builtInChecker!,
      wallet,
      executor,
      hooks: {
        onUngoverned: (record, reason) => announceUngoverned(pi, record, reason),
        onSkillRefused: (skill, reason) => announceSkillRefused(pi, skill, reason),
      },
    });
  const getCommands = (): SlashCommandInfo[] => {
    try {
      return pi.getCommands();
    } catch {
      return [];
    }
  };

  pi.registerCommand("kcp", {
    description: "Use KCP memory and deterministic knowledge plans",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const loaded = await loadConfig(ctx.cwd);
      const config = loaded.config;
      if (subcommand === "help" || !subcommand) {
        publish(pi, "KCP help", KCP_HELP);
        show(ctx, KCP_HELP);
        return;
      }
      if (loaded.status === "invalid" && subcommand !== "health") {
        show(ctx, `Invalid .pi/kcp.json: ${loaded.errors.join("; ")} (run /kcp health for diagnostics)`, "warning");
        return;
      }
      if (!config.enabled && subcommand !== "health") {
        show(ctx, "pi-kcp is disabled in .pi/kcp.json", "warning");
        return;
      }

      if (subcommand === "recall") {
        const query = rest.join(" ").trim();
        if (!query) {
          show(ctx, "Usage: /kcp recall <query>", "warning");
          return;
        }
        try {
          const correlationId = loop.currentCorrelationId();
          const sessions = await recall(config.memoryUrl, query, config, correlationId);
          const block = formatRecallBlock(query, sessions);
          if (!block) {
            show(ctx, `No kcp-memory results for: ${query}`);
            return;
          }
          publish(pi, "KCP recall", block, correlationId);
          show(ctx, `Added ${sessions.length} memory result(s) to the next turn.`);
        } catch (error) {
          show(ctx, `kcp-memory unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return;
      }

      if (subcommand === "plan") {
        const intent = rest.join(" ").trim();
        if (!intent) {
          show(ctx, "Usage: /kcp plan <intent>", "warning");
          return;
        }
        try {
          const correlationId = loop.currentCorrelationId();
          const plan = await runPlan(pi, ctx.cwd, intent, config, correlationId);
          publish(pi, "KCP plan", plan, correlationId);
          show(ctx, "Added the kcp-agent load plan to the next turn.");
        } catch (error) {
          show(ctx, error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }

      if (subcommand === "validate") {
        try {
          const report = await runValidate(pi, ctx.cwd, config);
          publish(pi, "KCP validation", report);
          show(ctx, "Added the kcp-agent validation report to the next turn.");
        } catch (error) {
          show(ctx, error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }

      if (subcommand === "init") {
        try {
          const result = await runInit(pi, ctx.cwd, config);
          publish(pi, "KCP initialization", result);
          show(ctx, "Created knowledge.yaml and added the result to the next turn.");
        } catch (error) {
          show(ctx, error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }

      if (subcommand === "evidence") {
        const turns = loop.recentTurns();
        if (turns.length === 0) {
          show(ctx, "pi-kcp evidence: no turns recorded yet (governed cycle off, or no turn has ended).");
          return;
        }
        const count = Math.max(1, Math.min(Number(rest[0]) || 1, turns.length));
        show(ctx, turns.slice(-count).map(renderTurnRecord).join("\n\n"));
        return;
      }

      if (subcommand === "govern") {
        const arg = (rest[0] ?? "").toLowerCase();
        const configured: GovernanceMode = config.enabled ? config.governance : "off";

        if (arg === "status" || arg === "") {
          const effective = governOverride ?? configured;
          const via = governOverride === undefined ? "from .pi/kcp.json" : "session override";
          show(
            ctx,
            `pi-kcp governance: ${effective} (${via})\n` +
              `configured: ${configured} · gate-failure posture: ${config.gateFailurePosture}\n` +
              `  full — all seven stages, gates skills through the planner (needs kcp-agent)\n` +
              `  tool — conformance and integrity at the tool boundary\n` +
              `  off  — no cycle (tool_call conformance still runs)`,
          );
          return;
        }

        if (arg === "full" || arg === "tool" || arg === "off") {
          governOverride = arg;
          show(ctx, `pi-kcp governance: ${arg} (session override; .pi/kcp.json unchanged)`);
          // Weakening the guarantee is itself a governance decision, so it leaves the same
          // trace a lapse does rather than happening quietly. Strengthening it need not.
          if (RANK[arg] < RANK[configured]) {
            pi.sendMessage(
              {
                customType: "pi-kcp",
                content:
                  `## KCP — governance lowered to **${arg}**\n\nConfigured mode is \`${configured}\`. ` +
                  (arg === "off"
                    ? "The cycle is disabled for this session; tool calls are no longer covered by the governance guarantee."
                    : "The full cycle is no longer running; the tool boundary still is.") +
                  "\n\nRestore with `/kcp govern " + configured + "`.",
                display: true,
              },
              { deliverAs: "nextTurn" },
            );
          }
          return;
        }

        show(ctx, `Usage: /kcp govern <full|tool|off|status>`, "warning");
        return;
      }

      if (subcommand === "health") {
        const memory = await fetchJson(`${config.memoryUrl.replace(/\/$/, "")}/health`, config.timeoutMs)
          .then(() => "ok")
          .catch(() => "unavailable");
        const agent = await findAgentInvocation(pi, config);
        const configLine = loaded.status === "invalid"
          ? `invalid — ${loaded.errors.join("; ")}`
          : `${loaded.status}${config.enabled ? "" : " (disabled)"}`;
        show(ctx, `pi-kcp health\nconfig: ${configLine}\nkcp-memory: ${memory}\nkcp-agent: ${agent?.label ?? "unavailable — set agentCli or install kcp-agent"}`);
        return;
      }

      show(ctx, `Unknown /kcp subcommand: ${subcommand}\n\n${KCP_HELP}`, "warning");
    },
  });

  // Whether the governed cycle is running for the turn now in progress. Decided once, at
  // the turn boundary: a turn is governed under one configuration, not one that can change
  // under it mid-flight — and it keeps the cycle off the disk on every lifecycle event.
  let mode: GovernanceMode = "off";
  // Session override from `/kcp govern`; `undefined` means defer to configuration.
  let governOverride: GovernanceMode | undefined;
  // Decided at the same boundary, for the same reason: the posture that applies to a turn
  // is the one in force when it started.
  let posture: GateFailurePosture = "announce";
  // The turn's configuration, captured with it, so the plan stage need not re-read disk.
  let turnConfig: KcpConfig = defaultConfig;

  // Mint a fresh per-turn correlation id (#29) at the turn boundary.
  pi.on("turn_start", async (event, ctx) => {
    const { config } = await loadConfig(ctx.cwd);
    mode = governOverride ?? (config.enabled ? config.governance : "off");
    loop.beginTurn(event.turnIndex, mode);
    posture = config.gateFailurePosture;
    turnConfig = config;
    // Let `.pi/kcp.json` drive strict mode for the built-in checker, unless RegisterOptions
    // pinned it. Only the checker we own is mutated (never an injected one).
    if (builtInChecker && options.requireActiveSkill === undefined) {
      builtInChecker.requireActiveSkill = config.requireActiveSkill;
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    // Detect user-forced skills (#28): `/skill:<name>` selects a skill for the turn.
    loop.observeInput(event.text, getCommands());
    const config = (await loadConfig(ctx.cwd)).config;
    const transformed = await augmentPrompt(event.text, config);
    return transformed === event.text
      ? { action: "continue" as const }
      : { action: "transform" as const, text: transformed };
  });

  // Runtime-depth observation + governance boundary (#28 detection, #27 enforcement).
  // Detects agent skill loads (read of SKILL.md), stamps the action with the turn
  // correlation id, and blocks non-conformant calls via the injected conformance seam.
  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    let decision: GovernanceDecision = { block: false };
    // The approve stage. Recorded through the ledger so a broken gate is a fact rather
    // than a swallowed exception; `evaluateToolCall` itself still decides.
    await loop.stage("approve", async () => {
      decision = await loop.evaluateToolCall(event.toolName, input, { cwd: ctx.cwd }, getCommands());
      // The digest of what was actually on the table when the gate decided. Pi invites
      // later extensions to mutate `event.input` in place, so this is the only record of
      // what the approval referred to.
      const inputDigest = digest(input);
      const detail = { tool: event.toolName, toolCallId: event.toolCallId, inputDigest };
      if (decision.block) {
        return { status: "blocked" as const, reason: decision.reason, detail };
      }
      loop.noteApproval(event.toolCallId, inputDigest);
      return { detail };
    });

    // Fail-closed posture. If a stage has errored this turn, the runtime cannot establish
    // what is authorized — so under `block` it authorizes nothing further. `tool_call` is
    // the only refusal Pi actually honours, which is why enforcement lives here and not at
    // the stage that broke.
    if (!decision.block && posture === "block" && !loop.gateHealthy()) {
      decision = {
        block: true,
        reason:
          "governance could not be established for this turn (a stage gate errored); " +
          'fail-closed by gateFailurePosture: "block"',
      };
    }

    return decision.block ? { block: true, reason: decision.reason } : undefined;
  });

  registerGovernedCycle(pi, loop, () => mode, () => turnConfig);
}

/**
 * The governed cycle across Pi's lifecycle (#27). Eight events, seven stages, one decision
 * record per stage per turn.
 *
 * `before_provider_request` is deliberately not used: its payload and result are both
 * `unknown`, an untyped escape hatch. Every stage below anchors on a typed contract.
 * See docs/decisions/0003-governed-runtime.md.
 */
function registerGovernedCycle(
  pi: ExtensionAPI,
  loop: GovernedLoop,
  mode: () => GovernanceMode,
  turnConfig: () => KcpConfig,
): void {
  // The five non-tool stages belong to `full` only. `tool` mode is the governance
  // boundary without the per-turn planner invocation.
  const full = (): boolean => mode() === "full";
  const anyCycle = (): boolean => mode() !== "off";
  // plan — the prompt is known and Pi has already assembled what it loaded, so the stage
  // can inspect that rather than re-discovering resources.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!full()) return undefined;
    await loop.stage("plan", async () => {
      const detail: Record<string, unknown> = {
        promptBytes: Buffer.byteLength(event.prompt, "utf8"),
        systemPromptBytes: Buffer.byteLength(event.systemPrompt, "utf8"),
        systemPromptDigest: digest(event.systemPrompt),
        ...(loop.currentSkill() ? { skill: loop.currentSkill()?.skillName } : {}),
      };

      // Procedural governance (#28): adjudicate declared units against the planner's gates
      // now, so skill selection later in the turn has a verdict to consult — and so a skill
      // already forced at `input` can still be revoked before it shapes anything.
      const trace = await runSkillTrace(
        pi,
        ctx.cwd,
        event.prompt,
        turnConfig(),
        loop.currentCorrelationId(),
      );
      if (trace === undefined) {
        return { detail: { ...detail, gated: false } };
      }

      const units = parseTrace(trace);
      const revoked = loop.setTracedUnits(units);
      return {
        detail: {
          ...detail,
          gated: true,
          units: units.length,
          ...(revoked ? { revokedSkill: revoked.skillName } : {}),
        },
      };
    });
    return undefined;
  });

  // load — the context assembly point. Phase 1 records what was assembled; injection of
  // planned units lands with the evidence-integrity work (Phase 3).
  pi.on("context", async (event) => {
    if (!full()) return undefined;
    await loop.stage("load", async () => ({
      detail: { messages: event.messages.length, contextDigest: digest(event.messages) },
    }));
    return undefined;
  });

  // synthesize is the provider's, and ground checks what it returned. Both are known at
  // agent_end: the messages are the evidence that synthesis happened at all.
  pi.on("agent_end", async (event) => {
    if (!full()) return undefined;
    await loop.stage("synthesize", async () => ({
      detail: { owner: "provider", messages: event.messages.length },
    }));
    await loop.stage("ground", async () => ({
      detail: { messages: event.messages.length },
    }));
    return undefined;
  });

  // act — the outcome of a tool call, which the approve stage never sees. Without this the
  // loop watches actions get proposed and never learns what they did.
  pi.on("tool_result", async (event) => {
    if (!anyCycle()) return undefined;
    await loop.stage("act", async () => {
      // `afterToolCall` hands back the same args object `beforeToolCall` saw, so this
      // compares what ran against what was approved rather than restating the intent.
      const outcome = loop.checkExecuted(event.toolCallId, event.input);
      return {
        ...outcome,
        ...(outcome.status === undefined && event.isError
          ? { reason: `tool ${event.toolName} reported an error` }
          : {}),
        detail: { ...outcome.detail, tool: event.toolName, isError: event.isError },
      };
    });
    return undefined;
  });

  // assess closes the cycle, then the turn record is emitted and its governance asserted.
  pi.on("turn_end", async (event) => {
    if (!anyCycle()) return undefined;
    if (full()) {
      await loop.stage("assess", async () => ({
        detail: { toolResults: event.toolResults.length },
      }));
    }

    // Close out the tool stages the turn never reached. `approve` absent means no tool was
    // called at all; `act` absent with `approve` present means the call was blocked or
    // never ran. Both are decisions, and recording them keeps the liveness warning for
    // turns where the cycle genuinely did not run.
    const missing = new Set(missingStages(loop.turnRecord()));
    const approvedSomething = !missing.has("approve");
    for (const stage of TOOL_STAGES) {
      if (!missing.has(stage)) continue;
      const reason =
        stage === "act" && approvedSomething
          ? "tool call did not execute — blocked, or the turn ended first"
          : "no tool call this turn";
      await loop.stage(stage, async () => ({ status: "skipped" as const, reason }));
    }

    loop.finishTurn();
    return undefined;
  });
}

export { helpMentionsFlag, supportsFlag, resetCapabilityCache } from "./agent-capability.js";
