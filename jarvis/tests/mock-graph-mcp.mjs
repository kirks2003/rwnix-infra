#!/usr/bin/env node
// Fake knowledge-graph MCP server for tests: same stdio newline-delimited
// JSON-RPC protocol and tool names as mcp/graph.mjs (the user-scoped,
// parameterized read tools plus the admin write/delete tools), with canned
// results. Every tools/call is logged to stderr (the backend forwards it as
// mcp_stderr) so tests can assert what the brain's tool loop sent — including
// the user, admin flag and registered user list the backend injected.

import readline from "node:readline";

const TOOLS = [
  { name: "get-schema", description: "fake schema", inputSchema: { type: "object", properties: {} } },
  { name: "get-entity", description: "fake entity lookup", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "list-my-knowledge", description: "fake knowledge list", inputSchema: { type: "object", properties: {} } },
  { name: "list-my-facts", description: "fake facts list", inputSchema: { type: "object", properties: { about: { type: "string" }, relation: { type: "string" } } } },
  { name: "store-entity", description: "fake store entity (admin)", inputSchema: { type: "object", properties: { owner: { type: "string" }, name: { type: "string" }, type: { type: "string" } } } },
  { name: "store-fact", description: "fake store fact (admin)", inputSchema: { type: "object", properties: { owner: { type: "string" }, from: { type: "string" }, to: { type: "string" }, type: { type: "string" }, negative: { type: "boolean" } } } },
  { name: "rename-entity", description: "fake rename entity (admin)", inputSchema: { type: "object", properties: { owner: { type: "string" }, name: { type: "string" }, newName: { type: "string" } } } },
  { name: "delete-entity", description: "fake delete entity (admin)", inputSchema: { type: "object", properties: { owner: { type: "string" }, name: { type: "string" } } } },
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
      const user = String(args.user || "?");
      if (name === "get-schema") {
        return respond(id, { content: [{ type: "text", text: "Labels: User, Entity. Relationship types: LIKES, USES. Property keys: name, type, owner." }] });
      }
      if (name === "get-entity") {
        const entityName = String(args.name || "unknown");
        return respond(id, { content: [{ type: "text", text: `${entityName} (thing). Known to ${user}: yes. Links to other entities: none. (mock data)` }] });
      }
      if (name === "list-my-knowledge") {
        return respond(id, { content: [{ type: "text", text: `${user} knows: Amelie (person), Berlin (place). (mock data)` }] });
      }
      if (name === "list-my-facts") {
        const filter = args.about ? ` mentioning "${args.about}"` : "";
        return respond(id, { content: [{ type: "text", text: `Facts about ${user}${filter}: likes -> Lego. (mock data)` }] });
      }
      // The write/delete tools: the mock does not write anything. It echoes
      // allowed calls and mirrors the real MCP server's non-admin owner gate
      // so tests can pin both self-scoped writes and cross-owner denial.
      if (["store-entity", "store-fact", "rename-entity", "delete-entity"].includes(name) && args.admin !== true && args.owner && args.owner !== user) {
        return respond(id, { content: [{ type: "text", text: `${name} can only modify ${user}'s own graph data.` }], isError: true });
      }
      if (name === "store-entity") {
        return respond(id, { content: [{ type: "text", text: `Stored ${args.name || "?"} (${args.type || "thing"}) under ${args.owner || user}. (mock data)` }] });
      }
      if (name === "store-fact") {
        return respond(id, { content: [{ type: "text", text: `Stored ${args.type || "?"} from ${args.from || "?"} to ${args.to || "?"} under ${args.owner || user}. (mock data)` }] });
      }
      if (name === "rename-entity") {
        return respond(id, { content: [{ type: "text", text: `Renamed ${args.name || "?"} to ${args.newName || "?"} (owner ${args.owner || user}); all links kept. (mock data)` }] });
      }
      if (name === "delete-entity") {
        return respond(id, { content: [{ type: "text", text: `Deleted ${args.name || "?"} (owner ${args.owner || user}). (mock data)` }] });
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
