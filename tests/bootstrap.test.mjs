import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("bootstrap directories contain tracked placeholders", () => {
  const expectedPlaceholderPaths = [
    "plugins/claude-bridge/prompts/.gitkeep",
    "plugins/claude-bridge/schemas/.gitkeep",
    "plugins/claude-bridge/skills/.gitkeep",
    "plugins/claude-bridge/.codex-plugin/.gitkeep",
    ".agents/plugins/.gitkeep"
  ];

  for (const relativePath of expectedPlaceholderPaths) {
    assert.equal(
      fs.existsSync(path.resolve(relativePath)),
      true,
      `missing placeholder: ${relativePath}`
    );
  }
});
