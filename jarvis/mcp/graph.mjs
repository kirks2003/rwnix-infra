#!/usr/bin/env node
// Knowledge-graph MCP server (stdio transport, newline-delimited JSON-RPC 2.0)
// exposing four parameterized read-only tools to the Jarvis backend.
//
// This server deliberately does NOT expose free-form Cypher. Neo4j Community
// has no RBAC, so a raw read tool would let the brain — or a prompt injection
// riding on it — query every node in the graph, including the personal data
// of other users. Instead every query is built in this file, pinned to the
// signed-in user that the backend injects into the arguments of each call
// (the brain never sees or sets it), and the connection uses the read-only
// database user. A user's personal data is their :User node and every edge
// incident to it; only that user's own node and :Entity world knowledge are
// ever returned.
//
// Env (set by the backend at spawn time): NEO4J_URI, NEO4J_DATABASE,
// NEO4J_READ_USER, NEO4J_READ_PASSWORD.

import readline from "node:readline";
import neo4j from "neo4j-driver";

const driver = neo4j.driver(
  process.env.NEO4J_URI || "bolt://localhost:7687",
  neo4j.auth.basic(process.env.NEO4J_READ_USER || "neo4j", process.env.NEO4J_READ_PASSWORD || ""),
);
const database = process.env.NEO4J_DATABASE || "neo4j";

function closeDriver() {
  driver.close().catch(() => {});
}
process.on("SIGTERM", () => { closeDriver(); process.exit(0); });
process.on("SIGINT", () => { closeDriver(); process.exit(0); });

async function run(cypher, params = {}) {
  const session = driver.session({ database });
  try {
    const result = await session.run(cypher, params, { timeout: 10000 });
    return result.records.map((record) => record.toObject());
  } finally {
    await session.close().catch(() => {});
  }
}

// "user" is injected by the backend on every call; the brain's tool schema
// (server.js) never offers it, so a user cannot ask the brain about anyone
// but themselves.
const USER_PARAM = { user: { type: "string", description: "The signed-in user (injected by the backend; not set by the brain)." } };

const TOOLS = [
  {
    name: "get-schema",
    description: "Inspect the knowledge graph schema: node labels, relationship types and property keys.",
    inputSchema: { type: "object", properties: { ...USER_PARAM } },
  },
  {
    name: "get-entity",
    description: "Look up one entity (person, place, organization, event, topic or thing) by name: its data and its links to other entities. Returns nothing if the entity is unknown.",
    inputSchema: { type: "object", properties: { ...USER_PARAM, name: { type: "string", description: "The entity name, e.g. 'Berlin'." } }, required: ["name"] },
  },
  {
    name: "list-my-knowledge",
    description: "List the entities the signed-in user has told the assistant about (their stored knowledge).",
    inputSchema: { type: "object", properties: { ...USER_PARAM } },
  },
  {
    name: "list-my-facts",
    description: "List the facts stored about the signed-in user (likes, ownership, family, home, work, ...), optionally filtered to one entity (about) or one relation type (relation, e.g. LIKES).",
    inputSchema: { type: "object", properties: { ...USER_PARAM, about: { type: "string", description: "Optional: only facts about this entity name." }, relation: { type: "string", description: "Optional: only this relation type, e.g. LIKES." } } },
  },
];

const plain = (type) => String(type || "").toLowerCase().replace(/_/g, " ");

async function handleGetSchema() {
  const [labelRows, relRows, keyRows] = await Promise.all([
    run("MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50"),
    run("MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50"),
    run("MATCH (n) UNWIND keys(n) AS key RETURN DISTINCT key ORDER BY key LIMIT 50"),
  ]);
  // KNOWS is bookkeeping (provenance), not a relation the brain should query.
  const relTypes = relRows.map((row) => row.t).filter((type) => type !== "KNOWS");
  return [
    `Labels: ${labelRows.map((row) => row.label).join(", ") || "-"}.`,
    `Relationship types: ${relTypes.join(", ") || "-"}.`,
    `Property keys: ${keyRows.map((row) => row.key).join(", ") || "-"}.`,
  ].join(" ");
}

