import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { markRetrieved, reportDelivery, acknowledgeReport } from "./delivery.mjs";
import { recoverJournal } from "./stream.mjs";
import { recoverLegacySessions } from "./session-recovery.mjs";
import { interactionState, submitAnswer, submitSteering } from "./interaction.mjs";
import { resolveHostDelivery, watchDeliveryJob } from "./host-delivery.mjs";
import { readPlanUsage, cachedPlanUsage, costMetadata, modelUsageMetadata } from "./usage.mjs";
import { conversationFields, registerSessionRepository, sessionCatalog, sessionLabel } from "./catalog.mjs";
import { resolveSession } from "./sessions.mjs";
import { shareSavedSession } from "./visibility.mjs";
import { accountState } from "./viewer-state.mjs";
import { fileURLToPath } from "node:url";

import {
  checkClaudeAvailability as defaultCheckClaudeAvailability,
  checkClaudeReadiness as defaultCheckClaudeReadiness,
  runClaudeForeground as defaultRunClaudeForeground,
  spawnDetachedWorker as defaultSpawnDetachedWorker,
  readFileTail,
} from "./claude.mjs";
import {
  loadMergedConfig,
  resolveClaudeBinary,
  resolveEffort,
  resolveModel,
} from "./config.mjs";
import { buildReviewInput as defaultBuildReviewInput } from "./git.mjs";
import {
  listJobRecords,
  claimJobRecord,
  readJobRecord,
  resolveJobRecord,
  updateJobRecord,
} from "./jobs.mjs";
import {
  checkGitRepository as defaultCheckGitRepository,
  resolvePaths,
  ensureStateDirs,
} from "./paths.mjs";
import {
  enqueueDelegateJob,
  prepareDelegateJob,
  runPreparedDelegateJob,
} from "./delegate.mjs";
import {
  enqueueReviewJob,
  prepareReviewJob,
  runPreparedReviewJob,
} from "./review.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT = path.resolve(SCRIPT_DIR, "..", "claude-bridge.mjs");

function isTerminalJobStatus(status) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function intentKey(ctx, options) {
  return crypto.createHash("sha256").update(JSON.stringify({ cwd: fs.realpathSync(ctx.cwd), ...options })).digest("hex");
}

function recoverIntentSubmission({ ctx, deps, requestId, key }) {
  if (!requestId) return null;
  const record = listJobRecords({ jobsDir: ctx.paths.jobsDir }).find((job) => job.request?.requestId === requestId);
  if (!record?.request?.intentKey) return null;
  if (record.request.intentKey !== key) return { jobId: record.id,
    error: "This requestId belongs to a different request. Retrieve the existing job or use a new requestId." };
  const existing = reconcileWorker(record, ctx, deps);
  return { jobId: existing.id, status: existing.status, reused: true, background: !isTerminalJobStatus(existing.status) };
}

export function reconcileWorker(job, ctx, deps) {
  if (isTerminalJobStatus(job.status)) return job;
  let workerPid = job.pid;
  if (!workerPid && job.workerPidFile && fs.existsSync(job.workerPidFile)) {
    const saved = Number(fs.readFileSync(job.workerPidFile, "utf8"));
    if (Number.isSafeInteger(saved) && saved > 0) workerPid = saved;
  }
  if (!workerPid) return job;
  try {
    deps.killProcess(workerPid, 0);
    return { ...job, pid: workerPid };
  } catch (error) {
    if (error?.code !== "ESRCH") return job;
  }
  if (job.backendPid) {
    try {
      deps.killProcess(job.backendPid, 0);
      return { ...job, activity: "Worker exited; backend still running", pid: workerPid };
    } catch (error) { if (error.code !== "ESRCH") return job; }
  }
  const latest = readJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id });
  if (isTerminalJobStatus(latest.status)) return latest;
  let recovered = {};
  let recoveredSuccess = false;
  if (latest.eventsFile && fs.existsSync(latest.eventsFile) && latest.outputFile) {
    const state = recoverJournal(latest);
    recovered = state.progress;
    recoveredSuccess = state.terminal?.subtype === "success" && !state.terminal.is_error && !state.parseErrors &&
      fs.existsSync(latest.outputFile) && fs.statSync(latest.outputFile).size > 0;
  }
  let workerLog = "";
  if (latest.workerLogFile && fs.existsSync(latest.workerLogFile)) workerLog = readFileTail(latest.workerLogFile);
  return updateJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id, patch: {
    ...recovered, status: recoveredSuccess ? "completed" : "failed", ...(recoveredSuccess ? { exitCode: 0 } : {}),
    pid: null, backendPid: null, finishedAt: new Date().toISOString(),
    stderrTail: recoveredSuccess ? "Completion recovered from saved events without another execution." :
      `${workerLog}\nWorker exited before recording completion. Saved output is retained; inspect it before submitting another paid request.`.trim().slice(-2000),
  } });
}

