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
} from "../plugins/claude-bridge/scripts/lib/mcp-handlers.mjs";

function makeTmpRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  const result = await handleCancel({
    cwd: tmpDir,
    homeDir: tmpDir,
    deps: gitOk(tmpDir),
  });
  assert.match(result.error, /requires a job ID/);
  fs.rmSync(tmpDir, { recursive: true });
});
