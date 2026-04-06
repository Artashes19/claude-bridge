import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../plugins/claude-bridge/scripts/claude-bridge.mjs";
import { readJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";

function createStdoutBuffer() {
  const chunks = [];
  return {
    stdout: { write(value) { chunks.push(String(value)); } },
    stderr: { write(value) { chunks.push(String(value)); } },
    text() { return chunks.join(""); }
  };
}

test("review foreground stores a completed job and writes review output", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await main(["review", "--cwd", repoRoot, "--model", "opus", "look for missing tests"], {
    homeDir: path.join(tempRoot, "home"),
    stdio: out,
    buildReviewInput: () => ({
      target: "working tree",
      statusText: "M src/index.js\n",
      diffStatText: " src/index.js | 3 ++-\n",
      diffText: "@@ -1 +1 @@\n-old\n+new\n"
    }),
    runClaudeForeground: () => ({
      exitCode: 0,
      stdout: "1. High: add a regression test for the new branch.\n",
      stderr: ""
    })
  });

  assert.match(out.text(), /High: add a regression test/);

  const jobsDir = path.join(repoRoot, ".claude-bridge", "jobs");
  const [jobFile] = fs.readdirSync(jobsDir);
  const job = readJobRecord({ jobsDir, jobId: jobFile.replace(/\.json$/, "") });
  const outputText = fs.readFileSync(job.outputFile, "utf8");

  assert.equal(job.kind, "review");
  assert.equal(job.status, "completed");
  assert.match(outputText, /High: add a regression test/);
});

test("review foreground rejects and prefers stderr diagnostics on Claude failure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-fail-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await assert.rejects(
    () =>
      main(["review", "--cwd", repoRoot, "look for auth blockers"], {
        homeDir: path.join(tempRoot, "home"),
        stdio: out,
        buildReviewInput: () => ({
          target: "working tree",
          statusText: "",
          diffStatText: "",
          diffText: ""
        }),
        runClaudeForeground: () => ({
          exitCode: 1,
          stdout: "stdout fallback should not be used\n",
          stderr: "Not logged in · Please run /login\n"
        })
      }),
    /Not logged in · Please run \/login/
  );

  const jobsDir = path.join(repoRoot, ".claude-bridge", "jobs");
  const [jobFile] = fs.readdirSync(jobsDir);
  const job = readJobRecord({ jobsDir, jobId: jobFile.replace(/\.json$/, "") });

  assert.equal(job.status, "failed");
  assert.match(job.stderrTail, /Not logged in/);
  assert.equal(out.text(), "");
});

test("review background enqueues a worker job", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-bg-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  let spawnedArgs = null;
  const workerStdout = createStdoutBuffer();

  await main(["review", "--cwd", repoRoot, "--background", "check caching"], {
    homeDir: path.join(tempRoot, "home"),
    buildReviewInput: () => ({
      target: "working tree",
      statusText: "",
      diffStatText: "",
      diffText: ""
    }),
    spawnDetachedWorker: ({ workerArgs }) => {
      spawnedArgs = workerArgs;
      void main(workerArgs, {
        homeDir: path.join(tempRoot, "home"),
        stdio: workerStdout,
        runClaudeForeground: () => ({
          exitCode: 0,
          stdout: "1. High: validate the cache invalidation path.\n",
          stderr: ""
        })
      });
      return { pid: 4242, unref() {} };
    }
  });

  assert.deepEqual(spawnedArgs.slice(0, 3), ["worker", "--cwd", repoRoot]);

  const jobsDir = path.join(repoRoot, ".claude-bridge", "jobs");
  const [jobFile] = fs.readdirSync(jobsDir);
  const job = readJobRecord({ jobsDir, jobId: jobFile.replace(/\.json$/, "") });
  const outputText = fs.readFileSync(job.outputFile, "utf8");

  assert.equal(job.kind, "review");
  assert.equal(job.status, "completed");
  assert.equal(job.pid, null);
  assert.match(outputText, /High: validate the cache invalidation path/);
});
