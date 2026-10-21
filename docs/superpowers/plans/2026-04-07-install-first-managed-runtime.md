# Install-First Managed Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an install-first Claude Bridge management layer that installs or repairs a managed runtime in `~/.local/share/claude-bridge`, wires Codex config idempotently, and provides a doctor command for diagnostics.

**Architecture:** Keep the existing bridge runtime untouched under `plugins/claude-bridge/`, then add a root-level installer and doctor layer that manages runtime checkout, dependency installation, Codex config mutation, and setup verification. Use a marker-delimited block in `~/.codex/config.toml` and export shared config/runtime helpers so install and doctor cannot drift.

**Tech Stack:** Node.js ESM, built-in `node:test`, `assert/strict`, existing bridge runtime scripts, Git and NPM subprocesses.

---

## File Structure

- Create: `scripts/lib/install-config.mjs`
  Responsibility: render, validate, and upsert the managed Claude Bridge block in `~/.codex/config.toml`.
- Create: `scripts/lib/install-runtime.mjs`
  Responsibility: resolve runtime home, clone or update the runtime checkout, run `npm ci`, collect revision and Claude version metadata, and run the installed bridge setup probe.
- Create: `scripts/lib/doctor.mjs`
  Responsibility: collect health checks and render a doctor report using the same runtime and config helpers as the installer.
- Create: `scripts/install.mjs`
  Responsibility: CLI entrypoint for install/repair/update flow.
- Create: `scripts/doctor.mjs`
  Responsibility: CLI entrypoint for diagnostics.
- Create: `tests/install-config.test.mjs`
  Responsibility: unit-test managed config rendering, validation, and idempotent insertion.
- Create: `tests/install.test.mjs`
  Responsibility: unit-test installer orchestration with mocked subprocesses and filesystem state.
- Create: `tests/doctor.test.mjs`
  Responsibility: unit-test healthy and failing doctor reports.
- Modify: `package.json`
  Responsibility: add install/update/doctor package scripts without removing existing metadata.
- Modify: `README.md`
  Responsibility: replace the current manual plugin-copy install with the managed runtime flow.
- Modify: `plugins/claude-bridge/README.md`
  Responsibility: clarify that the plugin directory is an advanced/developer-facing path, not the primary runtime install path.
- Modify: `tests/manifest.test.mjs`
  Responsibility: assert the README now documents the managed runtime flow and new scripts.

### Task 1: Add Managed Codex Config Writer

**Files:**
- Create: `scripts/lib/install-config.mjs`
- Test: `tests/install-config.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install-config.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../scripts/lib/install-config.mjs`

- [ ] **Step 3: Write minimal implementation**

```javascript
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

  if (!configText.includes(mcpScript)) {
    return false;
  }

  return skillPaths.every((skillPath) => configText.includes(skillPath));
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/install-config.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/install-config.test.mjs scripts/lib/install-config.mjs
git commit -m "feat: add managed Codex config writer"
```

### Task 2: Add Managed Runtime Installer

