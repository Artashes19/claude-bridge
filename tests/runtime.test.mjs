import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import {
  buildDelegateClaudeArgs,
  buildReviewClaudeArgs,
  checkClaudeAvailability,
  checkClaudeReadiness,
  runClaudeForeground
} from "../plugins/claude-bridge/scripts/lib/claude.mjs";
import { buildReviewInput } from "../plugins/claude-bridge/scripts/lib/git.mjs";
import {
  buildDelegatePrompt,
  buildReviewPrompt
} from "../plugins/claude-bridge/scripts/lib/prompts.mjs";

test("checkClaudeAvailability reports version when the binary works", () => {
  const result = checkClaudeAvailability({
    binary: "claude",
    run: () => ({
      status: 0,
      stdout: "2.1.92 (Claude Code)\n",
      stderr: ""
    })
  });

  assert.equal(result.available, true);
  assert.equal(result.version, "2.1.92 (Claude Code)");
  assert.equal(result.error, "");
});

test("checkClaudeAvailability surfaces runner diagnostics when the binary is missing", () => {
  const result = checkClaudeAvailability({
    binary: "claude",
    run: () => ({
      status: 127,
      stdout: "",
      stderr: "",
      error: { code: "ENOENT", message: "spawn claude ENOENT" }
    })
  });

  assert.equal(result.available, false);
  assert.equal(result.error, "spawn claude ENOENT");
});

test("runClaudeForeground passes timeout through to the runner and preserves runner errors", () => {
  const result = runClaudeForeground({
    binary: "claude",
    args: ["-p", "probe"],
    cwd: "/tmp/project",
    timeoutMs: 4321,
    run: (_binary, _args, options) => {
      assert.equal(options.timeout, 4321);
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: { code: "ETIMEDOUT", message: "spawnSync claude ETIMEDOUT" }
      };
    }
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.error?.code, "ETIMEDOUT");
});

test("checkClaudeReadiness rejects a prompt probe when Claude is not logged in", () => {
  const calls = [];

  const result = checkClaudeReadiness({
    binary: "claude",
    model: "claude-opus-latest",
    effort: "high",
    checkClaudeAvailability: () => ({
      available: true,
      version: "2.1.92 (Claude Code)",
      error: ""
    }),
    runClaudeForeground: ({ binary, args, cwd, timeoutMs }) => {
      calls.push({ binary, args, cwd, timeoutMs });
      return {
        exitCode: 1,
        stdout: "",
        stderr: "Not logged in · Please run /login"
      };
    }
  });

  assert.equal(result.ready, false);
  assert.equal(result.version, "2.1.92 (Claude Code)");
  assert.match(result.error, /Not logged in/);
  assert.deepEqual(calls[0].binary, "claude");
  assert.equal(calls[0].timeoutMs, 5000);
  assert.deepEqual(calls[0].args.slice(0, 9), [
    "-p",
    "--model",
    "claude-opus-latest",
    "--effort",
    "high",
    "--tools",
    "",
    "--permission-mode",
    "plan"
  ]);
  assert.match(calls[0].args[9], /ready/i);
});

test("buildReviewInput captures git status and both unstaged and staged diffs", () => {
  const seen = [];
  const run = (_binary, args) => {
    seen.push(args.join(" "));
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "M src/index.js\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff") {
      return { status: 0, stdout: " src/index.js | 3 ++-\n", stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff") {
      return { status: 0, stdout: "@@ -1 +1 @@\n-old\n+new\n", stderr: "" };
    }
    if (args.join(" ") === "diff --cached --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "ls-files --others --exclude-standard -z") {
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: "/tmp/project", run });

  assert.match(result.statusText, /M src\/index\.js/);
  assert.match(result.diffStatText, /src\/index\.js/);
  assert.match(result.diffText, /\+new/);
  assert.equal(seen.length, 5);
});

test("buildReviewInput appends untracked file contents in a dedicated section", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-input-"));
  const repoRoot = path.join(tempRoot, "repo");
  const newFile = path.join(repoRoot, "notes.txt");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(newFile, "brand new reviewable content\n");

  const run = (_binary, args) => {
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "?? notes.txt\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --cached --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "ls-files --others --exclude-standard -z") {
      return { status: 0, stdout: "notes.txt\u0000", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: repoRoot, run });

  assert.match(result.diffText, /## Untracked/);
  assert.match(result.diffText, /notes\.txt/);
  assert.match(result.diffText, /brand new reviewable content/);
});

test("buildReviewInput omits bridge-local untracked artifacts from the review prompt", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-input-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge", "jobs"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".claude-bridge", "jobs", "latest.json"), "{\"id\":\"latest\"}\n");
  fs.writeFileSync(path.join(repoRoot, "notes.txt"), "safe text\n");

  const run = (_binary, args) => {
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "?? .claude-bridge/jobs/latest.json\n?? notes.txt\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --cached --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "ls-files --others --exclude-standard -z") {
      return { status: 0, stdout: ".claude-bridge/jobs/latest.json\0notes.txt\0", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: repoRoot, run });

  assert.match(result.statusText, /notes\.txt/);
  assert.doesNotMatch(result.statusText, /\.claude-bridge\/jobs\/latest\.json/);
  assert.match(result.diffText, /## Untracked/);
  assert.doesNotMatch(result.diffText, /\.claude-bridge\/jobs\/latest\.json/);
  assert.match(result.diffText, /notes\.txt/);
  assert.match(result.diffText, /safe text/);
});

