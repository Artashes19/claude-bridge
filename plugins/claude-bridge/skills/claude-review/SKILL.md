---
name: claude-review
description: Use when the user wants Claude Code to perform a read-only review of the current repository state from inside Codex.
---

Review submissions accept a topic `project`, native session `title`, and optional `shareSession`. Use `bridge_sessions` to find related conversations and continue a completed review with `bridge_discuss` and its job ID. Only when Remote Control viewing is wanted, enable sharing and present `accountSession.url` with the result. This does not create a regular desktop workspace session. Topic groups belong to the bridge and do not create native app Projects. Regular desktop workspace integration is not implemented; retrieve the saved report even if sharing fails.

# Claude Review

Use this skill when the user wants findings, not edits.

Call the `bridge_review` MCP tool with:
- `cwd` set to the current working directory
- Optionally: `model` (opus/sonnet/haiku), `baseRef`, `focus`, `background`, `requestId`

Examples:
- `bridge_review` with `model: "opus"`, `focus: "check error handling"`
- `bridge_review` with `baseRef: "main"`, `model: "sonnet"`
- `bridge_review` with `background: true`, `focus: "look for missing tests"`

Keep one stable `requestId` for each submission and reuse it after a timeout or disconnect. If a job ID is returned, retrieve that job rather than resubmitting the task. `reused: true` means the existing execution was recovered without another paid run.

A queued/running response is not the requested report. Unless the user explicitly asked only to launch a background job, keep calling `bridge_result` with the same `jobId`, `cwd`, and `waitSeconds: 30` until status is completed, failed, or canceled. Automatic question and completion delivery is available when the submission includes the originating host session’s `CODEX_THREAD_ID` as `deliveryThreadId`. Never guess that identity. If delivery is unavailable, continue retrieval normally. Once terminal, read from offset 0 and follow `nextOffset` while `hasMore` is true; combine all pages before presenting the report.

If a tool connection fails before a job ID arrives, use `bridge_status` in the same repository or retry with the original `requestId`. Inspect saved output and diagnostics on failure. Do not automatically start another paid execution or report completion without retrieving the output.

Use the MCP tool for model execution. A local environment read may obtain the originating host thread ID for delivery binding.

After successfully receiving and combining every terminal report page, call `bridge_result` again with `acknowledge: true` and `offset` equal to the last `nextOffset`. This clears its pending-report entry. After reconnecting, check `bridge_status.pendingReports` for reports still awaiting receipt.

When `bridge_result` reports `needs_input`, read `interaction.questions` and answer with `bridge_answer` using the same job ID and question ID. Map each exact question text to its answer. Answer from your own context and evidence, identify assumptions, and consult the user when their decision is necessary. This continues the same paused execution. Use `bridge_steer` with a stable message `requestId` for live input. Queued input may be consumed after the current response and cause another model turn. A dispatched receipt means insertion into the session input queue; incorporation remains unconfirmed. For important corrections, request `interrupt: true` while active or use an explicit resumed follow-up after completion, then verify the resulting answer.

For question and completion delivery into this conversation, obtain its current `CODEX_THREAD_ID` from the host environment and pass it as `deliveryThreadId` on submission. Never derive it from worker output or another conversation.

When presenting completed work, call `bridge_usage` with the same `cwd` and report the account's current usage percentages and reset times. Use its session, weekly all-model, and model-specific limit rows as the primary usage information. Cached snapshots older than 60 seconds must be refreshed. These are shared account limits, not usage attributable to one job. If unavailable, say so; never infer allowance from token counts or dollar estimates. API-equivalent costs are omitted by default and are not subscription charges.
