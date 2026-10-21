import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { runInteractive } from "../plugins/claude-bridge/scripts/lib/interactive.mjs";
import { submitAnswer, submitSteering, interactionState, records, controlDir, saveOnce } from "../plugins/claude-bridge/scripts/lib/interaction.mjs";
import { readEvidence, searchEvidence, listEvidence, evidencePath } from "../plugins/claude-bridge/scripts/lib/evidence.mjs";
import { queueNotification, deliverPending } from "../plugins/claude-bridge/scripts/lib/host-delivery.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-interactive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "jobs"));
  return { root, jobsDir: path.join(root, "jobs") };
}
const success = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });

test("paused clarification accepts a durable answer and continues the same query", async (t) => {
  const { root, jobsDir } = fixture(t);
  const job = { id: "question-job", kind: "discuss", cwd: root, sessionId: "saved-session", request: { prompt: "Investigate" } };
  let launches = 0, observedOptions;
  const progress = [];
  const queryImpl = ({ prompt, options }) => {
    launches++; observedOptions = options;
    return { close() {}, async *[Symbol.asyncIterator]() {
      const first = await prompt[Symbol.asyncIterator]().next();
      assert.equal(first.value.message.content, "Investigate");
      const response = await options.canUseTool("AskUserQuestion", { questions: [{ question: "Which baseline?" }] }, { toolUseID: "ask-one", signal: new AbortController().signal });
      assert.equal(response.updatedInput.answers["Which baseline?"], "Use the accepted baseline; this is my recommendation.");
      yield success("Continued with the accepted baseline");
    } };
  };
  const running = runInteractive({ job, paths: { jobsDir, repoRoot: root }, binary: "unused",
    outputFile: path.join(root, "output"), stderrFile: path.join(root, "stderr"), eventsFile: path.join(root, "events"),
    onProgress: (value) => progress.push(value), queryImpl, pollMs: 5 });
  let question;
  for (let attempt = 0; attempt < 100 && !question; attempt++) {
    question = interactionState(jobsDir, job.id).questions[0];
    if (!question) await delay(5);
  }
  assert.ok(question);
  const answers = { "Which baseline?": "Use the accepted baseline; this is my recommendation." };
  assert.equal(submitAnswer({ jobsDir, jobId: job.id, questionId: question.id, answers }).reused, false);
  assert.equal(submitAnswer({ jobsDir, jobId: job.id, questionId: question.id, answers }).reused, true);
  assert.throws(() => submitAnswer({ jobsDir, jobId: job.id, questionId: question.id, answers: { "Which baseline?": "different" } }), /different answer/);
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(launches, 1);
  assert.equal(interactionState(jobsDir, job.id).questions.length, 0);
  assert.ok(progress.some((value) => value.status === "needs_input"));
  assert.ok(progress.some((value) => value.status === "running"));
  assert.deepEqual(observedOptions.tools, ["AskUserQuestion"]);
  assert.deepEqual(observedOptions.allowedTools, ["mcp__evidence__read", "mcp__evidence__search", "mcp__evidence__list"]);
  assert.equal((await observedOptions.canUseTool("Bash", {}, {})).behavior, "deny");
});

for (const interrupt of [false, true]) test(`live input is delivered once with interrupt=${interrupt}`, async (t) => {
  const { root, jobsDir } = fixture(t);
  const job = { id: "steering-job", kind: "discuss", cwd: root, sessionId: "saved-session", request: { prompt: "Start" } };
  let interrupts = 0;
  const queryImpl = ({ prompt }) => ({ close() {}, async interrupt() { interrupts++; }, async *[Symbol.asyncIterator]() {
    const messages = prompt[Symbol.asyncIterator]();
    assert.equal((await messages.next()).value.message.content, "Start");
    const options = { jobsDir, jobId: job.id, message: "Focus on timing", requestId: "one-message", interrupt };
    assert.equal(submitSteering(options).reused, false);
    assert.equal(submitSteering(options).reused, true);
    assert.throws(() => submitSteering({ ...options, message: "different" }), /different steering/);
    assert.equal((await messages.next()).value.message.content, "Focus on timing");
    yield { ...success("Original turn"), queued_turn_count: 1 };
    yield { ...success("Steered turn"), queued_turn_count: 0 };
  } });
  const result = await runInteractive({ job, paths: { jobsDir, repoRoot: root }, binary: "unused",
    outputFile: path.join(root, "output"), stderrFile: path.join(root, "stderr"), eventsFile: path.join(root, "events"),
    onProgress() {}, queryImpl, pollMs: 5 });
  assert.equal(result.exitCode, 0);
  assert.equal(interrupts, interrupt ? 1 : 0);
  const receipt = interactionState(jobsDir, job.id).steering[0];
  assert.equal(receipt.state, "dispatched");
  assert.equal(receipt.mode, interrupt ? "interrupt" : "queued");
  assert.equal(receipt.incorporation, "unconfirmed");
  assert.match(result.stdout, /Steered turn/);
});

