// #151 — a persisted, signed record of the decision tree. TurnLedger (runtime.ts) and
// GovernedLoop's in-memory history (governed-loop.ts, TURN_HISTORY_LIMIT) already produce
// TurnRecords; this is the missing signing + persistence layer, reusing kcp-harness's
// existing ed25519 primitives (the same ones wallet.ts's settlement path already uses) rather
// than a second crypto implementation.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalSignedTurnPayload,
  createFileLedgerHook,
  signTurnRecord,
  verifyLedgerFile,
  verifySignedTurnEntry,
  type SignedTurnEntry,
} from "../src/signed-ledger.js";
import { DEMO_SIGNING_KEY_ID, DEMO_SIGNING_KEY_PEM } from "../src/wallet.js";
import type { TurnRecord } from "../src/runtime.js";

const SAMPLE_RECORD: TurnRecord = {
  turnIndex: 3,
  correlationId: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  decisions: [
    { stage: "plan", status: "ok", correlationId: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
    { stage: "act", status: "blocked", correlationId: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", reason: "deny-listed tool" },
  ],
  expectedStages: ["plan", "act"],
};

/**
 * A second, unrelated real ed25519 keypair (generated once via `crypto.generateKeyPairSync`,
 * not derived from DEMO_SIGNING_KEY_PEM), for the "wrong key" / trusted-key tests — a
 * genuinely different valid key, not garbage that would fail to parse for an unrelated reason.
 */
const OTHER_SIGNING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKssHsiXR5v63j/efMqFKNnYzioU4nSKxdDOLSIl4oNl
-----END PRIVATE KEY-----`;
const OTHER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkYJ4dmJaRyRwJD7qSvIiR2qxmMnc9TJ6wOv6ITbWauI=
-----END PUBLIC KEY-----`;

describe("canonicalSignedTurnPayload", () => {
  it("is deterministic for the same inputs", () => {
    const a = canonicalSignedTurnPayload(SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    const b = canonicalSignedTurnPayload(SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    expect(a).toBe(b);
  });

  it("changes when signedAt, decisions, or turnIndex change", () => {
    const base = canonicalSignedTurnPayload(SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    expect(canonicalSignedTurnPayload(SAMPLE_RECORD, "2026-09-27T12:00:01.000Z")).not.toBe(base);
    expect(canonicalSignedTurnPayload({ ...SAMPLE_RECORD, turnIndex: 4 }, "2026-09-27T12:00:00.000Z")).not.toBe(base);
    expect(
      canonicalSignedTurnPayload(
        { ...SAMPLE_RECORD, decisions: [...SAMPLE_RECORD.decisions].reverse() },
        "2026-09-27T12:00:00.000Z",
      ),
    ).not.toBe(base);
  });
});

describe("sign + verify round trip", () => {
  it("a genuinely signed entry verifies true", async () => {
    const entry = await signTurnRecord(DEMO_SIGNING_KEY_PEM, SAMPLE_RECORD, "2026-09-27T12:00:00.000Z", DEMO_SIGNING_KEY_ID);
    expect(entry.signature.algorithm).toBe("ed25519");
    expect(entry.signature.keyId).toBe(DEMO_SIGNING_KEY_ID);
    expect(await verifySignedTurnEntry(entry)).toBe(true);
  });

  it("fails closed when any signed field is tampered with after signing", async () => {
    const entry = await signTurnRecord(DEMO_SIGNING_KEY_PEM, SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    // decisions[0] was actually "ok" in SAMPLE_RECORD — flip it to a genuinely different
    // status, not back to the same value (a no-op tamper would pass verification for the
    // wrong reason and prove nothing).
    const tamperedStatus: SignedTurnEntry = {
      ...entry,
      decisions: [{ ...entry.decisions[0], status: "errored" }, entry.decisions[1]] as TurnRecord["decisions"] extends readonly (infer D)[] ? D[] : never,
    };
    expect(await verifySignedTurnEntry(tamperedStatus)).toBe(false);

    const tamperedTurnIndex: SignedTurnEntry = { ...entry, turnIndex: 999 };
    expect(await verifySignedTurnEntry(tamperedTurnIndex)).toBe(false);

    const tamperedTimestamp: SignedTurnEntry = { ...entry, signedAt: "2099-01-01T00:00:00.000Z" };
    expect(await verifySignedTurnEntry(tamperedTimestamp)).toBe(false);
  });

  it("fails closed on a malformed signature rather than throwing", async () => {
    const entry = await signTurnRecord(DEMO_SIGNING_KEY_PEM, SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    expect(await verifySignedTurnEntry({ ...entry, signature: { ...entry.signature, algorithm: "not-ed25519" as "ed25519" } })).toBe(false);
    expect(await verifySignedTurnEntry({ ...entry, signature: { ...entry.signature, value: "not-base64-!!!" } })).toBe(false);
    expect(await verifySignedTurnEntry({ ...entry, signature: { ...entry.signature, value: "" } })).toBe(false);
  });

  it("trusted-key pinning binds identity: a self-attesting entry is not enough once keys are pinned", async () => {
    const entry = await signTurnRecord(DEMO_SIGNING_KEY_PEM, SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    // No pinned keys: the entry's own embedded public key is used — proves integrity only.
    expect(await verifySignedTurnEntry(entry)).toBe(true);
    // Pinned to the real signer's public key (derived from the same demo key): still verifies.
    expect(await verifySignedTurnEntry(entry, [entry.signature.publicKey])).toBe(true);
    // Pinned to a DIFFERENT key: the payload is genuine but not from a trusted identity.
    const otherEntry = await signTurnRecord(OTHER_SIGNING_KEY_PEM, SAMPLE_RECORD, "2026-09-27T12:00:00.000Z");
    expect(await verifySignedTurnEntry(entry, [otherEntry.signature.publicKey])).toBe(false);
  });
});

/** Poll until `predicate` is true or `timeoutMs` elapses — for the hook's fire-and-forget async write. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createFileLedgerHook", () => {
  it("signs and appends one JSON line per turn, using the injected clock", async () => {
    const lines: string[] = [];
    let callCount = 0;
    const hook = createFileLedgerHook({
      signingKeyPem: DEMO_SIGNING_KEY_PEM,
      signingKeyId: DEMO_SIGNING_KEY_ID,
      path: "/unused-because-appendLine-is-injected",
      now: () => `fixed-timestamp-${++callCount}`,
      appendLine: (_path, line) => lines.push(line),
    });

    hook(SAMPLE_RECORD);
    hook({ ...SAMPLE_RECORD, turnIndex: 4 });
    await waitFor(() => lines.length === 2);

    const first = JSON.parse(lines[0]) as SignedTurnEntry;
    const second = JSON.parse(lines[1]) as SignedTurnEntry;
    expect(first.turnIndex).toBe(3);
    expect(first.signedAt).toBe("fixed-timestamp-1");
    expect(second.turnIndex).toBe(4);
    expect(second.signedAt).toBe("fixed-timestamp-2");
    expect(await verifySignedTurnEntry(first)).toBe(true);
    expect(await verifySignedTurnEntry(second)).toBe(true);
  });

  it("never throws back into the caller on a signing failure — reports via onWriteError", async () => {
    const errors: unknown[] = [];
    const hook = createFileLedgerHook({
      signingKeyPem: "not a real PEM key",
      path: "/unused",
      appendLine: () => {
        throw new Error("should never be reached — signing must fail first");
      },
      onWriteError: (error) => errors.push(error),
    });

    expect(() => hook(SAMPLE_RECORD)).not.toThrow();
    await waitFor(() => errors.length === 1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("reports an append failure via onWriteError too, without throwing", async () => {
    const errors: unknown[] = [];
    const hook = createFileLedgerHook({
      signingKeyPem: DEMO_SIGNING_KEY_PEM,
      path: "/unused",
      appendLine: () => {
        throw new Error("disk full, or whatever");
      },
      onWriteError: (error) => errors.push(error),
    });

    expect(() => hook(SAMPLE_RECORD)).not.toThrow();
    await waitFor(() => errors.length === 1);
    expect((errors[0] as Error).message).toBe("disk full, or whatever");
  });

  it("writes to a real file when appendLine is not injected (the default path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-kcp-ledger-test-"));
    const path = join(dir, "nested", "ledger.jsonl");
    try {
      const hook = createFileLedgerHook({ signingKeyPem: DEMO_SIGNING_KEY_PEM, path });
      hook(SAMPLE_RECORD);
      await waitFor(() => {
        try {
          return readFileSync(path, "utf8").trim().length > 0;
        } catch {
          return false;
        }
      });
      const line = readFileSync(path, "utf8").trim();
      const entry = JSON.parse(line) as SignedTurnEntry;
      expect(entry.turnIndex).toBe(3);
      expect(await verifySignedTurnEntry(entry)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyLedgerFile", () => {
  it("verifies every line and flags a tampered one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-kcp-ledger-verify-test-"));
    const path = join(dir, "ledger.jsonl");
    try {
      const good1 = await signTurnRecord(DEMO_SIGNING_KEY_PEM, SAMPLE_RECORD, "t1");
      const good2 = await signTurnRecord(DEMO_SIGNING_KEY_PEM, { ...SAMPLE_RECORD, turnIndex: 5 }, "t2");
      const tampered: SignedTurnEntry = { ...good2, turnIndex: 999 };
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, [JSON.stringify(good1), "not valid json {{{", JSON.stringify(tampered)].join("\n") + "\n", "utf8");

      const results = await verifyLedgerFile(path);
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ lineNumber: 1, turnIndex: 3, valid: true });
      expect(results[1].valid).toBe(false);
      expect(results[1].error).toMatch(/unparseable/);
      expect(results[2]).toMatchObject({ lineNumber: 3, turnIndex: 999, valid: false });
      expect(results[2].error).toBe("signature did not verify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors trustedKeys across the whole file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-kcp-ledger-trust-test-"));
    const path = join(dir, "ledger.jsonl");
    try {
      const entry = await signTurnRecord(DEMO_SIGNING_KEY_PEM, SAMPLE_RECORD, "t1");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, JSON.stringify(entry) + "\n", "utf8");

      const trusted = await verifyLedgerFile(path, [entry.signature.publicKey]);
      expect(trusted[0].valid).toBe(true);

      const untrusted = await verifyLedgerFile(path, [OTHER_PUBLIC_KEY_PEM]);
      expect(untrusted[0].valid).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
