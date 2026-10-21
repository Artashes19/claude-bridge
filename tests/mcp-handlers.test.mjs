import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  handleSetup,
  handleReview,
  handleDelegate,
  handleStatus,
  handleResult,
  handleCancel,
  handleTaskRequest,
} from "../plugins/claude-bridge/scripts/lib/mcp-handlers.mjs";
import { createJobRecord, writeJobRecord, updateJobRecord, readJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";

test("stable request IDs recover active and completed jobs without another launch", async () => {
  const cwd = makeTmpRepo();
  const jobsDir = path.join(cwd, ".claude-bridge", "jobs");
  let launches = 0;
  const options = { cwd, homeDir: cwd, task: "fixture task", requestId: "request-1", background: true,
    deps: { ...gitOk(cwd), spawnDetachedWorker: async () => { launches++; return { pid: process.pid }; } },
  };
  try {
    const first = await handleDelegate(options);
    const retry = await handleDelegate(options);
    assert.equal(retry.jobId, first.jobId);
    assert.equal(retry.reused, true);
    assert.equal(launches, 1);
    const outputFile = path.join(cwd, ".claude-bridge", "output", "report.txt");
    fs.writeFileSync(outputFile, "saved report");
    updateJobRecord({ jobsDir, jobId: first.jobId, patch: { status: "completed", pid: null, outputFile } });
    const completed = await handleTaskRequest(handleDelegate, options);
    assert.equal(completed.jobId, first.jobId);
    assert.equal(completed.output, "saved report");
    assert.equal(completed.reused, true);
    assert.equal(launches, 1);
    const conflict = await handleDelegate({ ...options, task: "different task" });
    assert.match(conflict.error, /different request/);
    assert.equal(launches, 1);
    const separate = await handleDelegate({ ...options, requestId: "request-2" });
    assert.notEqual(separate.jobId, first.jobId);
    assert.equal(launches, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("identical active submissions without an ID reuse their job", async () => {
  const cwd = makeTmpRepo();
  let launches = 0;
  const options = { cwd, homeDir: cwd, background: true, focus: "fixture review", deps: {
    ...reviewDeps(cwd), spawnDetachedWorker: async () => { launches++; return { pid: process.pid }; },
  } };
  try {
    const [first, second] = await Promise.all([handleReview(options), handleReview(options)]);
    assert.equal(second.jobId, first.jobId);
    assert.equal(launches, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("paged retrieval reconstructs long Unicode reports without broken characters", async () => {
  const cwd = makeTmpRepo();
  const jobsDir = path.join(cwd, ".claude-bridge", "jobs");
  const outputFile = path.join(cwd, ".claude-bridge", "output", "report.txt");
  const report = "a🛰️Հայերենé\n".repeat(1200);
  const job = createJobRecord({ kind: "review", cwd, summary: "fixture", model: "test" });
  Object.assign(job, { status: "completed", outputFile });
  fs.writeFileSync(outputFile, report);
  writeJobRecord({ jobsDir, job });
  try {
    const first = await handleResult({ cwd, homeDir: cwd, jobId: job.id });
    assert.equal(first.hasMore, true);
    assert.ok(Buffer.byteLength(first.output) <= 12000);
    let offset = 0;
    let restored = "";
    do {
      const result = await handleResult({ cwd, homeDir: cwd, jobId: job.id, offset, maxBytes: 137 });
      assert.ok(result.nextOffset > offset);
      assert.ok(!result.output.includes("�"));
      restored += result.output;
      offset = result.nextOffset;
      if (!result.hasMore) break;
    } while (true);
    assert.equal(restored, report);
    assert.equal(offset, Buffer.byteLength(report));
    fs.unlinkSync(outputFile);
    const missing = await handleResult({ cwd, homeDir: cwd, jobId: job.id });
    assert.match(missing.error, /report file is missing/);
    assert.equal(missing.id, job.id);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("lost workers report failure while retaining partial output and startup diagnostics", async () => {
  const cwd = makeTmpRepo();
  const jobsDir = path.join(cwd, ".claude-bridge", "jobs");
  const job = createJobRecord({ kind: "review", cwd, summary: "fixture", model: "test" });
  const outputFile = path.join(cwd, ".claude-bridge", "output", "partial.txt");
  const workerLogFile = `${outputFile}.worker`;
  fs.writeFileSync(outputFile, "retained evidence");
  fs.writeFileSync(workerLogFile, "startup failure");
  Object.assign(job, { status: "running", outputFile, workerLogFile, pid: 12345 });
  writeJobRecord({ jobsDir, job });
  try {
    const result = await handleResult({ cwd, homeDir: cwd, jobId: job.id, deps: {
      killProcess: () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); },
    } });
    assert.equal(result.status, "failed");
    assert.equal(result.output, "retained evidence");
    assert.match(result.diagnostics, /startup failure/);
    assert.match(result.diagnostics, /inspect it before/);
    assert.equal(readJobRecord({ jobsDir, jobId: job.id }).pid, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("empty reports and unexpected runner errors are stored as failures", async () => {
  for (const fail of [false, true]) {
    const cwd = makeTmpRepo();
    try {
      const submitted = await handleDelegate({ cwd, homeDir: cwd, task: "fixture", deps: {
        ...gitOk(cwd), runClaudeForeground: () => {
          if (fail) throw new Error("unexpected fixture failure");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      } });
      assert.equal(submitted.status, "failed");
      const result = await handleResult({ cwd, homeDir: cwd, jobId: submitted.jobId });
      assert.equal(result.status, "failed");
      assert.match(result.diagnostics, fail ? /unexpected fixture failure/ : /without a report/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("bounded requests return a retrievable job while work continues", async () => {
  const cwd = makeTmpRepo();
  const jobsDir = path.join(cwd, ".claude-bridge", "jobs");
  const job = createJobRecord({ kind: "review", cwd, summary: "check", model: "test" });
  writeJobRecord({ jobsDir, job });
  const submit = async (options) => {
    assert.equal(options.background, true);
    return { jobId: job.id, status: "queued" };
  };
  try {
    const result = await handleTaskRequest(submit, { cwd, homeDir: cwd }, { waitMs: 5, pollMs: 1 });
    assert.equal(result.jobId, job.id);
    assert.equal(result.status, "queued");
    assert.equal(result.background, true);
    assert.match(result.nextAction, /bridge_result/);
    const outputFile = path.join(cwd, ".claude-bridge", "output", "report.txt");
    fs.writeFileSync(outputFile, "final report");
    updateJobRecord({ jobsDir, jobId: job.id, patch: { status: "completed", outputFile } });
    const completed = await handleTaskRequest(submit, { cwd, homeDir: cwd });
    assert.equal(completed.status, "completed");
    assert.equal(completed.output, "final report");
    assert.equal(completed.background, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

function freshTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function makeTmpRepo() {
  const tmpDir = freshTemp();
  const jobsDir = path.join(tmpDir, ".claude-bridge", "jobs");
  const outputDir = path.join(tmpDir, ".claude-bridge", "output");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  return tmpDir;
}

function gitOk(root) {
  return { checkGitRepository: () => ({ valid: true, root }) };
}

function gitFail() {
  return { checkGitRepository: () => ({ valid: false, error: "not a git repository" }) };
}

function claudeOk() {
  return {
    checkClaudeAvailability: () => ({ available: true, version: "2.1.92 (Claude Code)", error: "" }),
    checkClaudeReadiness: () => ({ ready: true, version: "2.1.92 (Claude Code)", error: "" }),
  };
}

function reviewDeps(root) {
  return {
    ...gitOk(root),
    ...claudeOk(),
    runClaudeForeground: () => ({ exitCode: 0, stdout: "Looks good!", stderr: "", error: null }),
    buildReviewInput: () => ({ target: "working tree", statusText: "M file.js", diffStatText: "1 file", diffText: "+line" }),
    spawnDetachedWorker: () => ({ pid: 999 }),
  };
}

// ── handleSetup ──────────────────────────────────────────────────────────────

test("handleSetup returns ready when Claude is available and repo is valid", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleSetup({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: { ...gitOk(tmpDir), ...claudeOk() },
  });
  assert.equal(result.ready, true);
  assert.equal(result.version, "2.1.92 (Claude Code)");
  assert.equal(result.error, undefined);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleSetup returns error when not a git repo", async () => {
  const tmpDir = freshTemp();
  const result = await handleSetup({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: {
      ...gitFail(),
      checkClaudeAvailability: () => ({ available: true, version: "2.1.92", error: "" }),
    },
  });
  assert.equal(result.ready, false);
  assert.match(result.error, /not a git repository/);
  fs.rmSync(tmpDir, { recursive: true });
});

// ── handleReview ─────────────────────────────────────────────────────────────

test("handleReview foreground returns completed output", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleReview({
    cwd: tmpDir,
    homeDir: tmpDir,
    focus: "check error handling",
    deps: reviewDeps(tmpDir),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Looks good!");
  assert.ok(result.jobId);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleReview rejects non-git cwd", async () => {
  const tmpDir = freshTemp();
  const result = await handleReview({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: gitFail(),
  });
  assert.match(result.error, /not a git repository/);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleReview background returns queued job", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleReview({
    cwd: tmpDir,
    homeDir: tmpDir,
    background: true,
    deps: reviewDeps(tmpDir),
  });
  assert.equal(result.background, true);
  assert.equal(result.status, "queued");
  assert.ok(result.jobId);
  fs.rmSync(tmpDir, { recursive: true });
});

// ── handleDelegate ───────────────────────────────────────────────────────────

test("handleDelegate foreground returns completed output", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleDelegate({
    cwd: tmpDir,
    homeDir: tmpDir,
    task: "fix the failing test",
    deps: {
      ...gitOk(tmpDir),
      runClaudeForeground: () => ({ exitCode: 0, stdout: "Fixed the test.", stderr: "", error: null }),
      spawnDetachedWorker: () => ({ pid: 999 }),
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Fixed the test.");
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleDelegate rejects empty task", async () => {
  const tmpDir = freshTemp();
  const result = await handleDelegate({
    cwd: tmpDir,
    homeDir: tmpDir,
    task: "",
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /requires a task/);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleDelegate rejects non-git cwd", async () => {
  const tmpDir = freshTemp();
  const result = await handleDelegate({
    cwd: tmpDir,
    homeDir: tmpDir,
    task: "do something",
    deps: gitFail(),
  });
  assert.match(result.error, /not a git repository/);
  fs.rmSync(tmpDir, { recursive: true });
});

// ── handleStatus ─────────────────────────────────────────────────────────────

test("handleStatus returns empty job list for fresh repo", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleStatus({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: gitOk(tmpDir),
  });
  assert.deepEqual(result.jobs, []);
  fs.rmSync(tmpDir, { recursive: true });
});

// ── handleResult ─────────────────────────────────────────────────────────────

test("handleResult returns error for missing job", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleResult({
    cwd: tmpDir,
    homeDir: tmpDir,
    jobId: "nonexistent",
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /No job found/);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleResult returns error when no jobId provided", async () => {
  const tmpDir = freshTemp();
  const result = await handleResult({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /requires a job ID/);
  fs.rmSync(tmpDir, { recursive: true });
});

// ── handleCancel ─────────────────────────────────────────────────────────────

test("handleCancel returns error when no jobId provided", async () => {
  const tmpDir = freshTemp();
  const result = await handleCancel({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /requires a job ID/);
  fs.rmSync(tmpDir, { recursive: true });
});

// ── Tests for review findings #2 and #4 ──────────────────────────────────────

test("handleResult returns error for 'latest' on empty repo", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleResult({
    cwd: tmpDir,
    homeDir: tmpDir,
    jobId: "latest",
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /No job found/);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleCancel returns error for 'latest' on empty repo", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleCancel({
    cwd: tmpDir,
    homeDir: tmpDir,
    jobId: "latest",
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /No job found/);
  fs.rmSync(tmpDir, { recursive: true });
});

test("handleReview background marks job failed on spawn error", async () => {
  const tmpDir = makeTmpRepo();
  const result = await handleReview({
    cwd: tmpDir,
    homeDir: tmpDir,
    background: true,
    deps: {
      ...gitOk(tmpDir),
      buildReviewInput: () => ({ target: "working tree", statusText: "", diffStatText: "", diffText: "" }),
      runClaudeForeground: () => ({ exitCode: 0, stdout: "", stderr: "", error: null }),
      spawnDetachedWorker: () => { throw new Error("spawn failed"); },
    },
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /spawn failed/);
  fs.rmSync(tmpDir, { recursive: true });
});
