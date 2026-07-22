# Skill: buy-insight

Buy a paid market-insight resource over the x402 protocol.

**Spend envelope (action_scope.spend):**
- Allowed vendors: `0xVendorAcmeData`
- Max single purchase: `5000 USDC`
- Currency: `USDC`

Every purchase this skill makes is held to the envelope above by the
purchase-conformance gate before the wallet is ever asked to authorize.
