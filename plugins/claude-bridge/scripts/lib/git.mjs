import { spawnSync } from "node:child_process";

function formatRunnerError(result, fallbackMessage) {
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    return stderr;
  }

  const error = result.error;
  if (!error) {
    return fallbackMessage;
  }

  return (
    error.message ??
    String(error) ??
    error.code ??
    fallbackMessage
  ).trim();
}

function runGit(cwd, args, run) {
  const result = run("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(formatRunnerError(result, `git ${args.join(" ")} failed`));
  }
  return result.stdout ?? "";
}

export function buildReviewInput({ cwd, baseRef = null, run = spawnSync }) {
  if (baseRef) {
    return {
      target: `${baseRef}...HEAD`,
      statusText: `Range review: ${baseRef}...HEAD`,
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
