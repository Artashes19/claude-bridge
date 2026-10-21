import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runViewer, uploadHistory, boundedFlush } from "../plugins/claude-bridge/scripts/lib/viewer-runtime.mjs";
import { viewerFile, saveJson, readJson, viewerState, accountState } from "../plugins/claude-bridge/scripts/lib/viewer-state.mjs";
import { prepareVisibility } from "../plugins/claude-bridge/scripts/lib/visibility.mjs";
import { resolvePaths, ensureStateDirs } from "../plugins/claude-bridge/scripts/lib/paths.mjs";
import { createJobRecord, writeJobRecord } from "../plugins/claude-bridge/scripts/lib/jobs.mjs";
import { handleResult, handleSessions, handleShare } from "../plugins/claude-bridge/scripts/lib/mcp-handlers.mjs";
import { prepareDelegateJob } from "../plugins/claude-bridge/scripts/lib/delegate.mjs";
import { DEFAULT_CONFIG } from "../plugins/claude-bridge/scripts/lib/config.mjs";

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Viewer did not reach expected state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test("legacy sharing records explicitly identify the remote viewer rather than a desktop workspace", () => {
  const state = accountState({ accountSession: { state: "disabled", desktopPlacement: "unverified" } });
  assert.equal(state.surface, "remote-control");
  assert.equal(state.desktopPlacement, "remote-control");
  assert.equal(state.desktopWorkspaceCreated, false);
  assert.equal(state.nativeProjectCreated, false);
});
test("closed or stalled transport does not acknowledge history delivery", async () => {
  await assert.rejects(boundedFlush({ flush: async () => false }), /closed before delivery/);
  await assert.rejects(boundedFlush({ flush: () => new Promise(() => {}) }, 5), /timed out/);
});
test("upload pages all history, excludes duplicates, and checkpoints only after flush", async () => {
  const messages = Array.from({ length: 1003 }, (_, i) => ({ type: i % 2 ? "assistant" : "user", uuid: `m${i}` }));
  const writes = [], uploaded = new Set(["m0"]);
  const handle = { write: (message) => writes.push(message), reportState() {}, sendResult() {} };
  let fail = true;
  const options = { spec: { sessionId: crypto.randomUUID(), cwd: "/fixture" }, handle, uploaded,
    getMessages: async (_, { offset, limit }) => messages.slice(offset, offset + limit),
    flush: async () => { if (fail) throw new Error("offline"); } };
  await assert.rejects(uploadHistory(options), /offline/);
  assert.deepEqual([...uploaded], ["m0"]);
  fail = false; writes.length = 0;
  assert.equal(await uploadHistory(options), 1002);
  assert.equal(writes.length, 1002);
  assert.equal(uploaded.size, 1003);
  assert.equal(await uploadHistory(options), 0);
  assert.equal(await uploadHistory({ ...options, isCurrent: () => false }), null);
});

