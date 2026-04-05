import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkClaudeAvailability, spawnDetachedWorker } from "./lib/claude.mjs";
import { loadMergedConfig, resolveClaudeBinary } from "./lib/config.mjs";
import { listJobRecords, resolveJobRecord } from "./lib/jobs.mjs";
import { resolvePaths, ensureStateDirs } from "./lib/paths.mjs";
import {
  renderResultReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const positionals = [];

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) {
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

async function handleSetup({ paths, stdio, deps, binary }) {
  ensureStateDirs(paths);
  const availability = deps.checkClaudeAvailability({ binary });
  writeLine(
    stdio,
    renderSetupReport({
      ready: availability.available,
      binary,
      version: availability.version,
      repoStateDir: paths.repoStateDir,
      error: availability.error
    })
  );
}

async function handleStatus({ paths, stdio }) {
  ensureStateDirs(paths);
  const jobs = listJobRecords({ jobsDir: paths.jobsDir });
  writeLine(stdio, renderStatusReport(jobs));
}

async function handleResult({ paths, stdio, jobId }) {
  const job = resolveJobOrThrow({ paths, jobId });
  writeLine(stdio, renderResultReport(job, readJobOutput(job)));
}

async function handleCancel({ paths, stdio, jobId }) {
  const job = resolveJobOrThrow({ paths, jobId });
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  }
  writeLine(stdio, `Requested cancellation for ${job.id}`);
}

async function handleWorker() {
  throw new Error("worker command is reserved for review/delegate tasks implemented later.");
}

export async function main(argv, injected = {}) {
  const parsed = parseArgs(argv);
  const cwd = path.resolve(parsed.options.cwd ?? process.cwd());
  const homeDir = injected.homeDir ?? os.homedir();
  const stdio = injected.stdio ?? { stdout: process.stdout, stderr: process.stderr };
  const deps = {
    checkClaudeAvailability: injected.checkClaudeAvailability ?? checkClaudeAvailability,
    spawnDetachedWorker: injected.spawnDetachedWorker ?? spawnDetachedWorker
  };
  const paths = resolvePaths({ cwd, homeDir });
  const config = loadMergedConfig({
    repoConfigPath: paths.repoConfigPath,
    globalConfigPath: paths.globalConfigPath
  });
  const binary = resolveClaudeBinary({ config });

  switch (parsed.command) {
    case "setup":
      return handleSetup({ paths, stdio, deps, binary });
    case "status":
      return handleStatus({ paths, stdio });
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
        jobId: requireStringOption(parsed.options, "job-id", "cancel")
      });
    case "worker":
      return handleWorker();
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
