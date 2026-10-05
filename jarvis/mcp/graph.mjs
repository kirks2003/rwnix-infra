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
// database user. The graph is per-user private by construction: every
// :Entity is keyed by (name, type, owner), so a query pinned to
// owner = $user can only return that user's own entities. :User nodes are
// account markers (name only, no personal data) and may appear as link
// endpoints. A foreign or unknown entity name comes back exactly like a
// nonexistent one — there is nothing to enumerate.
//
// The ONE cross-user exception is the admin session: the backend injects
// `admin: true` (never the brain) and this file's admin query variants read
// across all owners, reporting each row's owner. The privilege is an
// app-level session property — there is no way for a non-admin chat turn to
// reach the admin queries.
//
// Env (set by the backend at spawn time): NEO4J_URI, NEO4J_DATABASE,
// NEO4J_READ_USER, NEO4J_READ_PASSWORD.

import readline from "node:readline";
import { pathToFileURL } from "node:url";
import neo4j from "neo4j-driver";

// The owner-scoped read queries. Exported so tests can pin that every query
// is bounded by the signed-in user (owner = them / the user's :User node) —
// no query here can return another user's entity.
export const QUERIES = {
  getSchemaLabels: "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50",
  getSchemaRelations: "MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50",
  getSchemaProperties: "MATCH (n) UNWIND keys(n) AS key RETURN DISTINCT key ORDER BY key LIMIT 50",
  // One of the user's OWN entities (owner = $user): a foreign or unknown
  // name yields no row, identical to a nonexistent one. Links are the
  // entity's edges to :User account markers or to the user's own entities.
  // Direction via startNode (there is no direction() in Neo4j): the
  // undirected match yields one row per relationship.
  getEntity:
    "MATCH (e:Entity {name: $name, owner: $user}) " +
    "OPTIONAL MATCH (e)-[r]-(other) " +
    "WHERE other:User OR coalesce(other.owner, '') = $user " +
    "RETURN e.name AS name, e.type AS type, properties(e) AS props, " +
    "other.name AS other, type(r) AS rel, " +
    "CASE WHEN e = startNode(r) THEN 'OUTGOING' ELSE 'INCOMING' END AS dir, " +
    "coalesce(r.negative, false) AS negative " +
    "LIMIT 200",
  // Everything the user owns — their stored knowledge.
  listMyKnowledge:
    "MATCH (e:Entity {owner: $user}) " +
    "RETURN e.name AS name, e.type AS type ORDER BY e.last_seen DESC LIMIT 50",
  // Facts stored about the user: the fact edges out of their :User node
  // (what they like, own, ...). The about/relation filters are appended by
  // the handler.
  listMyFacts: "MATCH (u:User {name: $user})-[r]->(e:Entity) WHERE type(r) <> 'KNOWS'",
  // Admin variants — run ONLY when the backend injects admin: true (admin
  // sessions only; the flag is not in the brain's tool schema, so a
  // non-admin call can never reach them). Same read-only user, same file:
  // the admin privilege is an app-level session property. These read across
  // all owners and report each row's owner.
  getEntityAll:
    "MATCH (e:Entity {name: $name}) " +
    "OPTIONAL MATCH (e)-[r]-(other) " +
    "WHERE other:User OR other:Entity " +
    "RETURN e.name AS name, e.type AS type, e.owner AS owner, properties(e) AS props, " +
    "other.name AS other, type(r) AS rel, " +
    "CASE WHEN e = startNode(r) THEN 'OUTGOING' ELSE 'INCOMING' END AS dir, " +
    "coalesce(r.negative, false) AS negative " +
    "LIMIT 200",
  listAllKnowledge:
    "MATCH (e:Entity) RETURN e.name AS name, e.type AS type, e.owner AS owner ORDER BY e.owner, e.last_seen DESC LIMIT 200",
  listAllFacts: "MATCH (u:User)-[r]->(e:Entity) WHERE type(r) <> 'KNOWS'",
};

// "user" is injected by the backend on every call; the brain's tool schema
// (server.js) never offers it, so a user cannot ask the brain about anyone
// but themselves.
const USER_PARAM = { user: { type: "string", description: "The signed-in user (injected by the backend; not set by the brain)." } };

