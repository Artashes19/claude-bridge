# Claude Bridge Release Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the final release-blocking Claude Bridge behavior bugs without broad refactoring.

**Architecture:** Keep the current job runner flow intact and patch the CLI and rendering edges where behavior is currently lost. Add a small cancellation confirmation helper in the CLI, extend review input generation to include untracked files, and surface persisted stderr diagnostics in result output.

**Tech Stack:** Node.js ESM, `node:test`, synchronous filesystem and git helpers

---

### Task 1: Foreground Failure Propagation

**Files:**
- Modify: `tests/review.test.mjs`
- Modify: `tests/delegate.test.mjs`
- Modify: `plugins/claude-bridge/scripts/claude-bridge.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test("review foreground rejects and prefers stderr diagnostics on Claude failure", async () => {
  await assert.rejects(() => main([...]), /Not logged in/);
});

test("delegate foreground rejects and falls back to stdout diagnostics on Claude failure", async () => {
  await assert.rejects(() => main([...]), /fallback stdout text/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/review.test.mjs tests/delegate.test.mjs`
Expected: FAIL because the foreground handlers currently resolve and only print `stdout`.

- [ ] **Step 3: Write minimal implementation**

```js
if (result.exitCode !== 0) {
  throw new Error(preferredDiagnostic(result));
}
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `node --test tests/review.test.mjs tests/delegate.test.mjs`
Expected: PASS

### Task 2: Background Cancel Confirmation

**Files:**
- Modify: `tests/broker-control.test.mjs`
- Modify: `plugins/claude-bridge/scripts/claude-bridge.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test("cancel signals the process group and only marks canceled after ESRCH confirmation", async () => {
  await main(["cancel", ...]);
  assert.deepEqual(killCalls, [[-7777, "SIGTERM"], [-7777, 0], [-7777, 0]]);
});

test("cancel throws when the process group does not terminate before timeout", async () => {
  await assert.rejects(() => main(["cancel", ...]), /Failed to confirm cancellation/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/broker-control.test.mjs`
Expected: FAIL because cancellation currently signals a positive PID once and persists `canceled` immediately.

- [ ] **Step 3: Write minimal implementation**

```js
await waitForProcessGroupExit(job.pid);
updateJobRecord({ patch: { status: "canceled", finishedAt: new Date().toISOString() } });
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `node --test tests/broker-control.test.mjs`
Expected: PASS

### Task 3: Review Input and Result Diagnostics

**Files:**
- Modify: `tests/runtime.test.mjs`
- Modify: `tests/broker-control.test.mjs`
- Modify: `plugins/claude-bridge/scripts/lib/git.mjs`
- Modify: `plugins/claude-bridge/scripts/lib/render.mjs`
- Add: `LICENSE`

- [ ] **Step 1: Write the failing tests**

```js
test("buildReviewInput appends untracked file contents", () => {
  assert.match(result.diffText, /## Untracked/);
});

test("result renders stderr diagnostics for failed jobs", async () => {
  await main(["result", ...]);
  assert.match(out.text(), /stderr details/);
});

test("repository includes an MIT license file", () => {
  assert.match(fs.readFileSync("LICENSE", "utf8"), /Permission is hereby granted/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/runtime.test.mjs tests/broker-control.test.mjs tests/manifest.test.mjs`
Expected: FAIL because untracked file contents are omitted, failed-job stderr is hidden, and `LICENSE` does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
diffText: ["## Unstaged", ..., "## Staged", ..., "## Untracked", untrackedText].join("\n")
```

```js
job.status === "failed" && job.stderrTail ? `Stderr:\n${job.stderrTail}` : outputText || "(no output stored)"
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `node --test tests/runtime.test.mjs tests/broker-control.test.mjs tests/manifest.test.mjs`
Expected: PASS

### Task 4: Verification and Commit

**Files:**
- Review: `git diff --stat`

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 2: Inspect the final diff**

Run: `git status --short`
Expected: only the planned files are modified or added

- [ ] **Step 3: Commit**

```bash
git add LICENSE docs/superpowers/plans/2026-04-06-claude-bridge-release-blockers.md \
  plugins/claude-bridge/scripts/claude-bridge.mjs \
  plugins/claude-bridge/scripts/lib/git.mjs \
  plugins/claude-bridge/scripts/lib/render.mjs \
  tests/broker-control.test.mjs \
  tests/delegate.test.mjs \
  tests/manifest.test.mjs \
  tests/review.test.mjs \
  tests/runtime.test.mjs
git commit -m "fix: close claude bridge release blockers"
```
