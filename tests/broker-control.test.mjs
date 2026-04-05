import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../plugins/claude-bridge/scripts/claude-bridge.mjs";

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
