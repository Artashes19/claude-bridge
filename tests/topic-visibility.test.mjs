import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DEFAULT_CONFIG } from "../plugins/claude-bridge/scripts/lib/config.mjs";
import { conversationFields, sessionCatalog, registerSessionRepository } from "../plugins/claude-bridge/scripts/lib/catalog.mjs";
import { prepareVisibility, shareSavedSession } from "../plugins/claude-bridge/scripts/lib/visibility.mjs";
import { prepareDelegateJob } from "../plugins/claude-bridge/scripts/lib/delegate.mjs";
import { resolvePaths, ensureStateDirs } from "../plugins/claude-bridge/scripts/lib/paths.mjs";
import { createJobRecord, writeJobRecord, updateJobRecord, readJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";
import { handleDelegate, handleShare, handleSessions } from "../plugins/claude-bridge/scripts/lib/mcp-handlers.mjs";
import { runInteractive } from "../plugins/claude-bridge/scripts/lib/interactive.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-topics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = (name) => {
    const cwd = path.join(root, name);
    assert.equal(spawnSync("git", ["init", "-q", cwd]).status, 0);
    const paths = resolvePaths({ cwd, homeDir: root });
    ensureStateDirs(paths);
    registerSessionRepository(paths);
    return { cwd, paths };
  };
  return { root, repo };
}
function saved(paths, patch = {}) {
  const job = { ...createJobRecord({ kind: "discuss", cwd: paths.repoRoot, summary: "Calibration check", model: "test" }),
    sessionId: crypto.randomUUID(), sessionReady: true, status: "completed", project: "Geometry", title: "Calibration",
    ...patch };
  writeJobRecord({ jobsDir: paths.jobsDir, job });
  return job;
}
const identity = { session_url: "https://claude.ai/code/session_history123", bridge_session_id: "cse_history123",
  connect_url: "https://invalid.example/private-secret" };

test("topic selection resumes the matching history and inherits title and account identity", (t) => {
  const { repo } = fixture(t);
  const { cwd, paths } = repo("one");
  const geometry = saved(paths, { createdAt: "2026-01-01T00:00:00Z", shareSession: true,
    accountSession: { sessionId: "cse_history123", url: identity.session_url } });
  saved(paths, { project: "Signal processing", createdAt: "2026-02-01T00:00:00Z" });
  const followup = prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, kind: "discuss", taskText: "Check the axes",
    project: "geometry", resumeSpecifier: "latest" });
  assert.equal(followup.sessionId, geometry.sessionId);
  assert.equal(followup.title, "Calibration");
  assert.equal(followup.shareSession, true);
  assert.equal(followup.accountSession.sessionId, "cse_history123");
  assert.throws(() => prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, taskText: "Continue",
    project: "Missing topic", resumeSpecifier: "latest" }), /no saved session/);
  saved(paths, { sessionId: geometry.sessionId, status: "running", createdAt: "2026-03-01T00:00:00Z" });
  assert.throws(() => prepareDelegateJob({ cwd, paths, config: DEFAULT_CONFIG, taskText: "Continue",
    resumeSpecifier: geometry.id }), /inactive session/);
});

test("catalog groups topics across registered repositories and lists each conversation once", async (t) => {
  const { root, repo } = fixture(t);
  const one = repo("one"), two = repo("two");
  const initial = saved(one.paths, { createdAt: "2026-01-01T00:00:00Z" });
  const latest = saved(one.paths, { sessionId: initial.sessionId, title: "Updated calibration",
    createdAt: "2026-02-01T00:00:00Z" });
  saved(two.paths, { project: "geometry", title: "Camera poses" });
  saved(two.paths, { project: "Other topic" });
  const local = sessionCatalog({ paths: one.paths });
  assert.equal(local.sessions.length, 1);
  assert.equal(local.sessions[0].jobId, latest.id);
  assert.equal(local.sessions[0].title, "Updated calibration");
  const all = await handleSessions({ cwd: one.cwd, homeDir: root, allRepositories: true, project: "GEOMETRY" });
  assert.equal(all.sessions.length, 2);
  assert.equal(all.projects.length, 1);
  assert.equal(all.projects[0].sessions, 2);
  assert.equal(all.nativeProjectCreated, false);
  assert.equal(all.modelPromptSent, false);
});

test("request retry finds the original job before resolving latest again", async (t) => {
  const { root, repo } = fixture(t);
  const { cwd, paths } = repo("one");
  saved(paths);
  let launches = 0;
  const options = { cwd, homeDir: root, kind: "discuss", task: "Continue", project: "Geometry", resume: "latest",
    requestId: "topic-followup", background: true, deps: { spawnDetachedWorker() { launches++; return { pid: process.pid }; } } };
  const first = await handleDelegate(options);
  const pending = await handleDelegate(options);
  assert.equal(pending.jobId, first.jobId);
  assert.equal(pending.reused, true);
  updateJobRecord({ jobsDir: paths.jobsDir, jobId: first.jobId, patch: { status: "completed", sessionReady: true } });
  const completed = await handleDelegate(options);
  assert.equal(completed.jobId, first.jobId);
  assert.equal(completed.reused, true);
  assert.equal(launches, 1);
  const conflict = await handleDelegate({ ...options, title: "Different intent" });
  assert.match(conflict.error, /different request/);
  assert.equal(launches, 1);
});

