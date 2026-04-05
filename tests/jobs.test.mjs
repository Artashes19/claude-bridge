import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

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

test("resolveJobRecord throws when latest is requested and no jobs exist", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-jobs-empty-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  assert.throws(
    () => resolveJobRecord({ jobsDir: paths.jobsDir, jobIdOrLatest: "latest" }),
    /No job found for specifier latest/
  );
});

test("ensureStateDirs creates jobs and output directories", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-dirs-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  assert.equal(fs.existsSync(paths.jobsDir), true);
  assert.equal(fs.existsSync(paths.outputDir), true);
});

test("updateJobRecord preserves identity fields and keeps a single stored record", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-jobs-identity-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "review",
    cwd: repoRoot,
    summary: "Protect identity fields",
    model: "claude-opus-latest"
  });
  writeJobRecord({ jobsDir: paths.jobsDir, job });

  updateJobRecord({
    jobsDir: paths.jobsDir,
    jobId: job.id,
    patch: {
      id: "tampered-id",
      createdAt: "2000-01-01T00:00:00.000Z",
      status: "completed"
    }
  });

  const stored = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });
  assert.equal(stored.id, job.id);
  assert.equal(stored.createdAt, job.createdAt);
  assert.equal(stored.status, "completed");
  assert.equal(listJobRecords({ jobsDir: paths.jobsDir }).length, 1);
  assert.deepEqual(
    fs.readdirSync(paths.jobsDir).filter((entry) => entry.endsWith(".json")),
    [`${job.id}.json`]
  );
});

test("updateJobRecord keeps concurrent readers from seeing partial JSON", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-jobs-atomic-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "review",
    cwd: repoRoot,
    summary: "Keep job reads consistent",
    model: "claude-opus-latest"
  });
  writeJobRecord({ jobsDir: paths.jobsDir, job });

  const jobsModuleUrl = new URL(
    "../plugins/claude-bridge/scripts/lib/jobs.mjs",
    import.meta.url
  ).href;
  const workerFile = path.join(tempRoot, "atomic-update-worker.mjs");
  const targetPath = path.join(paths.jobsDir, `${job.id}.json`);

  fs.writeFileSync(
    workerFile,
    `
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { updateJobRecord } from ${JSON.stringify(jobsModuleUrl)};

const originalWriteFileSync = fs.writeFileSync.bind(fs);
let signaled = false;

fs.writeFileSync = function (file, data, options) {
  const resolvedFile = path.resolve(String(file));
  if (!signaled) {
    signaled = true;
    parentPort.postMessage({ type: "write-started", file: resolvedFile });
  }

  if (resolvedFile === workerData.targetPath) {
    originalWriteFileSync(file, "", options);
    parentPort.postMessage({ type: "target-truncated" });
    Atomics.wait(new Int32Array(workerData.sab), 0, 0);
  }

  return originalWriteFileSync(file, data, options);
};

try {
  updateJobRecord({
    jobsDir: workerData.jobsDir,
    jobId: workerData.jobId,
    patch: { status: "running", pid: 4321 }
  });
  parentPort.postMessage({ type: "done" });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    message: error.message,
    stack: error.stack
  });
}
`
  );

  const sab = new SharedArrayBuffer(4);
  const worker = new Worker(workerFile, {
    workerData: {
      jobsDir: paths.jobsDir,
      jobId: job.id,
      targetPath,
      sab
    }
  });

  try {
    const firstMessage = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) {
          reject(new Error(`worker exited with code ${code}`));
        }
      });
    });

    assert.notEqual(firstMessage.type, "error", firstMessage.message ?? "worker failed");

    let jobs;
    assert.doesNotThrow(() => {
      jobs = listJobRecords({ jobsDir: paths.jobsDir });
    });

    assert.equal(jobs.some((candidate) => candidate.id === job.id), true);

    const released = new Int32Array(sab);
    Atomics.store(released, 0, 1);
    Atomics.notify(released, 0);
  } finally {
    await worker.terminate();
  }

  const stored = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });
  assert.equal(stored.status, "running");
  assert.equal(stored.pid, 4321);
});
