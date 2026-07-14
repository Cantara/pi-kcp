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

async function recall(memoryUrl: string, query: string, config: KcpConfig): Promise<MemorySession[]> {
  const url = new URL("/search", `${memoryUrl.replace(/\/$/, "")}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(config.maxResults));
  return parseSearchResults(await fetchJson(url.toString(), config.timeoutMs));
}

async function findAgentCli(config: KcpConfig): Promise<string | undefined> {
  const candidates = [
    config.agentCli,
    process.env.KCP_AGENT_CLI,
    "/opt/homebrew/lib/node_modules/kcp-harness/node_modules/kcp-agent/dist/cli.js",
    `${process.env.HOME ?? ""}/.npm-global/lib/node_modules/kcp-harness/node_modules/kcp-agent/dist/cli.js`,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next known installation location.
    }
  }
  return undefined;
}

async function runPlan(pi: ExtensionAPI, cwd: string, intent: string, config: KcpConfig): Promise<string> {
  const cli = await findAgentCli(config);
  if (!cli) {
    throw new Error("kcp-agent CLI was not found. Set agentCli in .pi/kcp.json or install kcp-agent.");
  }

  const result = await pi.exec(
    "node",
    [cli, "plan", intent, "--manifest", resolve(cwd, config.manifest)],
    { timeout: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `kcp-agent exited with code ${result.code}`);
  }
  return result.stdout.trim();
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
      const loaded = await loadConfig(ctx.cwd);
      const config = loaded.config;
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

      if (subcommand === "health") {
        const memory = await fetchJson(`${config.memoryUrl.replace(/\/$/, "")}/health`, config.timeoutMs)
          .then(() => "ok")
          .catch(() => "unavailable");
        const agent = (await findAgentCli(config)) ? "found" : "unavailable";
        const configLine = loaded.status === "invalid"
          ? `invalid — ${loaded.errors.join("; ")}`
          : `${loaded.status}${config.enabled ? "" : " (disabled)"}`;
        show(ctx, `pi-kcp health\nconfig: ${configLine}\nkcp-memory: ${memory}\nkcp-agent: ${agent}`);
        return;
      }

      show(ctx, "Usage: /kcp <help|health|recall <query>|plan <intent>>");
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const config = (await loadConfig(ctx.cwd)).config;
    if (!config.enabled || !config.autoRecall || !shouldRecall(event.text)) {
      return { action: "continue" as const };
    }

    try {
      const query = extractRecallQuery(event.text);
      const sessions = await recall(config.memoryUrl, query, config);
      const block = formatRecallBlock(query, sessions);
      return block
        ? { action: "transform" as const, text: `${block}\n\n${event.text}` }
        : { action: "continue" as const };
    } catch {
      return { action: "continue" as const };
    }
  });
}
