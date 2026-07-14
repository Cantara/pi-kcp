import { describe, expect, it } from "bun:test";
import { formatRecallBlock, shouldRecall } from "../src/index.js";

const fixtures = [
  { prompt: "What did we decide about deployment?", expected: true },
  { prompt: "Can you remind me what we built last week?", expected: true },
  { prompt: "Continue from where we left off.", expected: true },
  { prompt: "Do you remember the authentication fix?", expected: true },
  { prompt: "3 days ago we changed the parser.", expected: true },
  { prompt: "Fix the type error in compiler.ts.", expected: false },
  { prompt: "Build the project.", expected: false },
  { prompt: "Run the unit tests.", expected: false },
  { prompt: "What is the current deployment status?", expected: false },
  { prompt: "Use the previous value in this configuration.", expected: false },
] as const;

describe("automatic recall quality corpus", () => {
  it("meets the current precision and recall threshold", () => {
    const predictions = fixtures.map(({ prompt }) => shouldRecall(prompt));
    const truePositives = fixtures.filter(({ expected }, index) => expected && predictions[index]).length;
    const falsePositives = fixtures.filter(({ expected }, index) => !expected && predictions[index]).length;
    const falseNegatives = fixtures.filter(({ expected }, index) => expected && !predictions[index]).length;
    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);

    expect(precision).toBeGreaterThanOrEqual(0.9);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps signal detection fast", () => {
    const started = performance.now();
    for (let i = 0; i < 1_000; i += 1) {
      for (const { prompt } of fixtures) shouldRecall(prompt);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("keeps generated memory context bounded", () => {
    const block = formatRecallBlock("quality fixture", [{ firstMessage: "x".repeat(100_000) }]);
    expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(12_000);
  });
});
