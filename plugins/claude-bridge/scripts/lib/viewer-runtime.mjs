import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createCodeSession, fetchRemoteCredentials, attachBridgeSession } from "@anthropic-ai/claude-agent-sdk/bridge";
import { lockSession } from "./sessions.mjs";
import { VIEWER_LOCK_ID, REMOTE_CONTROL_SURFACE, viewerFile, readJson, saveJson, validSessionId } from "./viewer-state.mjs";

const API = "https://api.anthropic.com";
const accountUrl = (id) => {
  if (typeof id !== "string" || !/^cse_[A-Za-z0-9_-]{1,180}$/.test(id)) throw new Error("Invalid account history identity.");
  return `https://claude.ai/code/session_${id.slice(4)}`;
};
function accessToken() {
  const credentials = readJson(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), ".credentials.json"));
  const token = credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token) throw new Error("Account authentication is unavailable.");
  return token;
}
export async function boundedFlush(handle, timeoutMs = 30000) {
  let timer;
  try {
    const flushed = await Promise.race([handle.flush(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("History delivery acknowledgement timed out.")), timeoutMs);
    })]);
    if (flushed === false) throw new Error("History transport closed before delivery acknowledgement.");
  } finally { clearTimeout(timer); }
}
export async function uploadHistory({ spec, handle, uploaded, getMessages = getSessionMessages,
  isCurrent = () => true, flush = boundedFlush }) {
  const pending = [];
  const seen = new Set(uploaded);
  for (let offset = 0; ; offset += 1000) {
    const messages = await getMessages(spec.sessionId, { dir: spec.cwd, offset, limit: 1000 });
    if (!isCurrent()) return null;
    for (const message of messages) {
      if (!["user", "assistant"].includes(message.type) || !message.uuid || seen.has(message.uuid)) continue;
      handle.write(message);
      seen.add(message.uuid);
      pending.push(message.uuid);
    }
    if (messages.length < 1000) break;
  }
  handle.reportState("idle");
  if (pending.length) handle.sendResult();
  await flush(handle);
  for (const id of pending) uploaded.add(id);
  return pending.length;
}
const pause = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  if (signal?.aborted) done();
});

export async function runViewer({ directory, signal, pollMs = 2000, idleExitMs = 30000,
  tokenReader = accessToken, createSession = createCodeSession, fetchCredentials = fetchRemoteCredentials,
  attach = attachBridgeSession, getMessages = getSessionMessages, flush = boundedFlush }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let unlock;
  try { unlock = lockSession({ jobsDir: directory, job: { id: "history-viewer", sessionId: VIEWER_LOCK_ID } }); }
  catch (error) { if (error.message.startsWith("Session is already in use")) return; throw error; }
  const entries = new Map();
  let idleSince = Date.now();
  const persist = (spec, entry, patch = {}) => {
    entry.state = { ...entry.state, ...patch, generation: spec.generation, observedAt: new Date().toISOString(),
      viewerPid: process.pid, mode: "view-only", experimental: true, ...REMOTE_CONTROL_SURFACE,
      nativeProjectCreated: false, modelPromptSent: false, messagesUploaded: entry.uploaded.size,
      uploadedUuids: [...entry.uploaded] };
    saveJson(viewerFile(directory, "state", spec.sessionId), entry.state);
  };
  try {
    while (!signal?.aborted) {
      let enabledCount = 0;
      const files = fs.readdirSync(directory).filter((name) => /^spec-[0-9a-f-]+\.json$/i.test(name));
      for (const name of files) {
        if (signal?.aborted) break;
        let spec;
        try { spec = readJson(path.join(directory, name)); }
        catch { continue; }
        if (!spec || !validSessionId(spec.sessionId)) continue;
        let entry = entries.get(spec.sessionId);
        if (!entry) {
          let stored;
          try { stored = readJson(viewerFile(directory, "state", spec.sessionId)); } catch { stored = null; }
          entry = { state: stored ?? {}, uploaded: new Set(stored?.uploadedUuids ?? []), retryAt: 0 };
          entries.set(spec.sessionId, entry);
        }
        if (!spec.enabled) {
          entry.handle?.close(); entry.handle = null;
          entry.synced = false;
          persist(spec, entry, { state: "disabled", reason: null });
          continue;
        }
        enabledCount++;
        if (entry.retryAt > Date.now() && entry.generation === spec.generation) continue;
        try {
          if (entry.closed || entry.expiresAt <= Date.now()) {
            entry.handle?.close(); entry.handle = null;
          }
          if (!entry.handle) {
            const token = await tokenReader();
            let id = entry.state.sessionId ?? spec.accountSessionId;
            if (!id) id = await createSession(API, token, spec.title ?? "Saved conversation", 15000, undefined, undefined, spec.cwd);
            const url = accountUrl(id);
            persist(spec, entry, { sessionId: id, url, state: "connecting", reason: null });
            const credentials = await fetchCredentials(id, API, token, 15000);
            if (!credentials?.worker_jwt || !credentials.api_base_url) throw new Error("History connection is unavailable.");
            entry.closed = false;
            const connection = {};
            entry.connection = connection;
            entry.handle = await attach({ sessionId: id, ingressToken: credentials.worker_jwt,
              apiBaseUrl: credentials.api_base_url, epoch: credentials.worker_epoch, outboundOnly: true,
              onClose: () => { if (entry.connection === connection) entry.closed = true; } });
            entry.expiresAt = Date.now() + Math.max(60, (credentials.expires_in ?? 14400) - 300) * 1000;
            entry.synced = false;
          }
          let mtime = null;
          try { mtime = fs.statSync(path.join(spec.jobsDir, `${spec.jobId}.json`)).mtimeMs; } catch {}
          if (!entry.synced || entry.generation !== spec.generation || entry.jobMtime !== mtime) {
            const count = await uploadHistory({ spec, handle: entry.handle, uploaded: entry.uploaded, getMessages, flush,
              isCurrent: () => {
                const latest = readJson(viewerFile(directory, "spec", spec.sessionId));
                return !signal?.aborted && latest?.enabled && latest.generation === spec.generation;
              } });
            if (count === null) continue;
            entry.jobMtime = mtime;
            entry.synced = true;
          }
          entry.generation = spec.generation;
          entry.retryAt = 0;
          persist(spec, entry, { state: entry.handle.isConnected() && !entry.closed ? "connected" : "unconfirmed",
            connectedAt: entry.state.connectedAt ?? new Date().toISOString(), reason: null });
        } catch {
          entry.handle?.close(); entry.handle = null;
          entry.generation = spec.generation;
          entry.retryAt = Date.now() + 30000;
          persist(spec, entry, { state: "unavailable",
            reason: "History delivery is unavailable; the viewer will reconnect. The saved report is retained and no model task was restarted." });
        }
      }
      if (enabledCount) idleSince = Date.now();
      else if (Date.now() - idleSince >= idleExitMs) break;
      await pause(pollMs, signal);
    }
  } finally {
    for (const [id, entry] of entries) {
      entry.handle?.close();
      try {
        const spec = readJson(viewerFile(directory, "spec", id));
        if (spec) persist(spec, entry, { state: spec.enabled ? "offline" : "disabled" });
      } catch {}
    }
    unlock();
  }
}
