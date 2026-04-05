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

  const jobs = listJobRecords({ jobsDir }).filter(
    (job) => job.kind === "delegate" && job.outputFile && fs.existsSync(job.outputFile)
  );
  const job =
    jobIdOrLatest === "latest"
      ? jobs[0]
      : jobs.find((candidate) => candidate.id === jobIdOrLatest);

  if (!job) {
    return "No prior run context.";
  }

  const previousOutput = fs.readFileSync(job.outputFile, "utf8").trim();
  return previousOutput.slice(-2000);
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
      stderrTail: (result.stderr ?? "").slice(-2000),
      finishedAt: new Date().toISOString()
    }
  });

  return result;
}
