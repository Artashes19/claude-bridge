#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  handleSetup,
  handleReview,
  handleDelegate,
  handleStatus,
  handleResult,
  handleCancel,
} from "./lib/mcp-handlers.mjs";

function mcpText(text) {
  return { content: [{ type: "text", text }] };
}

function mcpResult(data) {
  return mcpText(JSON.stringify(data, null, 2));
}

function mcpError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new McpServer({ name: "claude-bridge", version: "0.2.0" });

server.tool(
  "bridge_setup",
  "Verify that Claude Code CLI is installed, authenticated, and can run review prompts in the given working directory. Run this first to confirm the bridge is operational.",
  { cwd: z.string().optional().describe("Working directory (must be a Git repo)") },
  async ({ cwd }) => {
    const result = await handleSetup({ cwd });
    return result.error ? mcpError(`READY: no\n${result.error}`) : mcpResult(result);
  }
);

server.tool(
  "bridge_review",
  "Run a read-only Claude Code review of the current Git working tree or a base..HEAD range. Returns findings about correctness bugs, regressions, and missing tests.",
  {
    cwd: z.string().optional().describe("Working directory (must be a Git repo)"),
    model: z.string().optional().describe("Model alias: opus, sonnet, or haiku"),
    effort: z.string().optional().describe("Effort level: low, medium, high"),
    baseRef: z.string().optional().describe("Git base ref for range review (e.g. main)"),
    focus: z.string().optional().describe("Review focus (e.g. 'check error handling')"),
    background: z.boolean().optional().describe("Run in background and return a job ID"),
  },
  async ({ cwd, model, effort, baseRef, focus, background }) => {
    const result = await handleReview({ cwd, model, effort, baseRef, focus, background });
    return result.error ? mcpError(result.error) : mcpResult(result);
  }
);

server.tool(
  "bridge_delegate",
  "Delegate a coding task to Claude Code. Claude can read and write files in the working tree. Use for implementation, bug fixes, refactoring, and investigation.",
  {
    cwd: z.string().optional().describe("Working directory (must be a Git repo)"),
    task: z.string().describe("Task description for Claude to execute"),
    model: z.string().optional().describe("Model alias: opus, sonnet, or haiku"),
    effort: z.string().optional().describe("Effort level: low, medium, high"),
    resume: z.string().optional().describe("Resume from a previous job: 'latest' or a job ID"),
    background: z.boolean().optional().describe("Run in background and return a job ID"),
  },
  async ({ cwd, task, model, effort, resume, background }) => {
    const result = await handleDelegate({ cwd, task, model, effort, resume, background });
    return result.error ? mcpError(result.error) : mcpResult(result);
  }
);

server.tool(
  "bridge_status",
  "List all Claude Bridge jobs for the repository, newest first.",
  { cwd: z.string().optional().describe("Working directory (must be a Git repo)") },
  async ({ cwd }) => {
    const result = await handleStatus({ cwd });
    return result.error ? mcpError(result.error) : mcpResult(result);
  }
);

server.tool(
  "bridge_result",
  "Retrieve the full output of a completed Claude Bridge job.",
  {
    cwd: z.string().optional().describe("Working directory (must be a Git repo)"),
    jobId: z.string().describe("Job ID to retrieve, or 'latest' for the most recent"),
  },
  async ({ cwd, jobId }) => {
    const result = await handleResult({ cwd, jobId });
    return result.error ? mcpError(result.error) : mcpResult(result);
  }
);

server.tool(
  "bridge_cancel",
  "Cancel a running or queued Claude Bridge job.",
  {
    cwd: z.string().optional().describe("Working directory (must be a Git repo)"),
    jobId: z.string().describe("Job ID to cancel, or 'latest' for the most recent"),
  },
  async ({ cwd, jobId }) => {
    const result = await handleCancel({ cwd, jobId });
    return result.error ? mcpError(result.error) : mcpResult(result);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Claude Bridge MCP server started on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
