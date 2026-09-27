// The REAL embedding path — Pi's SDK in-process with pi-kcp as an inline extension — up to
// the model call. No credential is given, so nothing can be prompted and nothing is spent;
// what this proves is that createAgentSession + DefaultResourceLoader.extensionFactories +
// the real register() compose, in isolation from ~/.pi, and that Pi refuses the prompt
// before any network call when no key is present. The live turn itself needs a key: see
// README "Persona-turn wrapper" for the by-hand smoke test.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersonaSession } from "../src/wrapper-pi-driver.js";
import { WrapperUsageError } from "../src/wrapper-cli.js";
import register from "../src/index.js";
import { GovernedLoop } from "../src/governed-loop.js";
import type { TurnRecord } from "../src/runtime.js";

/**
 * Pi's AuthStorage falls back to these process env vars for the anthropic provider even when
 * the storage itself is in-memory (auth-storage.js `getApiKey` → pi-ai `getEnvApiKey`). A
 * developer's shell may well have one set — found the hard way: the first run of this file
 * let `session.prompt` reach Pi's request path with the ambient key instead of being refused.
 * Under the bridge the child env is `{[token_env]: value}` only, so this leak cannot happen
 * there; in this test process it is removed for the duration and restored afterwards.
 */
const ANTHROPIC_ENV_FALLBACKS = ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();

let workspace = "";
beforeAll(() => {
  for (const name of ANTHROPIC_ENV_FALLBACKS) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  workspace = mkdtempSync(join(tmpdir(), "pi-kcp-driver-"));
  mkdirSync(join(workspace, ".pi"), { recursive: true });
  writeFileSync(join(workspace, ".pi", "kcp.json"), JSON.stringify({ enabled: true, autoRecall: false, governance: "tool" }));
});
afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
});

describe("createPersonaSession — Pi SDK embedding with pi-kcp as the only extension", () => {
  it("builds an isolated session with /kcp registered, no tools, and no session file", async () => {
    const records: TurnRecord[] = [];
    const loop = new GovernedLoop({ hooks: { onTurnRecorded: (r) => records.push(r) } });
    const persona = await createPersonaSession({
      cwd: workspace,
      model: "anthropic/claude-sonnet-4-5",
      tools: [],
      extension: (pi) => register(pi, { loop }),
    });
    try {
      expect(persona.model).toBe("anthropic/claude-sonnet-4-5");
      expect(persona.commands).toContain("kcp");
      expect(persona.session.getActiveToolNames()).toEqual([]);
      expect(persona.session.sessionFile).toBeUndefined();
      expect(persona.session.model?.provider).toBe("anthropic");

      // No credential: Pi refuses before any request leaves the process — and, because the
      // refusal is Pi's preflight, no turn_start fires and nothing reaches the ledger.
      await expect(persona.session.prompt("hello")).rejects.toThrow(/No API key found for anthropic/);
      expect(records).toEqual([]);
    } finally {
      persona.dispose();
    }
  });

  it("honours a tool allowlist and a persona system prompt", async () => {
    const persona = await createPersonaSession({
      cwd: workspace,
      model: "anthropic/claude-sonnet-4-5",
      tools: ["read"],
      systemPrompt: "You are the release manager persona.",
      appendSystemPrompt: "Grounding: freeze at 17:00.",
      extension: (pi) => register(pi),
    });
    try {
      expect(persona.session.getActiveToolNames()).toEqual(["read"]);
      expect(persona.session.systemPrompt).toContain("You are the release manager persona.");
      expect(persona.session.systemPrompt).toContain("Grounding: freeze at 17:00.");
    } finally {
      persona.dispose();
    }
  });

  it("maps an unknown model to a usage error (exit 2 territory), not a model failure", async () => {
    await expect(
      createPersonaSession({ cwd: workspace, model: "nonesuch/definitely-not-a-model", tools: [], extension: (pi) => register(pi) }),
    ).rejects.toBeInstanceOf(WrapperUsageError);
  });
});
