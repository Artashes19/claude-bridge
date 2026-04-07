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

function isTomlTableHeader(line) {
  const trimmed = line.trim();
  return /^\[\[[^\]]+\]\]$/.test(trimmed) || /^\[[^\]]+\]$/.test(trimmed);
}

function parseConfigSections(configText) {
  const prelude = [];
  const sections = [];
  let current = null;

  for (const line of configText.split("\n")) {
    if (isTomlTableHeader(line)) {
      if (current) {
        sections.push(current);
      }
      current = { header: line.trim(), lines: [line] };
      continue;
    }

    if (current) {
      current.lines.push(line);
      continue;
    }

    prelude.push(line);
  }

  if (current) {
    sections.push(current);
  }

  return { prelude, sections };
}

function renderConfigSections({ prelude, sections }) {
  const blocks = [];
  const preludeText = prelude.join("\n").trim();

  if (preludeText) {
    blocks.push(preludeText);
  }

  for (const section of sections) {
    const text = section.lines.join("\n").trimEnd();
    if (text) {
      blocks.push(text);
    }
  }

  return blocks.join("\n\n");
}

function parseSkillPath(section) {
  if (section.header !== "[[skills.config]]") {
    return "";
  }

  const pathLine = section.lines.find((line) => line.trim().startsWith("path = "));
  const match = pathLine?.match(/^\s*path\s*=\s*"([^"]+)"\s*$/);

  return match?.[1] ?? "";
}

function isClaudeBridgeSkillPath(skillPath) {
  return SKILL_NAMES.some(
    (skillName) =>
      skillPath.includes(`/claude-bridge/skills/${skillName}`) ||
      skillPath.includes(`\\claude-bridge\\skills\\${skillName}`)
  );
}

function isLegacyClaudeBridgeSection(section) {
  if (section.header === "[mcp_servers.claude-bridge]") {
    return true;
  }

  if (/^\[mcp_servers\.claude-bridge\.tools\.[^\]]+\]$/.test(section.header)) {
    return true;
  }

  const skillPath = parseSkillPath(section);
  return Boolean(skillPath) && isClaudeBridgeSkillPath(skillPath);
}

function stripManagedConfigBlock(configText) {
  return configText.replace(createManagedBlockPattern(), "").trim();
}

function stripLegacyClaudeBridgeConfig(configText) {
  const { prelude, sections } = parseConfigSections(configText);
  return renderConfigSections({
    prelude,
    sections: sections.filter((section) => !isLegacyClaudeBridgeSection(section))
  });
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
  const withoutLegacyConfig = stripLegacyClaudeBridgeConfig(withoutManagedBlock).trim();

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
