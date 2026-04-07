import test from "node:test";
import assert from "node:assert/strict";

import {
  MANAGED_BEGIN,
  READ_ONLY_TOOL_APPROVALS,
  SKILL_NAMES,
  getManagedPaths,
  hasManagedConfigTargets,
  renderManagedConfigBlock,
  upsertManagedConfigBlock
} from "../scripts/lib/install-config.mjs";

const runtimeHome = "/home/test/.local/share/claude-bridge";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("renderManagedConfigBlock includes runtime-owned MCP and all skill paths", () => {
  const block = renderManagedConfigBlock({ runtimeHome });
  const paths = getManagedPaths({ runtimeHome });

  assert.match(block, /\[mcp_servers\.claude-bridge\]/);
  assert.match(block, /tool_timeout_sec = 1800/);
  assert.match(block, new RegExp(escapeRegex(paths.mcpScript)));
  assert.equal(SKILL_NAMES.length, 6);

  for (const toolName of READ_ONLY_TOOL_APPROVALS) {
    assert.match(block, new RegExp(escapeRegex("[mcp_servers.claude-bridge.tools." + toolName + "]")));
    assert.match(block, /approval_mode = "approve"/);
  }

  for (const skillPath of paths.skillPaths) {
    assert.match(block, new RegExp(escapeRegex(skillPath)));
  }
});

test("upsertManagedConfigBlock appends the managed block when config is missing one", () => {
  const updated = upsertManagedConfigBlock({
    configText: 'model = "gpt-5.4"\n',
    runtimeHome
  });
  const expectedBlock = renderManagedConfigBlock({ runtimeHome });

  assert.equal(updated, 'model = "gpt-5.4"\n\n' + expectedBlock + '\n');
});

test("upsertManagedConfigBlock normalizes legacy unmanaged Claude Bridge config while preserving adjacent unrelated settings", () => {
  const legacyConfig = [
    'model = "gpt-5.4"',
    '[mcp_servers.claude-bridge]',
    'command = "node"',
    'args = ["~/plugins/claude-bridge/scripts/mcp-server.mjs"]',
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 60',
    '[[skills.config]]',
    'path = "~/plugins/claude-bridge/skills/claude-setup"',
    'enabled = true',
    '[[skills.config]]',
    'path = "~/plugins/claude-bridge/skills/claude-review"',
    'enabled = true',
    '[profiles.release]',
    'doctor = true',
    ''
  ].join("\n");

  const updated = upsertManagedConfigBlock({ configText: legacyConfig, runtimeHome });
  const expectedBlock = renderManagedConfigBlock({ runtimeHome });

  assert.equal(
    updated,
    'model = "gpt-5.4"\n\n[profiles.release]\ndoctor = true\n\n' + expectedBlock + '\n'
  );
  assert.equal(updated.split('[mcp_servers.claude-bridge]').length - 1, 1);
  assert.equal(updated.split('[[skills.config]]').length - 1, SKILL_NAMES.length);
  assert.match(updated, /\[profiles\.release\]\ndoctor = true/);
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

test("hasManagedConfigTargets validates the full managed contract", () => {
  const block = renderManagedConfigBlock({ runtimeHome });
  const paths = getManagedPaths({ runtimeHome });

  assert.equal(hasManagedConfigTargets({ configText: block, runtimeHome }), true);
  assert.equal(
    hasManagedConfigTargets({
      configText: block.replace(paths.mcpScript, paths.mcpScript + ".missing"),
      runtimeHome
    }),
    false
  );

  for (const skillPath of paths.skillPaths) {
    assert.equal(
      hasManagedConfigTargets({
        configText: block.replace(skillPath, skillPath + ".missing"),
        runtimeHome
      }),
      false
    );
  }

  assert.equal(
    hasManagedConfigTargets({
      configText: block.replace("tool_timeout_sec = 1800", "tool_timeout_sec = 60"),
      runtimeHome
    }),
    false
  );
  assert.equal(
    hasManagedConfigTargets({
      configText: block.replace(
        '[mcp_servers.claude-bridge.tools.bridge_review]\napproval_mode = "approve"\n\n',
        ""
      ),
      runtimeHome
    }),
    false
  );
});

test("hasManagedConfigTargets fails when managed skill path entries are duplicated", () => {
  const block = renderManagedConfigBlock({ runtimeHome });
  const paths = getManagedPaths({ runtimeHome });
  const duplicatedSkill = [
    '[[skills.config]]',
    'path = "' + paths.skillPaths[0] + '"',
    'enabled = true',
    ''
  ].join("\n");

  assert.equal(
    hasManagedConfigTargets({
      configText: block + duplicatedSkill,
      runtimeHome
    }),
    false
  );
});