**Files:**
- Create: `scripts/lib/install-runtime.mjs`
- Create: `scripts/install.mjs`
- Test: `tests/install.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CLAUDE_BINARY,
  DEFAULT_SOURCE_URL,
  installBridge,
  resolveRuntimeHome
} from "../scripts/lib/install-runtime.mjs";

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "", stdout = "") {
  return { status: 1, stdout, stderr };
}

test("resolveRuntimeHome uses ~/.local/share/claude-bridge", () => {
  assert.equal(
    resolveRuntimeHome({ homeDir: "/home/test" }),
    "/home/test/.local/share/claude-bridge"
  );
});

test("installBridge clones, installs dependencies, writes config, captures revision, and probes setup", () => {
  const calls = [];

  const result = installBridge(
    {
      homeDir: "/home/test",
      sourceUrl: DEFAULT_SOURCE_URL,
      probeCwd: "/home/test/.local/share/claude-bridge"
    },
    {
      existsSync(target) {
        return false;
      },
      mkdirSync(target) {
        calls.push(["mkdir", target]);
      },
      readFileSync() {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeFileSync(target, text) {
        calls.push(["write", target, text]);
      },
      run(command, args, options) {
        calls.push([command, args, options?.cwd ?? null]);
        if (command === "git" && args[0] === "clone") return ok();
        if (command === "git" && args.includes("rev-parse")) return ok("7f2ce3f\n");
        if (command === "npm") return ok();
        if (command === DEFAULT_CLAUDE_BINARY) return ok("2.1.91 (Claude Code)\n");
        if (command === "node") {
          return ok(
            "Claude Bridge setup\nREADY: yes\nCLAUDE VERSION: 2.1.91 (Claude Code)\n"
          );
        }
        throw new Error(`unexpected command: ${command}`);
      }
    }
  );

  assert.equal(result.ready, true);
  assert.equal(result.checkoutAction, "cloned");
  assert.equal(result.runtimeHome, "/home/test/.local/share/claude-bridge");
  assert.equal(result.revision, "7f2ce3f");
  assert.equal(result.claudeBinary, DEFAULT_CLAUDE_BINARY);
  assert.equal(result.claudeVersion, "2.1.91 (Claude Code)");
  assert.match(result.setupOutput, /READY: yes/);
});

test("installBridge preserves the installed runtime when Claude is unavailable and reports ready false", () => {
  const result = installBridge(
    {
      homeDir: "/home/test",
      probeCwd: "/home/test/.local/share/claude-bridge"
    },
    {
      existsSync(target) {
        return target.endsWith("/.git");
      },
      mkdirSync() {},
      readFileSync() {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeFileSync() {},
      run(command, args) {
        if (command === "git" && args.includes("pull")) return ok();
        if (command === "git" && args.includes("rev-parse")) return ok("3076345\n");
        if (command === "npm") return ok();
        if (command === DEFAULT_CLAUDE_BINARY) return fail("claude: command not found");
        if (command === "node") {
          return ok("Claude Bridge setup\nREADY: no\nDETAIL: claude: command not found\n");
        }
        throw new Error(`unexpected command: ${command}`);
      }
    }
  );

  assert.equal(result.checkoutAction, "updated");
  assert.equal(result.ready, false);
  assert.equal(result.revision, "3076345");
  assert.equal(result.claudeVersion, "");
  assert.match(result.setupDetail, /command not found/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/install.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../scripts/lib/install-runtime.mjs`

- [ ] **Step 3: Write minimal implementation**

`scripts/lib/install-runtime.mjs`

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { writeManagedConfigBlock } from "./install-config.mjs";

export const DEFAULT_SOURCE_URL = "https://github.com/Artashes19/claude-bridge.git";
export const DEFAULT_CLAUDE_BINARY = "claude";

function runResult(run, command, args, options = {}) {
  return run(command, args, { encoding: "utf8", ...options });
}

function runOrThrow(run, command, args, options, label) {
  const result = runResult(run, command, args, options);
  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `${label} failed: ${stderr || stdout || result.error?.message || "unknown error"}`
    );
  }
  return result;
}

export function resolveRuntimeHome({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".local", "share", "claude-bridge");
}

export function parseSetupReport(text) {
  const lines = text.split(/\r?\n/);
  const readyLine = lines.find((line) => line.startsWith("READY:")) ?? "READY: no";
  const versionLine =
    lines.find((line) => line.startsWith("CLAUDE VERSION:")) ?? "CLAUDE VERSION:";
  const detailLine = lines.find((line) => line.startsWith("DETAIL:")) ?? "";

  return {
    ready: readyLine.trim().endsWith("yes"),
    version: versionLine.replace("CLAUDE VERSION:", "").trim(),
    detail: detailLine.replace("DETAIL:", "").trim()
  };
}

