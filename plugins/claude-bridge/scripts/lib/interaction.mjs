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
  if (!allowNew && !fs.existsSync(destination)) throw new Error("This job has ended; use a resumed discussion for another turn.");
  const value = { id, message, interrupt, requestId, createdAt: new Date().toISOString(), createdOrder: process.hrtime.bigint().toString() };
  const created = saveOnce(destination, value);
  if (!created) {
    const previous = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (previous.message !== message || previous.interrupt !== interrupt) throw new Error("This requestId already identifies a different steering message.");
  }
  return { ...steeringReceipt(directory, value), reused: !created };
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
