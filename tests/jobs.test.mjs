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
});

test("writeJobRecord, readJobRecord, updateJobRecord, and listJobRecords round-trip JSON state", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-jobs-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "review",
    cwd: repoRoot,
    summary: "Review current changes",
    model: "claude-opus-latest"
  });

  writeJobRecord({ jobsDir: paths.jobsDir, job });

  const stored = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });
  assert.equal(stored.summary, "Review current changes");
  assert.equal(stored.status, "queued");

  updateJobRecord({
    jobsDir: paths.jobsDir,
    jobId: job.id,
    patch: { status: "completed", outputFile: path.join(paths.outputDir, `${job.id}.txt`) }
  });

  const updated = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });
  assert.equal(updated.status, "completed");

  const jobs = listJobRecords({ jobsDir: paths.jobsDir });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, job.id);
  assert.equal(resolveJobRecord({ jobsDir: paths.jobsDir, jobIdOrLatest: "latest" }).id, job.id);
});
