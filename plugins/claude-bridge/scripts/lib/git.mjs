import { spawnSync } from "node:child_process";

function runGit(cwd, args, run) {
  const result = run("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr ?? `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout ?? "";
}

export function buildReviewInput({ cwd, baseRef = null, run = spawnSync }) {
  if (baseRef) {
    return {
      target: `${baseRef}...HEAD`,
      statusText: runGit(cwd, ["status", "--short"], run),
      diffStatText: runGit(cwd, ["diff", "--stat", "--no-ext-diff", `${baseRef}...HEAD`], run),
      diffText: runGit(cwd, ["diff", "--no-ext-diff", `${baseRef}...HEAD`], run)
    };
  }

  return {
    target: "working tree",
    statusText: runGit(cwd, ["status", "--short"], run),
    diffStatText: runGit(cwd, ["diff", "--stat", "--no-ext-diff"], run),
    diffText: [
      "## Unstaged",
      runGit(cwd, ["diff", "--no-ext-diff"], run),
      "",
      "## Staged",
      runGit(cwd, ["diff", "--cached", "--no-ext-diff"], run)
    ].join("\n")
  };
}
