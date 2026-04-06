---
name: claude-setup
description: Use when the user wants to verify that Claude Bridge can run the local Claude CLI with the current repo's read-only review defaults.
---

# Claude Setup

Call the `bridge_setup` MCP tool with `cwd` set to the current working directory.

The result shows `ready: true` when Claude Code is installed, authenticated, and the working directory is a Git repo. If `ready: false`, check the `error` field for details.

Do NOT run shell commands for setup — the MCP tool runs on the host with full authentication access.
