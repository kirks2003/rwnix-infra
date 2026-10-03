import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function startMcpServer() {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../mcp/websearch.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = message.id !== undefined ? pending.get(message.id) : null;
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "MCP error"));
      else entry.resolve(message.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  return {
    request,
    notify,
    close: () => new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    }),
  };
}

test("MCP web-search server speaks the MCP protocol over stdio", async (t) => {
  const server = startMcpServer();
  t.after(() => server.close());

  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "jarvis-test", version: "0.1.0" },
  });
  assert.equal(init.serverInfo.name, "jarvis-websearch");
  assert.deepEqual(init.capabilities.tools, { listChanged: false });
  server.notify("notifications/initialized");

  const tools = await server.request("tools/list");
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["web_search"]);
  assert.deepEqual(tools.tools[0].inputSchema.required, ["query"]);

  const empty = await server.request("tools/call", { name: "web_search", arguments: { query: "   " } });
  assert.equal(empty.isError, true);
  await assert.rejects(server.request("tools/call", { name: "no_such_tool", arguments: {} }), /Unknown tool/);
  await assert.rejects(server.request("resources/list", {}), /Method not found/);
});
