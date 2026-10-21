# Claude Bridge

Claude Bridge is a Codex plugin that shells out to the local `claude` CLI for:

- read-only review
- writable delegation
- status, result, and cancel for background runs

## Runtime

- MCP task calls use detached workers. A normal call waits up to 10 seconds or returns when clarification is needed; `background: true` returns immediately. Retrieve `bridge_result` with that ID and the same `cwd`, answer pending questions, and present the terminal output. Supplying `deliveryThreadId` enables automatic question and completion delivery into the originating host conversation.
- Task stdout and stderr are saved directly to files while the process runs. Partial output is available through `bridge_result`; completed reports remain available after a client disconnect. Failed task responses retain the job ID, output path, and diagnostics.
- Use a stable `requestId` on submissions. Repeating the same ID recovers its original job, including after completion, without another execution. Reusing an ID with different inputs is rejected. Identical active requests without an ID also reuse their running job; a new ID explicitly starts a new execution.
- Retrieval supports `waitSeconds` (up to 30) and output paging (12000 bytes by default). Start at offset 0 after completion and follow `nextOffset` until `hasMore` is false. Paging preserves UTF-8 character boundaries and does not rerun the task.
- Missing workers, empty successful responses, and unexpected execution errors produce failed job records with saved diagnostics. Inspect those records and output files before deciding whether a paid retry is needed. The status response includes the running server version and process ID for checking a reload.
- Claude binary: discovered from `PATH` by default
- Repo-local state: `.claude-bridge/`
- Repo-local config: `.claude-bridge/config.json`
- Global config: `~/.claude-bridge/config.json`
- `setup --cwd <repo>` checks the executable and local authentication status without a paid model request. This does not test upstream model availability.
- `setup --cwd` should point at a Git repo; the bridge will not claim review readiness for a non-repo directory
- Claude Bridge bootstraps `.claude-bridge/` into that repo's local Git exclude file so runtime state stays untracked by default
- Read-only review input omits repo-local `.claude-bridge/` artifacts from the working-tree status text and only inlines small text untracked files; larger, binary, or unreadable untracked files are replaced with a note
- These examples assume the plugin has been installed to ~/plugins/claude-bridge.
- In `~/.agents/plugins/marketplace.json`, `./plugins/claude-bridge` resolves to `~/plugins/claude-bridge`.

## Publishing

This repo is structured so it can be pushed to GitHub and shared directly. After cloning, friends can install the plugin by copying `plugins/claude-bridge/` into `~/plugins/claude-bridge/` and registering the matching marketplace entry from `.agents/plugins/marketplace.json`.

## Commands Behind The Skills

- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" setup --cwd "."`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" review --cwd "." --model opus`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" delegate --cwd "." --model sonnet "fix the flaky test"`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" status --cwd "."`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" result --cwd "." --job-id latest`
- `node "$HOME/plugins/claude-bridge/scripts/claude-bridge.mjs" cancel --cwd "." --job-id latest`

For `setup`, `READY: yes` means the executable is available and local authentication is present in the requested repository context. It does not send a model prompt.

## Plan usage

Use `bridge_usage` with the repository `cwd` to read subscription usage without sending a model prompt. It returns every server-provided limit row in order, including session, weekly all-model, and model-specific weekly limits, with `usedPercent`, `remainingPercent`, an absolute `resetsAt` timestamp, and `resetsInSeconds`. Percentages are account-wide across product surfaces; they are not the share consumed by one bridge job. Render reset times in the user's timezone. Extra usage is reported as enabled or disabled without changing its setting.

Usage checks are cached for at most 60 seconds within the current server connection; `refresh: true` checks now. Status and result responses include the latest cached snapshot and mark its age and staleness. They never perform a usage check on every output poll. Call `bridge_usage` when presenting completed work or when the user asks about remaining allowance. If the structured endpoint is unavailable, report that explicitly; never infer plan percentages from tokens or dollar estimates. This endpoint is experimental and may require adaptation after a runtime update.

Dollar estimates are omitted from normal status and result responses. Set `includeCostEstimates: true` to obtain `estimatedApiEquivalentUsd`, explicitly labeled as a conversation token-price estimate rather than a subscription charge. This figure includes resumed turns and must not be summed across jobs in the same conversation. Raw saved events retain the backend's original metrics for diagnosis.

The command-line equivalent is `node plugins/claude-bridge/scripts/claude-bridge.mjs usage --cwd <repo>`.

## Persistent discussion and recovery

### Bridge topic labels and the optional remote viewer

`bridge_sessions` lists bridge-only topic labels and named conversations. Set `allRepositories: true` to include repositories registered under this user's global state directory, or filter with `project`. A conversation appears once even when several jobs continued it. Use the returned `cwd` and `jobId` for a follow-up. The catalog reads durable job records; it does not send a model prompt. These labels organize bridge sessions; they do not create regular desktop sessions, projects, workspaces, or sidebar groups.

Submissions accept `project`, `title`, and `shareSession`. For example, a project named `3D reconstruction geometry` can contain sessions named `Camera calibration` and `Coordinate conventions`. Supply `resume: "latest"` together with `project` to restrict continuation to that topic in the current working directory. Missing matches fail before execution. For a specific conversation, select its job ID from the catalog. Titles, topic labels, sharing preference, model and effort inherit on resume unless overridden. A retry with the same request ID recovers its original turn before resolving `latest` again.

With `shareSession: true`, a persistent read-only viewer uploads saved native user and assistant messages to the **Remote Control** section and returns `accountSession.url`. This transport does not place sessions in the regular desktop workspace list. It creates no model worker and sends no model prompts. Resume reuses the same account identity and adds new messages to that history. The viewer stays online after jobs finish and reconnects after transport failures. Its transport is outbound only: use bridge resume for automated discussion; typing in the account viewer does not send a bridge task.

Use `bridge_share` with a saved job ID to publish or reconnect a completed conversation without repeating its paid task. Supply `enabled: false` to stop the viewer for that session without deleting already published history. The CLI equivalent is `share --job-id <id> --no-share-session`.

The viewer uses the public alpha transport export in the pinned SDK. `accountSession.state` distinguishes pending, connecting, connected, disabled, offline, unavailable and unconfirmed states. `messagesUploaded` counts message UUIDs flushed through the transport; it does not prove client rendering. A private checkpoint prevents repeat uploads after reconnects. Reports and job status stay independent of viewer state. No credentials are returned or saved in viewer metadata. The viewer reads the existing native login credentials and refreshes its transport before expiration; if login expires, restore the native login and reconnect. On bridge startup, enabled viewers are restarted if their process is gone. The returned state identifies `surface: "remote-control"` and `desktopWorkspaceCreated: false`. Neither a successful connection nor a rendered history means that a regular desktop workspace was created.

Regular desktop workspace integration is handled by a separate Mac-side tool, not by this viewer: the sidebar registrar in [`tools/sidebar-registrar/`](../../tools/sidebar-registrar/README.md). It runs `sessions --all-repositories` over SSH, checks that each finished session's transcript exists on the host, and writes SSH session records into the desktop app's session store so the conversations appear in the regular Code-tab sidebar under the host and folder they ran in; opening one resumes the cluster transcript through the app's own SSH daemon. The desktop app reads that store once per launch, so new entries appear only after **relaunching Claude**. The store format is private to the desktop app (read from version 3.1623.0, not a public API); the registrar only creates records it owns, never touches records the app or the user changed, respects deletions made in the app, and may need updating after desktop releases. The bridge itself still registers nothing: the documented CLI-to-desktop resume flow applies to local sessions, excludes SSH sessions, and requires the desktop app on that computer (see the [desktop handoff reference](https://code.claude.com/docs/en/desktop#coming-from-the-cli)), and an [SSH new-session link](https://code.claude.com/docs/en/desktop#open-an-ssh-session-from-a-link) opens the app with a host and folder without submitting a prompt or importing a transcript. Do not substitute remote publishing or bridge labels for a request to manage regular desktop sessions.

Sharing defaults to the prior session preference, then `runtime.shareSessions` in repository/global configuration, then false. Set `shareSession: false` to stop publishing for a turn; this does not delete previously published history. Repository registrations live under `~/.claude-bridge/repositories/`; session data stays with the repository's saved jobs. Private viewer specifications and upload checkpoints live under `~/.claude-bridge/history-viewer/`.

CLI equivalents are `sessions [--all-repositories] [--project <topic>]` and `share --job-id <id> [--project <topic>] [--title <name>]`, with `--cwd <repo>`. New review/delegate calls also accept `--project`, `--title`, `--share-session`, and `--no-share-session`.

Use `bridge_discuss` with `message`, `cwd`, and a stable `requestId` to start a read-only conversation. After retrieving the reply, send the next message with `resume` set to the previous job ID and a new `requestId`. Earlier arguments and evidence remain in the native conversation. Discussion and review workers have scoped project read, search, and listing tools, plus clarifying questions; they have no shell or file-edit tools. A review or coding job can also supply the session for a discussion follow-up.

New workers use a streaming SDK connection to the configured local executable. When the worker asks a clarifying question, `bridge_result` returns `status: needs_input` and `interaction.questions` immediately, even if a wait was requested. Call `bridge_answer` with `jobId`, the question's `id` as `questionId`, and `answers` mapping every exact question text to its answer. The host agent should answer from its own evidence and context, and consult the user only when necessary. Answers are saved independently of the connection and consumed by the same paused worker. Conflicting repeated answers are rejected. This channel does not grant additional tool permissions.

Use `bridge_steer` with `jobId`, `message`, and a stable `requestId` to add input while a job runs. Input is queued by default and may be consumed after the current response, causing another model turn. `interrupt: true` requests interruption before queuing the message. `interaction.steering` exposes queued, dispatching, dispatched, and failed receipts, the requested `mode`, and `incorporation: unconfirmed`. A dispatched receipt proves insertion into the session input queue; it does not prove backend consumption or incorporation into the current answer. For important corrections, request interruption while active or use an explicit resumed follow-up after completion, then verify the resulting answer. A dispatch interrupted by a worker crash is uncertain and is not automatically replayed. Older jobs remain retrievable and resumable but do not acquire live controls until a new turn is started.

Bind delivery explicitly with the originating host session's `CODEX_THREAD_ID` as `deliveryThreadId`. The bridge discovers a single private app-server socket owned by the local user, or accepts its absolute path as `deliveryEndpoint`. It never infers a destination from another job or a shared server environment. Notifications steer an active host turn or start a continuation when idle; the host still retrieves and acknowledges the saved report. Pending notifications persist in a local delivery registry and are retried by the server after reconnecting. If delivery may have happened but acknowledgement was lost, `interaction.notifications` records `uncertain` and avoids automatic duplicate generation. Saved reports remain available regardless of notification delivery.

Every new job stores a native session ID before execution. `resume` passes that ID to the backend rather than inserting a shortened report into a new prompt. Interrupted sessions can be continued once their worker and backend have exited. Only one turn can use a session at a time; overlapping turns fail before another backend execution starts. A retry with the same `requestId` retrieves the original turn; a new follow-up needs a new ID.

For older jobs, call `bridge_status` with `recoverSessions: true` once. This matches exact saved prompts, working directories, and run timestamps against local session transcripts without running the model. Ambiguous or missing matches remain unchanged. Set `runtime.sessionProjectsDir` in configuration when transcripts live outside the default project directory.

New runs save an event journal alongside the readable report and diagnostics. Result responses expose activity, last activity time, session identity, actual model, usage when supplied, elapsed time, retry details, and permission denials. An interrupted worker can recover its report from saved events without repeating the task. A stream without a successful final result is a failure even if its process exits zero.

`bridge_status.pendingReports` lists saved reports that have not been acknowledged. Read terminal output from offset 0 through every `nextOffset`. After successfully receiving and combining all pages, call `bridge_result` again with `acknowledge: true` and `offset` equal to the final `nextOffset`. Serving a page alone does not confirm it reached the caller; acknowledgement records caller receipt, not that a person has read it.

Model and effort selection follows an explicit request, then the previous turn when resuming, then repository configuration, global configuration, and built-in defaults. The built-in effort is `high`. Supported levels are `low`, `medium`, `high`, `xhigh`, and `max`; unsupported model/effort combinations fail with backend diagnostics. Result metadata identifies the setting source and actual model when supplied; there is no automatic model or effort substitution.

Optional `maxBudgetUsd`, or `runtime.maxBudgetUsd` in configuration, passes the backend's estimated spending limit for the current run. Follow-ups inherit the preceding turn's numeric cap unless overridden, but restored costs from earlier runs do not count toward that cap. This is not a conversation-wide spending limit and may overshoot. `estimatedApiEquivalentUsd` and `modelUsage` are conversation totals, including earlier turns; do not sum those totals across resumed jobs. Usage, list-price estimates, subscription allowances, and actual billing differ. No budget is imposed when neither a request, prior turn nor configuration supplies one. The bridge does not enforce an independent token or runtime cap.

Native session history remains on the host. Resume cannot recover a deleted transcript or refund tokens already consumed; missing output should be investigated through saved reports and events before any paid retry.
