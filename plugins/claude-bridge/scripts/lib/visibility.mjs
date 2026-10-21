import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSessionMessages, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { lockSession } from "./sessions.mjs";
import { VIEWER_LOCK_ID, REMOTE_CONTROL_SURFACE, viewerFile, viewerState, readJson, saveJson } from "./viewer-state.mjs";

const script = fileURLToPath(new URL("../history-viewer.mjs", import.meta.url));
export function ensureViewer(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = readJson(path.join(directory, `${VIEWER_LOCK_ID}.session-lock`));
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); return owner.pid; }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const child = spawn(process.execPath, [script, directory], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}
export function recoverViewer(directory) {
  if (!fs.existsSync(directory)) return;
  const enabled = fs.readdirSync(directory).some((name) => {
    if (!/^spec-[0-9a-f-]+\.json$/i.test(name)) return false;
    try { return readJson(path.join(directory, name))?.enabled === true; } catch { return false; }
  });
  if (enabled) ensureViewer(directory);
}

export async function prepareVisibility({ job, paths, enabled = job.shareSession, timeoutMs = 15000,
  startViewer = ensureViewer, readState = viewerState }) {
  const directory = paths.mirrorDir;
  const generation = crypto.randomUUID();
  saveJson(viewerFile(directory, "spec", job.sessionId), { generation, sessionId: job.sessionId,
    cwd: job.cwd, jobsDir: paths.jobsDir, jobId: job.id, title: job.title,
    enabled: Boolean(enabled), accountSessionId: job.accountSession?.sessionId ?? null });
  startViewer(directory);
  const deadline = Date.now() + timeoutMs;
  do {
    const state = readState(directory, job.sessionId);
    if (state?.generation === generation && ["connected", "disabled", "unavailable"].includes(state.state)) return { ...state, ...REMOTE_CONTROL_SURFACE };
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return { ...(job.accountSession ?? {}), ...REMOTE_CONTROL_SURFACE, state: "unconfirmed", mode: "view-only", modelPromptSent: false,
    reason: "History connection acknowledgement timed out. Retrieve the saved report or reconnect this session; do not repeat its task." };
}

export async function shareSavedSession({ job, paths, onProgress, enabled = true,
  renameSessionImpl = renameSession, getMessages = getSessionMessages, prepare = prepareVisibility, timeoutMs = 15000 }) {
  const unlock = lockSession({ jobsDir: paths.jobsDir, job });
  try {
    if (enabled && !(await getMessages(job.sessionId, { dir: job.cwd, limit: 1 })).length) {
      throw new Error("No saved native conversation messages were found. No empty account session or replacement execution was created.");
    }
    if (job.title && enabled) {
      try {
        await renameSessionImpl(job.sessionId, job.title, { dir: job.cwd });
        onProgress({ nativeTitleState: "applied" }, true);
      } catch { onProgress({ nativeTitleState: "unavailable" }, true); }
    }
    const accountSession = await prepare({ job, paths, enabled, timeoutMs });
    onProgress({ sessionMirrorDir: paths.mirrorDir, accountSession }, true);
    return { accountSession, modelPromptSent: false };
  } finally { unlock(); }
}
