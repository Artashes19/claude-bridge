import { sessionFields } from "./sessions.mjs";
import { conversationFields } from "./catalog.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStoredJob } from "./execution.mjs";

import { buildReviewClaudeArgs } from "./claude.mjs";
import { resolveBudget, resolveEffort, resolveModel } from "./config.mjs";
import { buildReviewInput } from "./git.mjs";
import { createJobRecord, writeJobRecord } from "./jobs.mjs";
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
  maxBudgetUsd,
  project,
  title,
  shareSession,
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
  const session = sessionFields(null);
  const budget = resolveBudget(maxBudgetUsd, config);
  const args = buildReviewClaudeArgs({ model, effort, prompt, sessionId: session.sessionId, maxBudgetUsd: budget });

  const job = createJobRecord({
    kind: "review",
    cwd,
    summary: baseRef ? `Review ${baseRef}...HEAD` : "Review working tree",
    model,
    effort,
    request: { binary: null, args, prompt }
  });
  return Object.assign(job, session, conversationFields({ cwd, summary: job.summary, config, project, title, shareSession }),
    { interactive: true, maxBudgetUsd: budget, settingsSource: {
    model: requestedModel ? "request" : config.sources?.review ?? "built-in",
    effort: requestedEffort ? "request" : config.sources?.effort ?? "built-in",
  } });
}

export function runPreparedReviewJob({
  job,
  binary,
  paths,
  runClaudeForeground,
  jobsDir = paths.jobsDir
}) {
  return runStoredJob({ job, binary, paths, run: runClaudeForeground, jobsDir });
}

export function enqueueReviewJob({ jobsDir, job }) {
  writeJobRecord({ jobsDir, job });
  return job;
}
