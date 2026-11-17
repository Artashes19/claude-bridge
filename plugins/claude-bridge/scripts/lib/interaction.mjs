import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function controlDir(jobsDir, jobId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid job identity");
  const directory = path.join(jobsDir, `${jobId}.control`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function saveOnce(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  try {
    try { fs.linkSync(temporary, file); return true; }
    catch (error) { if (error.code === "EEXIST") return false; throw error; }
  } finally { fs.unlinkSync(temporary); }
}

export function saveControl(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function records(directory, prefix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort().map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
}

export function pendingQuestions(jobsDir, jobId) {
  return records(controlDir(jobsDir, jobId), "question-").filter((item) => item.state === "pending");
}

export function submitAnswer({ jobsDir, jobId, questionId, answers, allowNew = true }) {
  if (!/^[a-f0-9-]+$/.test(questionId)) throw new Error("Invalid question identity");
  const directory = controlDir(jobsDir, jobId);
  const question = JSON.parse(fs.readFileSync(path.join(directory, `question-${questionId}.json`), "utf8"));
  if (!answers || typeof answers !== "object" || Array.isArray(answers) ||
      Object.values(answers).some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("Answers must map each question's exact text to a nonempty string.");
  }
  const expected = question.input.questions.map((item) => item.question);
  if (expected.some((key) => !Object.hasOwn(answers, key)) || Object.keys(answers).some((key) => !expected.includes(key))) {
    throw new Error("Answer every question using its exact text as the key; no additional keys.");
  }
  const destination = path.join(directory, `answer-${questionId}.json`);
  const value = { questionId, answers, submittedAt: new Date().toISOString() };
  if (fs.existsSync(destination)) {
    const previous = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (expected.some((key) => previous.answers[key] !== answers[key])) throw new Error("This question already has a different answer.");
    return { questionId, submitted: true, reused: true };
  }
  if (!allowNew) throw new Error("This job has ended; retrieve its saved output.");
  if (question.state !== "pending") throw new Error("The question is no longer pending.");
  if (!saveOnce(destination, value)) return submitAnswer({ jobsDir, jobId, questionId, answers, allowNew });
  return { questionId, submitted: true, reused: false };
}

export function submitSteering({ jobsDir, jobId, message, requestId, interrupt = false, allowNew = true }) {
  if (typeof message !== "string" || !message.trim() || message.length > 100000) throw new Error("A steering message of 1..100000 characters is required.");
  if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 128) throw new Error("A stable requestId of 1..128 characters is required.");
  const id = crypto.createHash("sha256").update(requestId).digest("hex");
  const directory = controlDir(jobsDir, jobId);
  const destination = path.join(directory, `command-${id}.json`);
  const value = { id, message, interrupt, requestId, createdAt: new Date().toISOString(), createdOrder: process.hrtime.bigint().toString() };
  const created = fs.existsSync(destination) ? false : withSteeringLock(directory, () => {
    if (fs.existsSync(destination)) return false;
    if (!allowNew || fs.existsSync(path.join(directory, "steering-closed.json"))) {
      throw new Error("This job has stopped accepting input; use a resumed discussion for another turn. This message was not queued.");
    }
    return saveOnce(destination, value);
  });
  if (!created) {
    const previous = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (previous.message !== message || previous.interrupt !== interrupt) throw new Error("This requestId already identifies a different steering message.");
  }
  return { ...steeringReceipt(directory, value), reused: !created };
}

function withSteeringLock(directory, action) {
  const lock = path.join(directory, "steering.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt++) {
    acquired = saveOnce(lock, { pid: process.pid });
    if (!acquired) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!acquired) {
    throw new Error("Steering state is busy; retry with the same requestId. No new message was queued.");
  }
  try { return action(); } finally { fs.unlinkSync(lock); }
}

export function unresolvedSteering(jobsDir, jobId) {
  const directory = controlDir(jobsDir, jobId);
  return records(directory, "command-").map((command) => steeringReceipt(directory, command))
    .filter((item) => item.state !== "completed");
}

// Serialize accepting the final message with closing the input channel.
export function sealSteering(jobsDir, jobId, force = false) {
  const directory = controlDir(jobsDir, jobId);
  return withSteeringLock(directory, () => {
    if (!force && unresolvedSteering(jobsDir, jobId).length) return false;
    saveOnce(path.join(directory, "steering-closed.json"), { closedAt: new Date().toISOString() });
    return true;
  });
}

export function createSteeringTracker(directory) {
  const messages = new Map();
  const responding = new Set();
  const update = (uuid, patch) => {
    const record = messages.get(uuid);
    if (!record || ["completed", "failed"].includes(record.state)) return;
    Object.assign(record, patch);
    saveControl(path.join(directory, `receipt-${record.commandId}.json`), record);
  };
  return {
    register(record) { messages.set(record.messageUuid, record); },
    observe(event) {
      if (event.parent_tool_use_id || !["assistant", "stream_event", "result"].includes(event.type)) return;
      const ids = new Set([...(event.user_message_uuids ?? []), event.user_message_uuid].filter((id) => messages.has(id)));
      for (const id of ids) {
        responding.add(id);
        update(id, { state: "responding", receivedAt: new Date().toISOString() });
      }
      if (event.type !== "result") return;
      for (const id of responding) update(id, {
        state: event.subtype === "success" && !event.is_error &&
          (!event.terminal_reason || event.terminal_reason === "completed") ? "completed" : "failed",
        responseAt: new Date().toISOString(), resultUuid: event.uuid ?? null,
        resultIndex: event.result_index ?? null, terminalReason: event.terminal_reason ?? null,
      });
      responding.clear();
    },
    waitingForReceipt() { return [...messages.values()].some((record) => record.state === "dispatched"); },
    hasFailure() { return [...messages.values()].some((record) => record.state === "failed"); },
  };
}

function steeringReceipt(directory, command) {
  const receipt = path.join(directory, `receipt-${command.id}.json`);
  return { ...(fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, "utf8")) : { state: "queued" }),
    commandId: command.id, mode: command.interrupt ? "interrupt" : "queued", incorporation: "unconfirmed" };
}

export function interactionState(jobsDir, jobId) {
  const directory = controlDir(jobsDir, jobId);
  return { questions: pendingQuestions(jobsDir, jobId),
    steering: records(directory, "command-").map((command) => ({ requestId: command.requestId, ...steeringReceipt(directory, command) })),
    notifications: records(directory, "notification-").map(({ id, state, error }) => ({ id, state, ...(error ? { error } : {}) })),
  };
}
