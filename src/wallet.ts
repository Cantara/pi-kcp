/**
 * Payment-execution seam (the typed interface, NOT a live chain integration).
 *
 * This is the value-transfer counterpart of the conformance seam (`conformance.ts`). Where
 * conformance is the *decision* point ("may this action happen?"), the wallet is the
 * *execution* point ("perform the authorized spend, and hand back a settlement receipt").
 * pi-kcp ships only the seam plus deterministic, no-chain mocks; a real embedder injects a
 * {@link WalletProvider} backed by an actual signer and a {@link PaymentExecutor} backed by a
 * real x402 client.
 *
 * The governed loop calls into this seam ONLY after the purchase-aware conformance checker has
 * passed the buy (the spend fell within the active skill's `action_scope.spend`). A blocked
 * purchase never reaches the wallet.
 *
 * x402 recap — the two-request handshake this seam models:
 *   1. The client makes a request; the resource replies `402 Payment Required` with a body of
 *      accepted payment requirements.
 *   2. Governance runs on those requirements. If approved, the client asks the wallet to sign a
 *      payment for them, then retries the request with an `X-PAYMENT` header carrying the signed
 *      payload. The resource settles and replies `200` with an `X-PAYMENT-RESPONSE` header
 *      describing the settlement.
 * The governance hook therefore runs *between* the 402 challenge and the signed retry.
 */

import { createHash } from "node:crypto";

/**
 * Payment requirements parsed from an x402 `402 Payment Required` body (one accepted option).
 * `amount` is the atomic-unit string x402 uses on the wire, not a display number.
 */
export interface PaymentRequirements {
  /** Payment scheme (e.g. "exact"). */
  scheme: string;
  /** Settlement network (e.g. "base-sepolia"). */
  network: string;
  /** The asset/token to pay in (contract address or symbol). */
  asset: string;
  /** Amount required, in the asset's atomic units, as an x402 wire string. */
  amount: string;
  /** The address the payment must be made to. */
  payTo: string;
  /** The resource being paid for (URL or logical id). */
  resource: string;
  /** Optional facilitator endpoint that settles the payment. */
  facilitator?: string;
}

/** A signed payment — the value carried in the `X-PAYMENT` request header on the retry. */
export interface SignedPayment {
  /** Payment scheme, echoing the chosen requirement. */
  scheme: string;
  /** Settlement network, echoing the chosen requirement. */
  network: string;
  /** The `X-PAYMENT` header value: a base64-encoded, signed payment payload. */
  payload: string;
}

/** A settlement receipt — parsed from the resource's `X-PAYMENT-RESPONSE`, or synthesized. */
export interface PaymentReceipt {
  /** Whether settlement succeeded. */
  success: boolean;
  /** The network the payment settled on. */
  network: string;
  /** On-chain (or synthetic) transaction hash, when settled. */
  txHash?: string;
  /** Settlement timestamp (ISO 8601). */
  settledAt: string;
}

/**
 * The injectable wallet seam: an identity plus the ability to authorize (sign) a payment for a
 * set of requirements. Kept minimal — no balance, no chain state — so a mock and a real signer
 * satisfy the same contract.
 */
export interface WalletProvider {
  /** The wallet's account address (the `from` of any payment). */
  address(): Promise<string>;
  /** Sign a payment satisfying `req`; the result's `payload` becomes the `X-PAYMENT` header. */
  authorize(req: PaymentRequirements): Promise<SignedPayment>;
}

/** The governance verdict the executor consults between the 402 challenge and the signed retry. */
export interface PaymentGovernanceDecision {
  readonly approved: boolean;
  readonly reason?: string;
}

/**
 * A request thunk the {@link PaymentExecutor} drives twice: once for the challenge (no payment),
 * then again on approval with the signed payment so the caller can attach the `X-PAYMENT` header.
 * A plain `() => Promise<Response>` (which ignores the payment) is assignable to this type, so a
 * caller that only ever makes the challenge request still satisfies it.
 */
export type PaymentRequestFn = (payment?: SignedPayment) => Promise<Response>;

/** The governance callback: adjudicates the parsed requirements before any signing happens. */
export type PaymentGovernFn = (req: PaymentRequirements) => Promise<PaymentGovernanceDecision>;

/**
 * The injectable payment-execution seam. Owns the x402 two-request handshake so the governance
 * hook runs at exactly the right moment (after the 402 challenge, before the signed retry).
 */
