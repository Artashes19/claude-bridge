import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("plugin manifest contains required Codex metadata", () => {
  const manifest = JSON.parse(
    fs.readFileSync("plugins/claude-bridge/.codex-plugin/plugin.json", "utf8")
  );

  assert.equal(manifest.name, "claude-bridge");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Claude Bridge");
});

test("marketplace entry points to the local plugin path", () => {
  const marketplace = JSON.parse(
    fs.readFileSync(".agents/plugins/marketplace.json", "utf8")
  );

  const entry = marketplace.plugins.find((plugin) => plugin.name === "claude-bridge");
  assert.ok(entry);
  assert.equal(entry.source.path, "./plugins/claude-bridge");
  assert.equal(entry.category, "Coding");
});
