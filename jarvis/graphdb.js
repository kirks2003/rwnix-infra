// Neo4j access for the Jarvis knowledge graph. The store keeps two
// connections: a read-only user for the brain context and the UI panel, and a
// write user that ONLY the backend's turn ingestion uses. The brain's own
// access (the neo4j-mcp server spawned in server.js) always runs as the
// read-only user with writes disabled, so an LLM can never write to the graph
// from a chat turn.
//
// The memory store (createMemoryStore) implements the same interface over a
// small in-memory graph; it is selected with GRAPH_MEMORY=1 so the panel and
// the brain wiring can be exercised in tests and demos without a database.

const ENTITY_TYPES = new Set(["person", "place", "organization", "event", "topic", "thing"]);
const RELATION_TYPES = new Set([
  "WORKS_AT", "LIVES_IN", "STUDIES_AT", "BORN_IN", "FRIEND_OF", "FAMILY_OF",
  "PART_OF", "LOCATED_IN", "RELATED_TO", "MENTIONED_IN", "LIKES", "WENT_TO",
  "OWNS", "USES",
]);
const MAX_ENTITIES = 12;
const MAX_RELATIONS = 15;
const PROP_KEYS = new Set(["name", "type", "common", "id", "elementId"]);

function sanitizeName(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 80);
}

function sanitizeEntity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = sanitizeName(raw.name);
  if (!name) return null;
  const type = ENTITY_TYPES.has(String(raw.type || "").toLowerCase()) ? String(raw.type).toLowerCase() : "thing";
  const props = {};
  const source = raw.props && typeof raw.props === "object" ? raw.props : {};
  for (const [key, value] of Object.entries(source)) {
    if (Object.keys(props).length >= 12) break;
    if (!/^[a-z][a-z0-9_]{0,24}$/.test(key) || PROP_KEYS.has(key)) continue;
    const text = String(value == null ? "" : value).trim().slice(0, 200);
    if (text) props[key] = text;
  }
  return { name, type, common: raw.common === true, props };
}

