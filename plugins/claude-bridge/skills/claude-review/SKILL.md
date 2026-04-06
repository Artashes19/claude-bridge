---
name: claude-review
description: Use when the user wants Claude Code to perform a read-only review of the current repository state from inside Codex.
---

# Claude Review

Use this skill when the user wants findings, not edits.

Call the `bridge_review` MCP tool with:
- `cwd` set to the current working directory
- Optionally: `model` (opus/sonnet/haiku), `baseRef`, `focus`, `background`

Examples:
- `bridge_review` with `model: "opus"`, `focus: "check error handling"`
- `bridge_review` with `baseRef: "main"`, `model: "sonnet"`
- `bridge_review` with `background: true`, `focus: "look for missing tests"`

If background mode is used, check `bridge_status` and `bridge_result` afterward.

Do NOT run shell commands — use the MCP tool which runs on the host with full authentication.
