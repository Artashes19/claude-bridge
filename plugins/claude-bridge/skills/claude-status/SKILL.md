---
name: claude-status
description: Use when the user wants to see Claude Bridge jobs for the current repository.
---

# Claude Status

Call the `bridge_status` MCP tool with `cwd` set to the current working directory.

Returns a list of all jobs (newest first) with id, kind, status, model, and summary.

Do NOT run shell commands — use the MCP tool.
