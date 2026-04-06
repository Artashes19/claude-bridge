---
name: claude-cancel
description: Use when the user wants to stop an active Claude Bridge background job.
---

# Claude Cancel

Call the `bridge_cancel` MCP tool with `jobId` (required, or "latest") and `cwd`.

Sends SIGTERM to the job's process group and marks it as canceled.

Do NOT run shell commands — use the MCP tool.
