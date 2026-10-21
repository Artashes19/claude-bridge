import { resolveSession, sessionFields } from "./sessions.mjs";
import { conversationFields } from "./catalog.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStoredJob } from "./execution.mjs";

import { buildDelegateClaudeArgs, buildReviewClaudeArgs } from "./claude.mjs";
import { resolveBudget, resolveEffort, resolveModel } from "./config.mjs";
import { createJobRecord, writeJobRecord } from "./jobs.mjs";
import { loadPrompt, buildDelegatePrompt } from "./prompts.mjs";

const DELEGATE_PROMPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
  "delegate.md"
);

export function prepareDelegateJob({
  cwd,
  paths,
  config,
  requestedModel,
  requestedEffort,
  taskText,
  resumeSpecifier,
  maxBudgetUsd,
  project,
  title,
  shareSession,
  kind = "delegate"
}) {
  const template = loadPrompt(DELEGATE_PROMPT_PATH);
  const source = resolveSession({ jobsDir: paths.jobsDir, specifier: resumeSpecifier, cwd, project });
  const session = sessionFields(source);
  const prompt = kind === "discuss" || source ? taskText : buildDelegatePrompt({
    template,
    task: taskText,
    resumeContext: "New conversation."
  });

  const model = resolveModel({ command: "delegate", requestedModel: requestedModel ?? source?.model, config });
  const effort = resolveEffort({ requestedEffort: requestedEffort ?? source?.effort, config });
  const budget = resolveBudget(maxBudgetUsd ?? source?.maxBudgetUsd, config);
  const args = (kind === "discuss" ? buildReviewClaudeArgs : buildDelegateClaudeArgs)({
    model, effort, prompt, sessionId: session.sessionId, resumeSessionId: source?.sessionId, maxBudgetUsd: budget,
  });

  const job = createJobRecord({
    kind,
    cwd,
    summary: taskText,
    model,
    effort,
    request: { binary: null, args, prompt }
  });
  return Object.assign(job, session, conversationFields({ source, cwd, summary: taskText, config, project, title, shareSession }),
    { interactive: true, maxBudgetUsd: budget, settingsSource: {
    model: requestedModel ? "request" : source ? "session" : config.sources?.delegate ?? "built-in",
    effort: requestedEffort ? "request" : source ? "session" : config.sources?.effort ?? "built-in",
  } });
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
  return runStoredJob({ job, binary, paths, run: runClaudeForeground, jobsDir });
}
