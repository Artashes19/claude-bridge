# Claude Bridge

Claude Bridge is a Codex plugin that lets Codex invoke the local Claude Code CLI for:

- read-only code review
- writable task delegation
- background job control with status, result, and cancel

## Requirements

- Codex installed locally
- Claude Code installed locally
- `claude` available on `PATH`
- Claude Code authenticated so it can run a prompt; `setup` probes the current repo's read-only review defaults in the requested `--cwd` and reports `READY: no` until that review configuration can run
- `setup --cwd` must point at a Git repo when you want to validate the review flow for that repo
- Node.js 18+ available on `PATH`
- Repo-local state is bootstrapped into the target repo's local Git exclude file so `.claude-bridge/` stays untracked by default
- Read-only review input excludes repo-local `.claude-bridge/` artifacts from the working-tree status text and only inlines small text untracked files; large, binary, or unreadable untracked files are skipped with an explicit note

## Repository Layout

- repo-local plugin source: `plugins/claude-bridge`
- repo-local marketplace metadata: `.agents/plugins/marketplace.json`
- runtime state inside each target repo: `.claude-bridge/`

## Installing Into Your Home Codex Setup

1. Clone this repository somewhere local:

   ```bash
   git clone https://github.com/Artashes19/claude-bridge.git
   ```

2. Change into the cloned repository:

   ```bash
   cd claude-bridge
   ```

3. Copy the plugin payload into your home plugin directory:

   ```bash
   mkdir -p ~/plugins
   rsync -a ./plugins/claude-bridge/ ~/plugins/claude-bridge/
   ```

4. Add the marketplace entry from `.agents/plugins/marketplace.json` into `~/.agents/plugins/marketplace.json`.
   If the file does not exist yet, create it with the `claude-bridge` entry and `./plugins/claude-bridge` source path.
   In `~/.agents/plugins/marketplace.json`, `"./plugins/claude-bridge" resolves to ~/plugins/claude-bridge`.

5. Restart Codex and verify the plugin with:

   ```bash
   node ~/plugins/claude-bridge/scripts/claude-bridge.mjs setup --cwd "$PWD"
   ```

   `READY: yes` means the local Claude CLI is installed, reports its version, and can execute a prompt using the current repo's read-only review defaults in `--cwd` (including the resolved model and default effort). If `--cwd` is not inside a Git repo, or if you see `READY: no` with `Not logged in · Please run /login`, fix that repo/auth state and rerun the command there.

## Sharing The Repo

This repository is ready to publish on GitHub as-is. Once it is pushed, friends can clone it with:

```bash
git clone https://github.com/Artashes19/claude-bridge.git
```

Then they can follow the install steps above to copy `plugins/claude-bridge/` into their own `~/plugins/claude-bridge/` directory and add the matching marketplace entry from `.agents/plugins/marketplace.json`.

## MCP Server Setup (Recommended)

The MCP server runs on the host (outside Codex's sandbox) and gives Claude Bridge
full access to the macOS keychain for Claude CLI authentication.

### Option A: Codex config.toml

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.claude-bridge]
command = "node"
args = ["~/plugins/claude-bridge/scripts/mcp-server.mjs"]
```

### Option B: Codex CLI

```bash
codex mcp add claude-bridge -- node ~/plugins/claude-bridge/scripts/mcp-server.mjs
```

After adding, restart Codex. The 6 bridge tools (`bridge_setup`, `bridge_review`,
`bridge_delegate`, `bridge_status`, `bridge_result`, `bridge_cancel`) will be
available as MCP tools.
## Config

Repo-local config:

```json
{
  "models": {
    "aliases": {
      "opus": "claude-opus-4-6",
      "sonnet": "claude-sonnet-4-6",
      "haiku": "claude-haiku-4-5-20251001"
    },
    "defaults": {
      "review": "opus",
      "delegate": "sonnet"
    }
  },
  "runtime": {
    "defaultEffort": "high",
    "claudeBinary": "claude"
  }
}
```
