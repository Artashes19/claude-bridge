import test from "node:test";
import assert from "node:assert/strict";

import {
  MANAGED_BEGIN,
  MANAGED_END,
  SKILL_NAMES,
  getManagedPaths,
  hasManagedConfigTargets,
  renderManagedConfigBlock,
  upsertManagedConfigBlock
} from "../scripts/lib/install-config.mjs";

const runtimeHome = "/home/test/.local/share/claude-bridge";

test("renderManagedConfigBlock includes runtime-owned MCP and all skill paths", () => {
  const block = renderManagedConfigBlock({ runtimeHome });
  const { mcpScript, skillPaths } = getManagedPaths({ runtimeHome });

  assert.match(block, /\[mcp_servers\.claude-bridge\]/);
  assert.match(block, /tool_timeout_sec = 1800/);
  assert.match(block, new RegExp(mcpScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(SKILL_NAMES.length, 6);

  for (const skillPath of skillPaths) {
    assert.match(block, new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("upsertManagedConfigBlock appends the managed block when config is missing one", () => {
  const updated = upsertManagedConfigBlock({
    configText: 'model = "gpt-5.4"\n',
    runtimeHome
  });

  assert.match(updated, new RegExp(MANAGED_BEGIN));
  assert.match(updated, new RegExp(MANAGED_END));
  assert.match(updated, /model = "gpt-5\.4"/);
});

test("upsertManagedConfigBlock replaces the existing managed block without duplication", () => {
  const once = upsertManagedConfigBlock({ configText: "", runtimeHome });
  const twice = upsertManagedConfigBlock({
    configText: once.replace("tool_timeout_sec = 1800", "tool_timeout_sec = 60"),
    runtimeHome
  });

  assert.equal(twice.split(MANAGED_BEGIN).length - 1, 1);
  assert.match(twice, /tool_timeout_sec = 1800/);
});

test("hasManagedConfigTargets validates MCP script and all skill paths from shared metadata", () => {
  const block = renderManagedConfigBlock({ runtimeHome });

  assert.equal(hasManagedConfigTargets({ configText: block, runtimeHome }), true);
  assert.equal(
    hasManagedConfigTargets({
      configText: block.replace("claude-cancel", "claude-cancel-missing"),
      runtimeHome
    }),
    false
  );
});
