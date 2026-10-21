import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listJobRecords } from "./jobs.mjs";
import { projectKey, sessionLabel, newestAccountSession } from "./catalog.mjs";
import { accountState } from "./viewer-state.mjs";

export function resolveSession({ jobsDir, specifier, cwd, project }) {
  if (!specifier) return null;
  project = sessionLabel(project, "project", 120);
  const jobs = listJobRecords({ jobsDir });
  const candidates = jobs.filter((job) => {
    try { return job.sessionId && job.sessionReady &&
      ["completed", "failed", "canceled"].includes(job.status) &&
      (project === undefined || projectKey(job.project) === projectKey(project)) &&
      !jobs.some((other) => other.sessionId === job.sessionId && !["completed", "failed", "canceled"].includes(other.status)) &&
      fs.realpathSync(job.cwd) === fs.realpathSync(cwd); }
    catch { return false; }
  });
  const job = specifier === "latest" ? candidates.sort((a, b) =>
    (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt) || b.id.localeCompare(a.id))[0] :
    jobs.find((item) => item.id === specifier);
  if (!job) throw new Error(`Cannot resume from job "${specifier}": no saved session found.`);
  if (!candidates.includes(job)) {
    throw new Error(`Cannot resume from job "${specifier}": a saved, inactive session in the same working directory is required. Older report-only jobs cannot be resumed natively.`);
  }
  const accountSession = newestAccountSession(jobs, job.sessionId);
  const mirrorDir = jobs.find((item) => item.sessionId === job.sessionId && item.sessionMirrorDir)?.sessionMirrorDir;
  const saved = { ...job, ...(mirrorDir ? { sessionMirrorDir: mirrorDir } : {}),
    ...(accountSession ? { accountSession } : {}) };
  return { ...saved, accountSession: accountState(saved) };
}

export function sessionFields(source) {
  return { sessionId: source?.sessionId ?? crypto.randomUUID(), sessionReady: Boolean(source),
    resumedFrom: source?.id ?? null };
}

export function lockSession({ jobsDir, job }) {
  if (!job.sessionId) return () => {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(job.sessionId)) {
    throw new Error("Invalid saved session identity.");
  }
  const lockPath = path.join(jobsDir, `${job.sessionId}.session-lock`);
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, jobId: job.id })); }
      finally { fs.closeSync(fd); }
      const unlock = () => {
        if (!fs.existsSync(lockPath)) return;
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (owner.token !== token) return;
        if (owner.backendPid) {
          try { process.kill(owner.backendPid, 0); return; }
          catch (error) { if (error.code !== "ESRCH") return; }
        }
        fs.unlinkSync(lockPath);
      };
      unlock.setBackendPid = (backendPid) => {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, backendPid, token, jobId: job.id }));
      };
      return unlock;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(lockPath, "utf8")); }
      catch { throw new Error("Session lock is unreadable; inspect it before resuming."); }
      try {
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid session lock owner.");
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if (error.code !== "ESRCH" || !owner.backendPid) throw error;
          process.kill(owner.backendPid, 0);
        }
      }
      catch (probe) {
        if (probe.code === "ESRCH") {
          const reclaim = `${lockPath}.reclaim`;
          let fd;
          try {
            fd = fs.openSync(reclaim, "wx");
            const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
            if (current.token === owner.token) fs.unlinkSync(lockPath);
          } catch (error) {
            if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error;
          } finally {
            if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(reclaim); }
          }
          continue;
        }
        throw probe;
      }
      throw new Error(`Session is already in use by job ${owner.jobId}. Retrieve that job before sending another message.`);
    }
  }
  throw new Error("Session could not be locked; retry retrieval before resuming.");
}
