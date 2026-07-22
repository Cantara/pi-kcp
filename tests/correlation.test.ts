import { describe, expect, it } from "bun:test";
import {
  childContext,
  GovernedLoop,
  isTraceparent,
  mintTraceparent,
} from "../src/index.js";

describe("W3C traceparent correlation ids (#29)", () => {
  it("mints valid, unique traceparents", () => {
    const a = mintTraceparent();
    const b = mintTraceparent(3);
    expect(isTraceparent(a.correlationId)).toBe(true);
    expect(isTraceparent(b.correlationId)).toBe(true);
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(b.turnIndex).toBe(3);
    expect(a.correlationId).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it("rejects malformed or all-zero traceparents", () => {
    expect(isTraceparent("not-a-traceparent")).toBe(false);
    expect(isTraceparent("00-00000000000000000000000000000000-0000000000000000-01")).toBe(false);
  });

  it("derives a child span sharing the trace-id", () => {
    const parent = mintTraceparent();
    const child = childContext(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(isTraceparent(child.correlationId)).toBe(true);
  });
});

describe("correlation-id threading through the governed loop", () => {
  it("re-mints the correlation id per turn", () => {
    const loop = new GovernedLoop();
    const first = loop.beginTurn(0).correlationId;
    const second = loop.beginTurn(1).correlationId;
    expect(first).not.toBe(second);
    expect(loop.currentCorrelationId()).toBe(second);
  });

  it("threads a single correlation id into recall, plan, and publish", async () => {
    const loop = new GovernedLoop();
    loop.beginTurn(0);
    const seen: Record<string, string[]> = { recall: [], runPlan: [], publish: [] };
    const outcome = await loop.orchestrate(
      {
        recall: async (_query, correlationId) => {
          seen.recall.push(correlationId);
          return "## Episodic Memory\n- prior work";
        },
        runPlan: async (_intent, correlationId) => {
          seen.runPlan.push(correlationId);
          return '{"plan": []}';
        },
        publish: (_title, _content, correlationId) => {
          seen.publish.push(correlationId);
        },
      },
      { intent: "ship the release", recallQuery: "release" },
    );

    // Same correlation id everywhere, and it is a valid child of the turn trace.
    const all = [...seen.recall, ...seen.runPlan, ...seen.publish];
    expect(new Set(all).size).toBe(1);
    expect(all[0]).toBe(outcome.correlationId);
    expect(isTraceparent(outcome.correlationId)).toBe(true);
    expect(outcome.correlationId.slice(3, 35)).toBe(loop.turnContext.traceId);
    // recall block published + plan published => 2 publishes
    expect(seen.publish).toHaveLength(2);
  });

  it("skips recall when no query is supplied", async () => {
    const loop = new GovernedLoop();
    let recallCalls = 0;
    const outcome = await loop.orchestrate(
      {
        recall: async () => {
          recallCalls += 1;
          return "";
        },
        runPlan: async () => '{"plan": []}',
        publish: () => {},
      },
      { intent: "no recall" },
    );
    expect(recallCalls).toBe(0);
    expect(outcome.plan).toBe('{"plan": []}');
  });
});
