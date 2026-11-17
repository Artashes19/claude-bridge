import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executionPermissions } from "../plugins/claude-bridge/scripts/lib/permissions.mjs";
import { runInteractive } from "../plugins/claude-bridge/scripts/lib/interactive.mjs";
import { interactionState, submitAnswer } from "../plugins/claude-bridge/scripts/lib/interaction.mjs";
import { prepareDelegateJob } from "../plugins/claude-bridge/scripts/lib/delegate.mjs";
import { DEFAULT_CONFIG } from "../plugins/claude-bridge/scripts/lib/config.mjs";
import { writeJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-permissions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { repoRoot: path.join(root, "project"), globalConfigPath: path.join(root, "host.json"),
    repoConfigPath: path.join(root, "project", "config.json"), jobsDir: path.join(root, "jobs") };
  fs.mkdirSync(paths.repoRoot); fs.mkdirSync(paths.jobsDir);
  const trust = (directories) => fs.writeFileSync(paths.globalConfigPath,
    JSON.stringify({ runtime: { trustedDelegateDirectories: directories } }));
  return { root, paths, trust };
}

test("repository config cannot enable elevated execution", (t) => {
  const { paths } = fixture(t);
  fs.writeFileSync(paths.repoConfigPath, JSON.stringify({ runtime: { trustedDelegateDirectories: [paths.repoRoot] } }));
  assert.equal(executionPermissions({ kind: "delegate", paths }).mode, "acceptEdits");
});

test("host trust matches canonical repository identity, excludes nested and sibling projects", (t) => {
  const { root, paths, trust } = fixture(t);
  trust([paths.repoRoot]);
  const alias = path.join(root, "alias"); fs.symlinkSync(paths.repoRoot, alias);
  assert.equal(executionPermissions({ kind: "delegate", paths: { ...paths, repoRoot: alias } }).mode, "bypassPermissions");
  for (const other of [path.join(paths.repoRoot, "nested"), path.join(root, "project-other")]) {
    fs.mkdirSync(other);
    assert.equal(executionPermissions({ kind: "delegate", paths: { ...paths, repoRoot: other } }).mode, "acceptEdits");
  }
  trust([]);
  assert.equal(executionPermissions({ kind: "delegate", paths }).mode, "acceptEdits");
});

test("trusted directories cannot widen discussion or review tools", (t) => {
  const { paths, trust } = fixture(t); trust([paths.repoRoot]);
  for (const kind of ["discuss", "review"]) {
    assert.deepEqual(executionPermissions({ kind, paths }), { mode: "default", source: "read-only", trustedDirectory: null });
  }
});

test("explicit mode works in any project and can reduce a trusted default", (t) => {
  const { paths, trust } = fixture(t);
  assert.equal(executionPermissions({ kind: "delegate", paths, requestedMode: "bypassPermissions" }).mode, "bypassPermissions");
  trust([paths.repoRoot]);
  assert.equal(executionPermissions({ kind: "delegate", paths, requestedMode: "acceptEdits" }).mode, "acceptEdits");
  assert.throws(() => executionPermissions({ kind: "delegate", paths, requestedMode: "typo" }), /permissionMode must/);
});

test("resumed delegation inherits explicit mode, supports downgrade, and discussion drops elevation", (t) => {
  const { paths } = fixture(t);
  const options = { cwd: paths.repoRoot, paths, config: DEFAULT_CONFIG, taskText: "Check the fixture." };
  const first = prepareDelegateJob({ ...options, requestedPermissionMode: "bypassPermissions" });
  assert.equal(first.request.args[first.request.args.indexOf("--permission-mode")+1], "bypassPermissions");
  assert.equal(first.permissions.source, "request");
  writeJobRecord({ jobsDir: paths.jobsDir, job: { ...first, status: "completed", sessionReady: true } });
  const resumed = prepareDelegateJob({ ...options, resumeSpecifier: first.id });
  assert.equal(resumed.permissionMode, "bypassPermissions");
  assert.equal(resumed.permissions.source, "session");
  const limited = prepareDelegateJob({ ...options, resumeSpecifier: first.id, requestedPermissionMode: "acceptEdits" });
  assert.equal(limited.permissions.mode, "acceptEdits");
  const discussion = prepareDelegateJob({ ...options, resumeSpecifier: first.id, kind: "discuss" });
  assert.equal(discussion.permissionMode, null);
  assert.equal(discussion.permissions.mode, "default");
  assert.throws(() => prepareDelegateJob({ ...options, kind: "discuss", requestedPermissionMode: "bypassPermissions" }), /only for delegation/);
  assert.throws(() => prepareDelegateJob({ ...options, requestedPermissionMode: "typo" }), /permissionMode must/);
});

