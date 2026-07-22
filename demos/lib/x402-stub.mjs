// A self-facilitated x402 stub server for the purchasing demos.
//
// This is the resource-server side of the x402 payment handshake — the thing an
// agent pays to read. It is NOT a governance mock: it runs the REAL two-request
// x402 protocol over real HTTP. Only the *settlement* is faked (no chain): the
// server acts as its own facilitator and mints a synthetic transaction hash.
//
//   1. GET with no `X-PAYMENT`  → 402 Payment Required + a JSON body listing the
//      accepted PaymentRequirements ({ x402Version, accepts:[…] }).
//   2. GET with `X-PAYMENT: <base64 signed payment>` → 200 + the resource, and an
//      `X-PAYMENT-RESPONSE: <base64 settlement receipt>` header. The server
//      base64-decodes the payment (proving the handshake is real), then settles.
//
// The `X-PAYMENT` request header and `X-PAYMENT-RESPONSE` response header are
// base64-encoded per x402; the 402 challenge body is JSON per x402.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));

/**
 * Start the stub. Returns { url, origin, requirements, requests, stop }.
 * @param {object} opts { price, currency, asset, payTo, network, resource, data }
 */
export function startX402Stub(opts = {}) {
  const requirements = {
    scheme: "exact",
    network: opts.network ?? "base-sepolia",
    asset: opts.asset ?? "USDC",
    maxAmountRequired: String(opts.price ?? "250"),
    payTo: opts.payTo ?? "0xVendorAcmeData",
    resource: opts.resource ?? "/premium/insight",
  };
  const data = opts.data ?? "PREMIUM INSIGHT: governed-agent adoption tripled QoQ across regulated buyers.";
  const requests = []; // observability: one entry per HTTP hit, in order

  const server = createServer((req, res) => {
    const payment = req.headers["x-payment"];

    // Phase 1 — the challenge: no payment yet → 402 with the accepted requirements.
    if (!payment) {
      requests.push({ phase: "challenge", hadPayment: false });
      res.writeHead(402, { "content-type": "application/json", "www-authenticate": 'x402 realm="premium"' });
      res.end(JSON.stringify({ x402Version: 1, accepts: [requirements] }));
      return;
    }

    // Phase 2 — the signed retry: decode the real X-PAYMENT payload (handshake is
    // real), then fake settlement and return the resource + a receipt header.
    let decoded = null;
    try { decoded = unb64(payment); } catch { /* leave null; still settle deterministically */ }
    const txHash = "0x" + createHash("sha256").update(String(payment)).digest("hex").slice(0, 40);
    const receipt = {
      success: true,
      network: requirements.network,
      txHash,
      payer: decoded?.from ?? "unknown",
      asset: requirements.asset,
      amount: requirements.maxAmountRequired,
      settledAt: new Date().toISOString(),
    };
    requests.push({ phase: "settle", hadPayment: true, payer: receipt.payer });
    res.writeHead(200, { "content-type": "application/json", "x-payment-response": b64(receipt) });
    res.end(JSON.stringify({ resource: requirements.resource, data }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const origin = `http://127.0.0.1:${port}`;
      resolve({
        url: `${origin}${requirements.resource}`,
        origin,
        requirements,
        requests,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
