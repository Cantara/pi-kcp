/**
 * Canonical form and digests for the evidence spine (#29).
 *
 * The runtime records what a tool call *was* at approval and what it *had become* by
 * execution. Comparing those needs a form that is stable under things which carry no
 * meaning (key order) and sensitive to things which do (array order, values).
 */
import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, arrays left alone, `undefined` members dropped
 * so an absent key and an explicitly-undefined one agree.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/** A labelled digest of `value`'s canonical form: `sha256:<hex>`. */
export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
