import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkClaudeAvailability,
  checkClaudeReadiness,
  runClaudeForeground as defaultRunClaudeForeground,
  spawnDetachedWorker as defaultSpawnDetachedWorker
} from "./lib/claude.mjs";
import {
  loadMergedConfig,
  resolveClaudeBinary,
  resolveEffort,
  resolveModel
} from "./lib/config.mjs";
import { buildReviewInput as defaultBuildReviewInput } from "./lib/git.mjs";
import { listJobRecords, readJobRecord, resolveJobRecord, updateJobRecord } from "./lib/jobs.mjs";
import { checkGitRepository, resolvePaths, ensureStateDirs } from "./lib/paths.mjs";
import { readPlanUsage } from "./lib/usage.mjs";
import { registerSessionRepository } from "./lib/catalog.mjs";
import { handleSessions as listSessions, handleShare as shareSession } from "./lib/mcp-handlers.mjs";
import {
  enqueueDelegateJob,
  prepareDelegateJob,
  runPreparedDelegateJob
} from "./lib/delegate.mjs";
import {
  enqueueReviewJob,
  prepareReviewJob,
  runPreparedReviewJob
} from "./lib/review.mjs";
import {
  renderResultReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_CANCEL_TIMEOUT_MS = 2000;
const DEFAULT_CANCEL_POLL_INTERVAL_MS = 100;

function isTerminalJobStatus(status) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positionals = [];
  const booleanFlags = new Set(["background", "share-session", "no-share-session", "all-repositories"]);

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (booleanFlags.has(key) || !next || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      positionals.push(value);
    }
  }

  return { command, options, positionals };
}

function conversationOptions(options) {
  if (options["share-session"] && options["no-share-session"]) throw new Error("Choose one session sharing preference.");
  return { project: options.project, title: options.title,
    shareSession: options["share-session"] ? true : options["no-share-session"] ? false : undefined };
}

function writeLine(stdio, text) {
  stdio.stdout.write(`${text}\n`);
}

function readJobOutput(job) {
  if (!job.outputFile || !fs.existsSync(job.outputFile)) {
    return "";
  }
  return fs.readFileSync(job.outputFile, "utf8");
}

function resolveJobOrThrow({ paths, jobId }) {
  try {
    return resolveJobRecord({ jobsDir: paths.jobsDir, jobIdOrLatest: jobId });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`No job found for "${jobId}"`);
    }
    throw error;
  }
}

function requireStringOption(options, key, command) {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${command} requires --${key}`);
  }
  return value;
}

function requireTaskDescription(positionals) {
  const taskText = positionals.join(" ").trim();
  if (!taskText) {
    throw new Error("delegate requires a task description");
  }
  return taskText;
}

function formatClaudeFailure(result) {
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    return stderr;
  }

  const stdout = (result.stdout ?? "").trim();
  if (stdout) {
    return stdout;
  }

  const errorMessage = (
    result.error?.message ??
    result.error?.code ??
    (typeof result.error === "string" ? result.error : "")
  ).trim();
  if (errorMessage) {
    return errorMessage;
  }

  return `Claude command failed with exit code ${result.exitCode ?? "unknown"}`;
}

function ensureRepositoryOrThrow({ cwd, deps }) {
  const repository = deps.checkGitRepository({ cwd });
  if (!repository.valid) {
    throw new Error(repository.error);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessGroupExit({
  pid,
  killProcess,
  sleep,
  timeoutMs,
  pollIntervalMs
}) {
  const processGroupId = -Math.abs(pid);

  try {
    killProcess(processGroupId, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      return;
    }
    throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      killProcess(processGroupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Failed to confirm cancellation for ${Math.abs(pid)} within ${timeoutMs}ms`);
    }

    await sleep(pollIntervalMs);
  }
}

async function handleSetup({ paths, stdio, deps, binary, config, cwd }) {
  const repository = deps.checkGitRepository({ cwd });
  if (!repository.valid) {
    const availability = deps.checkClaudeAvailability({ binary });
    const combinedError = availability.error
      ? `${repository.error}; ${availability.error}`
      : repository.error;

    writeLine(
      stdio,
      renderSetupReport({
        ready: false,
        binary,
        version: availability.version,
        repoStateDir: paths.repoStateDir,
        error: combinedError
      })
    );
    return;
  }

  ensureStateDirs(paths);
  const readiness = deps.checkClaudeReadiness({
    binary,
    model: resolveModel({ command: "review", config }),
    effort: resolveEffort({ config }),
    cwd,
    checkClaudeAvailability: deps.checkClaudeAvailability,
    runClaudeForeground: deps.runClaudeForeground
  });
  writeLine(
    stdio,
    renderSetupReport({
      ready: readiness.ready,
      binary,
      version: readiness.version,
      repoStateDir: paths.repoStateDir,
      error: readiness.error
    })
  );
}

