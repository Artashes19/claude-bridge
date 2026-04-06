import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import {
  buildDelegateClaudeArgs,
  buildReviewClaudeArgs,
  checkClaudeAvailability,
  checkClaudeReadiness
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
    runClaudeForeground: ({ binary, args, cwd }) => {
      calls.push({ binary, args, cwd });
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
