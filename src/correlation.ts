/**
 * Correlation identifiers for runtime-depth governance (#29).
 *
 * Every governed turn (and, where useful, every governed action) is stamped with a
 * W3C `traceparent` so that recall lookups, plan invocations, published messages, and
 * — eventually — kcp-harness conformance decisions can all be correlated end to end.
 *
 * traceparent format (W3C Trace Context, version 00):
 *   00-<32 hex trace-id>-<16 hex span-id>-<2 hex flags>
 */

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Per-turn (or per-action) correlation context threaded through the governed loop. */
export interface TurnContext {
  /** The full W3C traceparent string. This is the value threaded everywhere as the correlation id. */
  readonly correlationId: string;
  /** The 32-hex trace-id component. */
  readonly traceId: string;
  /** The 16-hex span-id component. */
  readonly spanId: string;
  /** The turn index this context was minted for, when known. */
  readonly turnIndex?: number;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Mint a fresh child span-id (16 hex) under an existing trace-id. */
export function mintSpanId(): string {
  return randomHex(8);
}

/** Mint a new W3C traceparent, sampled flag set (01). */
export function mintTraceparent(turnIndex?: number): TurnContext {
  const traceId = randomHex(16);
  const spanId = mintSpanId();
  return {
    correlationId: `00-${traceId}-${spanId}-01`,
    traceId,
    spanId,
    ...(turnIndex === undefined ? {} : { turnIndex }),
  };
}

/** Derive a child TurnContext sharing the trace-id but with a fresh span-id. */
export function childContext(parent: TurnContext): TurnContext {
  const spanId = mintSpanId();
  return {
    correlationId: `00-${parent.traceId}-${spanId}-01`,
    traceId: parent.traceId,
    spanId,
    ...(parent.turnIndex === undefined ? {} : { turnIndex: parent.turnIndex }),
  };
}

/** True when the value is a syntactically valid, non-invalid W3C traceparent. */
export function isTraceparent(value: string): boolean {
  if (!TRACEPARENT_RE.test(value)) return false;
  const [, traceId, spanId] = value.split("-");
  // The all-zero trace-id or span-id is invalid per the spec.
  return !/^0+$/.test(traceId) && !/^0+$/.test(spanId);
}
