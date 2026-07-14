#!/usr/bin/env bun

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type Verdict = "APPROVE" | "REQUEST-CHANGES";

interface Options {
  prs: number[];
  repo: string;
  provider: string;
  model: string;
  comment: boolean;
}

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  headRefOid?: string;
}

export function extractIssueNumbers(text: string): number[] {
  const numbers = [...text.matchAll(/(?:ref|issue)\s*:?\s*#(\d+)/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isInteger);
  return [...new Set(numbers)];
}

export function parseVerdict(output: string): Verdict | undefined {
  const match = output.match(/^VERDICT:\s*(APPROVE|REQUEST-CHANGES)\s*$/m);
  return match?.[1] as Verdict | undefined;
}

export function buildEvaluationPrompt(
  pullRequest: PullRequest,
  issues: string,
  diff: string,
  model: string,
): string {
  return `You are an INDEPENDENT, out-of-context PR evaluator. Your evaluator is ${model}. Do not modify files, run deployments, create commits, or call external services. Judge the supplied artifacts, not the PR prose alone.

Evaluate PR #${pullRequest.number}: ${pullRequest.title}

Judge all of the following:
1. VALUE — Does it deliver the linked issue's requested outcome? Are tests real and non-vacuous?
2. CORRECTNESS — Check logic, TypeScript, shell safety, error handling, security, and documentation accuracy.
3. SCOPE — Is it self-contained with no unrelated work or unfinished scaffolding?

Report findings with severity and confidence. State which acceptance criteria are met or missing. Give a concise recommendation. Always complete the evaluation. End with exactly one line:
VERDICT: APPROVE
or
VERDICT: REQUEST-CHANGES

LINKED ISSUE ARTIFACTS:
${issues}

PR DIFF:
${diff}
`;
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    prs: [],
    repo: process.env.PI_KCP_REPO ?? "Cantara/pi-kcp",
    provider: process.env.PI_KCP_EVAL_PROVIDER ?? "opencode",
    model: process.env.PI_KCP_EVAL_MODEL ?? "minimax-m3",
    comment: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--comment") options.comment = true;
    else if (arg === "--repo") options.repo = argv[++index] ?? options.repo;
    else if (arg === "--provider") options.provider = argv[++index] ?? options.provider;
    else if (arg === "--model") options.model = argv[++index] ?? options.model;
    else if (/^\d+$/.test(arg)) options.prs.push(Number(arg));
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run pr-eval -- <PR> [<PR> ...] [--comment] [--repo owner/name]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.prs.length === 0) throw new Error("At least one PR number is required; use --help for usage");
  return options;
}

async function evaluate(prNumber: number, options: Options, workDir: string): Promise<Verdict> {
  const pullRequest = JSON.parse(
    run("gh", ["pr", "view", String(prNumber), "--repo", options.repo, "--json", "number,title,body,headRefOid"]),
  ) as PullRequest;
  const issueNumbers = extractIssueNumbers(pullRequest.body ?? "");
  if (issueNumbers.length === 0) throw new Error(`PR #${prNumber} does not reference an issue`);

  const issues = issueNumbers
    .map((issue) => run("gh", ["issue", "view", String(issue), "--repo", options.repo, "--json", "number,title,body"]))
    .join("\n");
  const diff = run("gh", ["pr", "diff", String(prNumber), "--repo", options.repo]);
  const prompt = buildEvaluationPrompt(pullRequest, issues, diff, `${options.provider}/${options.model}`);
  const promptPath = join(workDir, `pr-${prNumber}.prompt.txt`);
  await writeFile(promptPath, prompt, "utf8");

  const result = spawnSync("pi", [
    "--provider", options.provider,
    "--model", options.model,
    "--no-tools",
    "--print",
    `@${promptPath}`,
  ], { input: "", encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pi evaluator failed (${result.status}): ${result.stderr.trim()}`);

  const output = result.stdout.trim();
  const verdict = parseVerdict(output);
  if (!verdict) throw new Error(`Evaluator returned no recognizable verdict for PR #${prNumber}`);

  const report = `## PR-Eval — ${options.provider}/${options.model}\n\n**Context:** independent, out-of-context evaluation of PR diff and linked issue artifacts.\n\n${output}`;
  if (options.comment) {
    run("gh", ["pr", "comment", String(prNumber), "--repo", options.repo, "--body-file", "-"], report);
  }

  console.log(`PR #${prNumber}: ${verdict}${options.comment ? " (comment posted)" : ""}`);
  if (verdict === "REQUEST-CHANGES") console.log(report);
  return verdict;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const workDir = await mkdtemp(join(tmpdir(), "pi-kcp-pr-eval-"));
  let failures = 0;
  try {
    for (const pr of options.prs) {
      try {
        await evaluate(pr, options, workDir);
      } catch (error) {
        failures += 1;
        console.error(`PR #${pr}: FAILED — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  if (failures > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