export function ensureRuntimeCheckout(
  { runtimeHome, sourceUrl = DEFAULT_SOURCE_URL },
  { existsSync = fs.existsSync, mkdirSync = fs.mkdirSync, run = spawnSync } = {}
) {
  mkdirSync(path.dirname(runtimeHome), { recursive: true });

  const gitDir = path.join(runtimeHome, ".git");
  if (!existsSync(gitDir)) {
    runOrThrow(run, "git", ["clone", sourceUrl, runtimeHome], {}, "git clone");
    const revision = runOrThrow(
      run,
      "git",
      ["-C", runtimeHome, "rev-parse", "--short", "HEAD"],
      {},
      "git rev-parse"
    ).stdout.trim();
    return { action: "cloned", runtimeHome, sourceUrl, revision };
  }

  runOrThrow(run, "git", ["-C", runtimeHome, "pull", "--ff-only"], {}, "git pull");
  const revision = runOrThrow(
    run,
    "git",
    ["-C", runtimeHome, "rev-parse", "--short", "HEAD"],
    {},
    "git rev-parse"
  ).stdout.trim();
  return { action: "updated", runtimeHome, sourceUrl, revision };
}

export function ensureRuntimeDependencies({ runtimeHome }, { run = spawnSync } = {}) {
  runOrThrow(run, "npm", ["ci"], { cwd: runtimeHome }, "npm ci");
}

export function readClaudeVersion(
  { claudeBinary = DEFAULT_CLAUDE_BINARY },
  { run = spawnSync } = {}
) {
  const result = runResult(run, claudeBinary, ["--version"]);
  if ((result.status ?? 1) !== 0) {
    return {
      ok: false,
      binary: claudeBinary,
      version: "",
      detail: (result.stderr ?? "").trim() || result.error?.message || "unknown error"
    };
  }

  return {
    ok: true,
    binary: claudeBinary,
    version: (result.stdout ?? "").trim(),
    detail: ""
  };
}

export function runSetupProbe(
  { runtimeHome, probeCwd = runtimeHome },
  { run = spawnSync } = {}
) {
  const scriptPath = path.join(runtimeHome, "plugins", "claude-bridge", "scripts", "claude-bridge.mjs");
  const result = runResult(run, "node", [scriptPath, "setup", "--cwd", probeCwd], {
    cwd: runtimeHome
  });
  const parsed = parseSetupReport(result.stdout ?? "");

  return {
    ok: (result.status ?? 1) === 0,
    ready: parsed.ready,
    version: parsed.version,
    detail:
      parsed.detail ||
      (result.stderr ?? "").trim() ||
      (result.stdout ?? "").trim() ||
      result.error?.message ||
      "unknown error",
    stdout: result.stdout ?? ""
  };
}

export function installBridge(
  {
    homeDir = os.homedir(),
    runtimeHome = resolveRuntimeHome({ homeDir }),
    sourceUrl = DEFAULT_SOURCE_URL,
    probeCwd = runtimeHome,
    claudeBinary = DEFAULT_CLAUDE_BINARY
  },
  deps = {}
) {
  const checkout = ensureRuntimeCheckout({ runtimeHome, sourceUrl }, deps);
  ensureRuntimeDependencies({ runtimeHome }, deps);
  const configWrite = writeManagedConfigBlock({ runtimeHome }, deps);
  const claude = readClaudeVersion({ claudeBinary }, deps);
  const probe = runSetupProbe({ runtimeHome, probeCwd }, deps);

  return {
    runtimeHome,
    configPath: configWrite.configPath,
    checkoutAction: checkout.action,
    revision: checkout.revision,
    claudeBinary: claude.binary,
    claudeVersion: claude.ok ? claude.version : probe.version,
    ready: probe.ready,
    setupDetail: probe.detail,
    setupOutput: probe.stdout
  };
}
```

`scripts/install.mjs`

```javascript
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SOURCE_URL,
  installBridge,
  resolveRuntimeHome
} from "./lib/install-runtime.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

function printSummary(result) {
  console.log("Claude Bridge install");
  console.log(`CHECKOUT: ${result.checkoutAction}`);
  console.log(`RUNTIME HOME: ${result.runtimeHome}`);
  console.log(`CONFIG PATH: ${result.configPath}`);
  console.log(`REVISION: ${result.revision || "unknown"}`);
  console.log(`CLAUDE BINARY: ${result.claudeBinary}`);
  console.log(`CLAUDE VERSION: ${result.claudeVersion || "unavailable"}`);
  console.log(`READY: ${result.ready ? "yes" : "no"}`);
  console.log(
    `NEXT STEP: ${result.ready ? "restart Codex if it is already running" : result.setupDetail}`
  );
}

