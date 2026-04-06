import fs from "node:fs";

export const DEFAULT_CONFIG = {
  models: {
    aliases: {
      opus: "claude-opus-4-6",
      sonnet: "claude-sonnet-4-6",
      haiku: "claude-haiku-4-5-20251001"
    },
    defaults: {
      review: "opus",
      delegate: "sonnet"
    }
  },
  runtime: {
    defaultEffort: "high",
    defaultBackground: false,
    claudeBinary: "claude"
  }
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = cloneValue(nestedValue);
    }
    return result;
  }
  return value;
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadMergedConfig({ repoConfigPath, globalConfigPath }) {
  const globalConfig = readJsonIfExists(globalConfigPath);
  const repoConfig = readJsonIfExists(repoConfigPath);
  return deepMerge(deepMerge(cloneValue(DEFAULT_CONFIG), globalConfig), repoConfig);
}

export function resolveModel({ command, requestedModel, config }) {
  const rawValue = requestedModel ?? config.models.defaults[command];
  if (!rawValue) {
    throw new Error(`Missing model default for command "${command}".`);
  }
  return config.models.aliases[rawValue] ?? rawValue;
}

export function resolveEffort({ requestedEffort, config }) {
  return requestedEffort ?? config.runtime.defaultEffort;
}

export function resolveClaudeBinary({ config, env = process.env }) {
  return env.CLAUDE_BRIDGE_CLAUDE_BIN ?? config.runtime.claudeBinary ?? "claude";
}
