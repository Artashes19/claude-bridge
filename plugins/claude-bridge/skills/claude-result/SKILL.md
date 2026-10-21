---
name: claude-result
description: Use when the user wants the stored output for a Claude Bridge job.
---

For named conversations, use `bridge_sessions` to find the correct topic, working directory and job ID. Present `project`, `title`, and `accountSession.url` when available. Topic projects belong to the bridge, not the application's native Projects. A persistent read-only viewer keeps published history online after model workers finish. `messagesUploaded` counts transport-flushed messages; client rendering requires verification. The viewer appears in the Remote Control section; it does not create regular desktop sessions, projects, workspaces, or sidebar groups. `offline` means the viewer needs reconnection. Automated continuation uses bridge resume. Use `bridge_share` only when Remote Control viewing is wanted, to publish an inactive saved native history without sending a model prompt. Regular desktop workspace integration is not implemented. Never rerun a paid task merely because account sharing is unavailable or unconfirmed.

# Claude Result

Call the `bridge_result` MCP tool with `jobId` (required, or "latest") and `cwd`.

Retrieval reads saved output and does not spend tokens on another execution. For queued/running jobs, use `waitSeconds: 30` and continue until terminal status; partial output is not a finished report. For terminal jobs, start at offset 0 and follow `nextOffset` while `hasMore` is true, combining all pages. Include relevant diagnostics for failed jobs and retain the job ID and output path for recovery. Do not resubmit a task merely because its output is delayed or paged.

Do NOT run shell commands — use the MCP tool.

After successfully receiving and combining every terminal report page, call `bridge_result` again with `acknowledge: true` and `offset` equal to the last `nextOffset`. This clears its pending-report entry. After reconnecting, check `bridge_status.pendingReports` for reports still awaiting receipt.

When `bridge_result` reports `needs_input`, read `interaction.questions` and answer with `bridge_answer` using the same job ID and question ID. Map each exact question text to its answer. Answer from your own context and evidence, identify assumptions, and consult the user when their decision is necessary. This continues the same paused execution. Use `bridge_steer` with a stable message `requestId` for live input. Queued input may be consumed after the current response and cause another model turn. A dispatched receipt means insertion into the session input queue; incorporation remains unconfirmed. For important corrections, request `interrupt: true` while active or use an explicit resumed follow-up after completion, then verify the resulting answer.

When presenting completed work, call `bridge_usage` with the same `cwd` and report the account's current usage percentages and reset times. Use its session, weekly all-model, and model-specific limit rows as the primary usage information. Cached snapshots older than 60 seconds must be refreshed. These are shared account limits, not usage attributable to one job. If unavailable, say so; never infer allowance from token counts or dollar estimates. API-equivalent costs are omitted by default and are not subscription charges.