const options = parseArgs(process.argv.slice(2));
const homeDir = options["home-dir"] ? path.resolve(options["home-dir"]) : os.homedir();
const runtimeHome = options["runtime-home"]
  ? path.resolve(options["runtime-home"])
  : resolveRuntimeHome({ homeDir });
const probeCwd = options.cwd ? path.resolve(options.cwd) : runtimeHome;
const sourceUrl = options["source-url"] ?? DEFAULT_SOURCE_URL;

try {
  const result = installBridge({ homeDir, runtimeHome, probeCwd, sourceUrl });
  printSummary(result);
  process.exit(result.ready ? 0 : 1);
} catch (error) {
  console.error("Claude Bridge install failed");
  console.error(error?.message ?? String(error));
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/install.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/install.test.mjs scripts/lib/install-runtime.mjs scripts/install.mjs
git commit -m "feat: add managed runtime installer"
```

### Task 3: Add Doctor Diagnostics

**Files:**
- Create: `scripts/lib/doctor.mjs`
- Create: `scripts/doctor.mjs`
- Test: `tests/doctor.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectDoctorReport,
  renderDoctorReport
} from "../scripts/lib/doctor.mjs";

function ok(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = "", stdout = "") {
  return { status: 1, stdout, stderr };
}

test("collectDoctorReport reports ready for a healthy install", () => {
  const report = collectDoctorReport(
    { homeDir: "/home/test" },
    {
      existsSync(target) {
        return [
          "/home/test/.local/share/claude-bridge",
          "/home/test/.local/share/claude-bridge/node_modules"
        ].includes(target);
      },
      readFileSync() {
        return `model = "gpt-5.4"\n\n[mcp_servers.claude-bridge]\ncommand = "node"\nargs = ["/home/test/.local/share/claude-bridge/plugins/claude-bridge/scripts/mcp-server.mjs"]\n\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-setup"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-review"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-delegate"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-status"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-result"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-cancel"\nenabled = true\n`;
      },
      run(command, args) {
        if (command === "node" && args[0] === "--version") return ok("v24.14.1\n");
        if (command === "claude") return ok("2.1.91 (Claude Code)\n");
        if (command === "node" && args[0].endsWith("claude-bridge.mjs")) {
          return ok("Claude Bridge setup\nREADY: yes\nCLAUDE VERSION: 2.1.91 (Claude Code)\n");
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      }
    }
  );

  assert.equal(report.ready, true);
  assert.match(renderDoctorReport(report), /\[ok\] setup: ready/);
});

test("collectDoctorReport reports missing Claude separately from broken Codex config", () => {
  const report = collectDoctorReport(
    { homeDir: "/home/test" },
    {
      existsSync(target) {
        return [
          "/home/test/.local/share/claude-bridge",
          "/home/test/.local/share/claude-bridge/node_modules"
        ].includes(target);
      },
      readFileSync() {
        return 'model = "gpt-5.4"\n';
      },
      run(command, args) {
        if (command === "node" && args[0] === "--version") return ok("v24.14.1\n");
        if (command === "claude") return fail("claude: command not found");
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      }
    }
  );

  assert.equal(report.ready, false);
  assert.equal(report.checks.find((check) => check.name === "claude")?.ok, false);
  assert.equal(report.checks.find((check) => check.name === "codex-config")?.ok, false);
});

test("collectDoctorReport reports unauthenticated Claude from the live setup probe", () => {
  const report = collectDoctorReport(
    { homeDir: "/home/test" },
    {
      existsSync(target) {
        return [
          "/home/test/.local/share/claude-bridge",
          "/home/test/.local/share/claude-bridge/node_modules"
        ].includes(target);
      },
      readFileSync() {
        return `model = "gpt-5.4"\n\n[mcp_servers.claude-bridge]\ncommand = "node"\nargs = ["/home/test/.local/share/claude-bridge/plugins/claude-bridge/scripts/mcp-server.mjs"]\n\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-setup"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-review"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-delegate"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-status"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-result"\nenabled = true\n[[skills.config]]\npath = "/home/test/.local/share/claude-bridge/plugins/claude-bridge/skills/claude-cancel"\nenabled = true\n`;
      },
      run(command, args) {
        if (command === "node" && args[0] === "--version") return ok("v24.14.1\n");
        if (command === "claude") return ok("2.1.91 (Claude Code)\n");
        if (command === "node" && args[0].endsWith("claude-bridge.mjs")) {
          return ok(
            "Claude Bridge setup\nREADY: no\nDETAIL: Not logged in · Please run /login\nCLAUDE VERSION: 2.1.91 (Claude Code)\n"
          );
        }
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      }
    }
  );

  assert.equal(report.ready, false);
  assert.match(renderDoctorReport(report), /Not logged in/);
  assert.equal(report.checks.find((check) => check.name === "setup")?.ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/doctor.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../scripts/lib/doctor.mjs`

- [ ] **Step 3: Write minimal implementation**

`scripts/lib/doctor.mjs`

```javascript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  hasManagedConfigTargets,
  resolveCodexConfigPath
} from "./install-config.mjs";
import {
  readClaudeVersion,
  resolveRuntimeHome,
  runSetupProbe
} from "./install-runtime.mjs";

function runCheck(run, command, args, options = {}) {
  const result = run(command, args, { encoding: "utf8", ...options });
  const ok = (result.status ?? 1) === 0;
  return {
    ok,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    detail: ok
      ? (result.stdout ?? "").trim()
      : (result.stderr ?? "").trim() || result.error?.message || "unknown error"
  };
}

export function collectDoctorReport(
  {
    homeDir = os.homedir(),
    runtimeHome = resolveRuntimeHome({ homeDir }),
    probeCwd = runtimeHome,
    configPath = resolveCodexConfigPath({ homeDir })
  },
  {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
    run = spawnSync
  } = {}
) {
  const checks = [];

  const nodeCheck = runCheck(run, "node", ["--version"]);
  checks.push({ name: "node", ok: nodeCheck.ok, detail: nodeCheck.detail || "node missing" });

  const claudeCheck = readClaudeVersion({}, { run });
  checks.push({
    name: "claude",
    ok: claudeCheck.ok,
    detail: claudeCheck.ok ? claudeCheck.version : claudeCheck.detail
  });

  const runtimeOk = existsSync(runtimeHome);
  checks.push({ name: "runtime", ok: runtimeOk, detail: runtimeHome });

  const dependenciesOk = existsSync(path.join(runtimeHome, "node_modules"));
  checks.push({
    name: "dependencies",
    ok: dependenciesOk,
    detail: dependenciesOk ? "node_modules present" : "node_modules missing"
  });

  let configText = "";
  try {
    configText = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const configOk = hasManagedConfigTargets({ configText, runtimeHome });
  checks.push({ name: "codex-config", ok: configOk, detail: configPath });

  let version = claudeCheck.ok ? claudeCheck.version : "";
  if (nodeCheck.ok && runtimeOk && dependenciesOk && configOk) {
    const probe = runSetupProbe({ runtimeHome, probeCwd }, { run });
    version = probe.version || version;
    checks.push({
      name: "setup",
      ok: probe.ready,
      detail: probe.ready ? "ready" : probe.detail
    });
  } else {
    checks.push({ name: "setup", ok: false, detail: "skipped until prerequisites are healthy" });
  }

  return {
    ready: checks.every((check) => check.ok),
    runtimeHome,
    configPath,
    version,
    checks
  };
}

export function renderDoctorReport(report) {
  const lines = ["Claude Bridge doctor"];
  for (const check of report.checks) {
    lines.push(`[${check.ok ? "ok" : "fail"}] ${check.name}: ${check.detail}`);
  }
  lines.push(`READY: ${report.ready ? "yes" : "no"}`);
  if (report.version) {
    lines.push(`CLAUDE VERSION: ${report.version}`);
  }
  return lines.join("\n");
}
```

`scripts/doctor.mjs`

```javascript
import os from "node:os";
import path from "node:path";

import { collectDoctorReport, renderDoctorReport } from "./lib/doctor.mjs";
import { resolveRuntimeHome } from "./lib/install-runtime.mjs";
import { resolveCodexConfigPath } from "./lib/install-config.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const homeDir = options["home-dir"] ? path.resolve(options["home-dir"]) : os.homedir();
const runtimeHome = options["runtime-home"]
  ? path.resolve(options["runtime-home"])
  : resolveRuntimeHome({ homeDir });
const configPath = options["config-path"]
  ? path.resolve(options["config-path"])
  : resolveCodexConfigPath({ homeDir });
const probeCwd = options.cwd ? path.resolve(options.cwd) : runtimeHome;

try {
  const report = collectDoctorReport({ homeDir, runtimeHome, configPath, probeCwd });
  console.log(renderDoctorReport(report));
  process.exit(report.ready ? 0 : 1);
} catch (error) {
  console.error("Claude Bridge doctor failed");
  console.error(error?.message ?? String(error));
  process.exit(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/doctor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/doctor.test.mjs scripts/lib/doctor.mjs scripts/doctor.mjs
git commit -m "feat: add bridge doctor command"
```

### Task 4: Rewrite Docs And Expose The New Commands

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Modify: `plugins/claude-bridge/README.md`
- Modify: `tests/manifest.test.mjs`

- [ ] **Step 1: Write the failing documentation and package-script tests**

Replace the existing install-docs test with this block in `tests/manifest.test.mjs`:

```javascript
test("installation docs explain the managed runtime install flow", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  const pluginReadme = fs.readFileSync("plugins/claude-bridge/README.md", "utf8");
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

  assert.equal(packageJson.scripts["install:bridge"], "node scripts/install.mjs");
  assert.equal(packageJson.scripts["update:bridge"], "node scripts/install.mjs");
  assert.equal(packageJson.scripts["doctor:bridge"], "node scripts/doctor.mjs");

  assert.match(readme, /npm run install:bridge/);
  assert.match(readme, /npm run doctor:bridge/);
  assert.match(readme, /~\/\.local\/share\/claude-bridge/);
  assert.match(readme, /managed Claude Bridge block/);
  assert.match(pluginReadme, /advanced plugin development/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manifest.test.mjs`
Expected: FAIL because `package.json` scripts and README text do not match the new managed-runtime install flow yet

- [ ] **Step 3: Write minimal implementation**

`package.json`

```json
{
  "name": "claude-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "install:bridge": "node scripts/install.mjs",
    "update:bridge": "node scripts/install.mjs",
    "doctor:bridge": "node scripts/doctor.mjs",
    "test": "node --test tests/*.test.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.76"
  }
}
```

Replace the top install sections of `README.md` with:

```markdown
## Install

From a clone of this repository, run:

```bash
npm ci
npm run install:bridge
```

This managed install will:

- create or update the runtime in `~/.local/share/claude-bridge`
- run `npm ci` inside the managed runtime
- write a managed Claude Bridge block to `~/.codex/config.toml`
- run a live setup probe against the installed bridge

## Doctor

If anything feels off, run:

```bash
npm run doctor:bridge
```

## Update

To repair or update the managed runtime, re-run:

```bash
npm run update:bridge
```

## Uninstall

1. Delete `~/.local/share/claude-bridge`
2. Remove the managed Claude Bridge block between `# BEGIN CLAUDE BRIDGE MANAGED BLOCK` and `# END CLAUDE BRIDGE MANAGED BLOCK` in `~/.codex/config.toml`
```

Replace the install framing in `plugins/claude-bridge/README.md` with:

```markdown
## Runtime

The primary Claude Bridge install path is the managed runtime created by `npm run install:bridge`, which lives in `~/.local/share/claude-bridge` by default.

This plugin directory remains useful for advanced plugin development and repository-local testing, but it is no longer the primary user installation path.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (`tests/*.test.mjs` all green, including the new install and doctor coverage)

- [ ] **Step 5: Commit**

```bash
git add package.json README.md plugins/claude-bridge/README.md tests/manifest.test.mjs
git commit -m "docs: rewrite install flow around managed runtime"
```
