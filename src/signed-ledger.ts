/**
 * A persisted, signed record of every governed turn (#151 — "provide a signed ledger of
 * its decision tree").
 *
 * {@link TurnLedger} (runtime.ts) already accumulates one turn's {@link StageDecision}s into
 * a {@link TurnRecord}, and {@link GovernedLoop} already keeps the last `TURN_HISTORY_LIMIT`
 * (20) of them in memory for `/kcp evidence`. Neither is persisted, timestamped, or signed —
 * the process exiting loses the history, and nothing about a `TurnRecord` is tamper-evident.
 *
 * This module closes that gap the same way kcp-harness already signs purchase receipts
 * (`kcp-harness`'s `signPayload`/`importPrivateKey`/`importPublicKey`, the same primitives
 * `wallet.ts`'s settlement path uses) — reused here, not reimplemented, so there is one
 * ed25519 code path in this dependency graph, not two.
 *
 * Deliberately per-event signed, not hash-chained: each entry is independently verifiable
 * against the signing key, matching the discipline Sunstone Atlas Canvas's own run ledger
 * uses (`enact.mjs`/`sign.mjs` — per-event Ed25519, no chain). A hash chain adds tamper
 * detection for *deletion* of an entire line, which per-event signing does not catch; that is
 * a deliberate, named scope boundary (see the module doc below the exports), not an oversight.
 */
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { signPayload, importPublicKey } from "kcp-harness";
import type { TurnRecord } from "./runtime.js";

/** Schema version for {@link canonicalSignedTurnPayload} — bump on any field-shape change. */
export const SIGNED_TURN_PAYLOAD_VERSION = 1;

/** The detached-signature envelope, same shape as kcp-harness's `PurchaseReceiptSignature`. */
export interface SignedTurnSignature {
  readonly algorithm: "ed25519";
  /** Base64 detached signature over {@link canonicalSignedTurnPayload}'s output. */
  readonly value: string;
  /** SPKI PEM of the public key — self-attesting unless verified against `trustedKeys`. */
  readonly publicKey: string;
  readonly keyId?: string;
}

/** One persisted line: a turn record, the wall-clock time it was signed, and its signature. */
export interface SignedTurnEntry {
  readonly turnIndex: number;
  readonly correlationId: string;
  readonly decisions: TurnRecord["decisions"];
  readonly expectedStages: TurnRecord["expectedStages"];
  /** ISO-8601, assigned at signing time — never trust a caller-supplied timestamp unsigned. */
  readonly signedAt: string;
  readonly signature: SignedTurnSignature;
}

/**
 * Deterministic, versioned, fixed-field-order serialization of the fields the signature
 * commits to. Field order is fixed so a signature made today verifies byte-for-byte
 * tomorrow, independent of object construction order — mirrors
 * `canonicalPurchaseReceiptPayload` in kcp-harness exactly on purpose, same rationale.
 *
 * `decisions` and `expectedStages` are embedded via plain `JSON.stringify`, NOT run through
 * a key-sorting canonicalizer: array order inside `decisions` is itself meaningful (stage
 * sequence — see runtime.ts's `TurnLedger.run`), so sorting would destroy the thing being
 * attested. Object-key order within each decision does not vary (they are constructed by one
 * code path, `TurnLedger.run`), so this is safe without a generic canonicalizer.
 */
export function canonicalSignedTurnPayload(record: TurnRecord, signedAt: string): string {
  return JSON.stringify({
    v: SIGNED_TURN_PAYLOAD_VERSION,
    turnIndex: record.turnIndex,
    correlationId: record.correlationId,
    decisions: record.decisions,
    expectedStages: record.expectedStages,
    signedAt,
  });
}

/**
 * Sign a `TurnRecord` with an ed25519 private key (PKCS8 PEM) — mirrors
 * `signPurchaseReceipt` in kcp-harness field-for-field (derive the SPKI public key, sign the
 * canonical payload, return the detached-signature envelope).
 */