test("host-derived mode is re-evaluated on resume rather than persisting a revoked default", (t) => {
  const { paths, trust } = fixture(t); trust([paths.repoRoot]);
  const options = { cwd: paths.repoRoot, paths, config: DEFAULT_CONFIG, taskText: "Check the fixture." };
  const first = prepareDelegateJob(options);
  assert.equal(first.permissions.mode, "bypassPermissions");
  assert.equal(first.permissionMode, null);
  writeJobRecord({ jobsDir: paths.jobsDir, job: { ...first, status: "completed", sessionReady: true } });
  trust([]);
  const resumed = prepareDelegateJob({ ...options, resumeSpecifier: first.id });
  assert.equal(resumed.permissions.mode, "acceptEdits");
});

test("malformed host trust fails before execution and missing stale directories grant nothing", (t) => {
  const { paths, trust } = fixture(t);
  for (const value of [true, ["relative"], [null]]) {
    trust(value);
    assert.throws(() => executionPermissions({ kind: "delegate", paths }), /absolute directory paths/);
  }
  trust([path.join(paths.repoRoot, "missing")]);
  assert.equal(executionPermissions({ kind: "delegate", paths }).mode, "acceptEdits");
});

for (const explicit of [false, true]) test(`full execution preserves host clarification with explicit=${explicit}`, async (t) => {
  const { root, paths, trust } = fixture(t); if (!explicit) trust([paths.repoRoot]);
  const job = { id: "trusted-execution", kind: "delegate", cwd: paths.repoRoot, sessionId: "test-session", request: { prompt: "Check" } };
  if (explicit) job.permissionMode = "bypassPermissions";
  const progress = [];
  const result = await runInteractive({ job, paths, binary: "unused", pollMs: 1,
    outputFile: path.join(root, "output"), stderrFile: path.join(root, "stderr"), eventsFile: path.join(root, "events"),
    notify: async () => {}, onProgress: (p) => progress.push(p),
    queryImpl: ({ options }) => ({ close() {}, async *[Symbol.asyncIterator]() {
      assert.equal(options.permissionMode, "bypassPermissions");
      assert.equal(options.allowDangerouslySkipPermissions, true);
      assert.deepEqual(options.sandbox, { enabled: false });
      assert.equal(options.tools, undefined);
      const response = options.canUseTool("AskUserQuestion", { questions: [{ question: "Which check?" }] }, { toolUseID: "check" });
      const question = interactionState(paths.jobsDir, job.id).questions[0];
      submitAnswer({ jobsDir: paths.jobsDir, jobId: job.id, questionId: question.id, answers: { "Which check?": "Permission setup only." } });
      assert.equal((await response).updatedInput.answers["Which check?"], "Permission setup only.");
      assert.equal((await options.canUseTool("Bash", {}, {})).behavior, "deny");
      yield { type: "system", subtype: "init", permissionMode: "bypassPermissions", session_id: job.sessionId };
      yield { type: "result", subtype: "success", result: "Verified", is_error: false };
    } }),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(progress.some((p) => p.permissions?.source === (explicit ? "request" : "host-trusted-directory")));
  assert.ok(progress.some((p) => p.actualPermissionMode === "bypassPermissions"));
});
