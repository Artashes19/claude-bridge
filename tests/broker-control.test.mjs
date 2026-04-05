import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../plugins/claude-bridge/scripts/claude-bridge.mjs";
import { createJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";
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
