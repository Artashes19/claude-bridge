import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { query as defaultQuery, renameSession as defaultRenameSession } from "@anthropic-ai/claude-agent-sdk";
import { prepareVisibility } from "./visibility.mjs";
import { viewerFile } from "./viewer-state.mjs";
import { createProjector } from "./stream.mjs";
import { controlDir, records, saveOnce, saveControl } from "./interaction.mjs";
import { evidenceServer } from "./evidence.mjs";
import { queueNotification, deliverPending } from "./host-delivery.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const userMessage = (text, sessionId) => ({ type: "user", session_id: sessionId,
  message: { role: "user", content: text }, parent_tool_use_id: null });

function messageQueue() {
  const entries = [];
  let wake, ended = false;
  return {
    push(value) { entries.push(value); wake?.(); },
    close() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || entries.length) {
        if (entries.length) yield entries.shift();
        else await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

export async function runInteractive({ job, paths, binary, outputFile, stderrFile, eventsFile,
  onProgress, queryImpl = defaultQuery, renameSessionImpl = defaultRenameSession,
  notify = deliverPending, pollMs = 200, visibilityTimeoutMs = 15000, prepareVisibilityImpl = prepareVisibility }) {
  const directory = controlDir(paths.jobsDir, job.id);
  const input = messageQueue();
  const projector = createProjector({ outputFile, onProgress });
  fs.writeFileSync(stderrFile, "");
  const journal = fs.openSync(eventsFile, "w");
  let session, stopping = false, submitted = 1, finished = 0, dispatched = 0, commandTask = Promise.resolve();
  let failure, childClosed;
  const publish = async (type, key, detail) => {
    queueNotification({ jobsDir: paths.jobsDir, job, type, key, detail });
    await notify({ jobsDir: paths.jobsDir, job });
  };
  const canUseTool = async (toolName, data, context) => {
    if (toolName !== "AskUserQuestion") return { behavior: "deny", message: "This unattended run cannot grant additional permissions. Ask a clarifying question if needed." };
    if (!Array.isArray(data.questions) || !data.questions.length || data.questions.some((item) => typeof item.question !== "string")) {
      return { behavior: "deny", message: "A clarification needs nonempty questions with question text." };
    }
    const id = crypto.createHash("sha256").update(context.toolUseID ?? crypto.randomUUID()).digest("hex");
    const destination = path.join(directory, `question-${id}.json`);
    const question = { id, toolUseId: context.toolUseID ?? null, input: data, state: "pending", askedAt: new Date().toISOString() };
    saveOnce(destination, question);
    onProgress({ status: "needs_input", activity: "waiting_for_answer" }, true);
    void publish("question", id, data.questions).catch(() => {});
    while (!stopping && !context.signal?.aborted) {
      const answerPath = path.join(directory, `answer-${id}.json`);
      if (fs.existsSync(answerPath)) {
        const answer = JSON.parse(fs.readFileSync(answerPath, "utf8"));
        saveControl(destination, { ...question, state: "answered", answeredAt: new Date().toISOString() });
        const stillWaiting = records(directory, "question-").some((item) => item.state === "pending");
        onProgress({ status: stillWaiting ? "needs_input" : "running", activity: stillWaiting ? "waiting_for_answer" : "answer_received" }, true);
        return { behavior: "allow", updatedInput: { ...data, answers: answer.answers } };
      }
      await sleep(pollMs);
    }
    saveControl(destination, { ...question, state: "canceled" });
    return { behavior: "deny", message: "The clarification was interrupted. No answer was supplied." };
  };
  const readonly = job.kind !== "delegate";
  const evidenceTools = ["mcp__evidence__read", "mcp__evidence__search", "mcp__evidence__list"];
  const options = {
    cwd: job.cwd, model: job.model, effort: job.effort,
    ...(job.title ? { title: job.title } : {}),
    pathToClaudeCodeExecutable: binary, includePartialMessages: true,
    ...(job.resumedFrom ? { resume: job.sessionId } : { sessionId: job.sessionId }),
    ...(job.maxBudgetUsd != null ? { maxBudgetUsd: job.maxBudgetUsd } : {}),
    permissionMode: readonly ? "default" : "acceptEdits", canUseTool,
    ...(readonly ? { tools: ["AskUserQuestion"], mcpServers: { evidence: evidenceServer(paths.repoRoot) },
      allowedTools: evidenceTools, settingSources: [], extraArgs: { "strict-mcp-config": null } } : {}),
    systemPrompt: { type: "preset", preset: "claude_code", append:
      "You are collaborating with a host agent. Use AskUserQuestion when clarification from that agent would materially help; it can answer from its own perspective and evidence. Do not assume it speaks for the user or grants new authorization. " +
      (readonly ? "This is a read-only discussion or review. Inspect project evidence using the evidence tools, including repository instructions when present. You have no write or shell tools. Cite file locations for factual claims." : "Stay within the delegated task and existing authorization.") },
    stderr: (text) => fs.appendFileSync(stderrFile, text),
    spawnClaudeCodeProcess: (settings) => {
      const diagnostics = fs.openSync(stderrFile, "a");
      let child;
      try { child = spawn(settings.command, settings.args, { cwd: settings.cwd, env: settings.env,
        signal: settings.signal, stdio: ["pipe", "pipe", diagnostics] }); }
      finally { fs.closeSync(diagnostics); }
      childClosed = new Promise((resolve) => child.once("close", resolve));
      onProgress({ backendPid: child.pid }, true);
      return child;
    },
  };
  async function dispatchCommands() {
    if (stopping || !session) return;
    const commands = records(directory, "command-").sort((a, b) => a.createdAt.localeCompare(b.createdAt) ||
      (BigInt(a.createdOrder ?? 0) < BigInt(b.createdOrder ?? 0) ? -1 : 1));
    for (const command of commands) {
      const receipt = path.join(directory, `receipt-${command.id}.json`);
      if (!saveOnce(receipt, { state: "dispatching", commandId: command.id })) continue;
      submitted++;
      try {
        if (command.interrupt) await session.interrupt();
        input.push(userMessage(command.message, job.sessionId));
        dispatched++;
        saveControl(receipt, { state: "dispatched", commandId: command.id, dispatchedAt: new Date().toISOString() });
      } catch (error) {
        submitted--;
        saveControl(receipt, { state: "failed", commandId: command.id, error: error.message });
      }
    }
  }
  let timer;
  try {
    if (job.resumedFrom && job.title) {
      try {
        await renameSessionImpl(job.sessionId, job.title, { dir: job.cwd });
        onProgress({ nativeTitleState: "applied" }, true);
      } catch { onProgress({ nativeTitleState: "unavailable" }, true); }
    }
    if (job.shareSession || (paths.mirrorDir && fs.existsSync(viewerFile(paths.mirrorDir, "spec", job.sessionId)))) {
      try {
        const accountSession = await prepareVisibilityImpl({ job, paths, timeoutMs: visibilityTimeoutMs });
        onProgress({ sessionMirrorDir: paths.mirrorDir, accountSession }, true);
      } catch {
        if (!job.shareSession) throw new Error("History sharing could not be disabled. No model prompt was sent; repair the viewer preference before continuing.");
        onProgress({ accountSession: { ...(job.accountSession ?? {}), state: "unavailable",
          reason: "History sharing is unavailable. The original task will continue and its report will be saved." } }, true);
      }
    }
    session = queryImpl({ prompt: input, options });
    input.push(userMessage(job.request.prompt, job.sessionId));
    timer = setInterval(() => {
      commandTask = commandTask.then(dispatchCommands).catch((error) => { failure = error; session.close(); });
    }, pollMs);
    for await (const event of session) {
      const line = JSON.stringify(event);
      fs.writeSync(journal, `${line}\n`);
      projector.consume(line);
      if (event.type === "result") {
        finished++;
        const dispatchesAtResult = dispatched;
        await commandTask;
        await dispatchCommands();
        if (dispatched !== dispatchesAtResult) continue;
        if (typeof event.queued_turn_count === "number") {
          if (event.queued_turn_count === 0) break;
        } else {
          if (finished < submitted) failure = new Error("The final result lacks queue-state metadata for live input. The saved report is retained; inspect it before resuming.");
          break;
        }
      }
    }
  } catch (error) { failure = error; }
  finally {
    stopping = true;
    clearInterval(timer);
    input.close();
    session?.close();
    await commandTask.catch(() => {});
    if (childClosed) {
      let timer;
      await Promise.race([childClosed, new Promise((resolve) => {
        timer = setTimeout(() => { failure ??= new Error("Backend did not finish shutting down; its session remains locked while it is alive."); resolve(); }, 5000);
      })]);
      clearTimeout(timer);
    }
    fs.closeSync(journal);
  }
  const terminal = projector.state().terminal;
  const protocolError = !terminal ? "Session ended without a final result; partial output is saved." :
    terminal.is_error || terminal.subtype !== "success" ? (terminal.errors ?? [terminal.result || terminal.subtype]).join("\n") : "";
  return { exitCode: failure || protocolError ? 1 : 0, ...(failure || protocolError ? { error: failure ?? new Error(protocolError) } : {}),
    stdout: fs.readFileSync(outputFile, "utf8"), stderr: fs.readFileSync(stderrFile, "utf8").slice(-2000), outputPersisted: true };
}
