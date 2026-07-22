import { afterAll, describe, expect, it } from "bun:test";
import type { ExecResult, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { verifyPurchaseReceipt, type ActionScope } from "kcp-harness";
import register, {
  type ConformanceContext,
  GovernedLoop,
  HarnessConformanceChecker,
  MockPaymentExecutor,
  MockWallet,
  NoopWallet,
  type ObservedAction,
  PaymentDeniedError,
  type PaymentReceipt,
  type PaymentRequirements,
  type PaymentRequestFn,
  passThroughChecker,
  type ScopeResolver,
  type SignedPayment,
  type WalletProvider,
  X_PAYMENT_HEADER,
  X_PAYMENT_RESPONSE_HEADER,
} from "../src/index.js";

const ctx: ConformanceContext = { cwd: "/repo" };

/** A wallet that counts `authorize` calls so tests can prove it was (or was not) reached. */
class CountingWallet implements WalletProvider {
  authorizeCalls = 0;
  private readonly inner = new MockWallet();
  address(): Promise<string> {
    return this.inner.address();
  }
  authorize(req: PaymentRequirements): Promise<SignedPayment> {
    this.authorizeCalls += 1;
    return this.inner.authorize(req);
  }
}

/** A conformance checker backed by a fixed spend scope + an always-active synthetic skill. */
function scopedLoop(spend: ActionScope["spend"], options: { wallet?: WalletProvider } = {}): GovernedLoop {
  const resolver: ScopeResolver = { async resolve() { return { spend }; } };
  const checker = new HarnessConformanceChecker({ resolveScope: resolver });
  const loop = new GovernedLoop({ checker, ...(options.wallet ? { wallet: options.wallet } : {}) });
  return loop;
}

/** Establish an active skill for the turn (the checker only engages a scope when one is active). */
async function activateSkill(loop: GovernedLoop): Promise<void> {
  loop.beginTurn(0);
  await loop.evaluateToolCall("read", { path: "/repo/skills/buy-tickets/SKILL.md" }, ctx);
}

/** A purely in-memory x402 requestFn: 402 with `req` on the challenge, 200 on the signed retry. */
function inMemoryX402(req: Partial<PaymentRequirements> & { payTo: string; amount: string; asset: string }): PaymentRequestFn {
  return (payment) => {
    if (!payment) {
      const body = JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "mock", ...req }] });
      return Promise.resolve(new Response(body, { status: 402, headers: { "content-type": "application/json" } }));
    }
    // No X-PAYMENT-RESPONSE header → the executor synthesizes a settlement receipt.
    return Promise.resolve(new Response(null, { status: 200 }));
  };
}

describe("MockWallet (#139)", () => {
  it("authorize is deterministic: same requirements → byte-identical signed payment", async () => {
    const wallet = new MockWallet();
    const req: PaymentRequirements = {
      scheme: "exact", network: "base-sepolia", asset: "USDC", amount: "1000", payTo: "0xVendor", resource: "/x",
    };
    const a = await wallet.authorize(req);
    const b = await wallet.authorize(req);
    expect(a).toEqual(b);
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe("base-sepolia");

    // Different requirements → a different signature/payload.
    const c = await wallet.authorize({ ...req, amount: "2000" });
    expect(c.payload).not.toBe(a.payload);

    // address() is a stable synthetic account.
    expect(await wallet.address()).toBe(await wallet.address());
    expect(await wallet.address()).toMatch(/^0x[0-9a-f]{40}$/);
  });
});

describe("purchase conformance + wallet settlement (#139)", () => {
  it("an in-scope buy passes conformance, the wallet settles, and the receipt verifies", async () => {
    const wallet = new CountingWallet();
    const loop = scopedLoop({ max_spend: 5000, allowed_vendors: ["0xResource"], currency: "USDC" }, { wallet });
    await activateSkill(loop);

    const requestFn = inMemoryX402({ payTo: "0xResource", amount: "1000", asset: "USDC", resource: "/premium" });
    const { receipt, settlement } = await loop.pay(requestFn, ctx);

    expect(receipt.success).toBe(true);
    expect(receipt.txHash).toBeDefined();
    expect(wallet.authorizeCalls).toBe(1);

    // The signed purchase receipt verifies against its embedded (self-attesting) key.
    expect(settlement).toBeDefined();
    expect(settlement!.receipt.vendor).toBe("0xResource");
    expect(settlement!.receipt.amount).toBe(1000);
    expect(settlement!.event.type).toBe("purchase_settled");
    const ok = await verifyPurchaseReceipt(settlement!.receipt, settlement!.signature);
    expect(ok).toBe(true);
  });

  it("a direct buy in scope settles and fires onSettled with a purchase_settled event", async () => {
    const wallet = new CountingWallet();
    const settled: Array<{ action: ObservedAction; event: unknown }> = [];
    const resolver: ScopeResolver = { async resolve() { return { spend: { max_spend: 100, allowed_vendors: ["acme"], currency: "USDC" } }; } };
    const checker = new HarnessConformanceChecker({ resolveScope: resolver });
    const loop = new GovernedLoop({ checker, wallet, hooks: { onSettled: (action, event) => settled.push({ action, event }) } });
    await activateSkill(loop);

    const decision = await loop.evaluateToolCall("buy", { vendor: "acme", amount: 50, currency: "USDC" }, ctx);
    expect(decision.block).toBe(false);
    expect(wallet.authorizeCalls).toBe(1);
    expect(settled).toHaveLength(1);
    const event = settled[0]!.event as { type: string; purchase?: { vendor: string; amount: number; signed?: boolean } };
    expect(event.type).toBe("purchase_settled");
    expect(event.purchase?.vendor).toBe("acme");
    expect(event.purchase?.amount).toBe(50);
    expect(event.purchase?.signed).toBe(true);
  });

  it("an out-of-scope buy (over max_spend) is blocked and the wallet is never called", async () => {
    const wallet = new CountingWallet();
    const loop = scopedLoop({ max_spend: 100, allowed_vendors: ["acme"], currency: "USDC" }, { wallet });
    await activateSkill(loop);

    const decision = await loop.evaluateToolCall("buy", { vendor: "acme", amount: 500, currency: "USDC" }, ctx);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("max_spend");
    expect(wallet.authorizeCalls).toBe(0);
  });

  it("an out-of-scope buy (disallowed vendor) is blocked before the NoopWallet is touched", async () => {
    // A NoopWallet throws if authorize is ever reached — so a green test proves it was not.
    const resolver: ScopeResolver = { async resolve() { return { spend: { allowed_vendors: ["acme"], currency: "USDC" } }; } };
    const checker = new HarnessConformanceChecker({ resolveScope: resolver });
    const loop = new GovernedLoop({ checker, wallet: new NoopWallet() });
    await activateSkill(loop);

    const decision = await loop.evaluateToolCall("buy", { vendor: "evil-corp", amount: 5, currency: "USDC" }, ctx);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain("authorized vendors");
  });
});

