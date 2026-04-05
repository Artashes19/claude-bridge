import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("bootstrap directories exist after checkout", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const expectedDirectories = [
    "plugins/claude-bridge/prompts",
    "plugins/claude-bridge/schemas",
    "plugins/claude-bridge/skills",
    "plugins/claude-bridge/.codex-plugin",
    ".agents/plugins"
  ];

  for (const relativePath of expectedDirectories) {
    const absolutePath = path.join(repoRoot, relativePath);
    assert.equal(
      fs.statSync(absolutePath).isDirectory(),
      true,
      `missing directory: ${relativePath}`
    );
  }
});
