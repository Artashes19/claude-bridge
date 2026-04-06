import fs from "node:fs";
import path from "node:path";
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

function readUntrackedFileText(cwd, relativePath, readFile) {
  try {
    return readFile(path.join(cwd, relativePath), "utf8");
  } catch (error) {
    return `[unable to read ${relativePath}: ${error?.message ?? String(error)}]\n`;
  }
}

function buildUntrackedSection({ cwd, run, readFile }) {
  const untrackedFiles = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], run)
    .split("\0")
    .filter(Boolean);

  if (untrackedFiles.length === 0) {
    return "";
  }

  return [
    "## Untracked",
    ...untrackedFiles.map((relativePath) => {
      const text = readUntrackedFileText(cwd, relativePath, readFile);
      const normalized = text.endsWith("\n") ? text : `${text}\n`;
      return `### ${relativePath}\n${normalized}`;
    })
  ].join("\n");
}

export function buildReviewInput({ cwd, baseRef = null, run = spawnSync, readFile = fs.readFileSync }) {
  if (baseRef) {
    return {
      target: `${baseRef}...HEAD`,
      statusText: `Range review: ${baseRef}...HEAD`,
      diffStatText: runGit(cwd, ["diff", "--stat", "--no-ext-diff", `${baseRef}...HEAD`], run),
      diffText: runGit(cwd, ["diff", "--no-ext-diff", `${baseRef}...HEAD`], run)
    };
  }

  const statusText = runGit(cwd, ["status", "--short"], run);
  const diffStatText = runGit(cwd, ["diff", "--stat", "--no-ext-diff"], run);
  const unstagedDiffText = runGit(cwd, ["diff", "--no-ext-diff"], run);
  const stagedDiffText = runGit(cwd, ["diff", "--cached", "--no-ext-diff"], run);
  const untrackedSection = buildUntrackedSection({ cwd, run, readFile });

  return {
    target: "working tree",
    statusText,
    diffStatText,
    diffText: [
      "## Unstaged",
      unstagedDiffText,
      "",
      "## Staged",
      stagedDiffText,
      untrackedSection ? `\n${untrackedSection}` : ""
    ].join("\n")
  };
}