export async function signTurnRecord(
  privatePem: string,
  record: TurnRecord,
  signedAt: string,
  keyId?: string,
): Promise<SignedTurnEntry> {
  const priv = createPrivateKey(privatePem);
  const publicKeyPem = createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  const value = await signPayload(
    // signPayload takes an already-imported CryptoKey — mirror kcp-harness's own
    // signPurchaseReceipt, which imports from the PKCS8 DER of the parsed key rather than
    // re-parsing the PEM a second time.
    await importSigningKey(priv),
    canonicalSignedTurnPayload(record, signedAt),
  );
  return {
    turnIndex: record.turnIndex,
    correlationId: record.correlationId,
    decisions: record.decisions,
    expectedStages: record.expectedStages,
    signedAt,
    signature: { algorithm: "ed25519", value, publicKey: publicKeyPem, ...(keyId ? { keyId } : {}) },
  };
}

async function importSigningKey(priv: ReturnType<typeof createPrivateKey>) {
  const pkcs8Der = priv.export({ type: "pkcs8", format: "der" });
  return await crypto.subtle.importKey("pkcs8", pkcs8Der, { name: "Ed25519" }, false, ["sign"]);
}

/**
 * Verify one signed entry. Fail-closed: any missing/malformed input, or a signature that does
 * not match, returns `false` rather than throwing — mirrors `verifyPurchaseReceipt`.
 *
 * When `trustedKeys` is non-empty the signature must verify against one of the pinned keys
 * (binds the entry to a known identity); when empty, the entry's own embedded public key is
 * used, which proves the payload was not altered after signing but is self-attesting for
 * *identity* — the same honest caveat kcp-harness's purchase-receipt verifier carries.
 */
export async function verifySignedTurnEntry(
  entry: SignedTurnEntry,
  trustedKeys?: readonly string[],
): Promise<boolean> {
  if (!entry.signature || entry.signature.algorithm !== "ed25519") return false;
  const record: TurnRecord = {
    turnIndex: entry.turnIndex,
    correlationId: entry.correlationId,
    decisions: entry.decisions,
    expectedStages: entry.expectedStages,
  };
  const message = new TextEncoder().encode(canonicalSignedTurnPayload(record, entry.signedAt));
  let sigBytes: Uint8Array<ArrayBuffer>;
  try {
    // TS's lib.dom types Uint8Array.from's return as Uint8Array<ArrayBufferLike>, which
    // SubtleCrypto's BufferSource (ArrayBuffer-backed only) refuses — a type-checker gap, not
    // a runtime one: Uint8Array.from always allocates a fresh, plain ArrayBuffer. Asserted,
    // not cast around a real ambiguity.
    sigBytes = Uint8Array.from(Buffer.from(entry.signature.value, "base64")) as Uint8Array<ArrayBuffer>;
  } catch {
    return false;
  }
  if (sigBytes.length !== 64) return false;

  const candidates = trustedKeys && trustedKeys.length > 0 ? trustedKeys : [entry.signature.publicKey];
  for (const material of candidates) {
    try {
      const key = await importPublicKey(material);
      if (await crypto.subtle.verify("Ed25519", key, sigBytes, message)) return true;
    } catch {
      // An unimportable or non-matching key never grants trust — try the next candidate.
    }
  }
  return false;
}

/** Injected clock + file-append seam, so tests never touch real time or real disk. */
export interface FileLedgerOptions {
  /** PKCS8 PEM signing key. Defaults to the same demo key `wallet.ts` uses — replace in production. */
  signingKeyPem: string;
  signingKeyId?: string;
  /** Absolute path to the append-only ledger file. Parent directory is created if missing. */
  path: string;
  /** Defaults to `() => new Date().toISOString()`. Inject in tests for a deterministic timestamp. */
  now?: () => string;
  /** Defaults to a real `fs.appendFileSync` line-append. Inject in tests to capture without disk I/O. */
  appendLine?: (path: string, line: string) => void;
  /**
   * Called when signing or the append itself throws. Per this repo's own governed-runtime
   * discipline (runtime.ts's header comment — Pi swallows extension-handler exceptions, so a
   * gate that throws produces a turn that looks ungoverned and silent), a ledger WRITE failure
   * must never throw back into `onTurnRecorded` — it is reported here instead, and the turn's
   * own governance verdict (already decided before this hook runs) is unaffected either way.
   */
  onWriteError?: (error: unknown, record: TurnRecord) => void;
}

function defaultAppendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n", "utf8");
}

/**
 * Build a `GovernedLoopHooks.onTurnRecorded` implementation that signs and appends every
 * completed turn to a file. Wire it in via `RegisterOptions.loop`:
 *
 * ```ts
 * const ledger = createFileLedgerHook({ signingKeyPem, path: ".pi/kcp-ledger.jsonl" });
 * const loop = new GovernedLoop({ hooks: { onTurnRecorded: ledger } });
 * register(api, { loop });
 * ```
 *
 * One entry per turn, not per stage — matches `TurnLedger`'s own unit (one `TurnRecord` per
 * turn, `decisions` already holds the per-stage detail) rather than inventing a second grain.
 */
export function createFileLedgerHook(
  options: FileLedgerOptions,
): (record: TurnRecord) => void {
  const now = options.now ?? (() => new Date().toISOString());
  const appendLine = options.appendLine ?? defaultAppendLine;
  // Serializes writes so turn order in the file matches call order, even though signing is
  // async. Without this, two turns finishing close together race webcrypto.subtle.sign
  // independently and can append out of order — caught live by a test that called the hook
  // twice in a row and got the entries back reversed. Each call chains onto the previous
  // call's completion (success OR failure — `.catch(() => {})` so one turn's error can't wedge
  // every later turn's write behind a permanently-rejected promise) rather than awaiting
  // per-call, so the hook itself stays synchronous and non-blocking as designed.
  let queue: Promise<void> = Promise.resolve();

  return (record: TurnRecord): void => {
    // onTurnRecorded is a synchronous hook (governed-loop.ts:130); signing is async
    // (webcrypto.subtle). Fire-and-forget by design — the turn has already completed by the
    // time this hook runs (it fires at finishTurn), so there is nothing left to gate; a
    // slower or failed sign must not delay or break the turn that already happened. Errors
    // (signing or the append itself) go to onWriteError, never thrown, never silently lost.
    queue = queue.catch(() => {}).then(async () => {
      try {
        const signedAt = now();
        const entry = await signTurnRecord(options.signingKeyPem, record, signedAt, options.signingKeyId);
        appendLine(options.path, JSON.stringify(entry));
      } catch (error) {
        options.onWriteError?.(error, record);
      }
    });
  };
}

export interface LedgerVerificationResult {
  readonly lineNumber: number;
  readonly turnIndex: number | undefined;
  readonly correlationId: string | undefined;
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Read and verify every line of a ledger file. Read-only, offline — takes no dependency on
 * the running process, so this is the replay/audit path (analogous to Sunstone Atlas Canvas's
 * `verify-offline.mjs`): a buyer/auditor with a copy of the file and the public key (or the
 * file's own self-attested keys) can independently confirm nothing was altered since signing.
 *
 * A line that fails to parse as JSON is reported `valid: false` with the parse error rather
 * than skipped — an unreadable line is not evidence of anything, and hiding it would make a
 * corrupted ledger look shorter than it is instead of visibly broken.
 */
export async function verifyLedgerFile(
  path: string,
  trustedKeys?: readonly string[],
): Promise<LedgerVerificationResult[]> {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const results: LedgerVerificationResult[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    let entry: SignedTurnEntry;
    try {
      entry = JSON.parse(lines[i]) as SignedTurnEntry;
    } catch (error) {
      results.push({
        lineNumber,
        turnIndex: undefined,
        correlationId: undefined,
        valid: false,
        error: `unparseable line: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const valid = await verifySignedTurnEntry(entry, trustedKeys);
    results.push({
      lineNumber,
      turnIndex: entry.turnIndex,
      correlationId: entry.correlationId,
      valid,
      ...(valid ? {} : { error: "signature did not verify" }),
    });
  }
  return results;
}