test("publishing an inactive history sends no prompt and leaves its paid job and report intact", async (t) => {
  const { root, repo } = fixture(t);
  const { cwd, paths } = repo("one");
  const outputFile = path.join(paths.outputDir, "saved.txt");
  fs.writeFileSync(outputFile, "Original report");
  const job = saved(paths, { outputFile });
  let connections = 0, renamed = 0;
  const result = await handleShare({ cwd, homeDir: root, jobId: job.id, project: "Geometry", title: "Camera calibration", deps: {
    shareSavedSession: (options) => shareSavedSession({ ...options,
      getMessages: async () => [{ type: "user", uuid: "saved-message" }],
      renameSessionImpl: async (id, title) => { renamed++; assert.equal(id, job.sessionId); assert.equal(title, "Camera calibration"); },
      prepare: async ({ enabled }) => {
        connections++; assert.equal(enabled, true);
        return { sessionId: "cse_history123", url: identity.session_url, state: "connected", messagesUploaded: 2 };
      },
    }),
  } });
  assert.equal(result.modelPromptSent, false);
  assert.equal(result.accountSession.state, "connected");
  assert.equal(connections, 1); assert.equal(renamed, 1);
  const persisted = readJobRecord({ jobsDir: paths.jobsDir, jobId: job.id });
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.title, "Camera calibration");
  assert.equal(persisted.accountSession.url, identity.session_url);
  assert.equal(fs.readFileSync(outputFile, "utf8"), "Original report");
  assert.ok(!fs.existsSync(path.join(paths.jobsDir, `${job.sessionId}.session-lock`)));
  updateJobRecord({ jobsDir: paths.jobsDir, jobId: job.id, patch: { status: "running" } });
  assert.match((await handleShare({ cwd, homeDir: root, jobId: job.id })).error, /inactive session/);
  assert.equal(connections, 1);
});

test("empty histories are not published and viewer acknowledgement timeouts remain uncertain", async (t) => {
  const { repo } = fixture(t);
  const { paths } = repo("one");
  const job = saved(paths, { shareSession: true });
  let starts = 0;
  await assert.rejects(shareSavedSession({ job, paths, onProgress() {}, getMessages: async () => [],
    prepare: async () => { starts++; } }), /No saved native/);
  assert.equal(starts, 0);
  const state = await prepareVisibility({ job, paths, timeoutMs: 5, startViewer() { starts++; }, readState: () => null });
  assert.equal(state.state, "unconfirmed");
  assert.equal(starts, 1);
  const spec = JSON.parse(fs.readFileSync(path.join(paths.mirrorDir, `spec-${job.sessionId}.json`)));
  assert.equal(spec.enabled, true);
  assert.equal(spec.jobId, job.id);
});

test("visibility failure does not discard the model answer or create another worker", async (t) => {
  const { repo } = fixture(t);
  const { cwd, paths } = repo("one");
  const job = saved(paths, { shareSession: true, request: { prompt: "Check calibration" } });
  let launches = 0;
  const progress = [];
  const result = await runInteractive({ job, paths, binary: "unused", outputFile: path.join(paths.outputDir, "report.txt"),
    stderrFile: path.join(paths.outputDir, "stderr"), eventsFile: path.join(paths.outputDir, "events"),
    onProgress: (patch) => progress.push(patch), prepareVisibilityImpl: async () => { throw new Error("private-secret"); }, queryImpl: ({ prompt, options }) => {
      launches++; assert.equal(options.title, job.title);
      return { close() {},
        async *[Symbol.asyncIterator]() {
          assert.equal((await prompt[Symbol.asyncIterator]().next()).value.message.content, "Check calibration");
          yield { type: "result", subtype: "success", is_error: false, result: "Saved answer", queued_turn_count: 0 };
        },
      };
    } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "Saved answer");
  assert.equal(launches, 1);
  assert.ok(progress.some((patch) => patch.accountSession?.state === "unavailable"));
  assert.doesNotMatch(JSON.stringify(progress), /private-secret/);
});

test("invalid labels fail before publishing or executing", () => {
  for (const options of [{ project: "\nprivate" }, { title: "" }, { shareSession: "yes" }]) {
    assert.throws(() => conversationFields({ cwd: "/repo", summary: "Check", config: DEFAULT_CONFIG, ...options }));
  }
});

test("a failed sharing opt-out prevents sending the next model prompt", async (t) => {
  const { repo } = fixture(t);
  const { paths } = repo("one");
  const job = saved(paths, { shareSession: false, request: { prompt: "Private follow-up" } });
  fs.mkdirSync(paths.mirrorDir, { recursive: true });
  fs.writeFileSync(path.join(paths.mirrorDir, `spec-${job.sessionId}.json`), JSON.stringify({ enabled: true }));
  let prompts = 0;
  const result = await runInteractive({ job, paths, binary: "unused", onProgress() {},
    outputFile: path.join(paths.outputDir, "report.txt"), stderrFile: path.join(paths.outputDir, "stderr"),
    eventsFile: path.join(paths.outputDir, "events"), prepareVisibilityImpl: async () => { throw new Error("Unavailable"); },
    queryImpl: () => { prompts++; throw new Error("Unexpected model query"); } });
  assert.equal(result.exitCode, 1);
  assert.equal(prompts, 0);
  assert.match(result.error.message, /could not be disabled/);
});
