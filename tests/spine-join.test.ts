// #29 — one evidence spine per task. The stages record correlation differently, and until
// this was measured the chain did not actually join:
//
//   pi-kcp / kcp-agent   00-4bf92f35…4736-00f067aa0ba902b7-01   (full W3C traceparent)
//   kcp-harness          4bf92f35…4736                          (trace-id only)
//
// Verified against kcp-harness's own deriveCorrelation, which maps trace-id → correlationId.
// A join on the traceparent string finds nothing.
//
// The trace-id is the only stable key, and this is not a preference. W3C Trace Context
// defines trace-id as identifying the trace and span-id as identifying the individual
// operation — so the traceparent string necessarily changes per hop. pi-kcp's own
// childContext() proves it: same task, same trace, different correlationId.

import { describe, expect, it } from "bun:test";
import { childContext, mintTraceparent, traceIdOf } from "../src/index.js";
import { correlationKey, deriveCorrelation } from "kcp-harness";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

describe("traceIdOf — the spine's join key", () => {
  it("extracts the trace-id from a full traceparent", () => {
    expect(traceIdOf(TRACEPARENT)).toBe(TRACE_ID);
  });

  it("passes a bare trace-id through — what kcp-harness records", () => {
    expect(traceIdOf(TRACE_ID)).toBe(TRACE_ID);
  });

  it("is idempotent", () => {
    expect(traceIdOf(traceIdOf(TRACEPARENT)!)).toBe(TRACE_ID);
  });

  it("returns undefined for anything it cannot read, rather than guessing", () => {
    for (const bad of ["", "not-a-traceparent", "00-tooshort-00f067aa0ba902b7-01", undefined, null, 42]) {
      expect(traceIdOf(bad as never), `${String(bad)} should not yield a key`).toBeUndefined();
    }
  });

  // The all-zero trace-id is invalid per W3C Trace Context. Joining on it would merge
  // unrelated tasks into one "chain", which is worse than having no key at all.
  it("rejects the all-zero trace-id", () => {
    expect(traceIdOf("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeUndefined();
    expect(traceIdOf("00000000000000000000000000000000")).toBeUndefined();
  });

  it("is case-insensitive on hex but normalises to lower case", () => {
    expect(traceIdOf(TRACE_ID.toUpperCase())).toBe(TRACE_ID);
  });
});

describe("the chain actually joins", () => {
  it("a child span shares the parent's join key though its correlationId differs", () => {
    const turn = mintTraceparent(1);
    const child = childContext(turn);
    expect(child.correlationId).not.toBe(turn.correlationId);
    expect(traceIdOf(child.correlationId)).toBe(traceIdOf(turn.correlationId));
  });

  it("joins records from all three components of one task", () => {
    // Exactly what each component records for the same task. The harness value comes from
    // kcp-harness's own deriveCorrelation rather than a hardcoded guess, so this breaks if
    // that reduction ever changes — which is the drift that would silently unstitch the
    // chain. (Public API as of kcp-harness 0.10.4.)
    const fromPiKcp = TRACEPARENT;                                        // ObservedAction.correlationId
    const fromKcpAgent = TRACEPARENT;                                     // plan --json envelope, verbatim
    const fromHarness = deriveCorrelation({ traceparent: TRACEPARENT }).correlationId;  // audit record

    const keys = new Set([fromPiKcp, fromKcpAgent, fromHarness].map(traceIdOf));
    expect(keys.size, "one task must resolve to one key").toBe(1);
    expect([...keys][0]).toBe(TRACE_ID);

    // The naive join — on the recorded value — does not work, which is the point.
    expect(new Set([fromPiKcp, fromKcpAgent, fromHarness]).size).toBe(2);
  });
});

// Two repositories independently reduce an id to the spine's join key: traceIdOf() here,
// correlationKey() in kcp-harness (public since 0.10.4). They must agree, or the chain
// splits in exactly the way this whole effort exists to prevent — and it splits silently,
// because each side is individually self-consistent.
describe("the two implementations of the join key agree", () => {
  const cases = [
    TRACEPARENT,
    TRACEPARENT.toUpperCase(),
    TRACE_ID,
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  ];

  for (const value of cases) {
    it(`agrees on ${value.slice(0, 24)}…`, () => {
      expect(traceIdOf(value)).toBe(correlationKey(value.toLowerCase()));
    });
  }

  // Where they deliberately differ, and why: correlationKey passes an unrecognised id
  // through, because the harness stores randomUUID()-minted ids verbatim and reducing them
  // would lose the chain. traceIdOf returns undefined, because a join key it cannot vouch
  // for would merge unrelated tasks. Both are right for their own job; the point is that
  // neither silently produces a *different* trace-id for the same input.
  it("differ only on ids that are not traceparents, and never disagree on one that is", () => {
    expect(correlationKey("some-uuid-style-id")).toBe("some-uuid-style-id");
    expect(traceIdOf("some-uuid-style-id")).toBeUndefined();

    const key = traceIdOf(TRACEPARENT);
    expect(key).toBeDefined();
    expect(correlationKey(TRACEPARENT)).toBe(key!);
  });
});
