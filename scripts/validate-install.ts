#!/usr/bin/env bun

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

interface RunOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  input?: string;
  holdStdinMs?: number;
}

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function stopProcess(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function runProcess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        resolvePromise({ stdout, stderr, code: code ?? 1, timedOut });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stopProcess(child);
      setTimeout(() => stopProcess(child), 500);
    }, options.timeoutMs);

    child.on("close", () => clearTimeout(timer));
    if (options.input !== undefined) {
      child.stdin.write(options.input);
      void sleep(options.holdStdinMs ?? 0).then(() => child.stdin.end());
    } else {
      child.stdin.end();
    }
  });
}

function assertOutput(result: RunResult, expected: string, label: string): void {
  if (result.timedOut) throw new Error(`${label} timed out after its hard deadline`);
  if (result.code !== 0) throw new Error(`${label} exited ${result.code}: ${result.stderr || result.stdout}`);
  if (!result.stdout.includes(expected)) {
    throw new Error(`${label} did not contain ${JSON.stringify(expected)}:\n${result.stdout}`);
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const fixture = await mkdtemp(join(tmpdir(), "pi-kcp-install-"));
  const fakeAgent = join(fixture, "fake-kcp-agent.mjs");
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ status: "ok", version: "fake" });
      if (url.pathname === "/search") {
        return Response.json({
          query: url.searchParams.get("q"),
          count: 1,
          results: [{ slug: "fixture-session", firstMessage: "A synthetic remembered session" }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    await writeFile(join(fixture, "knowledge.yaml"), "kcp_version: '0.25'\nproject: fixture\nversion: 1.0.0\nunits: []\n");
    await mkdir(join(fixture, ".pi"), { recursive: true });
    await writeFile(join(fixture, ".pi-config-placeholder"), "");
    await writeFile(fakeAgent, `#!/usr/bin/env node
// Mirror the real kcp-agent parser: fail-closed on unknown options, so interface
// drift between pi-kcp and the kcp-agent CLI fails this harness (pi-kcp#36).
const KNOWN_OPTIONS = new Set(["--manifest", "--json"]);
const TAKES_VALUE = new Set(["--manifest"]);
const argv = process.argv.slice(2);
for (let i = 1; i < argv.length; i++) {
  const t = argv[i];
  if (!t.startsWith("--")) continue;
  if (!KNOWN_OPTIONS.has(t)) { console.error("Unknown option: " + t); process.exit(2); }
  if (TAKES_VALUE.has(t)) i++;
}
const command = argv[0];
if (command === "plan") console.log(JSON.stringify({ task: argv[1], selected: [] }));
else if (command === "validate") console.log(JSON.stringify({ ok: true, findings: [] }));
else if (command === "init") console.log("knowledge.yaml already exists");
else process.exit(2);
`);
    await chmod(fakeAgent, 0o755);
    await writeFile(join(fixture, ".pi", "kcp.json"), JSON.stringify({
      memoryUrl: `http://localhost:${server.port}`,
      manifest: "knowledge.yaml",
      timeoutMs: 400,
    }));

    const build = await runProcess("bun", ["run", "build"], { cwd: root, timeoutMs: 60_000 });
    assertOutput(build, "", "build");

    for (const extension of ["src/index.ts", "dist/src/index.js"]) {
      const extensionPath = resolve(root, extension);
      const env = { KCP_AGENT_CLI: fakeAgent };
      const checks = [
        ["/kcp help", "KCP agent proficiency"],
        ["/kcp health", "kcp-memory: ok"],
        ["/kcp validate", "Added the kcp-agent validation report"],
        ["/kcp plan test fixture", "Added the kcp-agent load plan"],
        ["/kcp recall what did we decide", "Added 1 memory result"],
        ["/kcp init", "will not overwrite"],
      ] as const;

      for (const [message, expected] of checks) {
        const result = await runProcess("pi", ["--mode", "rpc", "--no-session", "--no-tools", "-e", extensionPath], {
          cwd: fixture,
          env,
          timeoutMs: 15_000,
          input: `${JSON.stringify({ id: "validation", type: "prompt", message })}\n`,
          holdStdinMs: 2_000,
        });
        assertOutput(result, expected, `${extension} ${message}`);
      }
      console.log(`ok: ${extension} passes clean-fixture Pi command validation`);
    }
  } finally {
    server.stop(true);
    await rm(fixture, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