test("buildReviewInput skips large untracked files with an explicit note", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-input-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "generated.log"), `${"x".repeat(32 * 1024)}TAIL`);

  const run = (_binary, args) => {
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "?? generated.log\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --cached --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "ls-files --others --exclude-standard -z") {
      return { status: 0, stdout: "generated.log\0", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: repoRoot, run });

  assert.match(result.diffText, /## Untracked/);
  assert.match(result.diffText, /generated\.log/);
  assert.match(result.diffText, /(skipped|truncated)/i);
  assert.doesNotMatch(result.diffText, /TAIL/);
});

test("buildReviewInput skips binary untracked files with an explicit note", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-review-input-"));
  const repoRoot = path.join(tempRoot, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "image.bin"), Buffer.from([0x00, 0xff, 0x00, 0xff, 0x00, 0x10]));

  const run = (_binary, args) => {
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "?? image.bin\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "diff --cached --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "ls-files --others --exclude-standard -z") {
      return { status: 0, stdout: "image.bin\0", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: repoRoot, run });

  assert.match(result.diffText, /## Untracked/);
  assert.match(result.diffText, /image\.bin/);
  assert.match(result.diffText, /(skipped|binary|unreadable)/i);
  assert.doesNotMatch(result.diffText, /\x00/);
});

test("buildReviewInput truncates large tracked diffs and requests a larger git buffer", () => {
  const seenBuffers = [];
  const largeDiff = `@@ -1 +1 @@\n-${"old\n".repeat(40000)}+new\n`;
  const largeStat = `${" src/index.js | 99999 +".repeat(2000)}\n`;

  const run = (_binary, args, options) => {
    seenBuffers.push(options.maxBuffer);
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "M src/index.js\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff") {
      return { status: 0, stdout: largeStat, stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff") {
      return { status: 0, stdout: largeDiff, stderr: "" };
    }
    if (args.join(" ") === "diff --cached --no-ext-diff") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "ls-files --others --exclude-standard -z") {
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: "/tmp/project", run });

  assert.equal(seenBuffers.every((value) => typeof value === "number" && value > 1024 * 1024), true);
  assert.match(result.diffText, /\[truncated/i);
  assert.match(result.diffStatText, /\[truncated/i);
  assert.equal(result.diffText.length < largeDiff.length, true);
  assert.equal(result.diffStatText.length < largeStat.length, true);
});

test("buildReviewInput keeps base-ref reviews scoped to the range even when the tree is dirty", () => {
  const seen = [];
  const run = (_binary, args) => {
    seen.push(args.join(" "));
    if (args.join(" ") === "status --short") {
      return { status: 0, stdout: "M unrelated-file.js\n", stderr: "" };
    }
    if (args.join(" ") === "diff --stat --no-ext-diff origin/main...HEAD") {
      return { status: 0, stdout: " src/index.js | 2 +-\n", stderr: "" };
    }
    if (args.join(" ") === "diff --no-ext-diff origin/main...HEAD") {
      return { status: 0, stdout: "@@ -1 +1 @@\n-old\n+new\n", stderr: "" };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  const result = buildReviewInput({ cwd: "/tmp/project", baseRef: "origin/main", run });

  assert.equal(result.target, "origin/main...HEAD");
  assert.equal(result.statusText, "Range review: origin/main...HEAD");
  assert.doesNotMatch(result.statusText, /unrelated-file\.js/);
  assert.equal(seen.includes("status --short"), false);
});

test("buildReviewInput preserves git runner diagnostics when a git command fails", () => {
  const run = (_binary, args) => {
    if (args.join(" ") === "status --short") {
      return {
        status: 128,
        stdout: "",
        stderr: "",
        error: { code: "EACCES", message: "spawn git EACCES" }
      };
    }
    throw new Error(`Unexpected git call: ${args.join(" ")}`);
  };

  assert.throws(
    () => buildReviewInput({ cwd: "/tmp/project", run }),
    /spawn git EACCES/
  );
});

test("buildReviewClaudeArgs disables Claude tools for read-only reviews", () => {
  const args = buildReviewClaudeArgs({
    model: "claude-opus-latest",
    effort: "high",
    prompt: "Review these changes."
  });

  assert.deepEqual(args.slice(0, 9), [
    "-p",
    "--model",
    "claude-opus-latest",
    "--effort",
    "high",
    "--tools",
    "",
    "--permission-mode",
    "plan"
  ]);
});

test("buildDelegateClaudeArgs keeps Claude editable", () => {
  const args = buildDelegateClaudeArgs({
    model: "claude-sonnet-latest",
    effort: "medium",
    prompt: "Fix the bug."
  });

  assert.deepEqual(args.slice(0, 7), [
    "-p",
    "--model",
    "claude-sonnet-latest",
    "--effort",
    "medium",
    "--permission-mode",
    "acceptEdits"
  ]);
});

test("buildReviewPrompt and buildDelegatePrompt interpolate template markers", () => {
  const reviewPrompt = buildReviewPrompt({
    template: "Target: {{TARGET}}\\nFocus: {{FOCUS}}\\nDiff:\\n{{DIFF}}",
    target: "working tree",
    focus: "look for missing tests",
    diff: "+ const answer = 42;"
  });

  const delegatePrompt = buildDelegatePrompt({
    template: "Task: {{TASK}}\\nResume: {{RESUME_CONTEXT}}",
    task: "fix the flaky test",
    resumeContext: "none"
  });

  assert.match(reviewPrompt, /look for missing tests/);
  assert.match(delegatePrompt, /fix the flaky test/);
});
