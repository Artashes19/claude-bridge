import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { listJobRecords } from "./jobs.mjs";
import { accountState } from "./viewer-state.mjs";

export function sessionLabel(value, name, limit) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) || !value.trim() || value.trim().length > limit) {
    throw new Error(`${name} must be nonempty text of at most ${limit} characters without control characters.`);
  }
  return value.trim().replace(/\s+/gu, " ");
}

export const projectKey = (value) => value?.normalize("NFKC").toLowerCase() ?? null;

export function newestAccountSession(jobs, sessionId) {
  return jobs.filter((job) => job.sessionId === sessionId && job.accountSession?.sessionId)
    .sort((a, b) => (b.accountSession.connectedAt ?? b.createdAt).localeCompare(a.accountSession.connectedAt ?? a.createdAt))[0]?.accountSession;
}

export function conversationFields({ source, cwd, summary, config, project, title, shareSession }) {
  project = sessionLabel(project, "project", 120) ?? source?.project ?? null;
  title = sessionLabel(title, "title", 200) ?? source?.title ??
    `${project ?? path.basename(cwd)} · ${summary.split(/\r?\n/)[0].trim()}`.slice(0, 200);
  const savedPreference = source?.accountSession?.state === "disabled" ? false : source?.shareSession;
  shareSession = shareSession ?? savedPreference ?? config.runtime.shareSessions ?? false;
  if (typeof shareSession !== "boolean") throw new Error("shareSession must be a boolean.");
  return { project, title, shareSession, accountSession: {
    ...(source?.accountSession ?? {}), state: shareSession ? "pending" : "disabled",
  } };
}

export function registerSessionRepository(paths) {
  const directory = paths.sessionRegistryDir;
  if (!directory) return;
  const repoRoot = fs.realpathSync(paths.repoRoot);
  const name = crypto.createHash("sha256").update(repoRoot).digest("hex");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${name}.json`);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ repoRoot }), { mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function sessionCatalog({ paths, allRepositories = false, project, loadJobs = listJobRecords }) {
  project = sessionLabel(project, "project", 120);
  const roots = new Set([fs.realpathSync(paths.repoRoot)]);
  const warnings = [];
  if (allRepositories && paths.sessionRegistryDir && fs.existsSync(paths.sessionRegistryDir)) {
    for (const name of fs.readdirSync(paths.sessionRegistryDir).filter((entry) => entry.endsWith(".json"))) {
      try {
        const saved = JSON.parse(fs.readFileSync(path.join(paths.sessionRegistryDir, name), "utf8"));
        roots.add(fs.realpathSync(saved.repoRoot));
      } catch { warnings.push("A registered repository is unavailable or has unreadable metadata."); }
    }
  }
  const sessions = [];
  for (const repoRoot of roots) {
    const jobs = loadJobs({ jobsDir: path.join(repoRoot, ".claude-bridge", "jobs") });
    const latest = new Map();
    for (const job of jobs) {
      if (!job.sessionId || job.metadataError) continue;
      const previous = latest.get(job.sessionId);
      if (!previous || job.createdAt > previous.createdAt ||
          (job.createdAt === previous.createdAt && job.id > previous.id)) latest.set(job.sessionId, job);
    }
    for (const job of latest.values()) {
      if (project !== undefined && projectKey(job.project) !== projectKey(project)) continue;
      sessions.push({ project: job.project ?? null, title: job.title ?? job.summary?.slice(0, 200) ?? null,
        sessionId: job.sessionId, jobId: job.id, cwd: job.cwd, repoRoot, kind: job.kind,
        status: job.status, model: job.model, effort: job.effort, createdAt: job.createdAt,
        resumable: Boolean(job.sessionReady && ["completed", "failed", "canceled"].includes(job.status)),
        shareSession: Boolean(job.shareSession), accountSession: accountState({ ...job,
          accountSession: newestAccountSession(jobs, job.sessionId) ?? job.accountSession }, paths) });
    }
  }
  sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
  const projects = new Map();
  for (const session of sessions) {
    const key = projectKey(session.project);
    const group = projects.get(key) ?? { name: session.project, sessions: 0 };
    group.sessions++;
    projects.set(key, group);
  }
  return { projects: [...projects.values()], sessions, warnings,
    organizationScope: "bridge", nativeProjectCreated: false, desktopWorkspaceCreated: false, modelPromptSent: false };
}