async function handleStatus({ cwd, paths, stdio, deps }) {
  ensureRepositoryOrThrow({ cwd, deps });
  ensureStateDirs(paths);
  const jobs = listJobRecords({ jobsDir: paths.jobsDir });
  writeLine(stdio, renderStatusReport(jobs));
}

async function handleResult({ paths, stdio, jobId }) {
  const job = resolveJobOrThrow({ paths, jobId });
  writeLine(stdio, renderResultReport(job, readJobOutput(job)));
}

async function handleCancel({ paths, stdio, jobId, deps }) {
  const job = resolveJobOrThrow({ paths, jobId });
  if (job.pid && !isTerminalJobStatus(job.status)) {
    await waitForProcessGroupExit({
      pid: job.pid,
      killProcess: deps.killProcess,
      sleep: deps.sleep,
      timeoutMs: deps.cancelTimeoutMs,
      pollIntervalMs: deps.cancelPollIntervalMs
    });

    updateJobRecord({
      jobsDir: paths.jobsDir,
      jobId: job.id,
      patch: {
        status: "canceled",
        finishedAt: new Date().toISOString()
      }
    });
  }
  writeLine(stdio, `Requested cancellation for ${job.id}`);
}

async function handleReview({ parsed, cwd, paths, config, binary, stdio, deps }) {
  ensureRepositoryOrThrow({ cwd, deps });
  ensureStateDirs(paths);

  const job = prepareReviewJob({
    ...conversationOptions(parsed.options),
    cwd,
    paths,
    config,
    requestedModel: parsed.options.model,
    requestedEffort: parsed.options.effort,
    maxBudgetUsd: parsed.options["max-budget-usd"] === undefined ? undefined : Number(parsed.options["max-budget-usd"]),
    baseRef: parsed.options.base ?? null,
    focusText: parsed.positionals.join(" ").trim(),
    buildReviewInputImpl: deps.buildReviewInput
  });

  job.request.binary = binary;
  registerSessionRepository(paths);
  enqueueReviewJob({ jobsDir: paths.jobsDir, job });

  if (parsed.options.background) {
    try {
      await deps.spawnDetachedWorker({
        nodeBinary: process.execPath,
        scriptPath: SCRIPT_PATH,
        workerArgs: ["worker", "--cwd", cwd, "--job-id", job.id],
        cwd
      });
    } catch (error) {
      updateJobRecord({
        jobsDir: paths.jobsDir,
        jobId: job.id,
        patch: {
          status: "failed",
          pid: null,
          stderrTail: (error?.message ?? String(error)).slice(-2000),
          finishedAt: new Date().toISOString()
        }
      });
      throw error;
    }

    writeLine(stdio, `Started review job ${job.id}`);
    return;
  }

  const result = await runPreparedReviewJob({
    job,
    binary,
    paths,
    runClaudeForeground: deps.runClaudeForeground
  });

  if (result.exitCode !== 0) {
    throw new Error(formatClaudeFailure(result));
  }

  writeLine(stdio, result.stdout);
}

async function handleDelegate({ parsed, cwd, paths, config, binary, stdio, deps }) {
  const taskText = requireTaskDescription(parsed.positionals);
  ensureRepositoryOrThrow({ cwd, deps });
  ensureStateDirs(paths);

  const job = prepareDelegateJob({
    ...conversationOptions(parsed.options),
    cwd,
    paths,
    config,
    requestedModel: parsed.options.model,
    requestedEffort: parsed.options.effort,
    maxBudgetUsd: parsed.options["max-budget-usd"] === undefined ? undefined : Number(parsed.options["max-budget-usd"]),
    taskText,
    resumeSpecifier: parsed.options.resume ?? null
  });

  job.request.binary = binary;
  registerSessionRepository(paths);
  enqueueDelegateJob({ jobsDir: paths.jobsDir, job });

  if (parsed.options.background) {
    try {
      await deps.spawnDetachedWorker({
        nodeBinary: process.execPath,
        scriptPath: SCRIPT_PATH,
        workerArgs: ["worker", "--cwd", cwd, "--job-id", job.id],
        cwd
      });
    } catch (error) {
      updateJobRecord({
        jobsDir: paths.jobsDir,
        jobId: job.id,
        patch: {
          status: "failed",
          pid: null,
          stderrTail: (error?.message ?? String(error)).slice(-2000),
          finishedAt: new Date().toISOString()
        }
      });
      throw error;
    }

    writeLine(stdio, `Started delegate job ${job.id}`);
    return;
  }

  const result = await runPreparedDelegateJob({
    job,
    binary,
    paths,
    runClaudeForeground: deps.runClaudeForeground
  });

  if (result.exitCode !== 0) {
    throw new Error(formatClaudeFailure(result));
  }

  writeLine(stdio, result.stdout);
}

