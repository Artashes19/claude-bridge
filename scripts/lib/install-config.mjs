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

function createManagedBlockPattern() {
  return new RegExp(
    `${escapeRegex(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegex(MANAGED_END)}\\n?`,
    "gm"
  );
}

function countOccurrences(text, value) {
  return (text.match(new RegExp(escapeRegex(value), "g")) ?? []).length;
}

function splitConfigSegments(configText) {
  return configText
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isClaudeBridgeSkillSegment(segment) {
  if (!segment.startsWith("[[skills.config]]")) {
    return false;
  }

  return SKILL_NAMES.some((skillName) =>
    new RegExp(`^path = ".+[\\/]${escapeRegex(skillName)}"$`, "m").test(segment)
  );
}

function isLegacyClaudeBridgeSegment(segment) {
  return (
    /^\[mcp_servers\.claude-bridge\]$/m.test(segment) ||
    /^\[mcp_servers\.claude-bridge\.tools\./m.test(segment) ||
    isClaudeBridgeSkillSegment(segment)
  );
}

function stripManagedConfigBlock(configText) {
  return configText.replace(createManagedBlockPattern(), "").trim();
}

function stripLegacyClaudeBridgeSegments(configText) {
  return splitConfigSegments(configText)
    .filter((segment) => !isLegacyClaudeBridgeSegment(segment))
    .join("\n\n");
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
  const withoutManagedBlock = stripManagedConfigBlock(configText);
  const withoutLegacyConfig = stripLegacyClaudeBridgeSegments(withoutManagedBlock).trim();

  if (!withoutLegacyConfig) {
    return `${block}\n`;
  }

  return `${withoutLegacyConfig}\n\n${block}\n`;
}

export function hasManagedConfigTargets({ configText, runtimeHome }) {
  const block = renderManagedConfigBlock({ runtimeHome });
  const matches = configText.match(createManagedBlockPattern()) ?? [];
  const { mcpScript, skillPaths } = getManagedPaths({ runtimeHome });

  if (matches.length !== 1) {
    return false;
  }

  if (matches[0].trimEnd() !== block) {
    return false;
  }

  if (countOccurrences(configText, MANAGED_BEGIN) !== 1) {
    return false;
  }

  if (countOccurrences(configText, MANAGED_END) !== 1) {
    return false;
  }

  if (countOccurrences(configText, "[mcp_servers.claude-bridge]") !== 1) {
    return false;
  }

  if (countOccurrences(configText, `args = [${tomlString(mcpScript)}]`) !== 1) {
    return false;
  }

  for (const toolName of READ_ONLY_TOOL_APPROVALS) {
    if (countOccurrences(configText, `[mcp_servers.claude-bridge.tools.${toolName}]`) !== 1) {
      return false;
    }
  }

  return skillPaths.every(
    (skillPath) => countOccurrences(configText, `path = ${tomlString(skillPath)}`) === 1
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
