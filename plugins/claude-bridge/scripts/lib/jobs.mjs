import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function jobPath(jobsDir, jobId) {
  return path.join(jobsDir, `${jobId}.json`);
}

export function createJobRecord({ kind, cwd, summary, model, effort = null, request = {} }) {
  return {
    id: `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    kind,
    cwd,
    summary,
    model,
    effort,
    request,
    status: "queued",
    pid: null,
    outputFile: null,
    stderrTail: "",
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString()
  };
}

export function writeJobRecord({ jobsDir, job }) {
  fs.writeFileSync(jobPath(jobsDir, job.id), JSON.stringify(job, null, 2));
  return job;
}

export function readJobRecord({ jobsDir, jobId }) {
  return JSON.parse(fs.readFileSync(jobPath(jobsDir, jobId), "utf8"));
}

export function updateJobRecord({ jobsDir, jobId, patch }) {
  const current = readJobRecord({ jobsDir, jobId });
  const updated = { ...current, ...patch };
  writeJobRecord({ jobsDir, job: updated });
  return updated;
}

export function listJobRecords({ jobsDir }) {
  if (!fs.existsSync(jobsDir)) {
    return [];
  }

  return fs
    .readdirSync(jobsDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(jobsDir, entry), "utf8")))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function resolveJobRecord({ jobsDir, jobIdOrLatest }) {
  if (jobIdOrLatest === "latest") {
    const [latest] = listJobRecords({ jobsDir });
    if (!latest) {
      throw new Error("No job found for specifier latest");
    }
    return latest;
  }

  return readJobRecord({ jobsDir, jobId: jobIdOrLatest });
}
