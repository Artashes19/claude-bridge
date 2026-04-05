import { spawn, spawnSync } from "node:child_process";

export function checkClaudeAvailability({ binary, run = spawnSync }) {
  const result = run(binary, ["--version"], { encoding: "utf8" });
  return {
    available: result.status === 0,
    version: (result.stdout ?? "").trim(),
    error: (result.stderr ?? "").trim()
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

export function runClaudeForeground({ binary, args, cwd, run = spawnSync }) {
  const result = run(binary, args, { cwd, encoding: "utf8" });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
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
