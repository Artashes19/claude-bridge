import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../plugins/claude-bridge/scripts/claude-bridge.mjs";
import { createJobRecord, readJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";
import { ensureStateDirs, resolvePaths } from "../plugins/claude-bridge/scripts/lib/paths.mjs";

function createStdoutBuffer() {
  const chunks = [];
  return {
    stdout: {
      write(value) {
        chunks.push(String(value));
      }
    },
    stderr: {
      write(value) {
        chunks.push(String(value));
      }
    },
    text() {
      return chunks.join("");
    }
  };
}

test("setup prints readiness information", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-setup-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await main(["setup", "--cwd", repoRoot], {
    homeDir: path.join(tempRoot, "home"),
    stdio: out,
    checkClaudeAvailability: () => ({
      available: true,
      version: "2.1.92 (Claude Code)",
      error: ""
    })
  });

  assert.match(out.text(), /Claude Bridge setup/);
  assert.match(out.text(), /READY: yes/);
});

test("status prints no jobs yet when the repo has no state", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-status-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await main(["status", "--cwd", repoRoot], {
    homeDir: path.join(tempRoot, "home"),
    stdio: out
  });

  assert.match(out.text(), /No Claude Bridge jobs found/);
});

test("result reports a missing job clearly", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-result-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await assert.rejects(
    () =>
      main(["result", "--cwd", repoRoot, "--job-id", "missing-job"], {
        homeDir: path.join(tempRoot, "home"),
        stdio: out
      }),
    /No job found/
  );
});

test("result requires a string --job-id value", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-result-usage-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await assert.rejects(
    () => main(["result", "--cwd", repoRoot, "--job-id"], { homeDir: path.join(tempRoot, "home"), stdio: out }),
    /result requires --job-id/
  );
});

test("cancel requires a string --job-id value", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-cancel-usage-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await assert.rejects(
    () => main(["cancel", "--cwd", repoRoot, "--job-id"], { homeDir: path.join(tempRoot, "home"), stdio: out }),
    /cancel requires --job-id/
  );
});

test("cancel ignores ESRCH when the worker is already gone", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-cancel-esrch-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "delegate",
    cwd: repoRoot,
    summary: "Cancel a stale worker",
    model: "claude-sonnet-latest"
  });
  job.pid = 123456;
  fs.writeFileSync(path.join(paths.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));

  const out = createStdoutBuffer();
  const originalKill = process.kill;
  process.kill = () => {
    const error = new Error("process gone");
    error.code = "ESRCH";
    throw error;
  };

  try {
    await main(["cancel", "--cwd", repoRoot, "--job-id", job.id], {
      homeDir: path.join(tempRoot, "home"),
      stdio: out
    });
  } finally {
    process.kill = originalKill;
  }

  assert.match(out.text(), new RegExp(`Requested cancellation for ${job.id}`));
});

test("cancel signals the process group and waits for termination confirmation before persisting canceled", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-cancel-state-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "delegate",
    cwd: repoRoot,
    summary: "Cancel and persist state",
    model: "claude-sonnet-latest"
  });
  job.pid = 7777;
  job.status = "running";
  job.startedAt = "2026-04-05T00:00:00.000Z";
  fs.writeFileSync(path.join(paths.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));

  const out = createStdoutBuffer();
  const killCalls = [];
  const originalKill = process.kill;
  let probeCount = 0;
  process.kill = (pid, signal) => {
    killCalls.push([pid, signal]);
    if (signal === 0) {
      probeCount += 1;
      if (probeCount === 1) {
        return;
      }

      const error = new Error("process gone");
      error.code = "ESRCH";
      throw error;
    }
  };

  try {
    await main(["cancel", "--cwd", repoRoot, "--job-id", job.id], {
      homeDir: path.join(tempRoot, "home"),
      stdio: out,
      sleep: async () => {}
    });
  } finally {
    process.kill = originalKill;
  }

  const stored = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });

  assert.deepEqual(killCalls, [[-7777, "SIGTERM"], [-7777, 0], [-7777, 0]]);
  assert.match(out.text(), new RegExp(`Requested cancellation for ${job.id}`));
  assert.equal(stored.status, "canceled");
  assert.equal(stored.finishedAt.length > 0, true);
});

test("cancel throws instead of marking canceled when termination is not confirmed in time", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-cancel-timeout-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "review",
    cwd: repoRoot,
    summary: "Cancel but stay alive",
    model: "claude-opus-latest"
  });
  job.pid = 9911;
  job.status = "running";
  job.startedAt = "2026-04-05T00:00:00.000Z";
  fs.writeFileSync(path.join(paths.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));

  const out = createStdoutBuffer();
  const originalKill = process.kill;
  process.kill = () => {};

  try {
    await assert.rejects(
      () =>
        main(["cancel", "--cwd", repoRoot, "--job-id", job.id], {
          homeDir: path.join(tempRoot, "home"),
          stdio: out,
          sleep: async () => {},
          cancelTimeoutMs: 0,
          cancelPollIntervalMs: 0
        }),
      /Failed to confirm cancellation/
    );
  } finally {
    process.kill = originalKill;
  }

  const stored = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });

  assert.equal(stored.status, "running");
  assert.equal(stored.finishedAt, null);
  assert.equal(out.text(), "");
});

test("result renders stderr diagnostics for failed jobs", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-result-stderr-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const paths = resolvePaths({ cwd: repoRoot, homeDir: path.join(tempRoot, "home") });
  ensureStateDirs(paths);

  const job = createJobRecord({
    kind: "delegate",
    cwd: repoRoot,
    summary: "Show failed diagnostics",
    model: "claude-sonnet-latest"
  });
  job.status = "failed";
  job.stderrTail = "Not logged in · Please run /login";
  job.finishedAt = "2026-04-05T00:00:00.000Z";
  fs.writeFileSync(path.join(paths.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));

  const out = createStdoutBuffer();

  await main(["result", "--cwd", repoRoot, "--job-id", job.id], {
    homeDir: path.join(tempRoot, "home"),
    stdio: out
  });

  assert.match(out.text(), /Status: failed/);
  assert.match(out.text(), /Not logged in · Please run \/login/);
});
