#!/usr/bin/env node
// Knowledge-graph MCP server (stdio transport, newline-delimited JSON-RPC 2.0)
// exposing four parameterized read-only tools to the Jarvis backend — plus
// four write/delete tools (store-entity, store-fact, rename-entity,
// delete-entity). Regular sessions may write only their own owner scope; the
// admin session may target any registered owner.
//
// This server deliberately does NOT expose free-form Cypher. Neo4j Community
// has no RBAC, so a raw read tool would let the brain — or a prompt injection
// riding on it — query every node in the graph, including the personal data
// of other users. Instead every query is built in this file, pinned to the
// signed-in user that the backend injects into the arguments of each call
// (the brain never sees or sets it), and the connection uses the read-only
// database user. The graph is per-user private by construction: every
// :Entity is keyed by (name, owner) — the name case-insensitively, the type
// is a property, not part of the identity — so a query pinned to
// owner = $user can only return that user's own entities. :User nodes are
// account markers (name only, no personal data) and may appear as link
// endpoints. A foreign or unknown entity name comes back exactly like a
// nonexistent one — there is nothing to enumerate.
//
// The ONE cross-user exception is the admin session: the backend injects
// `admin: true` (never the brain) and this file's admin query variants read
// across all owners, reporting each row's owner. The same injected flag gates
// cross-owner writes: non-admin write/delete calls are forced to the injected
// `user` owner, while admin calls may set `owner` to any registered user the
// backend injects (`users`). The privilege is an app-level session property —
// there is no way for a non-admin chat turn to read or mutate another user's
// data.
//
// The write tools mirror the backend ingestion's upserts (upsert keyed by
// name+owner, the name case-insensitively, user-named endpoints resolve to
// :User nodes, SET-based edge upsert with the negative flag) and run over
// the WRITE database user;
// every other call stays on the read-only user. :User account nodes can be
// MERGE-d by the write tools but can never be deleted (the delete query
// matches :Entity only).
//
// Env (set by the backend at spawn time): NEO4J_URI, NEO4J_DATABASE,
// NEO4J_READ_USER, NEO4J_READ_PASSWORD, NEO4J_WRITE_USER,
// NEO4J_WRITE_PASSWORD.

import readline from "node:readline";
import { pathToFileURL } from "node:url";
import neo4j from "neo4j-driver";
import graphdb from "../graphdb.js";

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
    "MATCH (e:Entity {owner: $user}) " +
    "WHERE toLower(e.name) = toLower($name) " +
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
    "MATCH (e:Entity) " +
    "WHERE toLower(e.name) = toLower($name) " +
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
  // Admin write queries — run ONLY when the backend injects admin: true, and
  // only over the write database user. They mirror the backend ingestion's
  // upserts (upsert keyed by name+owner, the name case-insensitively,
  // bookkeeping timestamps, SET
  // edge upsert) so admin MCP writes land in exactly the shape the panel and
  // the brain reads expect. The delete matches :Entity only (never a :User
  // account node) and is pinned to owner = $owner (any owner — the admin may
  // remove any user's entity).
  ensureUser: "MERGE (u:User {name: $name})",
  // Same upsert key as the ingestion: (name, owner), the name
  // case-insensitively — the type is a property of the first stored copy,
  // never part of the identity.
  ensureEntity:
    "OPTIONAL MATCH (e:Entity {owner: $owner}) " +
    "WHERE toLower(e.name) = toLower($name) " +
    "FOREACH (_ IN CASE WHEN e IS NULL THEN [1] ELSE [] END | " +
    "CREATE (e:Entity {name: $name, type: $type, owner: $owner, first_seen: $now}) " +
    ") " +
    "SET e.last_seen = $now, e.mention_count = coalesce(e.mention_count, 0) + 1",
  touchEntity: "MATCH (e:Entity {owner: $owner}) WHERE toLower(e.name) = toLower($name) SET e.last_seen = $now RETURN e.name AS name",
  findEntity: "MATCH (e:Entity {owner: $owner}) WHERE toLower(e.name) = toLower($name) RETURN e.name AS name, e.type AS type LIMIT 10",
  deleteEntity: "MATCH (e:Entity {owner: $owner}) WHERE toLower(e.name) = toLower($name) DETACH DELETE e",
  // Rename = change the name property in place: the node keeps its elementId,
  // its type and every link (a delete+recreate would detach them). The
  // collision check (no other copy of $newName for $owner) runs in the
  // handler first — the (name, owner) key stays unique.
  renameEntity: "MATCH (e:Entity {owner: $owner}) WHERE toLower(e.name) = toLower($name) SET e.name = $newName, e.last_seen = $now RETURN e.name AS name, e.type AS type",
};