export interface PaymentExecutor {
  /**
   * Run the x402 handshake for `requestFn`: challenge → govern → (approve → sign → retry | deny →
   * abort) → parse the `X-PAYMENT-RESPONSE` receipt. Throws {@link PaymentDeniedError} on a
   * denied verdict, before the wallet is ever asked to sign.
   */
  pay(
    requestFn: PaymentRequestFn,
    govern: PaymentGovernFn,
  ): Promise<{ response: Response; receipt: PaymentReceipt }>;
  /**
   * Finalize an already-authorized payment into a settlement receipt, with no challenge and no
   * governance. Used by the governed loop's direct-buy path (a tool call carrying
   * `{vendor, amount, currency}`), which authorizes via the wallet then settles here.
   */
  settle(signed: SignedPayment, req: PaymentRequirements): Promise<PaymentReceipt>;
}

/** Raised by {@link PaymentExecutor.pay} when governance denies the buy — aborts before signing. */
export class PaymentDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PaymentDeniedError";
  }
}

/** Header the client sends on the signed retry. */
export const X_PAYMENT_HEADER = "X-PAYMENT";
/** Header the resource returns describing the settlement. */
export const X_PAYMENT_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function base64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

/** Deterministic, field-ordered serialization of requirements so a mock signature is stable. */
function canonicalRequirements(req: PaymentRequirements): string {
  return JSON.stringify([
    req.scheme,
    req.network,
    req.asset,
    req.amount,
    req.payTo,
    req.resource,
    req.facilitator ?? "",
  ]);
}

/** Synthesize x402 {@link PaymentRequirements} from a direct-buy purchase intent. */
export function requirementsFromPurchase(
  purchase: { vendor: string; amount: number; currency: string },
  correlationId: string,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "mock",
    asset: purchase.currency,
    amount: String(purchase.amount),
    payTo: purchase.vendor,
    resource: `kcp:purchase:${correlationId}`,
  };
}

/** Recover a display purchase `{vendor, amount, currency}` from parsed x402 requirements. */
export function purchaseFromRequirements(
  req: PaymentRequirements,
): { vendor: string; amount: number; currency: string } {
  return { vendor: req.payTo, amount: Number(req.amount), currency: req.asset };
}

/** Parse one x402 accepted payment requirement from a `402` response body. */
export async function parsePaymentRequirements(response: Response): Promise<PaymentRequirements> {
  const body = (await response.json()) as Record<string, unknown>;
  const accepts = body.accepts;
  const src = (Array.isArray(accepts) && accepts.length > 0 ? accepts[0] : body) as Record<string, unknown>;
  const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : value == null ? fallback : String(value));
  const requirements: PaymentRequirements = {
    scheme: str(src.scheme, "exact"),
    network: str(src.network, "base-sepolia"),
    asset: str(src.asset ?? src.currency, "USDC"),
    amount: str(src.maxAmountRequired ?? src.amount, "0"),
    payTo: str(src.payTo ?? src.pay_to),
    resource: str(src.resource),
  };
  if (typeof src.facilitator === "string") requirements.facilitator = src.facilitator;
  return requirements;
}

const MOCK_WALLET_SEED = "kcp-mock-wallet-v1";

/**
 * A deterministic, no-chain {@link WalletProvider}. `address()` is a stable synthetic account
 * and `authorize()` produces a stable synthetic signature over the requirements — the same
 * requirements always yield byte-identical output, which is what the tests pin. No key, no
 * network, no balance: it exists so the governed loop can be exercised end to end offline.
 */
export class MockWallet implements WalletProvider {
  private readonly account: string;

  constructor(seed: string = MOCK_WALLET_SEED) {
    this.account = `0x${sha256Hex(seed).slice(0, 40)}`;
  }

  async address(): Promise<string> {
    return this.account;
  }

  async authorize(req: PaymentRequirements): Promise<SignedPayment> {
    const digest = sha256Hex(canonicalRequirements(req));
    const inner = {
      x402Version: 1,
      scheme: req.scheme,
      network: req.network,
      from: this.account,
      to: req.payTo,
      value: req.amount,
      asset: req.asset,
      resource: req.resource,
      signature: `mock-sig:${digest}`,
    };
    return { scheme: req.scheme, network: req.network, payload: base64(JSON.stringify(inner)) };
  }
}

