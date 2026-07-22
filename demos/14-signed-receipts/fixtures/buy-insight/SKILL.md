# Skill: buy-insight (provable spend)

Buy paid market-insight resources from sanctioned vendors over x402.

**Spend envelope (action_scope.spend):**
- Allowed vendors: `0xVendorAcmeData`, `0xVendorBetaFeed`
- Max single purchase: `5000 USDC`
- Currency: `USDC`

Every settled purchase produces an ed25519-signed receipt that binds
`{ vendor, amount, currency, wallet, timestamp }` non-repudiably — provable,
verifiable spend for audit and compliance export.
