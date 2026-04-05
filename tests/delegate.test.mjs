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

test("delegate foreground stores a completed job and prints Claude output", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-delegate-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await main(["delegate", "--cwd", repoRoot, "--model", "sonnet", "fix the flaky test"], {
    homeDir: path.join(tempRoot, "home"),
    stdio: out,
    runClaudeForeground: () => ({
      exitCode: 0,
      stdout: "Updated tests/cache.test.js and src/cache.js\n",
      stderr: ""
    })
  });

  assert.match(out.text(), /Updated tests\/cache\.test\.js/);

  const jobsDir = path.join(repoRoot, ".claude-bridge", "jobs");
  const [jobFile] = fs.readdirSync(jobsDir);
  const job = readJobRecord({ jobsDir, jobId: jobFile.replace(/\.json$/, "") });
  assert.equal(job.kind, "delegate");
  assert.equal(job.status, "completed");
});

test("delegate --resume latest selects the newest completed output by finishedAt", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-resume-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "jobs"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "output"), { recursive: true });

  const olderByFinishedAt = "older-finished";
  const newerByCreatedAt = "newer-created";

  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "output", `${olderByFinishedAt}.txt`),
    "Selected output from the job that finished last.\n"
  );
  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "jobs", `${olderByFinishedAt}.json`),
    JSON.stringify({
      id: olderByFinishedAt,
      kind: "delegate",
      cwd: repoRoot,
      summary: "Older finished job",
      model: "claude-sonnet-latest",
      status: "completed",
      outputFile: path.join(repoRoot, ".claude-bridge", "output", `${olderByFinishedAt}.txt`),
      createdAt: "2026-04-05T10:00:00.000Z",
      finishedAt: "2026-04-05T11:00:00.000Z"
    })
  );

  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "output", `${newerByCreatedAt}.txt`),
    "Stale output from the job that finished earlier.\n"
  );
  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "jobs", `${newerByCreatedAt}.json`),
    JSON.stringify({
      id: newerByCreatedAt,
      kind: "delegate",
      cwd: repoRoot,
      summary: "Newer created job",
      model: "claude-sonnet-latest",
      status: "completed",
      outputFile: path.join(repoRoot, ".claude-bridge", "output", `${newerByCreatedAt}.txt`),
      createdAt: "2026-04-05T12:00:00.000Z",
      finishedAt: "2026-04-05T10:30:00.000Z"
    })
  );

  let seenPrompt = "";

  await main(["delegate", "--cwd", repoRoot, "--resume", "latest", "finish the test coverage"], {
    homeDir: path.join(tempRoot, "home"),
    runClaudeForeground: ({ args }) => {
      seenPrompt = args.at(-1);
      return { exitCode: 0, stdout: "Done.\n", stderr: "" };
    }
  });

  assert.match(seenPrompt, /Selected output from the job that finished last\./);
  assert.doesNotMatch(seenPrompt, /Stale output from the job that finished earlier\./);
});

test("delegate --resume rejects missing or invalid explicit sources", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-resume-explicit-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "jobs"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "output"), { recursive: true });

  const invalidJobId = "review-job";
  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "output", `${invalidJobId}.txt`),
    "Review output that should not be resumable from delegate.\n"
  );
  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "jobs", `${invalidJobId}.json`),
    JSON.stringify({
      id: invalidJobId,
      kind: "review",
      cwd: repoRoot,
      summary: "Review job",
      model: "claude-opus-latest",
      status: "completed",
      outputFile: path.join(repoRoot, ".claude-bridge", "output", `${invalidJobId}.txt`),
      createdAt: "2026-04-05T10:00:00.000Z",
      finishedAt: "2026-04-05T10:05:00.000Z"
    })
  );

  const out = createStdoutBuffer();

  await assert.rejects(
    () =>
      main(["delegate", "--cwd", repoRoot, "--resume", "missing-job", "finish the test coverage"], {
        homeDir: path.join(tempRoot, "home"),
        stdio: out
      }),
    /Cannot resume from job "missing-job"/
  );

  await assert.rejects(
    () =>
      main(["delegate", "--cwd", repoRoot, "--resume", invalidJobId, "finish the test coverage"], {
        homeDir: path.join(tempRoot, "home"),
        stdio: out
      }),
    new RegExp(`Cannot resume from job "${invalidJobId}"`)
  );
});

test("delegate requires a task description", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-delegate-empty-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  const out = createStdoutBuffer();

  await assert.rejects(
    () =>
      main(["delegate", "--cwd", repoRoot], {
        homeDir: path.join(tempRoot, "home"),
        stdio: out
      }),
    /delegate requires a task description/
  );
});

test("delegate background preserves the worker result when the worker finishes quickly", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-delegate-bg-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

  let spawnedArgs = null;
  const workerStdout = createStdoutBuffer();

  await main(["delegate", "--cwd", repoRoot, "--background", "fix the flaky test"], {
    homeDir: path.join(tempRoot, "home"),
    spawnDetachedWorker: ({ workerArgs }) => {
      spawnedArgs = workerArgs;
      void main(workerArgs, {
        homeDir: path.join(tempRoot, "home"),
        stdio: workerStdout,
        runClaudeForeground: () => ({
          exitCode: 0,
          stdout: "Updated tests/cache.test.js and src/cache.js\n",
          stderr: ""
        })
      });
      return { pid: 5150, unref() {} };
    }
  });

  assert.deepEqual(spawnedArgs.slice(0, 3), ["worker", "--cwd", repoRoot]);

  const jobsDir = path.join(repoRoot, ".claude-bridge", "jobs");
  const [jobFile] = fs.readdirSync(jobsDir);
  const job = readJobRecord({ jobsDir, jobId: jobFile.replace(/\.json$/, "") });
  const outputText = fs.readFileSync(job.outputFile, "utf8");

  assert.equal(job.kind, "delegate");
  assert.equal(job.status, "completed");
  assert.equal(job.pid, 5150);
  assert.match(outputText, /Updated tests\/cache\.test\.js/);
});
