import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";

const snapshots = new Map();
const pending = new Map();
const MAX_AGE_MS = 60000;
const keyFor = ({ binary, cwd, homeDir }) => JSON.stringify([binary, cwd, homeDir]);
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
const text = (value) => typeof value === "string" ? value : null;

function meter(row, observedAt) {
  const usedPercent = percent(row.percent);
  const resetsAt = text(row.resets_at);
  const resetMs = Date.parse(resetsAt);
  const model = text(row.scope?.model?.display_name);
  const surface = text(row.scope?.surface?.display_name);
  const scope = [model, surface].filter(Boolean).join(" · ");
  const label = text(row.label) ?? (row.kind === "session" ? "Session limit" :
    row.kind === "weekly_all" ? "Weekly · all models" :
    row.kind === "weekly_scoped" ? `Weekly${scope ? ` · ${scope}` : " · scoped"}` :
    `${text(row.group) ?? text(row.kind) ?? "Usage limit"}${scope ? ` · ${scope}` : ""}`);
  return {
    kind: text(row.kind), group: text(row.group), label,
    usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    resetsAt: Number.isFinite(resetMs) ? resetsAt : null,
    resetsInSeconds: Number.isFinite(resetMs) ? Math.max(0, Math.ceil((resetMs - Date.parse(observedAt)) / 1000)) : null,
    scope: { model, surface }, severity: text(row.severity), isActive: row.is_active === true,
  };
}

export function normalizePlanUsage(data, observedAt = new Date().toISOString()) {
  const limits = data?.rate_limits;
  const base = { observedAt, subscriptionType: text(data?.subscription_type), scope: "account", source: "subscription-usage-endpoint", modelPromptSent: false };
  if (data?.rate_limits_available !== true || !limits || typeof limits !== "object") {
    return { ...base, available: false, reason: "Plan limits are unavailable for this authentication method or account scope.", limits: [] };
  }
  let rows = limits.limits;
  if (!Array.isArray(rows)) {
    rows = [];
    const add = (value, kind, group, displayName) => {
      if (value && typeof value === "object") rows.push({ kind, group, percent: value.utilization,
        resets_at: value.resets_at, ...(displayName ? { scope: { model: { display_name: displayName } } } : {}) });
    };
    add(limits.five_hour, "session", "session");
    add(limits.seven_day, "weekly_all", "weekly");
    if (Array.isArray(limits.model_scoped)) {
      for (const item of limits.model_scoped) add(item, "weekly_scoped", "weekly", item?.display_name);
    } else {
      for (const [key, value] of Object.entries(limits)) {
        if (key.startsWith("seven_day_") && value && typeof value === "object") {
          add(value, "weekly_scoped", "weekly", key.slice("seven_day_".length).replaceAll("_", " "));
        }
      }
    }
  }
  return { ...base, available: true, limits: rows.filter((row) => row && typeof row === "object").map((row) => meter(row, observedAt)),
    extraUsage: { enabled: limits.extra_usage?.is_enabled === true || limits.spend?.enabled === true } };
}

export function cachedPlanUsage(options, now = Date.now()) {
  const snapshot = snapshots.get(keyFor(options));
  if (!snapshot) return { available: false, reason: "Not checked in this server connection. Call bridge_usage for current plan limits.", limits: [], refreshTool: "bridge_usage" };
  const ageMs = Math.max(0, now - Date.parse(snapshot.observedAt));
  return { ...snapshot, cached: true, ageSeconds: Math.floor(ageMs / 1000), stale: ageMs >= MAX_AGE_MS,
    limits: snapshot.limits.map((row) => ({ ...row, resetsInSeconds: row.resetsAt ? Math.max(0, Math.ceil((Date.parse(row.resetsAt) - now) / 1000)) : null })),
    refreshTool: "bridge_usage" };
}

export async function readPlanUsage({ binary, cwd, homeDir, refresh = false, timeoutMs = 15000, queryImpl = defaultQuery }) {
  const options = { binary, cwd, homeDir };
  const key = keyFor(options);
  if (pending.has(key)) return pending.get(key);
  const cached = cachedPlanUsage(options);
  if (!refresh && cached.observedAt && !cached.stale) return cached;
  const operation = (async () => {
    const controller = new AbortController();
    let finishInput, timer, session;
    const held = new Promise((resolve) => { finishInput = resolve; });
    const prompt = (async function* () { await held; })();
    try {
      session = queryImpl({ prompt, options: { pathToClaudeCodeExecutable: binary, cwd,
        tools: [], settingSources: [], extraArgs: { "strict-mcp-config": null },
        persistSession: false, abortController: controller, stderr: () => {} } });
      const method = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof method !== "function") throw new Error("unsupported");
      const data = await Promise.race([method.call(session, { skipBehaviors: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]);
      const snapshot = normalizePlanUsage(data);
      snapshots.set(key, snapshot);
      return { ...snapshot, cached: false, stale: false, refreshTool: "bridge_usage" };
    } catch {
      const snapshot = { available: false, observedAt: new Date().toISOString(), scope: "account", modelPromptSent: false,
        reason: "The structured plan usage check failed or is unsupported by the installed runtime. No model prompt was sent; no percentages were inferred from token or cost estimates.", limits: [] };
      snapshots.set(key, snapshot);
      return snapshot;
    } finally {
      clearTimeout(timer);
      finishInput();
      try { session?.close(); } finally { controller.abort(); }
    }
  })();
  pending.set(key, operation);
  try { return await operation; }
  finally { pending.delete(key); }
}

export function costMetadata(job, includeCostEstimates = false) {
  if (!includeCostEstimates) return {};
  return { estimatedApiEquivalentUsd: job.sessionCostUsd ?? null,
    costScope: "conversation-api-equivalent-estimate", isBillingRecord: false,
    costNote: "Token-price estimate for the conversation, including resumed turns. This is not a subscription charge or a measure of plan-limit usage." };
}

export function modelUsageMetadata(usage, includeCostEstimates = false) {
  if (!usage || includeCostEstimates) return usage ?? null;
  return Object.fromEntries(Object.entries(usage).map(([key, value]) => [key,
    value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([field]) => field !== "costUSD" && field !== "costUsd")) : value]));
}
