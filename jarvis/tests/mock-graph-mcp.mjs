#!/usr/bin/env node
// Fake neo4j-mcp server for tests: same stdio newline-delimited JSON-RPC
// protocol and tool names as the official server, with canned read-only
// results. Every tools/call is logged to stderr (the backend forwards it as
// mcp_stderr) so tests can assert what the brain's tool loop sent.

import readline from "node:readline";

const TOOLS = [
  { name: "get-schema", description: "fake schema", inputSchema: { type: "object", properties: {} } },
  { name: "read-cypher", description: "fake read-only cypher", inputSchema: { type: "object", properties: { query: { type: "string" }, params: { type: "object" } } } },
];

const readLine = readline.createInterface({ input: process.stdin, terminal: false });
readLine.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handleMessage(message).catch((error) => {
    if (message.id !== undefined) respond(message.id, null, { code: -32603, message: error.message });
  });
});

async function handleMessage(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return respond(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mock-graph-mcp", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "tools/list":
      return respond(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(params?.name || "");
      const args = params?.arguments || {};
      process.stderr.write(`MOCK_GRAPH_CALL ${name} ${JSON.stringify(args)}\n`);
      if (name === "get-schema") {
        return respond(id, { content: [{ type: "text", text: "Labels: User, Entity. Relationship types: KNOWS, USES. Property keys: name, type, common." }] });
      }
      if (name === "read-cypher") {
        const cypher = String(args.query || "");
        // Mirror the database-level guarantee: write Cypher is rejected.
        if (/\bdelete\b|\bcreate\b|\bmerge\b|\bset\b|\bremove\b/i.test(cypher)) {
          return respond(id, { content: [{ type: "text", text: "Query rejected: only read-only queries are allowed." }], isError: true });
        }
        return respond(id, { content: [{ type: "text", text: `Rows: 3 (mock data for: ${cypher.slice(0, 80)})` }] });
      }
      return respond(id, null, { code: -32602, message: `Unknown tool: ${name}` });
    }
    default:
      if (id !== undefined) respond(id, null, { code: -32601, message: `Method not found: ${method}` });
  }
}

function respond(id, result, error) {
  const message = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
