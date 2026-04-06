import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import {
  checkClaudeAvailability as defaultCheckClaudeAvailability,
  checkClaudeReadiness as defaultCheckClaudeReadiness,
  runClaudeForeground as defaultRunClaudeForeground,
  spawnDetachedWorker as defaultSpawnDetachedWorker,
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
  return { cwd: resolvedCwd, paths, config, binary, deps };
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
  cwd, homeDir, model, effort, baseRef, focus, background, deps: injectedDeps,
} = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  const repository = deps.checkGitRepository({ cwd: ctx.cwd });
  if (!repository.valid) {
    return { error: repository.error };
  }

  ensureStateDirs(ctx.paths);

  const job = prepareReviewJob({
    cwd: ctx.cwd,
    paths: ctx.paths,
    config: ctx.config,
    requestedModel: model,
    requestedEffort: effort,
    baseRef: baseRef ?? null,
    focusText: focus ?? "",
    buildReviewInputImpl: deps.buildReviewInput,
  });

  job.request.binary = ctx.binary;
  enqueueReviewJob({ jobsDir: ctx.paths.jobsDir, job });

  if (background) {
    const child = deps.spawnDetachedWorker({
      nodeBinary: process.execPath,
      scriptPath: CLI_SCRIPT,
      workerArgs: ["worker", "--cwd", ctx.cwd, "--job-id", job.id],
      cwd: ctx.cwd,
    });
    updateJobRecord({
      jobsDir: ctx.paths.jobsDir,
      jobId: job.id,
      patch: { pid: child.pid },
    });
    return { jobId: job.id, status: "queued", background: true };
  }

  const result = runPreparedReviewJob({
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
  cwd, homeDir, model, effort, task, resume, background, deps: injectedDeps,
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

  const job = prepareDelegateJob({
    cwd: ctx.cwd,
    paths: ctx.paths,
    config: ctx.config,
    requestedModel: model,
    requestedEffort: effort,
    taskText: task,
    resumeSpecifier: resume ?? null,
  });

  job.request.binary = ctx.binary;
  enqueueDelegateJob({ jobsDir: ctx.paths.jobsDir, job });

  if (background) {
    const child = deps.spawnDetachedWorker({
      nodeBinary: process.execPath,
      scriptPath: CLI_SCRIPT,
      workerArgs: ["worker", "--cwd", ctx.cwd, "--job-id", job.id],
      cwd: ctx.cwd,
    });
    updateJobRecord({
      jobsDir: ctx.paths.jobsDir,
      jobId: job.id,
      patch: { pid: child.pid },
    });
    return { jobId: job.id, status: "queued", background: true };
  }

  const result = runPreparedDelegateJob({
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

export async function handleStatus({ cwd, homeDir, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  const repository = deps.checkGitRepository({ cwd: ctx.cwd });
  if (!repository.valid) {
    return { error: repository.error };
  }

  ensureStateDirs(ctx.paths);
  const jobs = listJobRecords({ jobsDir: ctx.paths.jobsDir });
  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      model: j.model,
      summary: j.summary,
      createdAt: j.createdAt,
    })),
  };
}

export async function handleResult({ cwd, homeDir, jobId, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  if (!jobId) {
    return { error: "result requires a job ID" };
  }

  let job;
  try {
    job = resolveJobRecord({ jobsDir: ctx.paths.jobsDir, jobIdOrLatest: jobId });
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { error: `No job found for "${jobId}"` };
    }
    throw err;
  }

  const output =
    job.outputFile && fs.existsSync(job.outputFile)
      ? fs.readFileSync(job.outputFile, "utf8")
      : "";

  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    model: job.model,
    summary: job.summary,
    output,
    ...(job.stderrTail ? { diagnostics: job.stderrTail } : {}),
  };
}

export async function handleCancel({ cwd, homeDir, jobId, deps: injectedDeps } = {}) {
  const deps = buildDeps(injectedDeps);
  const ctx = resolveContext({ cwd, homeDir, deps });

  if (!jobId) {
    return { error: "cancel requires a job ID" };
  }

  let job;
  try {
    job = resolveJobRecord({ jobsDir: ctx.paths.jobsDir, jobIdOrLatest: jobId });
  } catch (err) {
    if (err?.code === "ENOENT") {
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
    try {
      deps.killProcess(-Math.abs(job.pid), "SIGTERM");
    } catch (err) {
      if (err?.code !== "ESRCH") throw err;
    }
  }

  updateJobRecord({
    jobsDir: ctx.paths.jobsDir,
    jobId: job.id,
    patch: { status: "canceled", finishedAt: new Date().toISOString() },
  });

  return { id: job.id, status: "canceled" };
}
