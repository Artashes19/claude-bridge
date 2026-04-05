import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReviewClaudeArgs } from "./claude.mjs";
import { resolveEffort, resolveModel } from "./config.mjs";
import { buildReviewInput } from "./git.mjs";
import { createJobRecord, updateJobRecord, writeJobRecord } from "./jobs.mjs";
import { loadPrompt, buildReviewPrompt } from "./prompts.mjs";

const REVIEW_PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
  "review.md"
);

export function prepareReviewJob({
  cwd,
  paths,
  config,
  requestedModel,
  requestedEffort,
  baseRef,
  focusText,
  buildReviewInputImpl = buildReviewInput
}) {
  const reviewInput = buildReviewInputImpl({ cwd, baseRef });
  const template = loadPrompt(REVIEW_PROMPT_PATH);
  const prompt = buildReviewPrompt({
    template,
    target: reviewInput.target,
    focus: focusText,
    diff: reviewInput.diffText,
    status: reviewInput.statusText,
    diffStat: reviewInput.diffStatText
  });

  const model = resolveModel({ command: "review", requestedModel, config });
  const effort = resolveEffort({ requestedEffort, config });
  const args = buildReviewClaudeArgs({ model, effort, prompt });

  return createJobRecord({
    kind: "review",
    cwd,
    summary: baseRef ? `Review ${baseRef}...HEAD` : "Review working tree",
    model,
    effort,
    request: { binary: null, args, prompt }
  });
}

export function runPreparedReviewJob({
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

  fs.writeFileSync(outputFile, result.stdout);

  updateJobRecord({
    jobsDir,
    jobId: job.id,
    patch: {
      status: result.exitCode === 0 ? "completed" : "failed",
      outputFile,
      stderrTail: result.stderr.slice(-2000),
      finishedAt: new Date().toISOString()
    }
  });

  return result;
}

export function enqueueReviewJob({ jobsDir, job }) {
  writeJobRecord({ jobsDir, job });
  return job;
}
