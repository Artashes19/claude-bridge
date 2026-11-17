import { resolveSession, sessionFields } from "./sessions.mjs";
import { conversationFields } from "./catalog.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStoredJob } from "./execution.mjs";

import { buildDelegateClaudeArgs, buildReviewClaudeArgs } from "./claude.mjs";
import { resolveAutoCompactWindow, resolveBudget, resolveEffort, resolveModel } from "./config.mjs";
import { createJobRecord, writeJobRecord } from "./jobs.mjs";
import { loadPrompt, buildDelegatePrompt } from "./prompts.mjs";
import { executionPermissions, validatePermissionMode } from "./permissions.mjs";

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
  requestedPermissionMode,
  taskText,
  resumeSpecifier,
  maxBudgetUsd,
  project,
  title,
  shareSession,
  kind = "delegate"
}) {
  validatePermissionMode(requestedPermissionMode);
  if (kind !== "delegate" && requestedPermissionMode != null) {
    throw new Error("permissionMode is available only for delegation; discussions remain read-only.");
  }
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
  const autoCompactWindow = resolveAutoCompactWindow(config);
  const permissionMode = kind === "delegate" ? validatePermissionMode(requestedPermissionMode ?? source?.permissionMode) : null;
  const permissionSource = requestedPermissionMode != null ? "request" : "session";
  const permissions = executionPermissions({ kind, paths, requestedMode: permissionMode, source: permissionSource });
  const args = (kind === "discuss" ? buildReviewClaudeArgs : buildDelegateClaudeArgs)({
    model, effort, prompt, sessionId: session.sessionId, resumeSessionId: source?.sessionId, maxBudgetUsd: budget,
    permissionMode: permissions.mode, autoCompactWindow,
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
    { interactive: true, autoCompactWindow, maxBudgetUsd: budget, permissionMode, permissions, settingsSource: {
    model: requestedModel ? "request" : source ? "session" : config.sources?.delegate ?? "built-in",
    effort: requestedEffort ? "request" : source ? "session" : config.sources?.effort ?? "built-in",
    ...(permissionMode ? { permissionMode: permissionSource } : {}),
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
