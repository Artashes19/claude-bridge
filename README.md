# Claude Bridge

Claude Bridge is a Codex plugin that lets Codex call the local Claude Code CLI through an MCP server running on the host machine.

It supports:

- read-only code review
- writable task delegation
- background jobs with status, result, and cancel
- per-call model selection for `opus`, `sonnet`, `haiku`, or a full Claude model ID

## Requirements

- Codex installed locally
- Claude Code installed locally
- `claude` available on `PATH`
- Claude Code authenticated on the host machine
- Node.js 18+ available on `PATH`

## Install

1. Clone the repository:

   ```bash
   git clone git@github.com:Artashes19/claude-bridge.git
   cd claude-bridge
   ```

2. Install the plugin into your local Codex plugins directory:

   ```bash
   mkdir -p ~/plugins
   rsync -a ./plugins/claude-bridge/ ~/plugins/claude-bridge/
   ```

3. Register the plugin in `~/.agents/plugins/marketplace.json`:

   ```json
   {
     "name": "claude-bridge-local",
     "interface": {
       "displayName": "Claude Bridge Local"
     },
     "plugins": [
       {
         "name": "claude-bridge",
         "source": {
           "source": "local",
           "path": "./plugins/claude-bridge"
         },
         "policy": {
           "installation": "AVAILABLE",
           "authentication": "ON_INSTALL"
         },
         "category": "Coding"
       }
     ]
   }
   ```

   In ~/.agents/plugins/marketplace.json, "./plugins/claude-bridge" resolves to ~/plugins/claude-bridge.

4. Register the MCP server. Use one of these:

   Option A: `~/.codex/config.toml`

   ```toml
   [mcp_servers.claude-bridge]
   command = "node"
   args = ["~/plugins/claude-bridge/scripts/mcp-server.mjs"]
   ```

   Option B: Codex CLI

   ```bash
   codex mcp add claude-bridge -- node ~/plugins/claude-bridge/scripts/mcp-server.mjs
   ```

5. Restart Codex.

## Verify

Open Codex inside a Git repository and use the `claude-setup` skill.

Expected result:

- `ready: true`
- Claude version is reported
- the state directory points at that repository's `.claude-bridge/`

If you want to verify the host bridge directly outside Codex, run:

```bash
node ~/plugins/claude-bridge/scripts/claude-bridge.mjs setup --cwd "$PWD"
```

## Usage

Once installed, the plugin provides these skills:

- `claude-setup` — verify the bridge can talk to Claude in the current Git repo
- `claude-review` — run a read-only Claude review
- `claude-delegate` — let Claude edit the current working tree
- `claude-status` — list bridge jobs for the repo
- `claude-result` — show stored output for a job
- `claude-cancel` — cancel a queued or running job

Example workflows:

- Review the current changes with Opus
- Delegate a bugfix to Sonnet
- Start a background review, then inspect it with `claude-status` and `claude-result`

## Configuration

Claude Bridge loads configuration from:

- repo-local: `.claude-bridge/config.json`
- global: `~/.claude-bridge/config.json`

Example:

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
    "defaultBackground": false,
    "claudeBinary": "claude"
  }
}
```

## Runtime Behavior

- Repo state is stored inside `.claude-bridge/` in the target repository.
- Claude Bridge adds `.claude-bridge/` to the repo's local Git exclude file so it stays untracked by default.
- Review input filters out bridge-local artifacts and only inlines small text untracked files.
- Large, binary, or unreadable untracked files are skipped with an explicit note.

## Troubleshooting

- `ready: false` with `Not logged in · Please run /login`
  Run Claude Code directly on the host and complete login first.

- `ready: false` with a timeout
  Claude started, but the readiness probe did not finish in time. Retry from a normal terminal first to separate host Claude issues from Codex integration issues.

- Codex keeps using old plugin behavior after an update
  Re-copy `~/plugins/claude-bridge`, restart Codex, and verify the plugin version in `~/plugins/claude-bridge/.codex-plugin/plugin.json`.