// The brain replies with a JSON object, possibly wrapped in a code fence or
// surrounded by prose. Anything that does not parse comes back empty: a bad
// extraction is skipped, never a crash and never a partial write.
function parseExtraction(text) {
  const cleaned = String(text == null ? "" : text).trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  let data;
  try {
    data = JSON.parse(fenced ? fenced[1] : start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
  } catch {
    return { entities: [], relations: [] };
  }
  const seen = new Set();
  const entities = [];
  for (const raw of Array.isArray(data.entities) ? data.entities : []) {
    const entity = sanitizeEntity(raw);
    if (!entity) continue;
    const key = `${entity.name}|${entity.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push(entity);
    if (entities.length >= MAX_ENTITIES) break;
  }
  const relationKeys = new Set();
  const relations = [];
  for (const raw of Array.isArray(data.relations) ? data.relations : []) {
    const from = sanitizeName(raw && raw.from);
    const to = sanitizeName(raw && raw.to);
    if (!from || !to || from === to) continue;
    const upper = String(raw && raw.type || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 24);
    const type = RELATION_TYPES.has(upper) ? upper : "RELATED_TO";
    const key = `${from}|${to}|${type}`;
    if (relationKeys.has(key)) continue;
    relationKeys.add(key);
    relations.push({ from, to, type });
    if (relations.length >= MAX_RELATIONS) break;
  }
  return { entities, relations };
}

function formatGraphContext({ userEntities = [], commonEntities = [] }) {
  if (!userEntities.length && !commonEntities.length) return "";
  const lines = [];
  if (userEntities.length) {
    lines.push(`Known to this user so far: ${userEntities.map((entity) => `${entity.name} (${entity.type})`).join(", ")}.`);
  }
  if (commonEntities.length) {
    lines.push(`Shared knowledge: ${commonEntities.map((entity) => `${entity.name} (${entity.type})`).join(", ")}.`);
  }
  return `Knowledge graph context (facts the assistant has stored from earlier conversations and searches):\n${lines.join("\n")}`;
}

// --- Neo4j store ------------------------------------------------------------

function createGraphStore({ uri, database, readUser, readPassword, writeUser, writePassword, driverFactory }) {
  let neo4j;
  try {
    neo4j = require("neo4j-driver");
  } catch {
    throw new Error("neo4j-driver is not installed (run npm install)");
  }
  const factory = driverFactory || neo4j.driver;
  const readClient = factory(uri, neo4j.auth.basic(readUser, readPassword));
  const writeClient = factory(uri, neo4j.auth.basic(writeUser, writePassword));

  async function run(client, cypher, params = {}, timeoutMs = 10000) {
    const session = client.session({ database });
    try {
      return await session.run(cypher, params, { timeout: timeoutMs });
    } finally {
      await session.close().catch(() => {});
    }
  }

  const rows = (result) => result.records.map((record) => record.toObject());

  return {
    memory: false,

    async status() {
      const [nodes, edges, labels, relTypes] = await Promise.all([
        rows(await run(readClient, "MATCH (n) RETURN count(n) AS value")),
        rows(await run(readClient, "MATCH ()-[r]->() RETURN count(r) AS value")),
        rows(await run(readClient, "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50")),
      ]);
      return {
        nodes: Number(nodes[0]?.value || 0),
        edges: Number(edges[0]?.value || 0),
        labels: labels.map((row) => row.label),
        relTypes: relTypes.map((row) => row.t),
      };
    },

    // Bounded neighbourhood for the panel: the newest named nodes (or, with
    // `center`, one node plus its direct neighbours), plus the edges between
    // the returned nodes.
    async subgraph({ limit = 60, center = null } = {}) {
      const cap = Math.min(120, Math.max(1, Number(limit) || 60));
      let nodeRows;
      let edgeRows = [];
      if (center) {
        nodeRows = rows(await run(readClient,
          "MATCH (a) WHERE elementId(a) = $center OPTIONAL MATCH (a)-[r]-(b) " +
          "RETURN elementId(a) AS id, a.name AS name, a.type AS type, a.common AS common, " +
          "elementId(b) AS other, other.name AS otherName, other.type AS otherType, other.common AS otherCommon, type(r) AS rel " +
          "LIMIT 200",
          { center },
        ));
        const byId = new Map();
        const edges = [];
        for (const row of nodeRows) {
          if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.name, type: row.type, common: row.common });
          if (row.other && !byId.has(row.other)) byId.set(row.other, { id: row.other, name: row.otherName, type: row.otherType, common: row.otherCommon });
          if (row.other && row.rel) edges.push({ source: row.id, target: row.other, type: row.rel });
        }
        return { nodes: [...byId.values()], edges: edges.slice(0, 200), center };
      }
      nodeRows = rows(await run(readClient,
        "MATCH (n) WHERE n.name IS NOT NULL " +
        "ORDER BY coalesce(n.last_seen, n.first_seen) DESC LIMIT $limit " +
        "RETURN elementId(n) AS id, n.name AS name, n.type AS type, n.common AS common, " +
        "coalesce(n.last_seen, n.first_seen) AS lastSeen",
        // The JS driver encodes plain numbers as floats and Neo4j LIMIT
        // rejects them ("'60.0' is not a valid value"), so wrap in neo4j.int.
        { limit: neo4j.int(cap) },
      ));
      const ids = nodeRows.map((row) => row.id);
      if (ids.length) {
        edgeRows = rows(await run(readClient,
          "MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids " +
          "RETURN elementId(a) AS source, elementId(b) AS target, type(r) AS type LIMIT 300",
          { ids },
        ));
      }
      return {
        nodes: nodeRows.map((row) => ({ id: row.id, name: row.name, type: row.type, common: row.common })),
        edges: edgeRows,
        center: null,
      };
    },

    async schema() {
      const [labels, relTypes, propKeys] = await Promise.all([
        rows(await run(readClient, "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50")),
        rows(await run(readClient, "MATCH (n) UNWIND keys(n) AS key RETURN DISTINCT key ORDER BY key LIMIT 50")),
      ]);
      return {
        labels: labels.map((row) => row.label),
        relTypes: relTypes.map((row) => row.t),
        propertyKeys: propKeys.map((row) => row.key),
      };
    },

    // What the brain should know about this user and about the shared
    // knowledge; bounded so the context block stays small.
    async readContext(user) {
      const [userRows, commonRows] = await Promise.all([
        rows(await run(readClient,
          "MATCH (u:User {name: $user})-[:KNOWS]->(e:Entity) " +
          "RETURN e.name AS name, e.type AS type ORDER BY e.last_seen DESC LIMIT 25",
          { user },
        )),
        rows(await run(readClient,
          "MATCH (e:Entity) WHERE e.common = true " +
          "RETURN e.name AS name, e.type AS type ORDER BY e.last_seen DESC LIMIT 15",
        )),
      ]);
      return {
        userEntities: userRows.map((row) => ({ name: row.name, type: row.type })),
        commonEntities: commonRows.map((row) => ({ name: row.name, type: row.type })),
      };
    },

    // The only write path in the app: the backend ingests a finished
    // conversation turn. The caller passes already-sanitised entities and
    // relations (see parseExtraction).
    async upsertTurn({ user, entities = [], relations = [] }) {
      const now = new Date().toISOString();
      let upserted = 0;
      if (entities.length) {
        await run(writeClient,
          "UNWIND $rows AS row " +
          "MERGE (u:User {name: $user}) " +
          "MERGE (e:Entity {name: row.name, type: row.type}) " +
          "ON CREATE SET e.first_seen = row.now " +
          "SET e.last_seen = row.now, " +
          "    e.mention_count = coalesce(e.mention_count, 0) + 1, " +
          "    e.common = coalesce(row.common, e.common, false) " +
          "SET e += row.props " +
          "MERGE (u)-[:KNOWS]->(e)",
          { rows: entities.map((entity) => ({ name: entity.name, type: entity.type, common: entity.common, props: entity.props || {}, now })), user },
        );
        upserted = entities.length;
        // An entity known by two or more users is shared knowledge.
        await run(writeClient,
          "MATCH (:User)-[:KNOWS]->(e:Entity) WITH e, count(*) AS knownBy " +
          "SET e.common = e.common OR knownBy >= 2",
        );
      }
      const byType = new Map();
      for (const relation of relations) {
        const list = byType.get(relation.type) || [];
        list.push({ from: relation.from, to: relation.to });
        byType.set(relation.type, list);
      }
      let linked = 0;
      for (const [type, list] of byType) {
        if (!RELATION_TYPES.has(type)) continue;
        await run(writeClient,
          `UNWIND $rows AS row ` +
          "MATCH (a:Entity {name: row.from}) " +
          "MATCH (b:Entity {name: row.to}) " +
          `MERGE (a)-[r:${type}]->(b) ` +
          "SET r.last_seen = row.now",
          { rows: list.map((relation) => ({ ...relation, now })) },
        );
        linked += list.length;
      }
      return { upserted, relations: linked };
    },

    async close() {
      await readClient.close().catch(() => {});
      await writeClient.close().catch(() => {});
    },
  };
}

// --- Memory store (tests / GRAPH_MEMORY=1) -----------------------------------

function createMemoryStore() {
  const nodes = new Map();
  const edges = [];
  let nextId = 1;

  function addNode({ name, type, common = false, props = {}, user = null }) {
    const existing = [...nodes.values()].find((node) => node.name === name && node.type === type);
    if (existing) return existing;
    const now = new Date().toISOString();
    const node = { id: `mem-${nextId++}`, name, type, common, props, firstSeen: now, lastSeen: now, mentionCount: 0, users: [] };
    nodes.set(node.id, node);
    return node;
  }

  function addUser(name) {
    return addNode({ name, type: "person", common: false, props: { role: "user" } });
  }

  function addEdge(from, to, type) {
    const existing = edges.find((edge) => edge.source === from && edge.target === to && edge.type === type);
    if (!existing) edges.push({ source: from, target: to, type });
    return existing;
  }

  // A small starter graph so the panel and the brain context are not empty on
  // first run of a memory-mode deployment.
  const mila = addUser("Mila");
  const roman = addUser("Roman");
  const rocky = addNode({ name: "Rocky", type: "thing", common: true, props: { note: "the Jarvis voice assistant" } });
  const berlin = addNode({ name: "Berlin", type: "place", common: true });
  const kokoro = addNode({ name: "Kokoro-82M", type: "thing", common: true, props: { note: "self-hosted TTS model" } });
  // User -> entity edges are KNOWS, exactly like the ingestion path writes
  // them into Neo4j; readContext only follows KNOWS.
  addEdge(mila.id, rocky.id, "KNOWS");
  addEdge(roman.id, rocky.id, "KNOWS");
  addEdge(mila.id, berlin.id, "KNOWS");
  addEdge(rocky.id, kokoro.id, "USES");

  function publicNode(node) {
    return { id: node.id, name: node.name, type: node.type, common: node.common };
  }

  return {
    memory: true,

    async status() {
      return {
        nodes: nodes.size,
        edges: edges.length,
        labels: [...new Set([...nodes.values()].map((node) => (node.props.role === "user" ? "User" : "Entity")))],
        relTypes: [...new Set(edges.map((edge) => edge.type))].sort(),
      };
    },

    async subgraph({ limit = 60, center = null } = {}) {
      const cap = Math.min(120, Math.max(1, Number(limit) || 60));
      if (center) {
        const byId = new Map();
        const out = [];
        const hub = nodes.get(center);
        if (!hub) return { nodes: [], edges: [], center };
        byId.set(hub.id, hub);
        for (const edge of edges) {
          if (edge.source === center) { byId.set(edge.target, nodes.get(edge.target)); out.push(edge); }
          else if (edge.target === center) { byId.set(edge.source, nodes.get(edge.source)); out.push(edge); }
        }
        return { nodes: [...byId.values()].map(publicNode), edges: out.slice(0, 200), center };
      }
      const picked = [...nodes.values()]
        .filter((node) => node.name)
        .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
        .slice(0, cap);
      const ids = new Set(picked.map((node) => node.id));
      return {
        nodes: picked.map(publicNode),
        edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
        center: null,
      };
    },

    async schema() {
      const labels = [...new Set([...nodes.values()].map((node) => (node.props.role === "user" ? "User" : "Entity")))];
      return {
        labels,
        relTypes: [...new Set(edges.map((edge) => edge.type))].sort(),
        propertyKeys: [...new Set([...nodes.values()].flatMap((node) => Object.keys(node.props)))].sort(),
      };
    },

    async readContext(user) {
      const userNode = [...nodes.values()].find((node) => node.name === user && node.type === "person" && node.props.role === "user");
      const userEntities = userNode
        ? edges.filter((edge) => edge.source === userNode.id && edge.type === "KNOWS")
          .map((edge) => publicNode(nodes.get(edge.target)))
          .filter(Boolean)
        : [];
      const commonEntities = [...nodes.values()].filter((node) => node.common && node.props.role !== "user").map(publicNode);
      return {
        userEntities: userEntities.map(({ name, type }) => ({ name, type })),
        commonEntities: commonEntities.map(({ name, type }) => ({ name, type })),
      };
    },

    async upsertTurn({ user, entities = [], relations = [] }) {
      const userNode = [...nodes.values()].find((node) => node.name === user && node.type === "person" && node.props.role === "user") || addUser(user);
      for (const entity of entities) {
        const node = addNode({ name: entity.name, type: entity.type, common: entity.common, props: entity.props || {} });
        node.mentionCount += 1;
        node.lastSeen = new Date().toISOString();
        if (entity.common) node.common = true;
        if (!node.users.includes(user)) node.users.push(user);
        if (node.users.length >= 2) node.common = true;
        addEdge(userNode.id, node.id, "KNOWS");
      }
      let linked = 0;
      for (const relation of relations) {
        const from = [...nodes.values()].find((node) => node.name === relation.from);
        const to = [...nodes.values()].find((node) => node.name === relation.to);
        if (from && to && from !== to && RELATION_TYPES.has(relation.type)) {
          addEdge(from.id, to.id, relation.type);
          linked += 1;
        }
      }
      return { upserted: entities.length, relations: linked };
    },

    async close() {},
  };
}

module.exports = {
  ENTITY_TYPES,
  RELATION_TYPES,
  MAX_ENTITIES,
  MAX_RELATIONS,
  parseExtraction,
  formatGraphContext,
  createGraphStore,
  createMemoryStore,
};
