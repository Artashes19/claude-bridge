import fs from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { readFileTail } from "./claude.mjs";

export function createProjector({ outputFile, onProgress = () => {} }) {
  fs.writeFileSync(outputFile, "");
  let parseErrors = 0, terminal = null, emitted = false, lastMessage = null;
  const streamed = new Set();
  const seen = new Set();
  const progress = { eventCount: 0 };
  const append = (value) => {
    if (value) { fs.appendFileSync(outputFile, value); emitted = true; }
  };
  const consume = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { parseErrors++; return; }
    if (!event || typeof event !== "object") { parseErrors++; return; }
    progress.eventCount++;
    progress.lastActivityAt = new Date().toISOString();
    progress.activity = event.subtype ?? event.type;
    if (event.session_id) progress.sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") {
      progress.sessionReady = true;
      progress.actualModel = event.model;
    }
    if (event.type === "system" && event.subtype === "api_retry") {
      progress.retry = { attempt: event.attempt, delayMs: event.retry_delay_ms, error: event.error };
    }
    if (!event.parent_tool_use_id && event.type === "stream_event") {
      const item = event.event;
      if (item?.type === "message_start") {
        lastMessage = item.message?.id ?? `message-${progress.eventCount}`;
        if (emitted) append("\n\n");
      }
      if (item?.delta?.type === "text_delta") {
        streamed.add(lastMessage);
        append(item.delta.text);
        progress.activity = "responding";
      }
      if (item?.content_block?.type === "tool_use") {
        progress.activity = "tool";
        progress.tool = item.content_block.name;
      }
    }
    if (!event.parent_tool_use_id && event.type === "assistant") {
      const message = event.message;
      const id = message?.id ?? event.uuid;
      const key = `${id}:${JSON.stringify(message?.content)}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (!streamed.has(id)) {
          const text = (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
          if (text) { if (emitted) append("\n\n"); append(text); }
        }
      }
      progress.actualModel = message?.model ?? progress.actualModel;
      progress.latestMessageUsage = message?.usage ?? progress.latestMessageUsage;
      const tool = message?.content?.find((block) => block.type === "tool_use");
      if (tool) { progress.activity = "tool"; progress.tool = tool.name; }
    }
    if (event.type === "result") {
      terminal = event;
      if (typeof event.result === "string" && event.result &&
          (!emitted || !fs.readFileSync(outputFile, "utf8").includes(event.result))) {
        if (emitted) append("\n\n");
        append(event.result);
      }
      Object.assign(progress, {
        usage: event.usage ?? null, modelUsage: event.modelUsage ?? null,
        sessionCostUsd: event.total_cost_usd ?? null, costScope: "conversation-estimate",
        durationMs: event.duration_ms ?? null, turns: event.num_turns ?? null,
        permissionDenials: event.permission_denials ?? [], resultSubtype: event.subtype,
      });
    }
    onProgress({ ...progress }, event.type === "result");
  };
  return { consume, state: () => ({ parseErrors, terminal, progress }) };
}

export function recoverJournal({ eventsFile, outputFile }) {
  const temporary = `${outputFile}.${process.pid}.recovery`;
  let projector;
  try {
    projector = createProjector({ outputFile: temporary });
    const fd = fs.openSync(eventsFile, "r");
    try {
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(65536);
      let pending = "", bytes;
      while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        pending += decoder.write(buffer.subarray(0, bytes));
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          projector.consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.end();
      if (pending.trim()) projector.consume(pending);
    } finally { fs.closeSync(fd); }
    if (fs.statSync(temporary).size > 0) fs.renameSync(temporary, outputFile);
    return projector.state();
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function runStream({ binary, args, cwd, outputFile, stderrFile, eventsFile, onProgress }) {
  const projector = createProjector({ outputFile, onProgress });
  const { consume } = projector;
  const journal = fs.openSync(eventsFile, "w");
  const diagnostics = fs.openSync(stderrFile, "w");
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let childError;
  let status;
  try {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", diagnostics] });
    child.stdout.on("data", (chunk) => {
      try {
        fs.writeSync(journal, chunk);
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      } catch (error) { childError = error; child.kill("SIGTERM"); }
    });
    child.on("error", (error) => { childError = error; });
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    try { onProgress({ backendPid: child.pid }, true); }
    catch (error) { childError = error; child.kill("SIGTERM"); }
    status = await closed;
    pending += decoder.end();
    if (pending.trim()) consume(pending);
  } finally {
    fs.closeSync(journal);
    fs.closeSync(diagnostics);
  }
  const { parseErrors, terminal } = projector.state();
  const protocolError = parseErrors ? `${parseErrors} invalid event lines; inspect the saved event journal.` :
    !terminal ? "Stream ended without a final result; partial output and session are saved." :
    terminal.is_error || terminal.subtype !== "success" ?
      (terminal.errors ?? [terminal.result || terminal.subtype]).join("\n") : "";
  return { exitCode: status.code ?? 1,
    ...(childError || protocolError || status.signal ? {
      exitCode: status.code || 1, error: childError ?? new Error(protocolError || `Process terminated by ${status.signal}`),
    } : {}),
    stdout: fs.readFileSync(outputFile, "utf8"), stderr: readFileTail(stderrFile), outputPersisted: true };
}