test("dispatched input can remain unconsumed until after the original answer", { timeout: 3000 }, async (t) => {
  const { root, jobsDir } = fixture(t);
  const outputFile = path.join(root, "output");
  const job = { id: "delayed-input", kind: "discuss", cwd: root, sessionId: "saved-session", request: { prompt: "Start" } };
  const queryImpl = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const messages = prompt[Symbol.asyncIterator]();
    await messages.next();
    const command = { jobsDir, jobId: job.id, message: "Apply the correction", requestId: "delayed-one" };
    submitSteering(command);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (interactionState(jobsDir, job.id).steering[0].state === "dispatched") break;
      await delay(5);
    }
    const receipt = submitSteering(command);
    assert.equal(receipt.reused, true);
    assert.equal(receipt.state, "dispatched");
    assert.equal(receipt.incorporation, "unconfirmed");
    yield { ...success("Original answer without the correction"), queued_turn_count: 1 };
    assert.equal(fs.readFileSync(outputFile, "utf8"), "Original answer without the correction");
    assert.equal((await messages.next()).value.message.content, "Apply the correction");
    yield { ...success("Follow-up answer with the correction"), queued_turn_count: 0 };
  } });
  const result = await runInteractive({ job, paths: { jobsDir, repoRoot: root }, binary: "unused", outputFile,
    stderrFile: path.join(root, "stderr"), eventsFile: path.join(root, "events"),
    onProgress() {}, queryImpl, pollMs: 5 });
  assert.equal(result.exitCode, 0, result.error?.message);
  assert.ok(result.stdout.indexOf("Original answer") < result.stdout.indexOf("Follow-up answer"));
  assert.equal(interactionState(jobsDir, job.id).steering[0].incorporation, "unconfirmed");
});

test("live input folded into the active turn completes without waiting for a nonexistent second result", async (t) => {
  const { root, jobsDir } = fixture(t);
  const job = { id: "folded-input", kind: "discuss", cwd: root, sessionId: "saved-session", request: { prompt: "Start" } };
  const queryImpl = ({ prompt }) => ({ close() {}, async *[Symbol.asyncIterator]() {
    const messages = prompt[Symbol.asyncIterator]();
    await messages.next();
    submitSteering({ jobsDir, jobId: job.id, message: "Fold this into the answer", requestId: "fold-one" });
    await messages.next();
    yield { ...success("Combined answer"), queued_turn_count: 0 };
    throw new Error("The bridge waited for a result that does not exist");
  } });
  const result = await runInteractive({ job, paths: { jobsDir, repoRoot: root }, binary: "unused",
    outputFile: path.join(root, "output"), stderrFile: path.join(root, "stderr"), eventsFile: path.join(root, "events"),
    onProgress() {}, queryImpl, pollMs: 5 });
  assert.equal(result.exitCode, 0, result.error?.message);
  assert.equal(result.stdout, "Combined answer");
});

