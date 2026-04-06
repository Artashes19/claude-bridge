import { spawn, spawnSync } from "node:child_process";

const DEFAULT_READINESS_TIMEOUT_MS = 30000;

function formatRunnerError(result) {
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    return stderr;
  }

  const error = result.error;
  if (!error) {
    return "";
  }

  return (
    error.message ??
    String(error) ??
    error.code ??
    ""
  ).trim();
}

export function checkClaudeAvailability({ binary, run = spawnSync }) {
  const result = run(binary, ["--version"], { encoding: "utf8" });
  return {
    available: result.status === 0,
    version: (result.stdout ?? "").trim(),
    error: formatRunnerError(result)
  };
}

export function checkClaudeReadiness({
  binary,
  model,
  effort,
  cwd = process.cwd(),
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  checkClaudeAvailability: checkAvailability = checkClaudeAvailability,
  runClaudeForeground: runForeground = runClaudeForeground
}) {
  const availability = checkAvailability({ binary });
  if (!availability.available) {
    return {
      ready: false,
      version: availability.version,
      error: availability.error
    };
  }

  const probe = runForeground({
    binary,
    args: buildReviewClaudeArgs({
      model,
      effort,
      prompt: "Reply with exactly: ready."
    }),
    cwd,
    timeoutMs
  });

  if (probe.exitCode === 0) {
    return {
      ready: true,
      version: availability.version,
      error: ""
    };
  }

  const probeError =
    formatRunnerError(probe) ||
    (probe.stdout ?? "").trim() ||
    `exit code ${probe.exitCode ?? "unknown"}`;
  return {
    ready: false,
    version: availability.version,
    error: `Claude prompt probe failed: ${probeError}`
  };
}

export function buildReviewClaudeArgs({ model, effort, prompt }) {
  return [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--tools",
    "",
    "--permission-mode",
    "plan",
    prompt
  ];
}

export function buildDelegateClaudeArgs({ model, effort, prompt }) {
  return [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "acceptEdits",
    prompt
  ];
}

export function runClaudeForeground({ binary, args, cwd, timeoutMs, run = spawnSync }) {
  const result = run(binary, args, {
    cwd,
    encoding: "utf8",
    ...(timeoutMs ? { timeout: timeoutMs } : {})
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

export function spawnDetachedWorker({ nodeBinary, scriptPath, workerArgs, cwd, spawnImpl = spawn }) {
  const child = spawnImpl(nodeBinary, [scriptPath, ...workerArgs], {
    cwd,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}