test("viewer survives jobs, reconnects with one identity, uploads new turns and honors stop", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-viewer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolvePaths({ cwd: root, homeDir: root });
  ensureStateDirs(paths);
  const job = { ...createJobRecord({ kind: "discuss", cwd: root, summary: "Fixture", model: "fixture" }),
    sessionId: crypto.randomUUID(), sessionReady: true, status: "completed", shareSession: true, title: "Fixture" };
  writeJobRecord({ jobsDir: paths.jobsDir, job });
  const messages = [{ type: "user", uuid: "first" }, { type: "assistant", uuid: "second" }];
  let creates = 0, attaches = 0, closeTransport;
  const writes = [];
  const controller = new AbortController();
  let running;
  const startViewer = () => { running ??= runViewer({ directory: paths.mirrorDir, signal: controller.signal,
    pollMs: 5, idleExitMs: 20, tokenReader: () => "opaque-test-token",
    createSession: async () => { creates++; return "cse_fixture123"; },
    fetchCredentials: async (id) => { assert.equal(id, "cse_fixture123"); return { worker_jwt: "private-test-jwt", api_base_url: "https://example.invalid", expires_in: 5000 }; },
    attach: async (options) => {
      attaches++; assert.equal(options.outboundOnly, true);
      assert.equal(options.onInboundMessage, undefined);
      closeTransport = options.onClose;
      return { write: (message) => writes.push(message.uuid), isConnected: () => true,
        flush: async () => {}, close() {}, reportState() {}, sendResult() {} };
    }, getMessages: async () => messages,
  }); };
  t.after(async () => { controller.abort(); await running; });
  const connected = await prepareVisibility({ job, paths, startViewer, timeoutMs: 1000 });
  assert.equal(connected.state, "connected");
  assert.equal(connected.messagesUploaded, 2);
  const source = { ...job, sessionMirrorDir: paths.mirrorDir, accountSession: connected };
  writeJobRecord({ jobsDir: paths.jobsDir, job: source });
  closeTransport();
  await until(() => attaches === 2);
  assert.equal(creates, 1);
  assert.deepEqual(writes, ["first", "second"]);
  const resumed = { ...source, id: "next-turn", createdAt: new Date().toISOString() };
  messages.push({ type: "assistant", uuid: "third" });
  writeJobRecord({ jobsDir: paths.jobsDir, job: resumed });
  await prepareVisibility({ job: resumed, paths, startViewer, timeoutMs: 1000 });
  await until(() => viewerState(paths.mirrorDir, job.sessionId)?.messagesUploaded === 3);
  const result = await handleResult({ cwd: root, homeDir: root, jobId: resumed.id });
  assert.equal(result.accountSession.messagesUploaded, 3);
  assert.equal((await handleSessions({ cwd: root, homeDir: root })).sessions[0].accountSession.messagesUploaded, 3);
  assert.equal(creates, 1);
  assert.deepEqual(writes, ["first", "second", "third"]);
  const stopped = await handleShare({ cwd: root, homeDir: root, jobId: resumed.id, enabled: false });
  assert.equal(stopped.accountSession.state, "disabled");
  const followup = prepareDelegateJob({ cwd: root, paths, config: DEFAULT_CONFIG, kind: "discuss", taskText: "Continue",
    resumeSpecifier: job.id });
  assert.equal(followup.shareSession, false);
  await running;
  const serialized = fs.readFileSync(viewerFile(paths.mirrorDir, "state", job.sessionId), "utf8");
  assert.doesNotMatch(serialized, /opaque-test-token|private-test-jwt/);
});

test("account identity is persisted before a failed attach and reused after restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-viewer-recovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const id = crypto.randomUUID();
  const spec = { generation: "one", sessionId: id, enabled: true, cwd: directory, jobsDir: directory, jobId: "fixture" };
  saveJson(viewerFile(directory, "spec", id), spec);
  let creates = 0, success = false;
  const run = async () => {
    const controller = new AbortController();
    const running = runViewer({ directory, signal: controller.signal, pollMs: 5, tokenReader: () => "opaque",
      createSession: async () => { creates++; return "cse_recovery"; },
      fetchCredentials: async () => { if (!success) throw new Error("private failure"); return { worker_jwt: "opaque", api_base_url: "https://example.invalid" }; },
      attach: async () => ({ write() {}, isConnected: () => true, flush: async () => {}, close() {}, reportState() {}, sendResult() {} }),
      getMessages: async () => [] });
    await until(() => readJson(viewerFile(directory, "state", id))?.state === (success ? "connected" : "unavailable"));
    controller.abort(); await running;
  };
  await run();
  assert.equal(readJson(viewerFile(directory, "state", id)).sessionId, "cse_recovery");
  const checkpoint = readJson(viewerFile(directory, "state", id));
  checkpoint.uploadedUuids = ["already-delivered"];
  saveJson(viewerFile(directory, "state", id), checkpoint);
  success = true;
  await run();
  assert.equal(creates, 1);
  assert.equal(readJson(viewerFile(directory, "state", id)).messagesUploaded, 1);
  assert.doesNotMatch(JSON.stringify(readJson(viewerFile(directory, "state", id))), /private failure/);
});
