import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  augmentPrompt,
  defaultConfig,
  formatRecallBlock,
  recall,
  type KcpConfig,
} from "../src/index.js";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/search") return new Response("not found", { status: 404 });

      const query = url.searchParams.get("q");
      if (query === "error") return new Response("failed", { status: 500 });
      if (query === "slow") {
        await Bun.sleep(100);
        return Response.json({ results: [] });
      }
      if (query === "malformed") return Response.json({ results: "not an array" });
      if (query === "empty") return Response.json({ query, count: 0, results: [] });

      return Response.json({
        query,
        count: 1,
        results: [{ slug: "memory-session", firstMessage: "Remembered a project decision" }],
      });
    },
  });
});

afterAll(() => server.stop(true));

function config(overrides: Partial<KcpConfig> = {}): KcpConfig {
  return {
    ...defaultConfig,
    memoryUrl: `http://localhost:${server.port}`,
    timeoutMs: 25,
    ...overrides,
  };
}

describe("kcp-memory HTTP integration", () => {
  it("reads healthy search results", async () => {
    const sessions = await recall(config().memoryUrl, "deployment", config({ timeoutMs: 250 }));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.slug).toBe("memory-session");
  });

  it("handles empty and malformed responses", async () => {
    expect(await recall(config().memoryUrl, "empty", config())).toEqual([]);
    expect(await recall(config().memoryUrl, "malformed", config())).toEqual([]);
  });

  it("rejects HTTP errors and timeouts", async () => {
    await expect(recall(config().memoryUrl, "error", config())).rejects.toThrow("HTTP 500");
    await expect(recall(config().memoryUrl, "slow", config())).rejects.toThrow();
  });

  it("fails open when automatic recall cannot reach memory", async () => {
    const prompt = "What did we decide about deployment last time?";
    const result = await augmentPrompt(prompt, config(), async () => {
      throw new Error("daemon unavailable");
    });
    expect(result).toBe(prompt);
  });

  it("bounds injected memory context", () => {
    const block = formatRecallBlock("large query", [
      { firstMessage: "x".repeat(100_000) },
    ]);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(12_000);
  });
});