async function handleWorker({ paths, jobId, deps }) {
  const job = readJobRecord({ jobsDir: paths.jobsDir, jobId });
  job.worker = true;

  if (job.kind === "review") {
    await runPreparedReviewJob({
      job,
      binary: job.request.binary,
      paths,
      runClaudeForeground: deps.runClaudeForeground
    });
    return;
  }

  if (["delegate", "discuss"].includes(job.kind)) {
    await runPreparedDelegateJob({
      job,
      binary: job.request.binary,
      paths,
      runClaudeForeground: deps.runClaudeForeground
    });
    return;
  }

  throw new Error(`Unsupported worker job type: ${job.kind}`);
}

export async function main(argv, injected = {}) {
  const parsed = parseArgs(argv);
  const cwd = path.resolve(parsed.options.cwd ?? process.cwd());
  const homeDir = injected.homeDir ?? os.homedir();
  const stdio = injected.stdio ?? { stdout: process.stdout, stderr: process.stderr };
  const deps = {
    checkGitRepository: injected.checkGitRepository ?? checkGitRepository,
    checkClaudeAvailability: injected.checkClaudeAvailability ?? checkClaudeAvailability,
    checkClaudeReadiness: injected.checkClaudeReadiness ?? checkClaudeReadiness,
    runClaudeForeground: injected.runClaudeForeground ?? defaultRunClaudeForeground,
    spawnDetachedWorker: injected.spawnDetachedWorker ?? defaultSpawnDetachedWorker,
    buildReviewInput: injected.buildReviewInput ?? defaultBuildReviewInput,
    killProcess: injected.killProcess ?? process.kill.bind(process),
    sleep: injected.sleep ?? defaultSleep,
    cancelTimeoutMs: injected.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
    cancelPollIntervalMs: injected.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS
  };
  const paths = resolvePaths({ cwd, homeDir });
  const config = loadMergedConfig({
    repoConfigPath: paths.repoConfigPath,
    globalConfigPath: paths.globalConfigPath
  });
  const binary = resolveClaudeBinary({ config });

  switch (parsed.command) {
    case "sessions":
      return writeLine(stdio, JSON.stringify(await listSessions({ cwd, homeDir, project: parsed.options.project,
        allRepositories: Boolean(parsed.options["all-repositories"]), deps }), null, 2));
    case "share": {
      const result = await shareSession({ cwd, homeDir, jobId: requireStringOption(parsed.options, "job-id", "share"),
        project: parsed.options.project, title: parsed.options.title,
        enabled: !parsed.options["no-share-session"], deps: { ...deps, ...injected } });
      if (result.error) throw new Error(result.error);
      return writeLine(stdio, JSON.stringify(result, null, 2));
    }
    case "usage":
      return writeLine(stdio, JSON.stringify(await (injected.readPlanUsage ?? readPlanUsage)({ binary, cwd, homeDir, refresh: true }), null, 2));
    case "setup":
      return handleSetup({ paths, stdio, deps, binary, config, cwd });
    case "status":
      return handleStatus({ cwd, paths, stdio, deps });
    case "result":
      return handleResult({
        paths,
        stdio,
        jobId: requireStringOption(parsed.options, "job-id", "result")
      });
    case "cancel":
      return handleCancel({
        paths,
        stdio,
        jobId: requireStringOption(parsed.options, "job-id", "cancel"),
        deps
      });
    case "review":
      return handleReview({ parsed, cwd, paths, config, binary, stdio, deps });
    case "delegate":
      return handleDelegate({ parsed, cwd, paths, config, binary, stdio, deps });
    case "worker":
      return handleWorker({
        paths,
        jobId: requireStringOption(parsed.options, "job-id", "worker"),
        deps
      });
    default:
      throw new Error(`Unsupported command: ${parsed.command}`);
  }
}

if (process.argv[1] === SCRIPT_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
