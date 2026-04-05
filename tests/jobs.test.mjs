import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureStateDirs,
  findRepoRoot,
  resolvePaths
} from "../plugins/claude-bridge/scripts/lib/paths.mjs";
import {
  createJobRecord,
  listJobRecords,
  readJobRecord,
  resolveJobRecord,
  updateJobRecord,
  writeJobRecord
} from "../plugins/claude-bridge/scripts/lib/jobs.mjs";

test("findRepoRoot walks up to the nearest .git directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-paths-"));
  const repoRoot = path.join(tempRoot, "repo");
  const nested = path.join(repoRoot, "src", "feature");

  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });

  assert.equal(findRepoRoot(nested), repoRoot);
});

test("resolvePaths returns repo-local state directories", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-paths-"));
  const repoRoot = path.join(tempRoot, "repo");

  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });

  assert.equal(paths.repoRoot, repoRoot);
  assert.equal(paths.repoStateDir, path.join(repoRoot, ".claude-bridge"));
  assert.equal(paths.jobsDir, path.join(repoRoot, ".claude-bridge", "jobs"));
  assert.equal(paths.outputDir, path.join(repoRoot, ".claude-bridge", "output"));
  assert.equal(paths.repoConfigPath, path.join(repoRoot, ".claude-bridge", "config.json"));
  assert.equal(paths.globalConfigPath, path.join(tempRoot, "home", ".claude-bridge", "config.json"));
});

test("writeJobRecord, readJobRecord, updateJobRecord, and listJobRecords round-trip JSON state", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-jobs-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const olderJob = createJobRecord({
    kind: "review",
    cwd: repoRoot,
    summary: "Review older changes",
    model: "claude-opus-latest"
  });
  olderJob.createdAt = "2024-01-01T00:00:00.000Z";

  const newerJob = createJobRecord({
    kind: "review",
    cwd: repoRoot,
    summary: "Review newer changes",
    model: "claude-opus-latest"
  });
  newerJob.createdAt = "2024-01-02T00:00:00.000Z";

  writeJobRecord({ jobsDir: paths.jobsDir, job: newerJob });
  writeJobRecord({ jobsDir: paths.jobsDir, job: olderJob });

  const stored = readJobRecord({ jobsDir: paths.jobsDir, jobId: newerJob.id });
  assert.equal(stored.summary, "Review newer changes");
  assert.equal(stored.status, "queued");

  updateJobRecord({
    jobsDir: paths.jobsDir,
    jobId: newerJob.id,
    patch: { status: "completed", outputFile: path.join(paths.outputDir, `${newerJob.id}.txt`) }
  });

  const updated = readJobRecord({ jobsDir: paths.jobsDir, jobId: newerJob.id });
  assert.equal(updated.status, "completed");

  const jobs = listJobRecords({ jobsDir: paths.jobsDir });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].id, newerJob.id);
  assert.equal(jobs[1].id, olderJob.id);
  assert.equal(resolveJobRecord({ jobsDir: paths.jobsDir, jobIdOrLatest: "latest" }).id, newerJob.id);
});
