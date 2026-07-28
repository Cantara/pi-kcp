/**
 * Ask the installed kcp-agent what it supports, rather than inferring it from a version.
 *
 * pi-kcp#36: `/kcp plan` failed against every released kcp-agent because the loop passed
 * `--correlation-id` and the agent's parser fail-closes on unknown options — the whole turn
 * died on `Unknown option: --correlation-id`. The flag was dropped as the fix, with a note
 * to re-enable it behind a capability probe once kcp-agent shipped it (kcp-agent#114). It
 * shipped in v0.22.0 and became visible to `--help` in v0.22.1.
 *
 * The probe reads the binary's own help text. Version comparison would be the obvious
 * alternative and is worse: it breaks on forks, prereleases, locally-built agents and
 * anything that reports a version string we did not anticipate. The help text is the
 * binary's own answer about itself.
 *
 * Everything here fails closed. Guessing "supported" costs a hard failure of the whole turn
 * — that is precisely pi-kcp#36. Guessing "unsupported" costs one absent field on an audit
 * record. The asymmetry is not close.
 */

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the agent's help command. Injected so the probe is testable without a binary. */
export type HelpRunner = () => Promise<ProbeResult>;

/**
 * Whether `help` documents `flag` as a whole token.
 *
 * Deliberately not a substring test: `--correlation-id` must not be satisfied by
 * `--correlation-id-source`, or the probe reports support that is not there and the turn
 * dies exactly as it did in pi-kcp#36.
 */
export function helpMentionsFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A flag ends where a character that cannot be part of one begins.
  return new RegExp(`${escaped}(?![a-zA-Z0-9-])`).test(help);
}

const cache = new Map<string, Promise<boolean>>();

/**
 * Whether the installed agent accepts `flag`.
 *
 * @param cacheKey identifies the binary. Pass one to probe a given agent once per process;
 *                 omit it when the caller cannot distinguish binaries and would rather
 *                 re-probe than risk a stale answer for a different one.
 */
export async function supportsFlag(
  runHelp: HelpRunner,
  flag: string,
  cacheKey?: string,
): Promise<boolean> {
  if (cacheKey !== undefined) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const probe = (async () => {
    try {
      const result = await runHelp();
      // A non-zero exit means we do not know what we are talking to, whatever it printed.
      if (result.code !== 0) return false;
      // Some CLIs write help to stderr; read both rather than assume.
      return helpMentionsFlag(`${result.stdout}\n${result.stderr}`, flag);
    } catch {
      // Missing binary, timeout, permissions — all "we cannot tell", which means no.
      return false;
    }
  })();

  if (cacheKey !== undefined) cache.set(cacheKey, probe);
  return probe;
}

/** Testing seam: drop memoised probe results. */
export function resetCapabilityCache(): void {
  cache.clear();
}
