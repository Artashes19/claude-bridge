import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { runStream } from "./stream.mjs";

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
    args: ["auth", "status", "--json"],
    cwd,
    timeoutMs
  });

  let authenticated = false;
  try { authenticated = JSON.parse(probe.stdout).loggedIn === true; } catch {}
  if (probe.exitCode === 0 && authenticated) {
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
    error: `Authentication check failed: ${probeError}`
  };
}

export function buildReviewClaudeArgs({ model, effort, prompt, sessionId, resumeSessionId, maxBudgetUsd }) {
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
    ...sessionArgs({ sessionId, resumeSessionId, maxBudgetUsd }),
    prompt
  ];
}

export function buildDelegateClaudeArgs({ model, effort, prompt, sessionId, resumeSessionId, maxBudgetUsd }) {
  return [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "acceptEdits",
    ...sessionArgs({ sessionId, resumeSessionId, maxBudgetUsd }),
    prompt
  ];
}

function sessionArgs({ sessionId, resumeSessionId, maxBudgetUsd }) {
  return [
    ...(sessionId ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ...(resumeSessionId ? ["--resume", resumeSessionId] : ["--session-id", sessionId])] : []),
    ...(maxBudgetUsd != null ? ["--max-budget-usd", String(maxBudgetUsd)] : []),
  ];
}

export function runClaudeForeground({ binary, args, cwd, timeoutMs, outputFile, stderrFile, eventsFile, onProgress, job, paths, run = spawnSync }) {
  if (job?.interactive) {
    return import("./interactive.mjs").then(({ runInteractive }) => runInteractive({
      job, paths, binary, outputFile, stderrFile, eventsFile, onProgress,
    }));
  }
  if (eventsFile && args.includes("stream-json")) {
    return runStream({ binary, args, cwd, outputFile, stderrFile, eventsFile, onProgress });
  }
  const descriptors = [];
  let result;
  try {
    if (outputFile) {
      descriptors.push(fs.openSync(outputFile, "w"));
      descriptors.push(fs.openSync(stderrFile ?? `${outputFile}.stderr`, "w"));
    }
    result = run(binary, args, {
      cwd,
      encoding: "utf8",
      ...(descriptors.length ? { stdio: ["ignore", ...descriptors] } : {}),
      ...(timeoutMs ? { timeout: timeoutMs } : {})
    });
  } finally {
    for (const descriptor of descriptors) fs.closeSync(descriptor);
  }
  return {
    exitCode: result.status ?? 1,
    stdout: outputFile ? fs.readFileSync(outputFile, "utf8") : result.stdout ?? "",
    stderr: outputFile ? readFileTail(stderrFile ?? `${outputFile}.stderr`) : result.stderr ?? "",
    error: result.error ?? (result.signal ? new Error(`Process terminated by ${result.signal}`) : undefined),
    outputPersisted: Boolean(outputFile),
  };
}

export function readFileTail(filePath, maxBytes = 2000) {
  const descriptor = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - maxBytes));
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function spawnDetachedWorker({ nodeBinary, scriptPath, workerArgs, cwd, logFile, spawnImpl = spawn }) {
  const descriptor = logFile ? fs.openSync(logFile, "a") : null;
  try {
    const child = spawnImpl(nodeBinary, [scriptPath, ...workerArgs], {
      cwd,
      detached: true,
      stdio: descriptor === null ? "ignore" : ["ignore", descriptor, descriptor],
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    return child;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
