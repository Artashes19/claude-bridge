# Claude Bridge Install-First Design

**Date:** 2026-04-07

## Goal

Make Claude Bridge effortless to install, repair, update, and verify on a local machine by replacing the current multi-step manual setup with a managed runtime installation flow.

## Scope

This design covers the first install-first pass only:

- a managed runtime home for Claude Bridge
- a single installer entrypoint
- a doctor command for diagnostics
- idempotent Codex config wiring
- documentation changes to match the new workflow

This design does not yet include:

- a self-contained packaged plugin artifact
- structured review-output schemas
- expanded workflow tools beyond the current bridge surface
- UI-level changes inside Codex itself

## Current Problems

The current bridge works, but the install experience is fragile:

- the README presents a plugin-copy flow that is not reliably self-contained
- users must understand repo layout, plugin layout, MCP wiring, and skill registration
- reruns and upgrades are not treated as first-class flows
- diagnosing failures requires manual investigation
- skills can function without being clearly discoverable in Codex UI surfaces

On this machine, the bridge worked only after a full repo clone, `npm ci`, explicit MCP registration, explicit skill registration, and direct verification outside normal child-Codex shell flows.

## Recommended Approach

Use a managed runtime installation with a hidden app-style home:

- canonical runtime directory: `~/.local/share/claude-bridge`
- canonical Codex config file: `~/.codex/config.toml`
- optional user-facing plugin directory: `~/plugins` only when needed later

The bridge should be treated as an installed runtime, not as a folder that users manually copy and wire together.

## User Experience

The target experience is:

1. User runs one install command from anywhere.
2. The installer creates or repairs the runtime installation.
3. The installer registers or repairs the Codex MCP config and skill paths.
4. The installer runs a live readiness check.
5. The installer prints a concise success or failure report with exact next steps.

Re-running the installer should be safe and should repair drift instead of duplicating configuration.

## Architecture

The install-first pass introduces a management layer alongside the existing bridge runtime:

- `scripts/install.mjs`
- `scripts/doctor.mjs`
- `scripts/lib/install-config.mjs`

The existing runtime entrypoints remain:

- `plugins/claude-bridge/scripts/claude-bridge.mjs`
- `plugins/claude-bridge/scripts/mcp-server.mjs`

The install layer owns setup and diagnostics. The runtime layer continues to own Claude-facing bridge behavior.

## Main Components

### `scripts/install.mjs`

Responsibilities:

- resolve runtime home path
- detect fresh install vs update vs repair
- clone or update the runtime checkout
- run `npm ci`
- ensure Codex MCP config exists
- ensure skill registrations exist
- run a readiness probe
- print a compact summary

Behavior requirements:

- idempotent on rerun
- no duplicate MCP blocks
- no duplicate `skills.config` entries
- clear failure messaging

### `scripts/doctor.mjs`

Responsibilities:

- validate environment prerequisites
- validate runtime installation health
- validate Codex configuration
- validate Claude availability and auth
- run a live setup probe
- emit a diagnostic summary with actionable fixes

Checks should include:

- `node` available and version acceptable
- `claude` available on `PATH`
- Claude auth is usable
- runtime directory exists
- `node_modules` present
- Codex MCP block present and correct
- skill paths present and correct
- bridge setup probe returns readiness

### `scripts/lib/install-config.mjs`

Responsibilities:

- read and patch `~/.codex/config.toml`
- ensure `[mcp_servers.claude-bridge]`
- ensure timeout values appropriate for Claude review/delegate calls
- ensure bridge skill paths exist exactly once
- avoid modifying unrelated Codex settings

This module should be the single source of truth for Codex config mutation and validation.

### Documentation

The root README should be rewritten around:

- install
- doctor
- update
- uninstall
- common failure modes

Advanced implementation details should move to lower sections or a dedicated contributor doc.

## Runtime Home Decision

The canonical runtime home should be `~/.local/share/claude-bridge`.

Reasons:

- separates runtime state from user-facing plugin experiments
- avoids confusion between “plugin folder” and “full runtime checkout”
- provides a clean upgrade path to a more packaged future
- reduces the chance that users manually mutate the install tree casually

## Data Flow

### Install Flow

1. Resolve runtime home.
2. Create parent directories if needed.
3. If runtime is missing, clone the repo there.
4. If runtime exists, fetch/update or repair it.
5. Run `npm ci` in runtime home.
6. Repair `~/.codex/config.toml`:
   - bridge MCP block
   - MCP timeout values
   - six skill paths
7. Run bridge setup verification against a Git repo target.
8. Print status:
   - installed revision
   - Claude binary and version
   - ready true/false
   - exact next step if false

### Doctor Flow

1. Check prerequisites.
2. Check runtime tree and dependencies.
3. Check Codex config.
4. Run bridge setup verification.
5. Print categorized failures and suggested repairs.

Install and doctor should share validation code so they cannot drift.

## Error Handling

The first pass should prefer explicit, narrow failures over hidden fallback behavior.

- Missing `claude`: installation may finish, but result must clearly say bridge is installed while Claude is unavailable.
- Unauthenticated Claude: clearly report auth problem and next step.
- Codex config patch failure: stop with exact file and reason; do not silently continue.
- Update failure: preserve the last known usable install when possible.
- Partial runtime damage: doctor should distinguish “missing repo”, “missing dependencies”, and “broken config”.

## Testing Strategy

Add tests for the install layer without making tests depend on the real host environment.

Key test cases:

- create fresh config from empty state
- rerun install without duplication
- repair partially broken config
- validate skill path generation
- validate MCP block generation
- doctor output for healthy install
- doctor output for missing Claude
- doctor output for missing auth
- runtime path handling

Where possible, use temp directories and mocked environment/process runners.

## Constraints

- preserve current bridge runtime behavior
- avoid requiring Codex internal changes
- keep install logic separate from Claude execution logic
- keep the first pass focused on setup and diagnostics, not broader feature expansion

## Success Criteria

The first install-first pass is successful when:

- a new user can run one command and get a working bridge
- rerunning the same command is safe and does not duplicate config
- a broken local install can be diagnosed with one doctor command
- docs match the actual working install path
- local contributors can still use a normal repo checkout

## Follow-On Work

After this pass lands, the next likely improvements are:

- job metadata enrichment with effort and duration
- structured review findings output
- better Codex skill discoverability
- eventual move toward a self-contained packaged install
