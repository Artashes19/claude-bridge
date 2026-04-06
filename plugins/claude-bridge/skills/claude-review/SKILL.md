---
name: claude-review
description: Use when the user wants Claude Code to perform a read-only review of the current repository state from inside Codex.
---

# Claude Review

Use this skill when the user wants findings, not edits.

Use the `bridge_review` MCP tool:

- `bridge_review` with `cwd`, and optionally `model`, `baseRef`, `focus`, `background`
- Example: `bridge_review` with `model: "opus"`, `focus: "check error handling"`
- Example: `bridge_review` with `baseRef: "main"`, `model: "sonnet"`
- Example: `bridge_review` with `background: true`, `focus: "look for missing tests"`

Notes:

- If background mode is used, check `bridge_status` and `bridge_result`
- Available models: opus (default for review), sonnet, haiku

Fallback (if MCP is unavailable):

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --model opus`
