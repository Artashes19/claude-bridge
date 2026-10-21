import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const VIEWER_LOCK_ID = "11111111-1111-4111-8111-111111111111";
export const REMOTE_CONTROL_SURFACE = { surface: "remote-control", desktopPlacement: "remote-control",
  desktopWorkspaceCreated: false, nativeProjectCreated: false };
export const validSessionId = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function viewerFile(directory, kind, id) {
  if (!directory || !validSessionId(id)) throw new Error("Invalid history viewer identity.");
  return path.join(directory, `${kind}-${id}.json`);
}
export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function viewerState(directory, id) {
  if (!directory || !validSessionId(id)) return null;
  const stored = readJson(viewerFile(directory, "state", id));
  if (!stored) return null;
  const { uploadedUuids, ...state } = stored;
  if (state.state === "connected") {
    try {
      if (!Number.isSafeInteger(state.viewerPid) || state.viewerPid <= 0) throw new Error("Missing viewer.");
      process.kill(state.viewerPid, 0);
      if (!(Date.now() - Date.parse(state.observedAt) < 30000)) throw new Error("Stale viewer.");
    } catch { return { ...state, state: "offline", reason: "The history viewer is offline. Reconnect the saved session without rerunning its task." }; }
  }
  return state;
}
export function accountState(job, paths) {
  try { return { ...(viewerState(job.sessionMirrorDir ?? paths?.mirrorDir, job.sessionId) ?? job.accountSession ?? { state: "disabled" }), ...REMOTE_CONTROL_SURFACE }; }
  catch { return { ...(job.accountSession ?? {}), ...REMOTE_CONTROL_SURFACE, state: "unconfirmed", reason: "History viewer metadata is unreadable. The saved report remains available." }; }
}
