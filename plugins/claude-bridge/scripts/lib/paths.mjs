import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

export function ensureStateDirs(paths) {
  fs.mkdirSync(paths.jobsDir, { recursive: true });
  fs.mkdirSync(paths.outputDir, { recursive: true });
}
