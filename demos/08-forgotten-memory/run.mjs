#!/usr/bin/env node
// Demo 8 — "The Forgotten Memory" (memory governance / recall gate)
// Organ: the REAL kcp-memory daemon (Java 21) — its recall gate over REAL HTTP.
// Endpoints exercised: GET /search, POST /governance/retention, POST /governance/forget,
//                      GET /governance/audit, GET /governance?session=.
//
// A memory whose retention window has expired, or that has been explicitly
// forgotten (right-to-forget tombstone), is skipped by recall — while a live
// memory is still returned WITH its provenance. Real HTTP, real SQLite, real gate.
//
// Isolation: the shipped `kcp-memory daemon` hard-binds port 7735 (the user's own
// daemon + real ~/.kcp/memory.db). This demo runs the SAME published handlers via
// a tiny launcher on a FREE ephemeral port over an isolated temp DB — it never
// touches the user's daemon or data. See MemoryGovDemoServer.java.
//
// Prereqs (clearly degraded if missing): Java 21+ and the built kcp-memory daemon
// jar. Override with KCP_MEMORY_JAR / KCP_MEMORY_SRC. If neither the jar nor a
// buildable source tree is present, the demo prints what's needed and exits 0.

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { section, expect, finish, showJson } from "../lib/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = "/src/cantara/kcp-memory/java";
const jarEnv = process.env.KCP_MEMORY_JAR;
const src = process.env.KCP_MEMORY_SRC ?? DEFAULT_SRC;

const has = (cmd) => spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const prereq = (msg) => { console.log(`\n⚠ PREREQ — live kcp-memory daemon step skipped.\n${msg}\n`); console.log("(This is the one demo that needs an external service: the Java kcp-memory daemon.)"); process.exitCode = 0; };

section("Demo 8: The Forgotten Memory — the real kcp-memory recall gate over HTTP");

if (!has("java")) { prereq("Java 21+ is required to run the kcp-memory daemon. Install a JDK 21+."); }
else {
  // --- Resolve (or build) the daemon jar -------------------------------------
  let jar = jarEnv && existsSync(jarEnv) ? jarEnv : null;
  if (!jar) {
    const built = join(src, "target", "kcp-memory-daemon.jar");
    if (existsSync(built)) jar = built;
    else if (existsSync(join(src, "pom.xml")) && has("mvn")) {
      console.log(`\nBuilding the kcp-memory daemon jar (mvn -q -DskipTests package in ${src})…`);
      const b = spawnSync("mvn", ["-q", "-DskipTests", "package"], { cwd: src, encoding: "utf8", timeout: 590000 });
      if (b.status === 0 && existsSync(built)) jar = built;
    }
  }

  if (!jar) {
    prereq(`Could not find or build the kcp-memory daemon jar.\n` +
      `  • set KCP_MEMORY_JAR=/path/to/kcp-memory-daemon.jar, or\n` +
      `  • set KCP_MEMORY_SRC to the Java source (default ${DEFAULT_SRC}) and ensure mvn is installed.`);
  } else {
    console.log(`\nUsing daemon jar: ${jar}`);
    await runLiveDemo(jar);
  }
}

finish("Demo 8 — The Forgotten Memory");

async function freePort() {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

async function waitForReady(child, port, timeoutMs = 15000) {
  const start = Date.now();
  // Resolve as soon as /health answers.
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 200));
    if (child.exitCode !== null) throw new Error("daemon exited before becoming ready");
  }
  throw new Error("daemon did not become ready in time");
}

