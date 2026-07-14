import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  agentCli?: string;
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

interface SearchResponse {
  results?: unknown;
}

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

async function loadConfig(cwd: string): Promise<KcpConfig> {
  try {
    const raw = JSON.parse(await readFile(resolve(cwd, CONFIG_FILE), "utf8")) as Partial<KcpConfig>;
    return {
      ...defaultConfig,
      ...raw,
      maxResults: Math.min(Math.max(Number(raw.maxResults ?? DEFAULT_MAX_RESULTS), 1), 10),
      timeoutMs: Math.min(Math.max(Number(raw.timeoutMs ?? DEFAULT_TIMEOUT_MS), 50), 5_000),
    };
  } catch {
    return { ...defaultConfig };
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

export async function recall(memoryUrl: string, query: string, config: KcpConfig): Promise<MemorySession[]> {
  const url = new URL("/search", `${memoryUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(config.maxResults));
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

async function runKcpAgent(pi: ExtensionAPI, cwd: string, args: string[], config: KcpConfig): Promise<string> {
  const invocation = await findAgentInvocation(pi, config);
  if (!invocation) throw new Error(agentNotFoundMessage(config));

  const result = await pi.exec(
    invocation.command,
    [...invocation.args, ...args],
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

async function runPlan(pi: ExtensionAPI, cwd: string, intent: string, config: KcpConfig): Promise<string> {
  return runKcpAgent(pi, cwd, ["plan", intent, "--manifest", resolve(cwd, config.manifest)], config);
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

function publish(pi: ExtensionAPI, title: string, content: string): void {
  pi.sendMessage(
    {
      customType: "pi-kcp",
      content: `## ${title}\n\n${truncate(content)}`,
      display: true,
    },
    { deliverAs: "nextTurn" },
  );
}

export default function register(pi: ExtensionAPI): void {
  pi.registerCommand("kcp", {
    description: "Use KCP memory and deterministic knowledge plans",
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const config = await loadConfig(ctx.cwd);
      if (!config.enabled) {
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
          const sessions = await recall(config.memoryUrl, query, config);
          const block = formatRecallBlock(query, sessions);
          if (!block) {
            show(ctx, `No kcp-memory results for: ${query}`);
            return;
          }
          publish(pi, "KCP recall", block);
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
          const plan = await runPlan(pi, ctx.cwd, intent, config);
          publish(pi, "KCP plan", plan);
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
        show(ctx, `pi-kcp health\nkcp-memory: ${memory}\nkcp-agent: ${agent?.label ?? "unavailable — set agentCli or install kcp-agent"}`);
        return;
      }

      show(ctx, "Usage: /kcp <help|health|recall <query>|plan <intent>|validate|init>");
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const config = await loadConfig(ctx.cwd);
    const transformed = await augmentPrompt(event.text, config);
    return transformed === event.text
      ? { action: "continue" as const }
      : { action: "transform" as const, text: transformed };
  });
}
