import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_DIFF_STAT_BYTES = 16 * 1024;
const MAX_TRACKED_DIFF_BYTES = 64 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 16 * 1024;
const MAX_UNTRACKED_SECTION_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
  const result = run("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(formatRunnerError(result, `git ${args.join(" ")} failed`));
  }
  return result.stdout ?? "";
}

function truncateTrackedText(text, maxBytes, label) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }

  const truncated = buffer.subarray(0, maxBytes).toString("utf8");
  const normalized = truncated.endsWith("\n") ? truncated : `${truncated}\n`;
  return `${normalized}[truncated ${label}: ${buffer.length} bytes exceeds ${maxBytes}-byte review limit]\n`;
}

function normalizeRelativePath(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function isBridgeArtifact(relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  return normalizedPath === ".claude-bridge" || normalizedPath.startsWith(".claude-bridge/");
}

function filterWorkingTreeStatusText(statusText) {
  return statusText
    .split("\n")
    .filter((line) => {
      if (!line) {
        return false;
      }

      const pathPart = line.slice(3);
      return !pathPart.includes(".claude-bridge/");
    })
    .join("\n");
}

function readUntrackedFileText(cwd, relativePath, readFile, remainingBudgetBytes) {
  const filePath = path.join(cwd, relativePath);

  try {
    const stats = fs.statSync(filePath);
    if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
      return {
        kind: "note",
        text: `[skipped ${relativePath}: ${stats.size} bytes exceeds ${MAX_UNTRACKED_FILE_BYTES}-byte review limit]\n`
      };
    }

    if (stats.size > remainingBudgetBytes) {
      return {
        kind: "stop",
        text: `[skipped remaining untracked files: review budget of ${MAX_UNTRACKED_SECTION_BYTES} bytes exhausted]\n`
      };
    }

    const fileData = readFile(filePath);
    const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);

    if (buffer.includes(0)) {
      return {
        kind: "note",
        text: `[skipped ${relativePath}: binary or unreadable content]\n`
      };
    }

    const text = UTF8_DECODER.decode(buffer);
    return {
      kind: "text",
      text: text.endsWith("\n") ? text : `${text}\n`,
      bytes: stats.size
    };
  } catch (error) {
    return {
      kind: "note",
      text: `[unable to read ${relativePath}: ${error?.message ?? String(error)}]\n`
    };
  }
}

function buildUntrackedSection({ cwd, run, readFile }) {
  const untrackedFiles = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], run)
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => !isBridgeArtifact(relativePath));

  if (untrackedFiles.length === 0) {
    return "";
  }

  let remainingBudget = MAX_UNTRACKED_SECTION_BYTES;
  const sectionLines = ["## Untracked"];

  for (const relativePath of untrackedFiles) {
    if (remainingBudget <= 0) {
      sectionLines.push(`[skipped remaining untracked files: review budget of ${MAX_UNTRACKED_SECTION_BYTES} bytes exhausted]`);
      break;
    }

    const entry = readUntrackedFileText(cwd, relativePath, readFile, remainingBudget);

    if (entry.kind === "stop") {
      sectionLines.push(entry.text.trimEnd());
      break;
    }

    sectionLines.push(`### ${relativePath}`);
    sectionLines.push(entry.text.trimEnd());

    if (entry.kind === "text") {
      remainingBudget -= entry.bytes ?? 0;
    }
  }

  return sectionLines.join("\n");
}

export function buildReviewInput({ cwd, baseRef = null, run = spawnSync, readFile = fs.readFileSync }) {
  if (baseRef) {
    return {
      target: `${baseRef}...HEAD`,
      statusText: `Range review: ${baseRef}...HEAD`,
      diffStatText: truncateTrackedText(
        runGit(cwd, ["diff", "--stat", "--no-ext-diff", `${baseRef}...HEAD`], run),
        MAX_TRACKED_DIFF_STAT_BYTES,
        "tracked diff stat"
      ),
      diffText: truncateTrackedText(
        runGit(cwd, ["diff", "--no-ext-diff", `${baseRef}...HEAD`], run),
        MAX_TRACKED_DIFF_BYTES,
        "tracked diff"
      )
    };
  }

  const statusText = filterWorkingTreeStatusText(runGit(cwd, ["status", "--short"], run));
  const diffStatText = truncateTrackedText(
    runGit(cwd, ["diff", "--stat", "--no-ext-diff"], run),
    MAX_TRACKED_DIFF_STAT_BYTES,
    "tracked diff stat"
  );
  const unstagedDiffText = truncateTrackedText(
    runGit(cwd, ["diff", "--no-ext-diff"], run),
    MAX_TRACKED_DIFF_BYTES,
    "tracked diff"
  );
  const stagedDiffText = truncateTrackedText(
    runGit(cwd, ["diff", "--cached", "--no-ext-diff"], run),
    MAX_TRACKED_DIFF_BYTES,
    "tracked diff"
  );
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
