# Claude Bridge

Claude Bridge is a Codex plugin that lets Codex invoke the local Claude Code CLI for:

- read-only code review
- writable task delegation
- background job control with status, result, and cancel

## Requirements

- Codex installed locally
- Claude Code installed locally
- `claude` available on `PATH`
- Node.js 18+ available on `PATH`

## Repository Layout

- repo-local plugin source: `plugins/claude-bridge`
- repo-local marketplace metadata: `.agents/plugins/marketplace.json`
- runtime state inside each target repo: `.claude-bridge/`

## Installing Into Your Home Codex Setup

1. Clone this repository somewhere local:

   ```bash
   git clone https://github.com/Artashes19/claude-bridge.git
   ```

2. Copy the plugin payload into your home plugin directory:

   ```bash
   mkdir -p ~/plugins
   rsync -a ./plugins/claude-bridge/ ~/plugins/claude-bridge/
   ```

3. Add the marketplace entry from `.agents/plugins/marketplace.json` into `~/.agents/plugins/marketplace.json`.
   If the file does not exist yet, create it with the `claude-bridge` entry and `./plugins/claude-bridge` source path.

4. Restart Codex and verify the plugin with:

   ```bash
   node ~/plugins/claude-bridge/scripts/claude-bridge.mjs setup --cwd "$PWD"
   ```

## Config

Repo-local config:

```json
{
  "models": {
    "aliases": {
      "opus": "claude-opus-latest",
      "sonnet": "claude-sonnet-latest",
      "haiku": "claude-haiku-latest"
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
