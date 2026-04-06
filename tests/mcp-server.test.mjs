import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "claude-bridge",
  "scripts",
  "mcp-server.mjs"
);

function sendJsonRpc(child, obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function collectResponse(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          clearTimeout(timer);
          child.stdout.removeListener("data", onData);
          resolve(parsed);
          return;
        } catch {}
      }
    };
    child.stdout.on("data", onData);
  });
}

test("MCP server responds to initialize and lists 6 tools", async () => {
  const child = spawn(process.execPath, [SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    sendJsonRpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });

    const initResponse = await collectResponse(child);
    assert.equal(initResponse.id, 1);
    assert.ok(initResponse.result.capabilities.tools);
    assert.equal(initResponse.result.serverInfo.name, "claude-bridge");

    sendJsonRpc(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    sendJsonRpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    const toolsResponse = await collectResponse(child);
    assert.equal(toolsResponse.id, 2);
    const toolNames = toolsResponse.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("bridge_setup"), "missing bridge_setup");
    assert.ok(toolNames.includes("bridge_review"), "missing bridge_review");
    assert.ok(toolNames.includes("bridge_delegate"), "missing bridge_delegate");
    assert.ok(toolNames.includes("bridge_status"), "missing bridge_status");
    assert.ok(toolNames.includes("bridge_result"), "missing bridge_result");
    assert.ok(toolNames.includes("bridge_cancel"), "missing bridge_cancel");
    assert.equal(toolNames.length, 6);
  } finally {
    child.kill();
  }
});