async function runLiveDemo(jar) {
  // Compile the launcher against the jar.
  const genDir = join(here, ".gen");
  mkdirSync(genDir, { recursive: true });
  const launcher = join(here, "MemoryGovDemoServer.java");
  const jc = spawnSync("javac", ["-cp", jar, "-d", genDir, launcher], { encoding: "utf8" });
  if (jc.status !== 0) { prereq("Failed to compile the launcher:\n" + (jc.stderr || jc.stdout)); return; }

  const port = await freePort();
  const wd = mkdtempSync(join(tmpdir(), "kcp-demo8-"));
  const dbPath = join(wd, "memory.db"); // isolated — NOT ~/.kcp/memory.db

  console.log(`\nStarting the real kcp-memory handlers on 127.0.0.1:${port} (isolated DB ${dbPath})`);
  const child = spawn("java", ["-cp", `${jar}:${genDir}`, "MemoryGovDemoServer", String(port), dbPath],
    { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); // drain
  child.stderr.on("data", () => {}); // JVM native-access warnings

  const base = `http://127.0.0.1:${port}`;
  const getJson = async (path) => (await fetch(base + path)).json();
  const post = async (path, body) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  try {
    const health = await waitForReady(child, port);
    console.log(`daemon health: status=${health.status} version=${health.version} sessions=${health.sessions}`);

    // --- 1. Pre-gate: all three governed memories are recalled ---------------
    const pre = await getJson(`/search?q=authentication&limit=10`);
    console.log(`\n(1) GET /search?q=authentication  → ${pre.count} memories recalled (pre-gate):`);
    for (const r of pre.results) console.log(`      ${r.sessionId.padEnd(16)} "${r.firstMessage}"  prov=${r.provenance}`);

    // --- 2. Govern two of them: one retention-expired, one forgotten ---------
    const past = "2000-01-01T00:00:00Z";
    const ret = await post(`/governance/retention`, { session: "sess-expired", valid_until: past });
    const forget = await post(`/governance/forget`, { session: "sess-forgotten", reason: "user exercised right-to-forget (sensitive credentials)" });
    console.log(`\n(2) POST /governance/retention {sess-expired, valid_until:${past}}  → ${JSON.stringify(ret)}`);
    console.log(`    POST /governance/forget    {sess-forgotten}                    → ${JSON.stringify(forget)}`);

    // --- 3. Post-gate: only the live memory is recalled, with provenance ------
    const post3 = await getJson(`/search?q=authentication&limit=10`);
    console.log(`\n(3) GET /search?q=authentication  → ${post3.count} memory recalled (post-gate):`);
    for (const r of post3.results) console.log(`      ${r.sessionId.padEnd(16)} "${r.firstMessage}"  prov=${r.provenance}`);

    // --- 4. Audit the gate: which candidates were skipped, and why -----------
    const audit = await getJson(`/governance/audit?q=authentication&limit=10`);
    showJson("(4) GET /governance/audit?q=authentication — the recall gate, explained", {
      candidates: audit.candidates, skipped: audit.skipped,
      results: audit.results.map((a) => ({ sessionId: a.sessionId, allowed: a.allowed, reason: a.reason })),
    });

    // --- 5. Provenance + tombstone metadata for individual memories ----------
    const govLive = await getJson(`/governance?session=sess-live`);
    const govForgotten = await getJson(`/governance?session=sess-forgotten`);
    showJson("(5) GET /governance?session=sess-live  (the live memory's provenance)", govLive);
    showJson("(5) GET /governance?session=sess-forgotten  (the tombstone is retained for audit)", govForgotten);

    // --- 6. Verdict ----------------------------------------------------------
    section("Verdict");
    expect("pre-gate: all three memories are recalled", pre.count === 3);
    expect("every recalled memory carries provenance", pre.results.every((r) => !!r.provenance));
    expect("retention + forget were applied over HTTP",
      ret.valid_until === past && forget.forgotten === "true");
    expect("post-gate: exactly ONE memory survives recall", post3.count === 1);
    expect("the survivor is the live memory, returned WITH its provenance",
      post3.results[0]?.sessionId === "sess-live" && /acme-auth|sess-live/.test(post3.results[0]?.provenance ?? ""));
    expect("the expired + forgotten memories are NOT recalled",
      !post3.results.some((r) => r.sessionId === "sess-expired" || r.sessionId === "sess-forgotten"));
    const byId = Object.fromEntries(audit.results.map((a) => [a.sessionId, a]));
    expect("audit surfaces all 3 candidates incl. the gated-out ones", audit.candidates === 3 && audit.skipped === 2);
    expect("audit reason for the expired memory says 'expired'", byId["sess-expired"]?.allowed === false && /expired/.test(byId["sess-expired"]?.reason ?? ""));
    expect("audit reason for the forgotten memory says 'forgotten' + the reason",
      byId["sess-forgotten"]?.allowed === false && /forgotten/.test(byId["sess-forgotten"]?.reason ?? "") && /right-to-forget/.test(byId["sess-forgotten"]?.reason ?? ""));
    expect("the live memory is allowed by the gate", byId["sess-live"]?.allowed === true);
    expect("the forgotten memory's ROW is retained (tombstone auditable)",
      govForgotten.forgottenAt != null && /right-to-forget/.test(govForgotten.forgetReason ?? ""));
    expect("the live memory has provenance and no tombstone/expiry",
      !!govLive.provenance && govLive.forgottenAt == null && govLive.validUntil == null);

    console.log(`\n(isolated run DB under ${wd} — the user's ~/.kcp/memory.db was never touched)`);
  } finally {
    child.kill("SIGTERM");
  }
}
