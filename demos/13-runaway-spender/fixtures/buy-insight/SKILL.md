# Skill: buy-insight (tight envelope)

Buy a paid market-insight resource.

**Spend envelope (action_scope.spend):**
- Allowed vendors: `acme-data`
- Max single purchase: `500 USD`
- Currency: `USD`

A purchase outside this envelope — too large, wrong vendor, wrong currency — is
held in-loop by the purchase-conformance gate and routed to a human. The wallet
is never asked to authorize a held purchase.
