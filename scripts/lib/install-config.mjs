import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_BEGIN = "# BEGIN CLAUDE BRIDGE MANAGED BLOCK";
export const MANAGED_END = "# END CLAUDE BRIDGE MANAGED BLOCK";

export const READ_ONLY_TOOL_APPROVALS = [
  "bridge_setup",
  "bridge_review",
  "bridge_status",
  "bridge_result"
];

export const SKILL_NAMES = [
  "claude-setup",
  "claude-review",
  "claude-delegate",
  "claude-status",
  "claude-result",
  "claude-cancel"
];

function tomlString(value) {
  return JSON.stringify(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveCodexConfigPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".codex", "config.toml");
}

export function getManagedPaths({ runtimeHome }) {
  const pluginRoot = path.join(runtimeHome, "plugins", "claude-bridge");
  const skillRoot = path.join(pluginRoot, "skills");

  return {
    pluginRoot,
    mcpScript: path.join(pluginRoot, "scripts", "mcp-server.mjs"),
    skillPaths: SKILL_NAMES.map((skillName) => path.join(skillRoot, skillName))
  };
}

export function renderManagedConfigBlock({ runtimeHome }) {
  const { mcpScript, skillPaths } = getManagedPaths({ runtimeHome });

  const lines = [
    MANAGED_BEGIN,
    "[mcp_servers.claude-bridge]",
    'command = "node"',
    `args = [${tomlString(mcpScript)}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 1800",
    ""
  ];

  for (const toolName of READ_ONLY_TOOL_APPROVALS) {
    lines.push(`[mcp_servers.claude-bridge.tools.${toolName}]`);
    lines.push('approval_mode = "approve"');
    lines.push("");
  }

  for (const skillPath of skillPaths) {
    lines.push("[[skills.config]]");
    lines.push(`path = ${tomlString(skillPath)}`);
    lines.push("enabled = true");
    lines.push("");
  }

  lines.push(MANAGED_END);
  return lines.join("\n");
}

export function upsertManagedConfigBlock({ configText, runtimeHome }) {
  const block = renderManagedConfigBlock({ runtimeHome });
  const pattern = new RegExp(
    `${escapeRegex(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegex(MANAGED_END)}\\n?`,
    "m"
  );

  if (pattern.test(configText)) {
    return configText.replace(pattern, `${block}\n`);
  }

  const trimmed = configText.trimEnd();
  if (!trimmed) {
    return `${block}\n`;
  }

  return `${trimmed}\n\n${block}\n`;
}

export function hasManagedConfigTargets({ configText, runtimeHome }) {
  const { mcpScript, skillPaths } = getManagedPaths({ runtimeHome });

  if (!configText.includes("[mcp_servers.claude-bridge]")) {
    return false;
  }

  if (!configText.includes(`args = [${tomlString(mcpScript)}]`)) {
    return false;
  }

  return skillPaths.every((skillPath) =>
    configText.includes(`path = ${tomlString(skillPath)}`)
  );
}

export function writeManagedConfigBlock(
  {
    runtimeHome,
    configPath = resolveCodexConfigPath()
  },
  {
    mkdirSync = fs.mkdirSync,
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync
  } = {}
) {
  mkdirSync(path.dirname(configPath), { recursive: true });

  let currentText = "";
  try {
    currentText = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const updatedText = upsertManagedConfigBlock({ configText: currentText, runtimeHome });
  if (updatedText !== currentText) {
    writeFileSync(configPath, updatedText, "utf8");
  }

  return { configPath, updatedText };
}
