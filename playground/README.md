# KCP Playground

### ▶ **[Try it live → cantara.github.io/kcp-playground](https://cantara.github.io/kcp-playground/)**

Interactive, in-browser demos of the **defendable agent** — the KCP family's governed
AI agent that keeps a written, checkable *receipt* for everything it does.

Eleven stations, one per organ. Each runs the **real** `kcp-agent` / `kcp-harness`
decision code in the browser (no server, nothing scripted) and signs each verdict with
genuine `crypto.subtle` (Ed25519 where supported, ECDSA P-256 fallback). Drag the
controls and the adjudicator re-decides live; a thermal printer prints the verdict.

- **Live:** https://cantara.github.io/kcp-playground/
- **The reveal:** https://wiki.totto.org/blog/2026/07/22/the-ai-agent-that-keeps-the-receipts/
- **The repos:** https://github.com/Cantara

Static site — no build. `assets/shell.css` + `assets/shell.js` are the shared shell
(theme, signing, the `KCP.printReceipt()` render); each `demos/<slug>/index.html` is a
self-contained station that links them. Apache-2.0, by eXOReaction under Cantara.