// "user" is injected by the backend on every call; the brain's tool schema
// (server.js) never offers it, so a user cannot ask the brain about anyone
// but themselves.
const USER_PARAM = { user: { type: "string", description: "The signed-in user (injected by the backend; not set by the brain)." } };

// Exported so tests can pin the surface: four read tools for every session,
// plus four owner-scoped write/delete tools. Non-admin calls are pinned to
// the backend-injected user; admin calls may name any registered owner.
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
  // Owner-scoped write/delete tools. Regular sessions may target only the
  // backend-injected user (owner defaults to that user); admin sessions may
  // target any registered owner. `admin`/`users` are never in the schema.
  {
    name: "store-entity",
    description: "Store an entity under the signed-in user's name (or, for admin sessions only, another registered owner). An entity named after a registered user becomes that user's :User account node, not an entity.",
    inputSchema: {
      type: "object",
      properties: {
        ...USER_PARAM,
        owner: { type: "string", description: "The registered user the entity is stored for, e.g. 'Mila'." },
        name: { type: "string", description: "The entity name, e.g. 'Berlin'." },
        type: { type: "string", description: "One of: person, place, organization, event, topic, thing (default thing)." },
      },
      required: ["owner", "name"],
    },
  },
  {
    name: "store-fact",
    description: "Store a fact (a typed link) under the signed-in user's name (or, for admin sessions only, another registered owner). Endpoints named after registered users are their :User account nodes; other endpoints are (or become) the owner's entity copies.",
    inputSchema: {
      type: "object",
      properties: {
        ...USER_PARAM,
        owner: { type: "string", description: "The registered user the fact is stored for, e.g. 'Mila'." },
        from: { type: "string", description: "The source name (a user or an entity), e.g. 'Mila'." },
        to: { type: "string", description: "The target name (a user or an entity), e.g. 'Lego'." },
        type: { type: "string", description: "The relation type, e.g. LIKES (UPPER_SNAKE_CASE; unknown prose degrades to RELATED_TO)." },
        negative: { type: "boolean", description: "True when the fact is negated ('doesn't like' = LIKES + negative)." },
      },
      required: ["owner", "from", "to", "type"],
    },
  },
  {
    name: "rename-entity",
    description: "Rename an entity of the signed-in user in place (or, for admin sessions only, another registered owner). All links survive the rename. The new name must be free for that user and must not be a registered user's name.",
    inputSchema: {
      type: "object",
      properties: {
        ...USER_PARAM,
        owner: { type: "string", description: "The registered user who owns the entity, e.g. 'Roman'." },
        name: { type: "string", description: "The current entity name, e.g. 'TradingMonitor List'." },
        newName: { type: "string", description: "The new entity name, e.g. 'Trading'." },
      },
      required: ["owner", "name", "newName"],
    },
  },
  {
    name: "delete-entity",
    description: "Delete an entity of the signed-in user (or, for admin sessions only, another registered owner) together with its links. :User account nodes can never be deleted. Afterwards the stored graph policy removes any of the owner's entities left without a relation to the user.",
    inputSchema: {
      type: "object",
      properties: {
        ...USER_PARAM,
        owner: { type: "string", description: "The registered user who owns the entity, e.g. 'Roman'." },
        name: { type: "string", description: "The entity name to delete, e.g. 'Berlin'." },
      },
      required: ["owner", "name"],
    },
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

// --- Admin write tools -------------------------------------------------------

// The fact edge query, built per endpoint-kind pair (like the ingestion's
// buckets): endpoints named after a registered user are :User account nodes,
// everything else is the owner's own :Entity copy — the owner pin in the key
// means the fact can never cross into another user's world. The type is only
// interpolated after the isRelationType check, so no Cypher injection.
export function factQuery(type, fromIsUser, toIsUser) {
  if (!graphdb.isRelationType(type)) throw new Error(`invalid relation type: ${type}`);
  // Entity endpoints match the upsert key (owner, lower(name)) so a casing
  // variant of a stored name lands on the existing copy, never a new node.
  const fromPattern = fromIsUser ? "(a:User {name: row.from})" : "(a:Entity {owner: $owner}) WHERE toLower(a.name) = toLower(row.from)";
  const toPattern = toIsUser ? "(b:User {name: row.to})" : "(b:Entity {owner: $owner}) WHERE toLower(b.name) = toLower(row.to)";
  return `UNWIND $rows AS row MATCH ${fromPattern} MATCH ${toPattern} MERGE (a)-[r:${type}]->(b) SET r.last_seen = $now, r.negative = $negative`;
}

// The write/delete tools. Non-admin calls are owner-scoped to the
// backend-injected user; admin calls may target any registered owner.
export const ADMIN_WRITE_TOOLS = new Set(["store-entity", "store-fact", "rename-entity", "delete-entity"]);

// The registered-user list the backend injects (like user/admin): owner must
// be one of them, so a brain — or a prompt injection riding on it — cannot
// mint data under a made-up owner. Matches case-insensitively, canonicalised
// back to the configured spelling (the :User node key).
function canonicalUserOf(name, users) {
  const wanted = String(name || "").trim().toLowerCase();
  for (const user of users) {
    if (String(user).toLowerCase() === wanted) return user;
  }
  return null;
}

function entityTypeOf(value, fallback = "thing") {
  const type = String(value || "").toLowerCase();
  return graphdb.ENTITY_TYPES.has(type) ? type : fallback;
}

// Argument validation for the write tools, run BEFORE any database access.
// Non-admin calls are forced to args.user as owner; an explicit different
// owner is refused. Admin calls may target any registered owner.
// Returns { ok: false, error } or { ok: true, params }.
export function validateWriteTool(name, args, users) {
  const userNames = Array.isArray(users) ? users.map((item) => String(item)).filter(Boolean) : [];
  const caller = canonicalUserOf(args.user, userNames);
  if (!caller) {
    return { ok: false, error: "user must be a registered user (injected by the backend)." };
  }
  const requestedOwner = args.owner === undefined || args.owner === null || String(args.owner).trim() === "" ? caller : args.owner;
  const owner = canonicalUserOf(requestedOwner, userNames);
  if (!owner) {
    return { ok: false, error: `owner must be a registered user${userNames.length ? ` (one of: ${userNames.join(", ")})` : ""}.` };
  }
  if (args.admin !== true && owner !== caller) {
    return { ok: false, error: `${name} can only modify ${caller}'s own graph data.` };
  }
  if (name === "store-entity") {
    const entityName = graphdb.sanitizeName(args.name);
    if (!entityName) return { ok: false, error: "name is required." };
    return { ok: true, params: { owner, name: entityName, type: entityTypeOf(args.type) } };
  }
  if (name === "store-fact") {
    const from = graphdb.sanitizeName(args.from);
    const to = graphdb.sanitizeName(args.to);
    if (!from || !to) return { ok: false, error: "from and to are required." };
    // Endpoints named after a registered user are their :User account nodes;
    // canonicalise so the node key matches the ingestion's MERGE, and a
    // self-fact ("Mila" -> "mila") is caught before any query.
    const fromUser = canonicalUserOf(from, userNames);
    const toUser = canonicalUserOf(to, userNames);
    const fromFinal = fromUser || from;
    const toFinal = toUser || to;
    // Case-insensitive: entity identity is (name, owner) without the type, so
    // "Pizza" -> "pizza" would MERGE a self-loop, not a fact.
    if (fromFinal.toLowerCase() === toFinal.toLowerCase()) return { ok: false, error: "from and to must name different things." };
    // Same normalisation as the ingestion: known or well-formed introduced
    // types pass through, malformed prose degrades to RELATED_TO so the fact
    // is never lost.
    const normalised = graphdb.normalizeRelationType(args.type);
    const type = graphdb.isRelationType(normalised) ? normalised : "RELATED_TO";
    return {
      ok: true,
      params: {
        owner, from: fromFinal, to: toFinal,
        fromIsUser: Boolean(fromUser), toIsUser: Boolean(toUser),
        type, negative: args.negative === true,
      },
    };
  }
  if (name === "rename-entity") {
    const entityName = graphdb.sanitizeName(args.name);
    const newName = graphdb.sanitizeName(args.newName);
    if (!entityName || !newName) return { ok: false, error: "name and newName are required." };
    // Case-insensitive identity: "Berlin" -> "berlin" is no rename at all.
    if (entityName.toLowerCase() === newName.toLowerCase()) return { ok: false, error: "newName must differ from the current name." };
    // A registered user's name is their :User account node, never an entity.
    if (canonicalUserOf(newName, userNames)) return { ok: false, error: `newName must not be a registered user's name (one of: ${userNames.join(", ")}).` };
    return { ok: true, params: { owner, name: entityName, newName } };
  }
  if (name === "delete-entity") {
    const entityName = graphdb.sanitizeName(args.name);
    if (!entityName) return { ok: false, error: "name is required." };
    return { ok: true, params: { owner, name: entityName } };
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

// The stdio server: only starts when run directly (node mcp/graph.mjs), so
// importing this module in tests does not open a driver or read stdin.
function startServer() {
  const driver = neo4j.driver(
    process.env.NEO4J_URI || "bolt://localhost:7687",
    neo4j.auth.basic(process.env.NEO4J_READ_USER || "neo4j", process.env.NEO4J_READ_PASSWORD || ""),
  );
  // The write driver serves the admin write/delete tools ONLY. On Neo4j
  // Community both users have full privileges (no RBAC), so the separation is
  // credential bookkeeping plus the app-level admin gate above — same as the
  // backend's own split between jarvis_read and jarvis_write.
  const writeDriver = process.env.NEO4J_WRITE_USER
    ? neo4j.driver(
      process.env.NEO4J_URI || "bolt://localhost:7687",
      neo4j.auth.basic(process.env.NEO4J_WRITE_USER, process.env.NEO4J_WRITE_PASSWORD || ""),
    )
    : null;
  const database = process.env.NEO4J_DATABASE || "neo4j";
  const closeDriver = () => {
    driver.close().catch(() => {});
    if (writeDriver) writeDriver.close().catch(() => {});
  };
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

  // Write-side counterpart of run(): the admin write/delete tools only.
  async function runWrite(cypher, params = {}) {
    if (!writeDriver) throw new Error("graph write user not configured (NEO4J_WRITE_USER/NEO4J_WRITE_PASSWORD)");
    const session = writeDriver.session({ database });
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

  // The admin write/delete handlers. Every one is reached only after
  // validateWriteTool accepted the call (admin flag + registered owner +
  // sanitised arguments); the parameters here are already canonical.

  async function handleStoreEntity(params, users) {
    const now = new Date().toISOString();
    // Same one-node-per-user rule as the ingestion: an entity named after a
    // registered user is that user's :User account node, never an :Entity.
    if (canonicalUserOf(params.name, users)) {
      await runWrite(QUERIES.ensureUser, { name: params.name });
      return `Stored "${params.name}" as their :User account node (registered users are never stored as entities).`;
    }
    await runWrite(QUERIES.ensureEntity, { name: params.name, type: params.type, owner: params.owner, now });
    return `Stored "${params.name}" (${params.type}) under ${params.owner}.`;
  }

  // The fact's entity endpoints: match the owner's existing copy first (any
  // type — the fact key is name+owner, not the type) so an existing copy of a
  // different type is kept, not duplicated; create with type "thing" only
  // when the owner has no copy yet.
  async function ensureEntityEndpoint(name, owner, now) {
    const existing = await runWrite(QUERIES.touchEntity, { name, owner, now });
    if (!existing.length) await runWrite(QUERIES.ensureEntity, { name, type: "thing", owner, now });
  }

  async function handleStoreFact(params) {
    const now = new Date().toISOString();
    // Ensure the endpoints exist before the edge: referenced users' :User
    // nodes, entity copies under the owner.
    if (params.fromIsUser) await runWrite(QUERIES.ensureUser, { name: params.from });
    else await ensureEntityEndpoint(params.from, params.owner, now);
    if (params.toIsUser) await runWrite(QUERIES.ensureUser, { name: params.to });
    else await ensureEntityEndpoint(params.to, params.owner, now);
    await runWrite(factQuery(params.type, params.fromIsUser, params.toIsUser), {
      rows: [{ from: params.from, to: params.to }], owner: params.owner, now, negative: params.negative,
    });
    return `Stored ${params.type} from "${params.from}" to "${params.to}" under ${params.owner}${params.negative ? " (negative)" : ""}.`;
  }

  async function handleRenameEntity(params) {
    const now = new Date().toISOString();
    const existing = await runWrite(QUERIES.findEntity, { name: params.name, owner: params.owner });
    if (!existing.length) return `No entity named "${params.name}" owned by ${params.owner} in the graph.`;
    // Collision against the upsert key: renaming onto an existing copy (any
    // case) would leave two nodes with the same (name, owner) key.
    const taken = await runWrite(QUERIES.findEntity, { name: params.newName, owner: params.owner });
    if (taken.length) {
      return `Cannot rename to "${params.newName}": ${params.owner} already has an entity by that name ("${taken[0].name}"). Delete or rename it first.`;
    }
    await runWrite(QUERIES.renameEntity, { name: params.name, newName: params.newName, owner: params.owner, now });
    return `Renamed "${existing[0].name}" to "${params.newName}" (owner ${params.owner}); all links kept.`;
  }

  async function handleDeleteEntity(params) {
    const existing = await runWrite(QUERIES.findEntity, { name: params.name, owner: params.owner });
    if (!existing.length) return `No entity named "${params.name}" owned by ${params.owner} in the graph.`;
    await runWrite(QUERIES.deleteEntity, { name: params.name, owner: params.owner });
    // The stored graph policy runs after the removal, exactly like the
    // backend's own delete path: deleting the middle of a chain can free the
    // far side with no path to the owner's :User node left, and an entity
    // with no relation to its user does not belong in the world.
    const swept = await runWrite(graphdb.DISCONNECT_SWEEP, { user: params.owner });
    const sweptNames = swept.map((row) => row.name);
    return `Deleted "${params.name}" (owner ${params.owner}) and its links.`
      + (sweptNames.length ? ` Also removed ${sweptNames.join(", ")}: the policy keeps only entities connected to the user.` : "");
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
        // `admin` and `users` are injected the same way (admin sessions
        // only) — none of them is in the brain's tool schema, so a chat turn
        // can never set them.
        const user = String(args.user || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const admin = args.admin === true;
        const users = Array.isArray(args.users) ? args.users.map((item) => String(item)).filter(Boolean) : [];
        if (name !== "get-schema" && !user) {
          return respond(id, { content: [{ type: "text", text: "user is required (injected by the backend)." }], isError: true });
        }
        let text;
        if (ADMIN_WRITE_TOOLS.has(name)) {
          // Validated before any database access: a non-admin call (or a
          // brain-supplied admin flag, which the backend overrides) and a
          // malformed argument are refused here, before the write driver.
          const check = validateWriteTool(name, args, users);
          if (!check.ok) {
            return respond(id, { content: [{ type: "text", text: check.error }], isError: true });
          }
          if (name === "store-entity") text = await handleStoreEntity(check.params, users);
          else if (name === "store-fact") text = await handleStoreFact(check.params);
          else if (name === "rename-entity") text = await handleRenameEntity(check.params);
          else text = await handleDeleteEntity(check.params);
        }
        else if (name === "get-schema") text = await handleGetSchema();
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