test("evidence tools read and search files while excluding escapes and runtime state", (t) => {
  const { root } = fixture(t);
  const project = path.join(root, "project"); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "code.txt"), "first\nuseful evidence\nlast\n");
  fs.writeFileSync(path.join(root, "outside.txt"), "outside-secret");
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(project, "linked.txt"));
  fs.mkdirSync(path.join(project, ".claude-bridge"));
  fs.writeFileSync(path.join(project, ".claude-bridge", "private.txt"), "private-marker");
  assert.match(readEvidence(project, { file: "code.txt", startLine: 2, lines: 1 }), /2: useful evidence/);
  assert.match(searchEvidence(project, { pattern: "useful" }), /code.txt:2:useful evidence/);
  assert.equal(searchEvidence(project, { pattern: "outside-secret|private-marker" }), "No matches");
  assert.match(listEvidence(project, {}), /code.txt/);
  assert.doesNotMatch(listEvidence(project, {}), /linked|private/);
  for (const target of ["../outside.txt", "linked.txt", ".claude-bridge/private.txt"]) {
    assert.throws(() => evidencePath(project, target), /limited to project files/);
  }
});

for (const active of [false, true]) test(`notifications target the bound thread with active=${active}`, async (t) => {
  const { jobsDir } = fixture(t);
  const job = { id: "notify-job", cwd: "/project", hostDelivery: { threadId: "origin-thread", endpoint: "/private/socket" } };
  const calls = [];
  const connect = async () => ({ close() {}, async request(method, params) {
    calls.push({ method, params });
    if (method === "thread/turns/list") return { data: active ? [{ id: "active-turn", status: "inProgress" }] : [] };
    return { turnId: "accepted" };
  } });
  queueNotification({ jobsDir, job, type: "completion", key: job.id, detail: { status: "completed" } });
  queueNotification({ jobsDir, job, type: "completion", key: job.id, detail: { status: "completed" } });
  await Promise.all([deliverPending({ jobsDir, job, connect }), deliverPending({ jobsDir, job, connect })]);
  await deliverPending({ jobsDir, job, connect });
  const delivered = calls.filter((call) => ["turn/steer", "turn/start"].includes(call.method));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].method, active ? "turn/steer" : "turn/start");
  assert.equal(delivered[0].params.threadId, "origin-thread");
  assert.equal(interactionState(jobsDir, job.id).notifications[0].state, "delivered");
});

test("uncertain delivery is retained without duplicate inference after a lost acknowledgement", async (t) => {
  const { jobsDir } = fixture(t);
  const job = { id: "uncertain-job", cwd: "/project", hostDelivery: { threadId: "origin", endpoint: "/socket" } };
  let sent = 0;
  const connect = async () => ({ close() {}, async request(method) {
    if (method === "thread/turns/list") return { data: [] };
    if (method === "thread/resume") return {};
    sent++; throw new Error("Connection lost after send");
  } });
  queueNotification({ jobsDir, job, type: "completion", key: job.id, detail: { status: "completed" } });
  await deliverPending({ jobsDir, job, connect });
  await deliverPending({ jobsDir, job, connect });
  assert.equal(sent, 1);
  assert.equal(interactionState(jobsDir, job.id).notifications[0].state, "uncertain");
});

test("explicitly rejected notification can be retried, and resolved questions are not delivered late", async (t) => {
  const { jobsDir } = fixture(t);
  const job = { id: "retry-job", cwd: "/project", hostDelivery: { threadId: "origin", endpoint: "/socket" } };
  let attempts = 0;
  const connect = async () => ({ close() {}, async request(method) {
    if (method === "thread/turns/list") return { data: [] };
    if (method === "thread/resume") return {};
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("Turn state changed"), { rpcError: true });
    return {};
  } });
  queueNotification({ jobsDir, job, type: "completion", key: job.id, detail: { status: "completed" } });
  await deliverPending({ jobsDir, job, connect });
  assert.equal(interactionState(jobsDir, job.id).notifications[0].state, "pending");
  await deliverPending({ jobsDir, job, connect });
  assert.equal(attempts, 2);
  const id = "abc123";
  saveOnce(path.join(controlDir(jobsDir, job.id), `answer-${id}.json`), { answers: {} });
  queueNotification({ jobsDir, job, type: "question", key: id, detail: [] });
  await deliverPending({ jobsDir, job, connect });
  assert.equal(attempts, 2);
  assert.equal(records(controlDir(jobsDir, job.id), "notification-").find((item) => item.type === "question").state, "resolved");
});
