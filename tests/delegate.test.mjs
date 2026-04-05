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

test("delegate --resume latest includes prior output context", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-resume-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "jobs"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "output"), { recursive: true });

  const oldJobId = "old-job";
  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "output", `${oldJobId}.txt`),
    "Previous run changed src/cache.js but did not update tests.\n"
  );
  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "jobs", `${oldJobId}.json`),
    JSON.stringify({
      id: oldJobId,
      kind: "delegate",
      cwd: repoRoot,
      summary: "Fix cache bug",
      model: "claude-sonnet-latest",
      status: "completed",
      outputFile: path.join(repoRoot, ".claude-bridge", "output", `${oldJobId}.txt`),
      createdAt: "2026-04-05T10:00:00.000Z"
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

  assert.match(seenPrompt, /Previous run changed src\/cache\.js/);
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
