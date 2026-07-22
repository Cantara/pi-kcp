import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { GovernedLoop } from "./governed-loop.js";
import { type ConformanceChecker } from "./conformance.js";
import { HarnessConformanceChecker } from "./harness-conformance.js";

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
export { GovernedLoop } from "./governed-loop.js";
export type { GovernanceDecision, PlanProduced } from "./governed-loop.js";
export { childContext, isTraceparent, mintTraceparent } from "./correlation.js";
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
}

const DEFAULT_MEMORY_URL = "http://localhost:7735";
const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_MAX_RESULTS = 3;
const MAX_CONTEXT_BYTES = 12_000;
const CONFIG_FILE = ".pi/kcp.json";

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
/kcp init                 Create knowledge.yaml without overwriting an existing file`;

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

async function runKcpAgent(pi: ExtensionAPI, cwd: string, args: string[], config: KcpConfig, correlationId?: string): Promise<string> {
  const invocation = await findAgentInvocation(pi, config);
  if (!invocation) throw new Error(agentNotFoundMessage(config));

  const correlationArgs = correlationId ? ["--correlation-id", correlationId] : [];
  const result = await pi.exec(
    invocation.command,
    [...invocation.args, ...args, ...correlationArgs],
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

async function runPlan(pi: ExtensionAPI, cwd: string, intent: string, config: KcpConfig, correlationId?: string): Promise<string> {
  const output = await runKcpAgent(pi, cwd, ["plan", intent, "--manifest", resolve(cwd, config.manifest), "--json"], config, correlationId);
  return normalizePlanJson(output);
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
  const loop = new GovernedLoop({
    checker: options.conformanceChecker ?? builtInChecker!,
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

  // Mint a fresh per-turn correlation id (#29) at the turn boundary.
  pi.on("turn_start", async (event, ctx) => {
    loop.beginTurn(event.turnIndex);
    // Let `.pi/kcp.json` drive strict mode for the built-in checker, unless RegisterOptions
    // pinned it. Only the checker we own is mutated (never an injected one).
    if (builtInChecker && options.requireActiveSkill === undefined) {
      builtInChecker.requireActiveSkill = (await loadConfig(ctx.cwd)).config.requireActiveSkill;
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
    const decision = await loop.evaluateToolCall(event.toolName, input, { cwd: ctx.cwd }, getCommands());
    if (decision.block) {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });
}
