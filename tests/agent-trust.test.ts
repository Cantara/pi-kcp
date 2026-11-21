import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentNotFoundMessage, findAgentInvocation, parseConfig, resetTrustNotices } from "../src/index.js";

// Trust for a repo-local kcp-agent may only come from sources the repository cannot write:
// the environment, or the user-level ~/.pi/kcp.json. Planted binaries are never executed
// here; assertions are on the returned invocation and the notices raised.

const noWhichPi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
const ENV_KEYS = ["HOME", "KCP_AGENT_CLI", "KCP_TRUST_LOCAL_AGENT"] as const;

describe("repo-local kcp-agent requires explicit trust", () => {
  let base: string;
  let home: string;
  let repo: string;
  let planted: string;
  const saved: Record<string, string | undefined> = {};
  const notices: string[] = [];
  const notify = (m: string) => notices.push(m);

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    base = realpathSync(mkdtempSync(join(tmpdir(), "pi-kcp-trust-test-")));
    home = join(base, "home");
    repo = join(base, "repo");
    mkdirSync(join(home, ".pi"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
    planted = join(repo, "node_modules", ".bin", "kcp-agent");
    writeFileSync(planted, "#!/bin/sh\necho allow\n", { mode: 0o755 }); // never executed
    process.env.HOME = home;
    delete process.env.KCP_AGENT_CLI;
    delete process.env.KCP_TRUST_LOCAL_AGENT;
    notices.length = 0;
    resetTrustNotices();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(base, { recursive: true, force: true });
  });

  const base0 = () => parseConfig({}).config;
  const userConfig = (obj: unknown) => writeFileSync(join(home, ".pi", "kcp.json"), JSON.stringify(obj));

  it("skips an untrusted repo-local binary and raises the notice once", async () => {
    expect(await findAgentInvocation(noWhichPi, repo, base0(), { notify })).toBeUndefined();
    expect(await findAgentInvocation(noWhichPi, repo, base0(), { notify })).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(planted);
    expect(notices[0]).toContain("KCP_TRUST_LOCAL_AGENT=1");
  });

  it("uses the repo-local binary when KCP_TRUST_LOCAL_AGENT=1", async () => {
    process.env.KCP_TRUST_LOCAL_AGENT = "1";
    expect((await findAgentInvocation(noWhichPi, repo, base0(), { notify }))?.command).toBe(planted);
    expect(notices).toEqual([]);
  });

  it("uses the repo-local binary when the user-level config sets trustLocalAgent", async () => {
    userConfig({ trustLocalAgent: true });
    expect((await findAgentInvocation(noWhichPi, repo, base0(), { notify }))?.command).toBe(planted);
  });

  it("uses the repo-local binary when the project is in the user-level allow-list", async () => {
    userConfig({ trustedProjects: [repo] });
    expect((await findAgentInvocation(noWhichPi, repo, base0(), { notify }))?.command).toBe(planted);
    // another project is not trusted by that entry
    const other = join(base, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(other, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(other, "node_modules", ".bin", "kcp-agent"), "x", { mode: 0o755 });
    expect(await findAgentInvocation(noWhichPi, other, base0(), { notify })).toBeUndefined();
  });

  it("ignores trustLocalAgent written in the repo's own .pi/kcp.json", async () => {
    mkdirSync(join(repo, ".pi"));
    writeFileSync(join(repo, ".pi", "kcp.json"), JSON.stringify({ trustLocalAgent: true, trustedProjects: [repo] }));
    // Whatever the repo says, only env/user config count.
    expect(await findAgentInvocation(noWhichPi, repo, { ...base0(), ...({ trustLocalAgent: true } as object) }, { notify })).toBeUndefined();
    expect(notices).toHaveLength(1);
  });

  it("ignores a repo-config agentCli unless trusted, and notifies naming it", async () => {
    const repoCli = join(repo, "evil-cli.js");
    writeFileSync(repoCli, "// planted\n");
    expect(await findAgentInvocation(noWhichPi, repo, { ...base0(), agentCli: repoCli }, { notify })).toBeUndefined();
    expect(notices.join("\n")).toContain(repoCli);
    process.env.KCP_TRUST_LOCAL_AGENT = "1";
    expect((await findAgentInvocation(noWhichPi, repo, { ...base0(), agentCli: repoCli }, { notify }))?.args).toEqual([repoCli]);
  });

  it("user-level agentCli and KCP_AGENT_CLI work without any trust flag and beat repo candidates", async () => {
    const userCli = join(base, "user-cli.js");
    const envCli = join(base, "env-cli.js");
    writeFileSync(userCli, "// user\n");
    writeFileSync(envCli, "// env\n");
    userConfig({ agentCli: userCli });
    expect((await findAgentInvocation(noWhichPi, repo, base0(), { notify }))?.args).toEqual([userCli]);
    process.env.KCP_AGENT_CLI = envCli;
    expect((await findAgentInvocation(noWhichPi, repo, base0(), { notify }))?.args).toEqual([envCli]);
  });

  it("the not-found message carries the trust hint", () => {
    const msg = agentNotFoundMessage(base0());
    expect(msg).toContain("kcp-agent CLI was not found");
    expect(msg).toContain("KCP_TRUST_LOCAL_AGENT=1");
    expect(msg).toContain("~/.pi/kcp.json");
  });
});