async function handleGetEntity(user, name) {
  const rows = await run(
    "MATCH (e:Entity {name: $name}) " +
    "OPTIONAL MATCH (u:User {name: $user}) " +
    "OPTIONAL MATCH (e)-[r]-(other:Entity) " +
    "RETURN e.name AS name, e.type AS type, e.common AS common, properties(e) AS props, " +
    "EXISTS { (u)-[:KNOWS]->(e) } AS known, " +
    "other.name AS other, type(r) AS rel, direction(r) AS dir, coalesce(r.negative, false) AS negative " +
    "LIMIT 200",
    { user, name },
  );
  if (!rows.length || rows[0].name === null) return `No entity named "${name}" in the graph.`;
  const head = rows[0];
  const lines = [`${head.name} (${head.type || "thing"})${head.common ? ", public knowledge" : ""}. Known to this user: ${head.known ? "yes" : "no"}.`];
  const props = Object.entries(head.props || {}).filter(([key]) => !["name", "type", "common", "last_seen", "first_seen", "mention_count"].includes(key));
  if (props.length) lines.push(`Properties: ${props.map(([key, value]) => `${key}=${value}`).join(", ")}.`);
  const links = rows.filter((row) => row.rel);
  lines.push(links.length
    ? `Links to other entities: ${links.map((row) =>
        `${row.dir === "INCOMING" ? `${row.other} ${plain(row.rel)} -> ${head.name}` : `${head.name} ${plain(row.rel)} -> ${row.other}`}${row.negative ? " (negative)" : ""}`
      ).join("; ")}.`
    : "Links to other entities: none.");
  return lines.join(" ");
}

async function handleListMyKnowledge(user) {
  const rows = await run(
    "MATCH (u:User {name: $user})-[:KNOWS]->(e:Entity) " +
    "RETURN e.name AS name, e.type AS type, e.common AS common ORDER BY e.last_seen DESC LIMIT 50",
    { user },
  );
  if (!rows.length) return "This user has no stored knowledge yet.";
  return `This user knows: ${rows.map((row) => `${row.name} (${row.type || "thing"})${row.common ? ", public" : ""}`).join(", ")}.`;
}

async function handleListMyFacts(user, about, relation) {
  let cypher = "MATCH (u:User {name: $user})-[r]->(e:Entity) WHERE type(r) <> 'KNOWS' ";
  const params = { user };
  if (about) {
    cypher += "AND e.name = $about ";
    params.about = about;
  }
  if (relation) {
    cypher += "AND type(r) = $relation ";
    params.relation = String(relation).toUpperCase().slice(0, 24);
  }
  cypher += "RETURN type(r) AS type, e.name AS name, coalesce(r.negative, false) AS negative ORDER BY type, name LIMIT 100";
  const rows = await run(cypher, params);
  if (!rows.length) return `No stored facts about this user${about ? ` mentioning "${about}"` : ""}${relation ? ` of type ${String(relation).toUpperCase()}` : ""} yet.`;
  return `Facts about this user: ${rows.map((row) => `${plain(row.type)}${row.negative ? " (negative)" : ""} -> ${row.name}`).join("; ")}.`;
}

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
        serverInfo: { name: "jarvis-graph", version: "1.0.0" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "tools/list":
      return respond(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(params?.name || "");
      const args = params?.arguments || {};
      // Defense in depth: every scoped tool requires the user the backend
      // injected; a call without it (which the backend never makes) fails.
      const user = String(args.user || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (name !== "get-schema" && !user) {
        return respond(id, { content: [{ type: "text", text: "user is required (injected by the backend)." }], isError: true });
      }
      let text;
      if (name === "get-schema") text = await handleGetSchema();
      else if (name === "get-entity") {
        const entityName = String(args.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!entityName) return respond(id, { content: [{ type: "text", text: "name is required." }], isError: true });
        text = await handleGetEntity(user, entityName);
      } else if (name === "list-my-knowledge") text = await handleListMyKnowledge(user);
      else if (name === "list-my-facts") text = await handleListMyFacts(user, String(args.about || "").trim().slice(0, 80), String(args.relation || "").trim().slice(0, 24));
      else return respond(id, null, { code: -32602, message: `Unknown tool: ${name}` });
      return respond(id, { content: [{ type: "text", text }] });
    }
    default:
      if (id !== undefined) respond(id, null, { code: -32601, message: `Method not found: ${method}` });
  }
}

function respond(id, result, error) {
  const message = error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
