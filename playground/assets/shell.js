/* KCP Playground — shared shell JS.
 * window.KCP: theme toggle, genuine crypto.subtle signing (Ed25519 → ECDSA P-256 fallback),
 * and printReceipt() — the thermal-printer render every station reuses. No external deps. */
window.KCP = (() => {
  "use strict";
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const cid = () => (crypto.randomUUID ? crypto.randomUUID() : "cid-" + Math.floor(performance.now())).slice(0, 8);
  const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  // ---- theme ----
  function initTheme() {
    let btn = document.querySelector(".themebtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "themebtn"; btn.textContent = "◐ theme"; btn.setAttribute("aria-label", "Toggle theme");
      document.body.appendChild(btn);
    }
    btn.addEventListener("click", () => {
      const root = document.documentElement;
      const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
    });
  }

  // ---- signature crypto (genuine sign+verify; Ed25519 where supported, ECDSA P-256 fallback) ----
  let signer = null;
  const ready = (async () => {
    try {
      const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
      signer = { kp, alg: { name: "Ed25519" }, label: "ed25519" };
    } catch {
      try {
        const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        signer = { kp, alg: { name: "ECDSA", hash: "SHA-256" }, label: "ecdsa-p256 · demo fallback (prod: ed25519)" };
      } catch { signer = null; }
    }
  })();
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s); };
  async function sign(str) {
    if (!signer) return null;
    const bytes = await crypto.subtle.sign(signer.alg, signer.kp.privateKey, new TextEncoder().encode(str));
    return { bytes, b64: b64(bytes) };
  }
  async function verify(str, bytes) {
    if (!signer) return null;
    return crypto.subtle.verify(signer.alg, signer.kp.publicKey, bytes, new TextEncoder().encode(str));
  }
  // meaningful generic tamper: flip a verdict bool, else bump a digit, else append
  function mutate(str) {
    if (/"passed":\s*true/.test(str)) return str.replace(/"passed":\s*true/, '"passed":false');
    if (/"passed":\s*false/.test(str)) return str.replace(/"passed":\s*false/, '"passed":true');
    if (/\d/.test(str)) return str.replace(/\d/, (d) => ((+d + 1) % 10).toString());
    return str + " ";
  }

  /**
   * Render a receipt into a paperwell.
   * spec = { title, meta?, lines?:[{k,v}], stampClass:'pass'|'block', stampText, reason,
   *          footer?:[{k,v}], payload? } — if payload present, it's genuinely signed + verified.
   */
  async function printReceipt(well, spec) {
    await ready;
    const corr = spec.corr || cid();
    const payloadStr = spec.payload ? JSON.stringify(spec.payload) : null;
    const signed = payloadStr ? await sign(payloadStr) : null;
    const line = (li) => `<div class="li"><span>${esc(li.k)}</span><span>${esc(li.v)}</span></div>`;
    const sigBlock = spec.payload ? `
      <hr>
      <div class="li muted2"><span>signature</span><span>${esc(signer ? signer.label : "unavailable")}</span></div>
      <div class="muted2" style="word-break:break-all;font-size:11px">${signed ? esc(signed.b64.slice(0, 44)) + "…" : "—"}</div>
      <div class="verifyline" id="__vl">verifying…</div>
      <details class="raw"><summary>view raw signed record</summary>
        <pre class="json">${esc(JSON.stringify(spec.payload, null, 2))}</pre>
      </details>` : "";

    well.innerHTML = `
      <div class="receipt r-anim">
        <div class="c"><b>KCP · ${esc(spec.title)}</b></div>
        <div class="c muted2">${now()}</div>
        <div class="c muted2">corr ${esc(corr)}${spec.meta ? " · " + esc(spec.meta) : ""}</div>
        <hr>
        ${(spec.lines || []).map(line).join("")}
        <div class="stamp ${spec.stampClass}">${esc(spec.stampText)}</div>
        <div class="reason ${spec.stampClass === "block" ? "block" : ""}">${esc(spec.reason)}</div>
        ${spec.footer && spec.footer.length ? "<hr>" + spec.footer.map(line).join("") : ""}
        ${sigBlock}
      </div>`;

    if (signed) {
      const vl = document.getElementById("__vl");
      const good = await verify(payloadStr, signed.bytes);
      const bad = await verify(mutate(payloadStr), signed.bytes);
      vl.innerHTML = `verify(receipt): <b class="${good ? "ok" : "no"}">${good ? "✓ valid" : "✗ FAILED"}</b> · `
        + `verify(tampered): ${bad ? '<b class="no">✗ accepted?!</b>' : '<b class="ok">✓ rejected</b>'}`;
    }
    return corr;
  }

  return { el, esc, cid, now, initTheme, ready, sign, verify, printReceipt, signerLabel: () => signer ? signer.label : "unavailable" };
})();
