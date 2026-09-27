/**
 * The real {@link PersonaTurnDriver}: one Pi turn, in-process, via Pi's SDK.
 *
 * Why in-process and not `pi --mode rpc` as a subprocess: Pi v0.80.6 ships a first-class SDK
 * (`createAgentSession`, `DefaultResourceLoader.extensionFactories`) and its own docs prefer it
 * over spawning when you are already in Node ("consider using AgentSession directly …
 * instead of spawning a subprocess", pi-coding-agent/docs/rpc.md). It is also the only way to
 * reach `RegisterOptions` — a file-loaded extension (`-e`) is called with `factory(api)` alone,
 * so the injected {@link GovernedLoop} that carries the signed-ledger hook could never be
 * wired through the subprocess route. And the RPC route needs stdin held open until the reply
 * is read, which the bridge contract forbids the wrapper to do anything with at all.
 *
 * Isolation choices, all deliberate:
 *   - `AuthStorage.inMemory()` + `setRuntimeApiKey`: `~/.pi/agent/auth.json` is never read, and
 *     the runtime override outranks everything else in Pi's `getApiKey`. One caveat, verified:
 *     Pi's in-memory storage STILL falls back to the provider's conventional env vars
 *     (`ANTHROPIC_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` for anthropic) when no override is set — so
 *     the "no credential" smoke mode of {@link createPersonaSession} is only credential-free in
 *     an environment without them. Under the bridge the child env is `{[token_env]: value}`
 *     only, so the credential the wrapper injects is the only one Pi can see there.
 *   - `ModelRegistry.inMemory`: Pi's built-in model catalogue only, no `models.json`.
 *   - `SettingsManager.inMemory({compaction:{enabled:false}})`: no user settings, no
 *     compaction turn sneaking a second model call into a one-turn process.
 *   - `SessionManager.inMemory(cwd)`: nothing written under `~/.pi/agent/sessions`.
 *   - a throwaway, empty `agentDir`: global extensions/skills/prompts/themes do not load.
 *     `noExtensions: true` on the loader additionally skips project `.pi/extensions`, while
 *     inline factories still load (resource-loader.js:267-269) — so pi-kcp is the ONLY extension.
 *   - project skills from `<cwd>/.pi/skills` DO load: governed skills are what pi-kcp gates.
 *   - `noTools: "all"` unless `--tools` names an allowlist: a persona turn is an answer, not an
 *     edit session, and every tool granted is a tool the 60 s budget has to pay for.
 *
 * Pi's SDK is imported dynamically: `@earendil-works/pi-coding-agent` is a devDependency here
 * (pi-kcp normally runs inside Pi), so the module must stay loadable — and the tests for the
 * rest of the wrapper runnable — without it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type DriverInput, type DriverResult, type DriverStopReason, WrapperUsageError } from "./wrapper-cli.js";

async function loadPiSdk() {
  try {
    return await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    throw new Error(
      `pi-kcp persona-turn needs @earendil-works/pi-coding-agent installed next to it (it is a devDependency of pi-kcp): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface PersonaSessionInput {
  cwd: string;
  model: string;
  /** Omit to build a session with no credential (nothing can be prompted; useful for smoke tests). */
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  tools: readonly string[];
  extension: (pi: ExtensionAPI) => void | Promise<void>;
}

export interface PersonaSession {
  session: AgentSession;
  /** `provider/id` of the resolved model. */
  model: string;
  /** Names of the slash commands the loaded extensions registered — `kcp` must be among them. */
  commands: string[];
  /** Dispose the session and remove the throwaway agent dir. Idempotent. */
  dispose: () => void;
}

/**
 * Build the isolated Pi session with pi-kcp as its only extension. Exported separately from the
 * turn so the embedding path (SDK + inline factory + real `register()`) can be exercised without
 * a credential and without a model call.
 */
export async function createPersonaSession(input: PersonaSessionInput): Promise<PersonaSession> {
  const pi = await loadPiSdk();
  const agentDir = mkdtempSync(join(tmpdir(), "pi-kcp-persona-agent-"));
  let disposed = false;
  const cleanup = (session?: AgentSession) => {
    if (disposed) return;
    disposed = true;
    session?.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  };

  try {
    const authStorage = pi.AuthStorage.inMemory();
    const modelRegistry = pi.ModelRegistry.inMemory(authStorage);
    const resolved = pi.resolveCliModel({ cliModel: input.model, modelRegistry });
    if (!resolved.model) {
      throw new WrapperUsageError(`--model ${JSON.stringify(input.model)} did not resolve: ${resolved.error ?? "unknown model"}`);
    }
    if (input.apiKey) authStorage.setRuntimeApiKey(resolved.model.provider, input.apiKey);

    const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false } });
    const loader = new pi.DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "pi-kcp", factory: input.extension }],
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.appendSystemPrompt ? { appendSystemPrompt: [input.appendSystemPrompt] } : {}),
    });
    await loader.reload();

    const { session, extensionsResult } = await pi.createAgentSession({
      cwd: input.cwd,
      agentDir,
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel ?? "off",
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader: loader,
      sessionManager: pi.SessionManager.inMemory(input.cwd),
      ...(input.tools.length > 0 ? { tools: [...input.tools] } : { noTools: "all" }),
    });
    if (extensionsResult.errors.length > 0) {
      cleanup(session);
      throw new Error(`extension load failed — the turn cannot be governed: ${extensionsResult.errors.map((e) => `${e.path}: ${e.error}`).join("; ")}`);
    }
    const commands = extensionsResult.extensions.flatMap((ext) => [...ext.commands.keys()]);
    return {
      session,
      model: `${resolved.model.provider}/${resolved.model.id}`,
      commands,
      dispose: () => cleanup(session),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * The turn itself. `session.prompt` resolves only after the whole accepted run finishes,
 * retries included (Pi's `AgentSession.prompt` contract); the reply is read exactly the way
 * Pi's own print mode reads it (last assistant message; `error`/`aborted` stop reasons are
 * failures, `text` parts are the reply).
 */
export const runPiPersonaTurn = async (input: DriverInput): Promise<DriverResult> => {
  const persona = await createPersonaSession(input);
  const { session } = persona;
  const timer = setTimeout(() => {
    void session.abort();
  }, input.timeoutMs);
  try {
    await session.prompt(input.prompt);
    const last = session.state.messages.at(-1);
    if (!last || last.role !== "assistant") {
      return { reply: "", stopReason: "none", errorMessage: "no assistant message after the turn", model: persona.model };
    }
    const stopReason = last.stopReason as DriverStopReason;
    const reply = last.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    return {
      reply,
      stopReason,
      ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}),
      model: persona.model,
    };
  } finally {
    clearTimeout(timer);
    persona.dispose();
  }
};