/**
 * An inert {@link WalletProvider} for pure tests: it holds a fixed address but refuses to
 * authorize. Inject it where a purchase must be *blocked before* any signing happens — if
 * `authorize()` is ever reached the test throws, proving the wallet was not called.
 */
export class NoopWallet implements WalletProvider {
  async address(): Promise<string> {
    return "0x0000000000000000000000000000000000000000";
  }

  async authorize(): Promise<SignedPayment> {
    throw new Error("NoopWallet.authorize called — the wallet was not supposed to run");
  }
}

/**
 * A deterministic {@link PaymentExecutor} that performs the REAL x402 two-request handshake
 * against whatever `requestFn` it is given (a live stub server, or any Response-returning
 * thunk), signing with its injected {@link WalletProvider}. Settlement is faked: when the
 * resource returns no `X-PAYMENT-RESPONSE`, a synthetic receipt with a synthetic `txHash`
 * (derived from the signed payload) stands in for on-chain confirmation.
 */
export class MockPaymentExecutor implements PaymentExecutor {
  constructor(private readonly wallet: WalletProvider = new MockWallet()) {}

  async pay(
    requestFn: PaymentRequestFn,
    govern: PaymentGovernFn,
  ): Promise<{ response: Response; receipt: PaymentReceipt }> {
    // 1. Challenge — the first, unpaid request.
    const challenge = await requestFn();
    if (challenge.status !== 402) {
      // No payment was demanded; return the response with a no-settlement receipt.
      return {
        response: challenge,
        receipt: { success: challenge.ok, network: "none", settledAt: new Date().toISOString() },
      };
    }

    // 2a. Parse the accepted requirements and run governance BEFORE signing anything.
    const req = await parsePaymentRequirements(challenge);
    const verdict = await govern(req);
    if (!verdict.approved) {
      throw new PaymentDeniedError(verdict.reason ?? `payment to "${req.payTo}" denied by governance`);
    }

    // 2b. Approved → sign, then retry with the X-PAYMENT header carrying the signed payload.
    const signed = await this.wallet.authorize(req);
    const paid = await requestFn(signed);
    const receipt = await this.receiptFrom(paid, signed, req);
    return { response: paid, receipt };
  }

  async settle(signed: SignedPayment, req: PaymentRequirements): Promise<PaymentReceipt> {
    return this.syntheticReceipt(signed, req, true);
  }

  /** Prefer the resource's `X-PAYMENT-RESPONSE`; fall back to a synthetic settlement. */
  private async receiptFrom(response: Response, signed: SignedPayment, req: PaymentRequirements): Promise<PaymentReceipt> {
    const header = response.headers.get(X_PAYMENT_RESPONSE_HEADER);
    if (header) {
      try {
        const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
        return {
          success: typeof decoded.success === "boolean" ? decoded.success : response.ok,
          network: typeof decoded.network === "string" ? decoded.network : req.network,
          ...(typeof decoded.txHash === "string" ? { txHash: decoded.txHash } : {}),
          settledAt: typeof decoded.settledAt === "string" ? decoded.settledAt : new Date().toISOString(),
        };
      } catch {
        // Malformed header → fall through to a synthetic receipt bound to the response status.
      }
    }
    return this.syntheticReceipt(signed, req, response.ok);
  }

  private syntheticReceipt(signed: SignedPayment, req: PaymentRequirements, success: boolean): PaymentReceipt {
    return {
      success,
      network: req.network,
      txHash: `0x${sha256Hex(signed.payload)}`,
      settledAt: new Date().toISOString(),
    };
  }
}

/**
 * A demo ed25519 signing key (PKCS8 PEM) for stamping settlement receipts in the mock/default
 * path. It is a throwaway demonstration key — NOT a settling-authority key — present so the
 * default seam emits a self-attesting, verifiable receipt offline. A real deployment injects a
 * loop whose settlement is signed by the actual settling authority's key.
 */
export const DEMO_SIGNING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPaohiy6TPXfMlpaj4lndtaMdnbmKsaEe+Ri1PKzOMAC
-----END PRIVATE KEY-----`;

/** Key identifier recorded on demo-signed receipts. */
export const DEMO_SIGNING_KEY_ID = "kcp-demo";

/** Ready-to-use default wallet instance (mirrors `passThroughChecker`). */
export const mockWallet: WalletProvider = new MockWallet();

export default mockWallet;