function reuseSubmission({ ctx, deps, job, requestId, input }) {
  const key = crypto.createHash("sha256").update(JSON.stringify({
    kind: job.kind, cwd: fs.realpathSync(job.cwd), model: job.model, effort: job.effort,
    project: job.project, title: job.title, shareSession: job.shareSession,
    ...(job.hostDelivery ? { deliveryThreadId: job.hostDelivery.threadId } : {}), ...input,
  })).digest("hex");
  job.request.submissionKey = key;
  job.request.requestId = requestId ?? null;
  if (requestId) job.id = `request-${crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
  const records = listJobRecords({ jobsDir: ctx.paths.jobsDir });
  for (const record of records) {
    const sameId = requestId && record.request?.requestId === requestId;
    if (sameId && record.request.submissionKey !== key) {
      return { error: "This requestId belongs to a different request. Retrieve the existing job or use a new requestId.", jobId: record.id };
    }
    if (sameId || (!requestId && !isTerminalJobStatus(record.status) && record.request?.submissionKey === key)) {
      const existing = reconcileWorker(record, ctx, deps);
      return { jobId: existing.id, status: existing.status, reused: true, background: !isTerminalJobStatus(existing.status) };
    }
  }
  return null;
}

function enqueueSubmission({ ctx, job, requestId, enqueue }) {
  if (!requestId) {
    enqueue({ jobsDir: ctx.paths.jobsDir, job });
    return null;
  }
  if (claimJobRecord({ jobsDir: ctx.paths.jobsDir, job })) return null;
  const existing = readJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id });
  if (existing.request?.submissionKey !== job.request.submissionKey) {
    return { jobId: existing.id, error: "This requestId belongs to a different request. Retrieve the existing job or use a new requestId." };
  }
  return { jobId: existing.id, status: existing.status, reused: true, background: !isTerminalJobStatus(existing.status) };
}

async function spawnBackgroundWorker({ deps, ctx, job }) {
  const workerLogFile = path.join(ctx.paths.outputDir, `${job.id}.worker.stderr`);
  const workerPidFile = path.join(ctx.paths.outputDir, `${job.id}.worker.pid`);
  updateJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id, patch: { workerLogFile, workerPidFile } });
  let child;
  try {
    child = await deps.spawnDetachedWorker({
      nodeBinary: process.execPath,
      scriptPath: CLI_SCRIPT,
      workerArgs: ["worker", "--cwd", ctx.cwd, "--job-id", job.id],
      cwd: ctx.cwd,
      logFile: workerLogFile,
    });
  } catch (err) {
    updateJobRecord({
      jobsDir: ctx.paths.jobsDir,
      jobId: job.id,
      patch: {
        status: "failed",
        pid: null,
        stderrTail: (err?.message ?? String(err)).slice(-2000),
        finishedAt: new Date().toISOString(),
      },
    });
    return { jobId: job.id, status: "failed", error: err.message };
  }

  fs.writeFileSync(workerPidFile, String(child.pid));
  const current = readJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id });

  return { jobId: job.id, status: current.status, background: true };
}

export async function handleTaskRequest(submit, options = {}, { waitMs = 10000, pollMs = 250 } = {}) {
  let submitted;
  try { submitted = await submit({ ...options, background: true }); }
  catch (error) { return { error: error.message }; }
  if (submitted.error || !submitted.jobId) return submitted;
  const deadline = Date.now() + (options.background ? 0 : waitMs);
  let result;
  do {
    result = await handleResult({ ...options, jobId: submitted.jobId });
    if (isTerminalJobStatus(result.status) || result.status === "needs_input" || result.error) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  } while (true);
  return {
    ...result,
    jobId: submitted.jobId,
    reused: Boolean(submitted.reused),
    background: !isTerminalJobStatus(result.status),
    ...(isTerminalJobStatus(result.status) ? {} : {
      nextAction: result.nextAction ?? "Call bridge_result with this jobId and the same cwd until terminal status, then retrieve all output pages before responding.",
    }),
  };
}

function buildDeps(injected = {}) {
  return {
    checkGitRepository: injected.checkGitRepository ?? defaultCheckGitRepository,
    checkClaudeAvailability: injected.checkClaudeAvailability ?? defaultCheckClaudeAvailability,
    checkClaudeReadiness: injected.checkClaudeReadiness ?? defaultCheckClaudeReadiness,
    runClaudeForeground: injected.runClaudeForeground ?? defaultRunClaudeForeground,
    spawnDetachedWorker: injected.spawnDetachedWorker ?? defaultSpawnDetachedWorker,
    buildReviewInput: injected.buildReviewInput ?? defaultBuildReviewInput,
    killProcess: injected.killProcess ?? process.kill.bind(process),
    sleep: injected.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

function resolveContext({ cwd, homeDir, deps }) {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const resolvedHome = homeDir || os.homedir();
  const paths = resolvePaths({ cwd: resolvedCwd, homeDir: resolvedHome });
  const config = loadMergedConfig({
    repoConfigPath: paths.repoConfigPath,
    globalConfigPath: paths.globalConfigPath,
  });
  const binary = resolveClaudeBinary({ config });
  return { cwd: resolvedCwd, homeDir: resolvedHome, paths, config, binary, deps };
}

export async function handleSetup({ cwd, homeDir, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  const repository = deps.checkGitRepository({ cwd: ctx.cwd });
  if (!repository.valid) {
    const availability = deps.checkClaudeAvailability({ binary: ctx.binary });
    return {
      ready: false,
      binary: ctx.binary,
      version: availability.version || "",
      stateDir: ctx.paths.repoStateDir,
      error: availability.error
        ? `${repository.error}; ${availability.error}`
        : repository.error,
    };
  }

  ensureStateDirs(ctx.paths);
  const readiness = deps.checkClaudeReadiness({
    binary: ctx.binary,
    model: resolveModel({ command: "review", config: ctx.config }),
    effort: resolveEffort({ config: ctx.config }),
    cwd: ctx.cwd,
    checkClaudeAvailability: deps.checkClaudeAvailability,
    runClaudeForeground: deps.runClaudeForeground,
  });

  return {
    ready: readiness.ready,
    binary: ctx.binary,
    version: readiness.version,
    stateDir: ctx.paths.repoStateDir,
    ...(readiness.error ? { error: readiness.error } : {}),
  };
}

export async function handleReview({
  cwd, homeDir, model, effort, baseRef, focus, background, requestId, maxBudgetUsd, deliveryThreadId, deliveryEndpoint,
  project, title, shareSession, deps: injectedDeps,
} = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  const repository = deps.checkGitRepository({ cwd: ctx.cwd });
  if (!repository.valid) {
    return { error: repository.error };
  }

  ensureStateDirs(ctx.paths);

  const key = intentKey(ctx, { kind: "review", model: model ?? null, effort: effort ?? null, baseRef: baseRef ?? null,
    focus: focus ?? "", maxBudgetUsd: maxBudgetUsd ?? null, deliveryThreadId: deliveryThreadId ?? null,
    project: sessionLabel(project, "project", 120) ?? null, title: sessionLabel(title, "title", 200) ?? null,
    shareSession: shareSession ?? null });
  const retry = recoverIntentSubmission({ ctx, deps, requestId, key });
  if (retry) return retry;

  const job = prepareReviewJob({
    cwd: ctx.cwd,
    paths: ctx.paths,
    config: ctx.config,
    requestedModel: model,
    requestedEffort: effort,
    maxBudgetUsd,
    project, title, shareSession,
    baseRef: baseRef ?? null,
    focusText: focus ?? "",
    buildReviewInputImpl: deps.buildReviewInput,
  });

  job.request.binary = ctx.binary;
  job.request.intentKey = key;
  job.hostDelivery = resolveHostDelivery(deliveryThreadId, deliveryEndpoint);
  if (job.hostDelivery) job.hostDelivery.registryDir = path.join(homeDir || os.homedir(), ".claude-bridge", "delivery");
  const reused = reuseSubmission({ ctx, deps, job, requestId, input: { baseRef: baseRef ?? null, focus: focus ?? "", maxBudgetUsd: job.maxBudgetUsd } });
  if (reused) return reused;
  registerSessionRepository(ctx.paths);
  const claimed = enqueueSubmission({ ctx, job, requestId, enqueue: enqueueReviewJob });
  if (claimed) return claimed;
  watchDeliveryJob({ jobsDir: ctx.paths.jobsDir, job });

  if (background) {
    return spawnBackgroundWorker({ deps, ctx, job });
  }

  const result = await runPreparedReviewJob({
    job,
    binary: ctx.binary,
    paths: ctx.paths,
    runClaudeForeground: deps.runClaudeForeground,
  });

  if (result.exitCode !== 0) {
    const errText = (result.stderr || result.stdout || "unknown error").trim();
    return { jobId: job.id, status: "failed", error: errText };
  }

  return { jobId: job.id, status: "completed", output: result.stdout };
}

export async function handleDelegate({
  cwd, homeDir, model, effort, task, resume, background, requestId, maxBudgetUsd, deliveryThreadId, deliveryEndpoint,
  project, title, shareSession, kind = "delegate", deps: injectedDeps,
} = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  const repository = deps.checkGitRepository({ cwd: ctx.cwd });
  if (!repository.valid) {
    return { error: repository.error };
  }

  if (!task || task.trim() === "") {
    return { error: "delegate requires a task description" };
  }

  ensureStateDirs(ctx.paths);

  const key = intentKey(ctx, { kind, task, resume: resume ?? null, model: model ?? null, effort: effort ?? null,
    maxBudgetUsd: maxBudgetUsd ?? null, deliveryThreadId: deliveryThreadId ?? null,
    project: sessionLabel(project, "project", 120) ?? null, title: sessionLabel(title, "title", 200) ?? null,
    shareSession: shareSession ?? null });
  const retry = recoverIntentSubmission({ ctx, deps, requestId, key });
  if (retry) return retry;

  const job = prepareDelegateJob({
    cwd: ctx.cwd,
    paths: ctx.paths,
    config: ctx.config,
    requestedModel: model,
    requestedEffort: effort,
    maxBudgetUsd, kind,
    project, title, shareSession,
    taskText: task,
    resumeSpecifier: resume ?? null,
  });

  job.request.binary = ctx.binary;
  job.request.intentKey = key;
  job.hostDelivery = resolveHostDelivery(deliveryThreadId, deliveryEndpoint);
  if (job.hostDelivery) job.hostDelivery.registryDir = path.join(homeDir || os.homedir(), ".claude-bridge", "delivery");
  const reused = reuseSubmission({ ctx, deps, job, requestId, input: { task, resume: resume ?? null, maxBudgetUsd: job.maxBudgetUsd } });
  if (reused) return reused;
  registerSessionRepository(ctx.paths);
  const claimed = enqueueSubmission({ ctx, job, requestId, enqueue: enqueueDelegateJob });
  if (claimed) return claimed;
  watchDeliveryJob({ jobsDir: ctx.paths.jobsDir, job });

  if (background) {
    return spawnBackgroundWorker({ deps, ctx, job });
  }

  const result = await runPreparedDelegateJob({
    job,
    binary: ctx.binary,
    paths: ctx.paths,
    runClaudeForeground: deps.runClaudeForeground,
  });

  if (result.exitCode !== 0) {
    const errText = (result.stderr || result.stdout || "unknown error").trim();
    return { jobId: job.id, status: "failed", error: errText };
  }

  return { jobId: job.id, status: "completed", output: result.stdout };
}

export async function handleUsage({ cwd, homeDir, refresh = false, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });
  return (injectedDeps?.readPlanUsage ?? readPlanUsage)({ binary: ctx.binary, cwd: ctx.cwd, homeDir: ctx.homeDir, refresh });
}

export async function handleSessions({ cwd, homeDir, project, allRepositories = false, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });
  return sessionCatalog({ paths: ctx.paths, project, allRepositories,
    loadJobs: ({ jobsDir }) => listJobRecords({ jobsDir }).map((job) =>
      reconcileWorker(job, { ...ctx, paths: { ...ctx.paths, jobsDir } }, deps)),
  });
}

export async function handleShare({ cwd, homeDir, jobId, project, title, enabled = true, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });
  try {
    if (!jobId) throw new Error("Sharing requires a saved job ID or latest.");
    const source = resolveSession({ jobsDir: ctx.paths.jobsDir, specifier: jobId, cwd: ctx.cwd });
    const fields = conversationFields({ source, cwd: ctx.cwd, summary: source.summary, config: ctx.config,
      project, title, shareSession: enabled });
    const job = { ...source, ...fields };
    registerSessionRepository(ctx.paths);
    const result = await (injectedDeps?.shareSavedSession ?? shareSavedSession)({ job, paths: ctx.paths, enabled,
      onProgress: (patch) => updateJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id, patch: { ...fields, ...patch } }),
    });
    return { jobId: job.id, sessionId: job.sessionId, project: job.project, title: job.title, ...result };
  } catch (error) { return { error: error.message, modelPromptSent: false }; }
}

export async function handleStatus({ cwd, homeDir, recoverSessions = false, includeCostEstimates = false, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  const repository = deps.checkGitRepository({ cwd: ctx.cwd });
  if (!repository.valid) {
    return { error: repository.error };
  }

  ensureStateDirs(ctx.paths);
  const sessionRecovery = recoverSessions ? recoverLegacySessions({ jobsDir: ctx.paths.jobsDir,
    ...(ctx.config.runtime.sessionProjectsDir ? { projectsDir: ctx.config.runtime.sessionProjectsDir } : {}),
  }) : null;
  const jobs = listJobRecords({ jobsDir: ctx.paths.jobsDir }).map((job) => reconcileWorker(job, ctx, deps));
  return {
    runtime: { version: "0.6.0", pid: process.pid },
    planUsage: cachedPlanUsage(ctx),
    ...(sessionRecovery ? { sessionRecovery } : {}),
    pendingReports: jobs.filter((j) => isTerminalJobStatus(j.status) && j.outputFile &&
      fs.existsSync(j.outputFile) && fs.statSync(j.outputFile).size > 0 && !reportDelivery(ctx.paths.jobsDir, j).acknowledged).map((j) => j.id),
    jobs: jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      model: j.model,
      effort: j.effort,
      actualModel: j.actualModel ?? null,
      settingsSource: j.settingsSource ?? null,
      sessionId: j.sessionId ?? null,
      project: j.project ?? null,
      title: j.title ?? null,
      nativeTitleState: j.nativeTitleState ?? null,
      shareSession: Boolean(j.shareSession),
      accountSession: accountState(j, ctx.paths),
      resumable: Boolean(j.sessionReady && isTerminalJobStatus(j.status)),
      activity: j.activity ?? null,
      lastActivityAt: j.lastActivityAt ?? null,
      usage: j.usage ?? null,
      ...costMetadata(j, includeCostEstimates),
      interactive: Boolean(j.interactive),
      interaction: interactionState(ctx.paths.jobsDir, j.id),
      completionDelivery: j.hostDelivery ? { threadId: j.hostDelivery.threadId, enabled: true } : { enabled: false },
      delivery: reportDelivery(ctx.paths.jobsDir, j),
      ...(j.metadataError ? { metadataError: j.metadataError } : {}),
      summary: j.summary?.slice(0, 240),
      requestId: j.request?.requestId ?? null,
      outputFile: j.outputFile,
      createdAt: j.createdAt,
    })),
  };
}

export async function handleResult({ cwd, homeDir, jobId, offset = 0, maxBytes = 12000, waitSeconds = 0, acknowledge = false, includeCostEstimates = false, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  if (!jobId) {
    return { error: "result requires a job ID" };
  }
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 65536 ||
      !Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) {
    return { error: "Invalid retrieval limits: offset >= 0, maxBytes 4..65536, waitSeconds 0..30." };
  }

  let job;
  try {
    job = resolveJobRecord({ jobsDir: ctx.paths.jobsDir, jobIdOrLatest: jobId });
  } catch (err) {
    if (err?.code === "ENOENT" || err?.message?.startsWith("No job found")) {
      return { error: `No job found for "${jobId}"` };
    }
    return { error: `Cannot read saved job metadata: ${err.message}. No new execution was started.` };
  }

  const deadline = Date.now() + waitSeconds * 1000;
  while (true) {
    job = reconcileWorker(job, ctx, deps);
    if (isTerminalJobStatus(job.status) || job.status === "needs_input" || Date.now() >= deadline) break;
    await deps.sleep(Math.min(250, deadline - Date.now()));
    job = readJobRecord({ jobsDir: ctx.paths.jobsDir, jobId: job.id });
  }

  let output = "";
  if (isTerminalJobStatus(job.status) && job.outputFile && !fs.existsSync(job.outputFile) &&
      job.eventsFile && fs.existsSync(job.eventsFile)) recoverJournal(job);
  let outputBytes = 0;
  let nextOffset = offset;
  const outputAvailable = Boolean(job.outputFile && fs.existsSync(job.outputFile));
  if (outputAvailable) {
    const descriptor = fs.openSync(job.outputFile, "r");
    try {
      outputBytes = fs.fstatSync(descriptor).size;
      const buffer = Buffer.alloc(Math.min(maxBytes + 4, Math.max(0, outputBytes - offset)));
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      let end = Math.min(maxBytes, bytes);
      if (offset + end < outputBytes) {
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      }
      output = buffer.subarray(0, end).toString("utf8");
      nextOffset += end;
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const hasMore = nextOffset < outputBytes;
  if (isTerminalJobStatus(job.status)) markRetrieved(ctx.paths.jobsDir, job.id, offset, nextOffset);
  if (acknowledge) {
    try { acknowledgeReport(ctx.paths.jobsDir, job); }
    catch (error) { return { id: job.id, error: error.message }; }
  }

  const diagnostics = job.stderrTail ||
    (job.stderrFile && fs.existsSync(job.stderrFile) ? readFileTail(job.stderrFile) : "");
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    model: job.model,
    effort: job.effort,
    actualModel: job.actualModel ?? null,
    settingsSource: job.settingsSource ?? null,
    sessionId: job.sessionId ?? null,
    project: job.project ?? null,
    title: job.title ?? null,
    nativeTitleState: job.nativeTitleState ?? null,
    shareSession: Boolean(job.shareSession),
    accountSession: accountState(job, ctx.paths),
    resumable: Boolean(job.sessionReady && isTerminalJobStatus(job.status)),
    resumedFrom: job.resumedFrom ?? null,
    activity: job.activity ?? null,
    lastActivityAt: job.lastActivityAt ?? null,
    eventCount: job.eventCount ?? 0,
    retry: job.retry ?? null,
    planUsage: cachedPlanUsage(ctx),
    usage: job.usage ?? null,
    latestMessageUsage: job.latestMessageUsage ?? null,
    modelUsage: modelUsageMetadata(job.modelUsage, includeCostEstimates),
    ...costMetadata(job, includeCostEstimates),
    maxBudgetUsd: job.maxBudgetUsd ?? null,
    interactive: Boolean(job.interactive),
    interaction: interactionState(ctx.paths.jobsDir, job.id),
    completionDelivery: job.hostDelivery ? { threadId: job.hostDelivery.threadId, enabled: true } : { enabled: false },
    durationMs: job.durationMs ?? null,
    elapsedSeconds: job.startedAt ? Math.max(0, (Date.parse(job.finishedAt ?? new Date().toISOString()) - Date.parse(job.startedAt)) / 1000) : 0,
    permissionDenials: job.permissionDenials ?? [],
    eventsFile: job.eventsFile ?? null,
    delivery: reportDelivery(ctx.paths.jobsDir, job),
    summary: job.summary?.slice(0, 240),
    requestId: job.request?.requestId ?? null,
    output,
    offset, nextOffset, outputBytes, hasMore, outputAvailable,
    reportReady: job.status === "completed" && outputAvailable,
    outputFile: job.outputFile,
    ...(job.status === "needs_input" ? {
      nextAction: "Read interaction.questions and answer from your context and evidence with bridge_answer(jobId, questionId, answers). Use each question's exact text as its answers key. Ask the user only if their decision is required. Then retrieve this same job; no new paid run is needed.",
    } : !isTerminalJobStatus(job.status) ? {
      nextAction: "Wait with bridge_result(waitSeconds: 30) using the same jobId and cwd. Once terminal, read from offset 0 and follow nextOffset while hasMore is true. Retrieve saved output instead of submitting the task again.",
    } : hasMore ? {
      nextAction: `Read bridge_result with offset ${nextOffset}, the same jobId and cwd; concatenate all pages until hasMore is false.`,
    } : {}),
    ...(job.status === "completed" && !outputAvailable ? {
      error: "The job completed but its report file is missing. Inspect the saved job metadata and diagnostics before submitting another paid request.",
    } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export async function handleAnswer({ cwd, homeDir, jobId, questionId, answers, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });
  try {
    const job = reconcileWorker(resolveJobRecord({ jobsDir: ctx.paths.jobsDir, jobIdOrLatest: jobId }), ctx, deps);
    if (!job.interactive) throw new Error("This older job does not support live answers.");
    return { jobId: job.id, ...submitAnswer({ jobsDir: ctx.paths.jobsDir, jobId: job.id, questionId, answers, allowNew: !isTerminalJobStatus(job.status) }),
      nextAction: "Retrieve this same job with bridge_result; the answer continues its paused execution." };
  } catch (error) { return { error: error.message }; }
}

export async function handleSteer({ cwd, homeDir, jobId, message, requestId, interrupt = false, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });
  try {
    const job = reconcileWorker(resolveJobRecord({ jobsDir: ctx.paths.jobsDir, jobIdOrLatest: jobId }), ctx, deps);
    if (!job.interactive) throw new Error("This older job does not support live steering.");
    return { jobId: job.id, ...submitSteering({ jobsDir: ctx.paths.jobsDir, jobId: job.id, message, requestId, interrupt, allowNew: !isTerminalJobStatus(job.status) }),
      nextAction: "Inspect interaction.steering and the resulting answer in bridge_result. Dispatched means added to the session input queue; incorporation is unconfirmed. Important corrections need interruption while active or an explicit resumed follow-up after completion, followed by checking the answer. Reuse the original requestId for retries." };
  } catch (error) { return { error: error.message }; }
}

export async function handleCancel({ cwd, homeDir, jobId, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  if (!jobId) {
    return { error: "cancel requires a job ID" };
  }

  let job;
  try {
    job = reconcileWorker(resolveJobRecord({ jobsDir: ctx.paths.jobsDir, jobIdOrLatest: jobId }), ctx, deps);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.message?.startsWith("No job found")) {
      return { error: `No job found for "${jobId}"` };
    }
    throw err;
  }

  const terminal =
    job.status === "completed" || job.status === "failed" || job.status === "canceled";
  if (terminal) {
    return { id: job.id, status: job.status, message: "Job already in terminal state" };
  }

  if (job.pid) {
    const pgid = -Math.abs(job.pid);
    try {
      deps.killProcess(pgid, "SIGTERM");
    } catch (err) {
      if (err?.code !== "ESRCH") throw err;
    }

    // Wait for process group to exit (up to 2s), matching CLI behavior
    const deadline = Date.now() + 2000;
    let exited = false;
    while (Date.now() < deadline) {
      try {
        deps.killProcess(pgid, 0);
      } catch (err) {
        if (err?.code === "ESRCH") {
          exited = true;
          break;
        }
        throw err;
      }
      await deps.sleep(100);
    }

    if (!exited) {
      return { error: `Failed to confirm cancellation for ${Math.abs(job.pid)} within 2000ms` };
    }
  }

  updateJobRecord({
    jobsDir: ctx.paths.jobsDir,
    jobId: job.id,
    patch: { status: "canceled", finishedAt: new Date().toISOString() },
  });

  return { id: job.id, status: "canceled" };
}
