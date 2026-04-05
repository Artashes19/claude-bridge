import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadMergedConfig,
  resolveClaudeBinary,
  resolveEffort,
  resolveModel
} from "../plugins/claude-bridge/scripts/lib/config.mjs";

test("loadMergedConfig uses repo config over global config", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-config-"));
  const homeDir = path.join(tempRoot, "home");
  const repoRoot = path.join(tempRoot, "repo");

  fs.mkdirSync(path.join(homeDir, ".claude-bridge"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, ".claude-bridge"), { recursive: true });

  fs.writeFileSync(
    path.join(homeDir, ".claude-bridge", "config.json"),
    JSON.stringify({
      models: {
        aliases: { opus: "claude-opus-global" },
        defaults: { review: "haiku" }
      }
    })
  );

  fs.writeFileSync(
    path.join(repoRoot, ".claude-bridge", "config.json"),
    JSON.stringify({
      models: {
        aliases: { opus: "claude-opus-repo" },
        defaults: { review: "opus", delegate: "sonnet" }
      },
      runtime: {
        defaultEffort: "medium"
      }
    })
  );

  const config = loadMergedConfig({
    repoConfigPath: path.join(repoRoot, ".claude-bridge", "config.json"),
    globalConfigPath: path.join(homeDir, ".claude-bridge", "config.json")
  });

  assert.equal(config.models.aliases.opus, "claude-opus-repo");
  assert.equal(config.models.defaults.review, "opus");
  assert.equal(config.runtime.defaultEffort, "medium");
});

test("loadMergedConfig returns isolated config objects", () => {
  const repoConfigPath = path.join(os.tmpdir(), "claude-bridge-missing-repo-config.json");
  const globalConfigPath = path.join(os.tmpdir(), "claude-bridge-missing-global-config.json");

  const firstConfig = loadMergedConfig({ repoConfigPath, globalConfigPath });
  firstConfig.runtime.defaultBackground = true;

  const secondConfig = loadMergedConfig({ repoConfigPath, globalConfigPath });

  assert.equal(secondConfig.runtime.defaultBackground, false);
});

test("resolveModel expands aliases and respects command defaults", () => {
  const config = {
    models: {
      aliases: {
        opus: "claude-opus-latest",
        sonnet: "claude-sonnet-latest",
        haiku: "claude-haiku-latest"
      },
      defaults: {
        review: "opus",
        delegate: "sonnet"
      }
    }
  };

  assert.equal(resolveModel({ command: "review", config }), "claude-opus-latest");
  assert.equal(resolveModel({ command: "delegate", config }), "claude-sonnet-latest");
  assert.equal(
    resolveModel({ command: "review", requestedModel: "haiku", config }),
    "claude-haiku-latest"
  );
  assert.equal(
    resolveModel({ command: "review", requestedModel: "claude-sonnet-4-5", config }),
    "claude-sonnet-4-5"
  );
});

test("resolveEffort and resolveClaudeBinary use explicit values before defaults", () => {
  const config = {
    runtime: {
      defaultEffort: "high",
      claudeBinary: "claude-from-config"
    }
  };

  assert.equal(resolveEffort({ config }), "high");
  assert.equal(resolveEffort({ requestedEffort: "max", config }), "max");
  assert.equal(
    resolveClaudeBinary({ config, env: { CLAUDE_BRIDGE_CLAUDE_BIN: "claude-from-env" } }),
    "claude-from-env"
  );
  assert.equal(resolveClaudeBinary({ config, env: {} }), "claude-from-config");
});