// Exported so tests can pin the read-only surface: the brain may look things
// up, never write or delete (deletion is the panel's explicit endpoint only).
export const TOOLS = [
  {
    name: "get-schema",
    description: "Inspect the knowledge graph schema: node labels, relationship types and property keys.",
    inputSchema: { type: "object", properties: { ...USER_PARAM } },
  },
  {
    name: "get-entity",
    description: "Look up one of the signed-in user's own entities (person, place, organization, event, topic or thing) by name: its data and its links. Returns nothing if the user has no such entity.",
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

// Exported for tests: the pure result formatting (no driver involved).

export function formatEntity(head, links) {
  const lines = [`${head.name} (${head.type || "thing"}).`];
  const props = Object.entries(head.props || {}).filter(([key]) => !["name", "type", "owner", "last_seen", "first_seen", "mention_count"].includes(key));
  if (props.length) lines.push(`Properties: ${props.map(([key, value]) => `${key}=${value}`).join(", ")}.`);
  lines.push(links.length
    ? `Links: ${links.map((row) =>
        `${row.dir === "INCOMING" ? `${row.other} ${plain(row.rel)} -> ${head.name}` : `${head.name} ${plain(row.rel)} -> ${row.other}`}${row.negative ? " (negative)" : ""}`
      ).join("; ")}.`
    : "Links: none.");
  return lines.join(" ");
}

export function formatKnowledge(rows) {
  if (!rows.length) return "This user has no stored knowledge yet.";
  return `This user knows: ${rows.map((row) => `${row.name} (${row.type || "thing"})`).join(", ")}.`;
}

export function formatFacts(rows, about, relation) {
  if (!rows.length) return `No stored facts about this user${about ? ` mentioning "${about}"` : ""}${relation ? ` of type ${String(relation).toUpperCase()}` : ""} yet.`;
  return `Facts about this user: ${rows.map((row) => `${plain(row.type)}${row.negative ? " (negative)" : ""} -> ${row.name}`).join("; ")}.`;
}

// Bookkeeping properties never rendered (the owner bookkeeping is shown in
// the admin headers, never leaked into a user's rendered properties).
const BOOKKEEPING_PROPS = ["name", "type", "owner", "last_seen", "first_seen", "mention_count"];

// Admin: one line per owner copy of an entity, each with its own links.
export function formatEntityAll(rows) {
  if (!rows.length) return "No entity found in the graph.";
  const byOwner = new Map();
  for (const row of rows) {
    const key = String(row.owner || "unknown");
    const list = byOwner.get(key) || [];
    list.push(row);
    byOwner.set(key, list);
  }
  const parts = [...byOwner.entries()].map(([owner, list]) => {
    const head = list[0];
    const props = Object.entries(head.props || {}).filter(([key]) => !BOOKKEEPING_PROPS.includes(key));
    const links = list
      .filter((row) => row.rel && row.other !== null && row.other !== undefined)
      .map((row) =>
        `${row.dir === "INCOMING" ? `${row.other} ${plain(row.rel)} -> ${head.name}` : `${head.name} ${plain(row.rel)} -> ${row.other}`}${row.negative ? " (negative)" : ""}`,
      );
    return `owner ${owner}: ${head.name} (${head.type || "thing"})${props.length ? `, properties ${props.map(([key, value]) => `${key}=${value}`).join(", ")}` : ""}, links ${links.length ? links.join("; ") : "none"}`;
  });
  return `${rows[0].name} (${rows[0].type || "thing"}) has ${byOwner.size === 1 ? "1 owner copy" : `${byOwner.size} owner copies`}: ${parts.join(". ")}.`;
}

export function formatKnowledgeAll(rows) {
  if (!rows.length) return "No stored entities in the graph yet.";
  const byUser = new Map();
  for (const row of rows) {
    const key = String(row.owner || "unknown");
    const list = byUser.get(key) || [];
    list.push(`${row.name} (${row.type || "thing"})`);
    byUser.set(key, list);
  }
  return `Stored entities per user: ${[...byUser.entries()].map(([user, list]) => `${user}: ${list.join(", ")}`).join("; ")}.`;
}

export function formatFactsAll(rows) {
  if (!rows.length) return "No stored facts in the graph yet.";
  const byUser = new Map();
  for (const row of rows) {
    const key = String(row.user || "unknown");
    const list = byUser.get(key) || [];
    list.push(`${plain(row.type)}${row.negative ? " (negative)" : ""} -> ${row.name}`);
    byUser.set(key, list);
  }
  return `Stored facts per user: ${[...byUser.entries()].map(([user, list]) => `${user}: ${list.join("; ")}`).join("; ")}.`;
}

// The stdio server: only starts when run directly (node mcp/graph.mjs), so
// importing this module in tests does not open a driver or read stdin.
function startServer() {
  const driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://localhost:7687",
    neo4j.auth.basic(process.env.NEO4J_READ_USER || "neo4j", process.env.NEO4J_READ_PASSWORD || ""),
  );
  const database = process.env.NEO4J_DATABASE || "neo4j";
  const closeDriver = () => { driver.close().catch(() => {}); };
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

  async function handleGetSchema() {
    const [labelRows, relRows, keyRows] = await Promise.all([
      run(QUERIES.getSchemaLabels),
      run(QUERIES.getSchemaRelations),
      run(QUERIES.getSchemaProperties),
    ]);
    const relTypes = relRows.map((row) => row.t);
    return [
      `Labels: ${labelRows.map((row) => row.label).join(", ") || "-"}.`,
      `Relationship types: ${relTypes.join(", ") || "-"}.`,
      `Property keys: ${keyRows.map((row) => row.key).join(", ") || "-"}.`,
    ].join(" ");
  }

  async function handleGetEntity(user, name, admin) {
    if (admin) {
      const rows = await run(QUERIES.getEntityAll, { name });
      if (!rows.length) return `No entity named "${name}" in the graph.`;
      return formatEntityAll(rows);
    }
    const rows = await run(QUERIES.getEntity, { user, name });
    if (!rows.length || rows[0].name === null) return `No entity named "${name}" in the graph.`;
    return formatEntity(rows[0], rows.filter((row) => row.rel));
  }

  async function handleListMyKnowledge(user, admin) {
    if (admin) return formatKnowledgeAll(await run(QUERIES.listAllKnowledge));
    const rows = await run(QUERIES.listMyKnowledge, { user });
    return formatKnowledge(rows);
  }

  async function handleListMyFacts(user, about, relation, admin) {
    const base = admin ? QUERIES.listAllFacts : QUERIES.listMyFacts;
    let cypher = base + " ";
    const params = admin ? {} : { user };
    if (about) {
      cypher += "AND e.name = $about ";
      params.about = about;
    }
    if (relation) {
      cypher += "AND type(r) = $relation ";
      params.relation = String(relation).toUpperCase().slice(0, 24);
    }
    cypher += admin
      ? "RETURN type(r) AS type, u.name AS user, e.name AS name, coalesce(r.negative, false) AS negative ORDER BY user, type, name LIMIT 100"
      : "RETURN type(r) AS type, e.name AS name, coalesce(r.negative, false) AS negative ORDER BY type, name LIMIT 100";
    const rows = await run(cypher, params);
    return admin ? formatFactsAll(rows) : formatFacts(rows, about, relation);
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
        // `admin` is injected the same way (admin sessions only) — it is not
        // in the brain's tool schema, so a chat turn can never set it.
        const user = String(args.user || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const admin = args.admin === true;
        if (name !== "get-schema" && !user) {
          return respond(id, { content: [{ type: "text", text: "user is required (injected by the backend)." }], isError: true });
        }
        let text;
        if (name === "get-schema") text = await handleGetSchema();
        else if (name === "get-entity") {
          const entityName = String(args.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
          if (!entityName) return respond(id, { content: [{ type: "text", text: "name is required." }], isError: true });
          text = await handleGetEntity(user, entityName, admin);
        } else if (name === "list-my-knowledge") text = await handleListMyKnowledge(user, admin);
        else if (name === "list-my-facts") text = await handleListMyFacts(user, String(args.about || "").trim().slice(0, 80), String(args.relation || "").trim().slice(0, 24), admin);
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
