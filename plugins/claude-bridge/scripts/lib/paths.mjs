import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function findRepoRoot(startCwd) {
  let current = path.resolve(startCwd);

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startCwd);
    }
    current = parent;
  }
}

export function checkGitRepository({ cwd, run = spawnSync }) {
  try {
    const result = run("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8"
    });

    if ((result.status ?? 1) === 0) {
      return { valid: true, repoRoot: (result.stdout ?? "").trim() };
    }

    const error = (result.stderr ?? "").trim() || result.error?.message || "fatal: not a git repository";
    return { valid: false, error };
  } catch (error) {
    return {
      valid: false,
      error: error?.message ?? String(error)
    };
  }
}

export function resolvePaths({ cwd, homeDir = os.homedir() }) {
  const repoRoot = findRepoRoot(cwd);
  const repoStateDir = path.join(repoRoot, ".claude-bridge");

  return {
    repoRoot,
    repoStateDir,
    jobsDir: path.join(repoStateDir, "jobs"),
    outputDir: path.join(repoStateDir, "output"),
    repoConfigPath: path.join(repoStateDir, "config.json"),
    globalConfigPath: path.join(homeDir, ".claude-bridge", "config.json")
  };
}

function resolveGitExcludePath(repoRoot, run) {
  try {
    const result = run("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    if ((result.status ?? 1) !== 0) {
      return null;
    }

    const gitPath = (result.stdout ?? "").trim();
    if (!gitPath) {
      return null;
    }

    return path.resolve(repoRoot, gitPath);
  } catch {
    return null;
  }
}

function ensureRepoStateIgnored(paths, { run, readFile, writeFile, mkdir }) {
  const excludePath = resolveGitExcludePath(paths.repoRoot, run);
  if (!excludePath) {
    return;
  }

  mkdir(path.dirname(excludePath), { recursive: true });

  let current = "";
  try {
    current = readFile(excludePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return;
    }
  }

  const entry = ".claude-bridge/";
  const existingEntries = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (existingEntries.includes(entry)) {
    return;
  }

  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFile(excludePath, `${current}${separator}${entry}\n`);
}

export function ensureStateDirs(
  paths,
  {
    run = spawnSync,
    readFile = fs.readFileSync,
    writeFile = fs.writeFileSync,
    mkdir = fs.mkdirSync
  } = {}
) {
  mkdir(paths.jobsDir, { recursive: true });
  mkdir(paths.outputDir, { recursive: true });
  ensureRepoStateIgnored(paths, { run, readFile, writeFile, mkdir });
}
