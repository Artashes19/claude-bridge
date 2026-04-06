import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDelegateClaudeArgs } from "./claude.mjs";
import { resolveEffort, resolveModel } from "./config.mjs";
import { createJobRecord, listJobRecords, updateJobRecord, writeJobRecord } from "./jobs.mjs";
import { loadPrompt, buildDelegatePrompt } from "./prompts.mjs";

const DELEGATE_PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
  "delegate.md"
);

function resolveResumeContext({ jobsDir, jobIdOrLatest }) {
  if (!jobIdOrLatest) {
    return "No prior run context.";
  }

  const isReadableCompletedDelegateJob = (job) =>
    job.kind === "delegate" &&
    job.status === "completed" &&
    Boolean(job.outputFile) &&
    fs.existsSync(job.outputFile);
  const jobTimestamp = (job) => {
    const value = Date.parse(job.finishedAt ?? job.createdAt ?? "");
    return Number.isNaN(value) ? 0 : value;
  };
  const readResumeOutput = (job, { explicitJobId = null } = {}) => {
    try {
      return fs.readFileSync(job.outputFile, "utf8").trim().slice(-2000);
    } catch (error) {
      if (explicitJobId) {
        throw new Error(`Cannot resume from job "${explicitJobId}": output file is not readable`);
      }
      return null;
    }
  };

  const jobs = listJobRecords({ jobsDir });

  if (jobIdOrLatest === "latest") {
    const candidates = jobs
      .filter(isReadableCompletedDelegateJob)
      .sort((left, right) => jobTimestamp(right) - jobTimestamp(left));

    for (const job of candidates) {
      const previousOutput = readResumeOutput(job);
      if (previousOutput !== null) {
        return previousOutput;
      }
    }

    return "No prior run context.";
  }

  const job = jobs.find((candidate) => candidate.id === jobIdOrLatest);

  if (!job) {
    throw new Error(`Cannot resume from job "${jobIdOrLatest}": job not found`);
  }

  if (job.kind !== "delegate") {
    throw new Error(`Cannot resume from job "${jobIdOrLatest}": only completed delegate jobs can be resumed`);
  }

  if (job.status !== "completed") {
    throw new Error(`Cannot resume from job "${jobIdOrLatest}": job is not completed`);
  }

  if (!job.outputFile || !fs.existsSync(job.outputFile)) {
    throw new Error(`Cannot resume from job "${jobIdOrLatest}": output file is not readable`);
  }

  return readResumeOutput(job, { explicitJobId: jobIdOrLatest });
}

export function prepareDelegateJob({
  cwd,
  paths,
  config,
  requestedModel,
  requestedEffort,
  taskText,
  resumeSpecifier
}) {
  const template = loadPrompt(DELEGATE_PROMPT_PATH);
  const resumeContext = resolveResumeContext({
    jobsDir: paths.jobsDir,
    jobIdOrLatest: resumeSpecifier
  });
  const prompt = buildDelegatePrompt({
    template,
    task: taskText,
    resumeContext
  });

  const model = resolveModel({ command: "delegate", requestedModel, config });
  const effort = resolveEffort({ requestedEffort, config });
  const args = buildDelegateClaudeArgs({ model, effort, prompt });

  return createJobRecord({
    kind: "delegate",
    cwd,
    summary: taskText,
    model,
    effort,
    request: { binary: null, args, prompt }
  });
}

export function enqueueDelegateJob({ jobsDir, job }) {
  writeJobRecord({ jobsDir, job });
  return job;
}

export function runPreparedDelegateJob({
  job,
  binary,
  paths,
  runClaudeForeground,
  jobsDir = paths.jobsDir
}) {
  const outputFile = path.join(paths.outputDir, `${job.id}.txt`);

  updateJobRecord({
    jobsDir,
    jobId: job.id,
    patch: { status: "running", startedAt: new Date().toISOString() }
  });

  const result = runClaudeForeground({
    binary,
    args: job.request.args,
    cwd: job.cwd
  });

  fs.writeFileSync(outputFile, result.stdout ?? "");

  updateJobRecord({
    jobsDir,
    jobId: job.id,
    patch: {
      status: result.exitCode === 0 ? "completed" : "failed",
      outputFile,
      pid: null,
      stderrTail: (result.stderr ?? "").slice(-2000),
      finishedAt: new Date().toISOString()
    }
  });

  return result;
}
