import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

const LIMIT = 20000;
export function evidencePath(root, requested = ".") {
  const base = fs.realpathSync(root);
  const target = fs.realpathSync(path.resolve(base, requested));
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      relative.split(path.sep).some((part) => [".git", ".claude-bridge"].includes(part))) {
    throw new Error("Evidence access is limited to project files inside the repository.");
  }
  return target;
}

export function readEvidence(root, { file, startLine = 1, lines = 150 }) {
  const target = evidencePath(root, file);
  if (!fs.statSync(target).isFile()) throw new Error("Expected a regular file");
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 2 * 1024 * 1024));
    const bytes = fs.readSync(fd, buffer);
    if (buffer.subarray(0, bytes).includes(0)) throw new Error("Binary files are not supported by text evidence tools.");
    const source = buffer.subarray(0, bytes).toString("utf8").split("\n");
    return `${path.relative(fs.realpathSync(root), target)}\n` + source.slice(startLine - 1, startLine - 1 + lines)
      .map((line, index) => `${startLine + index}: ${line}`).join("\n").slice(0, LIMIT) +
      (fs.fstatSync(fd).size > bytes ? "\n[File read limited to first 2 MiB]" : "");
  } finally { fs.closeSync(fd); }
}

export function searchEvidence(root, { pattern, directory = "." }) {
  const target = evidencePath(root, directory);
  const result = spawnSync("rg", ["--no-config", "--no-follow", "--hidden", "--line-number", "--color", "never",
    "--max-count", "20", "--max-columns", "500", "--max-columns-preview", "--glob", "!.git/**", "--glob", "!.claude-bridge/**",
    "-e", pattern, "--", target], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw result.error ?? new Error(result.stderr || "Search failed");
  return (result.stdout || "No matches").slice(0, LIMIT);
}

export function listEvidence(root, { directory = ".", depth = 2 }) {
  const output = [];
  const visited = new Set();
  function visit(location, remaining) {
    const target = evidencePath(root, location);
    if (visited.has(target)) return;
    visited.add(target);
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", ".claude-bridge", "node_modules"].includes(entry.name)) continue;
      if (output.length >= 300) return;
      const child = path.join(target, entry.name);
      try { evidencePath(root, child); } catch { continue; }
      output.push(path.relative(fs.realpathSync(root), child) + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory() && remaining > 0) visit(child, remaining - 1);
    }
  }
  visit(directory, depth);
  return output.join("\n") + (output.length >= 300 ? "\n[Listing limited to 300 entries]" : "");
}

export function evidenceServer(root) {
  const response = (fn) => async (input) => {
    try { return { content: [{ type: "text", text: fn(root, input) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
  };
  return createSdkMcpServer({ name: "evidence", version: "1.0.0", tools: [
    tool("read", "Read a project text file with line numbers. Paths must stay inside the repository.",
      { file: z.string(), startLine: z.number().int().min(1).optional(), lines: z.number().int().min(1).max(300).optional() }, response(readEvidence)),
    tool("search", "Search project text with a regular expression. Does not follow symbolic links.",
      { pattern: z.string().min(1).max(1000), directory: z.string().optional() }, response(searchEvidence)),
    tool("list", "List project files and directories. Repository metadata and bridge state are excluded.",
      { directory: z.string().optional(), depth: z.number().int().min(0).max(4).optional() }, response(listEvidence)),
  ] });
}