describe("MockPaymentExecutor x402 handshake (#139)", () => {
  const servers: Array<{ stop: () => void }> = [];
  afterAll(() => { for (const s of servers) s.stop(); });

  function startStub(): string {
    const settlement = Buffer.from(
      JSON.stringify({ success: true, network: "base-sepolia", txHash: "0xServerTx", settledAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    ).toString("base64");
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (!request.headers.get(X_PAYMENT_HEADER)) {
          const body = JSON.stringify({
            x402Version: 1,
            accepts: [{ scheme: "exact", network: "base-sepolia", asset: "USDC", maxAmountRequired: "1000", payTo: "0xResource", resource: "/premium" }],
          });
          return new Response(body, { status: 402, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { [X_PAYMENT_RESPONSE_HEADER]: settlement } });
      },
    });
    servers.push(server);
    return server.url.toString();
  }

  it("challenge → approve → sign → retry → parses the X-PAYMENT-RESPONSE receipt", async () => {
    const url = startStub();
    const executor = new MockPaymentExecutor(new MockWallet());
    const requestFn: PaymentRequestFn = (payment) =>
      fetch(url, { headers: payment ? { [X_PAYMENT_HEADER]: payment.payload } : {} });

    const { response, receipt } = await executor.pay(requestFn, async () => ({ approved: true }));
    expect(response.status).toBe(200);
    const receiptOut: PaymentReceipt = receipt;
    expect(receiptOut.success).toBe(true);
    expect(receiptOut.network).toBe("base-sepolia");
    expect(receiptOut.txHash).toBe("0xServerTx");
  });

  it("a denied verdict aborts before signing (wallet never called)", async () => {
    const url = startStub();
    const wallet = new CountingWallet();
    const executor = new MockPaymentExecutor(wallet);
    const requestFn: PaymentRequestFn = (payment) =>
      fetch(url, { headers: payment ? { [X_PAYMENT_HEADER]: payment.payload } : {} });

    await expect(executor.pay(requestFn, async () => ({ approved: false, reason: "over budget" }))).rejects.toBeInstanceOf(PaymentDeniedError);
    expect(wallet.authorizeCalls).toBe(0);
  });
});

describe("register() wallet injection (#139)", () => {
  type Handler = (event: any, ctx: any) => any;
  class FakePi {
    handlers = new Map<string, Handler[]>();
    commands = new Map<string, { handler: Handler }>();
    sent: unknown[] = [];
    registerCommand(name: string, options: { handler: Handler }): void { this.commands.set(name, options); }
    on(event: string, handler: Handler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
    }
    getCommands(): SlashCommandInfo[] { return []; }
    getAllTools(): unknown[] { return []; }
    sendMessage(message: unknown): void { this.sent.push(message); }
    async exec(): Promise<ExecResult> { return { stdout: "", stderr: "", code: 0, killed: false }; }
    async fire(event: string, payload: any, c: any = { cwd: "/repo" }): Promise<any> {
      let result: any;
      for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, c);
      return result;
    }
    asApi() { return this as any; }
  }

  it("routes a conformant purchase through an injected custom wallet", async () => {
    const wallet = new CountingWallet();
    const pi = new FakePi();
    // Pass-through conformance so the buy is admitted; the injected wallet must then settle it.
    register(pi.asApi(), { conformanceChecker: passThroughChecker, walletProvider: wallet });

    await pi.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    const decision = await pi.fire(
      "tool_call",
      { type: "tool_call", toolCallId: "t1", toolName: "buy", input: { vendor: "acme", amount: 12, currency: "USDC" } },
      { cwd: "/repo" },
    );
    expect(decision).toBeUndefined();
    expect(wallet.authorizeCalls).toBe(1);
  });
});
