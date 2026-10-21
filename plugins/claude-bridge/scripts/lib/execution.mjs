import fs from "node:fs";
import path from "node:path";
import { updateJobRecord, readJobRecord } from "./jobs.mjs";
import { lockSession } from "./sessions.mjs";
import { queueNotification, deliverPending } from "./host-delivery.mjs";

export function runStoredJob({ job, binary, paths, run, jobsDir = paths.jobsDir }) {
  const existing = readJobRecord({ jobsDir, jobId: job.id });
  if (["completed", "failed", "canceled"].includes(existing.status)) {
    return { exitCode: existing.status === "completed" ? 0 : 1,
      stdout: existing.outputFile && fs.existsSync(existing.outputFile) ? fs.readFileSync(existing.outputFile, "utf8") : "",
      stderr: existing.stderrTail ?? "",
    };
  }
  if (["running", "needs_input"].includes(existing.status)) {
    return { exitCode: 1, error: new Error("Job execution already started. Retrieve the saved job; it was not started again."), stdout: "", stderr: "" };
  }
  const outputFile = path.join(paths.outputDir, `${job.id}.txt`);
  const stderrFile = `${outputFile}.stderr`;
  const eventsFile = `${outputFile}.events.jsonl`;
  updateJobRecord({ jobsDir, jobId: job.id, patch: {
    status: "running", outputFile, stderrFile, eventsFile, ...(job.worker ? { pid: process.pid } : {}), startedAt: new Date().toISOString(),
  } });

  let unlock = () => {};
  let lastSaved = 0;
  const onProgress = (patch, force = false) => {
    if (patch.sessionId && job.sessionId && patch.sessionId !== job.sessionId) {
      throw new Error("Backend session identity changed unexpectedly; saved events are retained for inspection.");
    }
    if (patch.backendPid) unlock.setBackendPid?.(patch.backendPid);
    if (!force && Date.now() - lastSaved < 500 && !["init", "tool", "success"].includes(patch.activity)) return;
    updateJobRecord({ jobsDir, jobId: job.id, patch });
    lastSaved = Date.now();
  };
  let result;
  try {
    unlock = lockSession({ jobsDir, job });
    result = run({ binary, args: job.request.args, cwd: job.cwd, outputFile, stderrFile, eventsFile, onProgress, job, paths });
  } catch (error) { result = { exitCode: 1, error, stderr: "" }; }
  const finish = (result) => {
    try {
      if (!result.outputPersisted && result.stdout !== undefined) fs.writeFileSync(outputFile, result.stdout);
      if (!fs.existsSync(outputFile)) fs.writeFileSync(outputFile, "");
      if (result.exitCode === 0 && !fs.readFileSync(outputFile, "utf8").trim()) {
        result = { ...result, exitCode: 1, error: new Error(
          "Process exited successfully without a report. Inspect saved diagnostics before retrying; the request may already have consumed tokens."
        ) };
      }
    } catch (error) {
      result = { exitCode: 1, error,
        stdout: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "",
        stderr: "",
      };
    }

    const diagnostics = [result.stderr?.trim(), result.error?.message ?? result.error?.code ??
      (typeof result.error === "string" ? result.error : "")].filter(Boolean).join("\n");
    const current = readJobRecord({ jobsDir, jobId: job.id });
    if (current.status !== "canceled") {
      const completed = updateJobRecord({ jobsDir, jobId: job.id, patch: {
        status: result.exitCode === 0 ? "completed" : "failed",
        exitCode: result.exitCode, outputFile, stderrFile, pid: null, backendPid: null,
        stderrTail: diagnostics.slice(-2000), finishedAt: new Date().toISOString(),
      } });
      queueNotification({ jobsDir, job: completed, type: "completion", key: job.id,
        detail: { status: completed.status, diagnostics: completed.stderrTail } });
      void deliverPending({ jobsDir, job: completed }).catch(() => {});
    }
    return result;
  };
  if (result?.then) return result.then(finish, (error) => finish({ exitCode: 1, error })).finally(unlock);
  try { return finish(result); } finally { unlock(); }
}
