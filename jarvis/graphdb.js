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
const PROP_KEYS = new Set(["name", "type", "common", "owner", "id", "elementId"]);

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
  return { name, type, props };
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
    // Negation is a flag on the relation, never a separate type: "I don't
    // like X" is LIKES + negative, and it overwrites an earlier positive one.
    relations.push({ from, to, type, negative: raw && raw.negative === true });
    if (relations.length >= MAX_RELATIONS) break;
  }
  return { entities, relations };
}

// The brain's context is this user's PRIVATE knowledge only: the entities
// they own (owner = them). There is no shared/public tier — a cross-user
// "Shared knowledge" line would leak other users' entity names into this
// user's brain. The admin session does not need a cross-user context line:
// its graph tools read across all owners, and direct DB access remains the
// operator's back door.
function formatGraphContext({ userEntities = [] }) {
  if (!userEntities.length) return "";
  return `Knowledge graph context (this user's own private knowledge — facts the assistant stored from their conversations and searches):\nKnown to this user so far: ${userEntities.map((entity) => `${entity.name} (${entity.type})`).join(", ")}.`;
}

// --- Neo4j store ------------------------------------------------------------

function createGraphStore({ uri, database, readUser, readPassword, writeUser, writePassword, driverFactory, users = [] }) {
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

  // The signed-in user's visible world: their :User node, the entities they
  // own, and the real fact edges between them. Ownership is the isolation
  // boundary: an :Entity exists once per owner (keyed name+type+owner), so
  // there is no shared tier and no neighbour expansion to bound — an entity
  // is visible to exactly the user who owns it. A fact edge is visible when
  // every :Entity endpoint is in the user's set; :User endpoints are account
  // markers (the user's own node or another registered user's node — name
  // only, never personal data), and a pure user-to-user edge is visible only
  // to its two parties. Every node in the world is drawn by the panel; the
  // `isolated` flag marks an owned entity no fact edge touches (an isolated
  // mention) — the UI renders it dimmed, so what the brain's
  // list-my-knowledge reports is what the panel shows. With `admin`: the
  // WHOLE graph — every :User and :Entity node and every fact edge — because
  // the admin session is the one place allowed to see all users' data.
  const EDGE_RETURN =
    "RETURN elementId(a) AS source, a.name AS sourceName, a.type AS sourceType, a.owner AS sourceOwner, " +
    "elementId(b) AS target, b.name AS targetName, b.type AS targetType, b.owner AS targetOwner, " +
    "type(r) AS type, coalesce(r.negative, false) AS negative";
  async function visibleWorld(user, cap, userRows = null, admin = false) {
    let byId;
    if (admin) {
      // Global: every account node and every owner-keyed entity. No query in
      // this branch is pinned to a user — the flag is set by the backend for
      // admin sessions only, never by a client.
      const allUserRows = rows(await run(readClient,
        "MATCH (u:User) ORDER BY u.name LIMIT 50 RETURN elementId(u) AS id, u.name AS name",
      ));
      const allEntityRows = rows(await run(readClient,
        "MATCH (e:Entity) ORDER BY e.last_seen DESC LIMIT $limit " +
        "RETURN elementId(e) AS id, e.name AS name, e.type AS type, e.owner AS owner",
        // The JS driver encodes plain numbers as floats and Neo4j LIMIT
        // rejects them ("'60.0' is not a valid value"), so wrap in neo4j.int.
        { limit: neo4j.int(cap) },
      ));
      byId = new Map();
      for (const row of allUserRows) byId.set(row.id, { id: row.id, name: row.name, type: null, owner: null, isolated: false });
      for (const row of allEntityRows) byId.set(row.id, { id: row.id, name: row.name, type: row.type, owner: row.owner, isolated: true });
    } else {
      if (!userRows) {
        userRows = rows(await run(readClient, "MATCH (u:User {name: $user}) RETURN elementId(u) AS id, u.name AS name", { user }));
      }
      if (!userRows.length) return null;
      const ownedRows = rows(await run(readClient,
        "MATCH (e:Entity {owner: $user}) " +
        "ORDER BY e.last_seen DESC LIMIT $limit " +
        "RETURN elementId(e) AS id, e.name AS name, e.type AS type, e.owner AS owner",
        // The JS driver encodes plain numbers as floats and Neo4j LIMIT
        // rejects them ("'60.0' is not a valid value"), so wrap in neo4j.int.
        { user, limit: neo4j.int(cap) },
      ));
      byId = new Map([[userRows[0].id, { id: userRows[0].id, name: userRows[0].name, type: null, owner: user, isolated: false }]]);
      for (const row of ownedRows) byId.set(row.id, { id: row.id, name: row.name, type: row.type, owner: row.owner, isolated: true });
    }
    // Fact edges touching the world. For a user, an edge is visible only when
    // every :Entity endpoint is theirs and :User endpoints are account
    // markers (pure user-to-user edges: their parties only). For the admin
    // there is no visibility rule — at least one endpoint in the fetched
    // world is enough, and user-to-user edges are included.
    const edgeWhere = admin
      ? "MATCH (a)-[r]->(b) WHERE type(r) <> 'KNOWS' AND (elementId(a) IN $ids OR elementId(b) IN $ids) "
      : "MATCH (a)-[r]->(b) WHERE type(r) <> 'KNOWS' " +
        "AND (a:User OR elementId(a) IN $ids) AND (b:User OR elementId(b) IN $ids) " +
        "AND (NOT (a:User AND b:User) OR elementId(a) IN $ids OR elementId(b) IN $ids) ";
    const edgeRows = rows(await run(readClient,
      edgeWhere + EDGE_RETURN + " LIMIT 300",
      { ids: [...byId.keys()] },
    ));
    for (const row of edgeRows) {
      if (!byId.has(row.source)) byId.set(row.source, { id: row.source, name: row.sourceName, type: row.sourceType, owner: row.sourceOwner, isolated: false });
      if (!byId.has(row.target)) byId.set(row.target, { id: row.target, name: row.targetName, type: row.targetType, owner: row.targetOwner, isolated: false });
    }
    const edges = edgeRows.map((row) => ({ source: row.source, target: row.target, type: row.type, negative: row.negative === true }));
    for (const edge of edges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (source) source.isolated = false;
      if (target) target.isolated = false;
    }
    return { byId, edges };
  }

  return {
    memory: false,

    // Counts of the signed-in user's drawn world (must match the panel's
    // subgraph exactly): their :User node, the entities they own (isolated
    // mentions included, flagged by the subgraph) and those fact edges.
    // Never another user's node or edge — except for the admin, whose view is
    // the whole graph (every user's world at once).
    async status({ user, admin = false } = {}) {
      // 60 = the panel's default /api/graph/subgraph?limit=60.
      const [world, labelRows, relRows] = await Promise.all([
        visibleWorld(user, 60, null, admin),
        rows(await run(readClient, "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50")),
      ]);
      // KNOWS is bookkeeping, not a link the panel should advertise.
      const relTypes = relRows.map((row) => row.t).filter((type) => type !== "KNOWS");
      if (!world) return { nodes: 0, edges: 0, labels: labelRows.map((row) => row.label), relTypes };
      return {
        nodes: world.byId.size,
        edges: world.edges.length,
        labels: labelRows.map((row) => row.label),
        relTypes,
      };
    },

    // Bounded neighbourhood for the panel, scoped to the signed-in user's
    // world: their :User node, the entities they own (isolated mentions
    // drawn but flagged `isolated` for the UI to dim) and the fact edges
    // between them (ownership bounds the world — see visibleWorld). With
    // `center`: one visible node plus its direct neighbours. Never another
    // user's node or edge — the panel is per-user by construction. The admin
    // (`admin: true`, set by the backend for admin sessions only) gets the
    // whole graph: every user's nodes, entities and facts.
    async subgraph({ user, limit = 60, center = null, admin = false } = {}) {
      const cap = Math.min(120, Math.max(1, Number(limit) || 60));
      if (admin) {
        if (center) {
          // The admin may centre on ANY node; neighbours follow every real
          // fact edge, whoever owns them.
          // `r IS NULL OR ...`: a centre with no fact edges (an isolated
          // mention, or a user node with no stored facts) still has to come
          // back — with a null r, type(r) is null and the plain filter would
          // drop the only row, leaving an empty view.
          const nodeRows = rows(await run(readClient,
            "MATCH (a) WHERE elementId(a) = $center " +
            "OPTIONAL MATCH (a)-[r]-(b) " +
            "WHERE r IS NULL OR type(r) <> 'KNOWS' " +
            "RETURN elementId(a) AS id, a.name AS name, a.type AS type, a.owner AS owner, " +
            "elementId(b) AS other, b.name AS otherName, b.type AS otherType, b.owner AS otherOwner, type(r) AS rel, " +
            "coalesce(r.negative, false) AS negative " +
            "LIMIT 200",
            { center },
          ));
          const byId = new Map();
          const edges = [];
          for (const row of nodeRows) {
            if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.name, type: row.type, owner: row.owner, isolated: false });
            if (row.other && !byId.has(row.other)) byId.set(row.other, { id: row.other, name: row.otherName, type: row.otherType, owner: row.otherOwner, isolated: false });
            if (row.other && row.rel) edges.push({ source: row.id, target: row.other, type: row.rel, negative: row.negative === true });
          }
          return { nodes: [...byId.values()], edges: edges.slice(0, 200), center };
        }
        const world = await visibleWorld(user, cap, null, true);
        return { nodes: [...world.byId.values()], edges: world.edges, center: null };
      }
      const userRows = rows(await run(readClient, "MATCH (u:User {name: $user}) RETURN elementId(u) AS id, u.name AS name", { user }));
      if (!userRows.length) return { nodes: [], edges: [], center: null };
      if (center) {
        // The centre must be the user's own node or an entity they own — no
        // matter which elementId the client sends. Neighbours follow the same
        // visibility rule as the full view: entities the user owns plus
        // :User account markers (the user's own node or another registered
        // user's node, name only). KNOWS is gone; the panel only draws real
        // facts.
        const nodeRows = rows(await run(readClient,
          "MATCH (u:User {name: $user}) " +
          "MATCH (a) WHERE elementId(a) = $center " +
          "WITH u, a WHERE elementId(a) = elementId(u) " +
          "OR (a:Entity AND a.owner = $user) " +
          "OPTIONAL MATCH (a)-[r]-(b) " +
          // r IS NULL OR ...: a centre with no fact edges (isolated mention,
          // or a user node with no stored facts) must still come back — with
          // a null r, type(r) is null and the plain filter would drop the
          // only row, leaving an empty view.
          "WHERE r IS NULL OR (type(r) <> 'KNOWS' AND (b:User OR (b:Entity AND b.owner = $user))) " +
          "RETURN elementId(a) AS id, a.name AS name, a.type AS type, a.owner AS owner, " +
          "elementId(b) AS other, b.name AS otherName, b.type AS otherType, b.owner AS otherOwner, type(r) AS rel, " +
          "coalesce(r.negative, false) AS negative " +
          "LIMIT 200",
          { user, center },
        ));
        const byId = new Map();
        const edges = [];
        for (const row of nodeRows) {
          if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.name, type: row.type, owner: row.owner, isolated: false });
          if (row.other && !byId.has(row.other)) byId.set(row.other, { id: row.other, name: row.otherName, type: row.otherType, owner: row.otherOwner, isolated: false });
          if (row.other && row.rel) edges.push({ source: row.id, target: row.other, type: row.rel, negative: row.negative === true });
        }
        return { nodes: [...byId.values()], edges: edges.slice(0, 200), center };
      }
      const world = await visibleWorld(user, cap, userRows, false);
      // Every node in the user's world is drawn; isolated owned mentions
      // (no fact edge touches them) carry the `isolated` flag the UI renders
      // dimmed — what the brain's list-my-knowledge reports is what the
      // panel shows.
      return {
        nodes: [...world.byId.values()],
        edges: world.edges,
        center: null,
      };
    },

    async schema() {
      const [labels, relTypes, propKeys] = await Promise.all([
        rows(await run(readClient, "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50")),
        rows(await run(readClient, "MATCH (n) UNWIND keys(n) AS key RETURN DISTINCT key ORDER BY key LIMIT 50")),
      ]);
      // KNOWS is bookkeeping, not a fact the panel should advertise.
      return {
        labels: labels.map((row) => row.label),
        relTypes: relTypes.map((row) => row.t).filter((type) => type !== "KNOWS"),
        propertyKeys: propKeys.map((row) => row.key),
      };
    },

    // What the brain should know: this user's own entities (owner = them),
    // bounded so the context block stays small. There is no shared/public
    // tier to inject — a cross-user list would leak other users' entity
    // names into this user's brain.
    async readContext(user) {
      const userRows = rows(await run(readClient,
        "MATCH (e:Entity {owner: $user}) " +
        "RETURN e.name AS name, e.type AS type ORDER BY e.last_seen DESC LIMIT 25",
        { user },
      ));
      return {
        userEntities: userRows.map((row) => ({ name: row.name, type: row.type })),
      };
    },

    // The only write path in the app: the backend ingests a finished
    // conversation turn. The caller passes already-sanitised entities and
    // relations (see parseExtraction). Every entity is written keyed by
    // (name, type, owner) with owner = the signed-in user of the turn: each
    // user gets their own copy of every entity they mention, which is what
    // makes the whole graph per-user private by construction (reads match on
    // owner, so no query can cross the boundary).
    async upsertTurn({ user, entities = [], relations = [] }) {
      const now = new Date().toISOString();
      // Every registered user is ONE node: their :User account doubles as the
      // person entity. So any entity or relation endpoint named after a
      // registered user resolves to that user's :User node, never to an
      // :Entity — a person entity carrying another user's name is a proxy for
      // that user's personal data.
      const userNames = new Set(users);
      userNames.add(user);
      const isUser = (name) => userNames.has(name);
      const otherEntities = entities.filter((entity) => !isUser(entity.name));
      // Referenced users' :User nodes must exist before relations target them.
      const referencedUsers = new Set(relations.flatMap((relation) => [relation.from, relation.to]).filter(isUser));
      await run(writeClient, "UNWIND $names AS name MERGE (u:User {name: name})", { names: [...new Set([user, ...referencedUsers])] });
      if (otherEntities.length) {
        // Keyed by owner: "Lego" mentioned by two users is two nodes, one per
        // owner. No common flag, no KNOWS edge — ownership IS the provenance.
        await run(writeClient,
          "UNWIND $rows AS row " +
          "MERGE (e:Entity {name: row.name, type: row.type, owner: $user}) " +
          "ON CREATE SET e.first_seen = row.now " +
          "SET e.last_seen = row.now, " +
          "    e.mention_count = coalesce(e.mention_count, 0) + 1 " +
          "SET e += row.props",
          { rows: otherEntities.map((entity) => ({ name: entity.name, type: entity.type, props: entity.props || {}, now })), user },
        );
      }
      const upserted = otherEntities.length;
      // Each endpoint is matched by the label it actually is: an endpoint
      // named after a registered user is that user's :User node, everything
      // else is the turn user's own :Entity copy (owner: $user). Group by
      // (type, from-label, to-label) so the MERGE targets the right nodes
      // (the parser already drops from === to).
      const buckets = new Map();
      for (const relation of relations) {
        if (!RELATION_TYPES.has(relation.type)) continue;
        const key = `${relation.type}|${isUser(relation.from) ? "U" : "E"}|${isUser(relation.to) ? "U" : "E"}`;
        const list = buckets.get(key) || [];
        list.push({ from: relation.from, to: relation.to, negative: relation.negative === true });
        buckets.set(key, list);
      }
      let linked = 0;
      for (const [key, list] of buckets) {
        const [type, fromLabel, toLabel] = key.split("|");
        const fromPattern = fromLabel === "U" ? "MATCH (a:User {name: row.from})" : "MATCH (a:Entity {name: row.from, owner: $user})";
        const toPattern = toLabel === "U" ? "MATCH (b:User {name: row.to})" : "MATCH (b:Entity {name: row.to, owner: $user})";
        // SET (not just ON CREATE): a later "I don't like X" flips an
        // existing edge to negative, and vice versa.
        await run(writeClient,
          `UNWIND $rows AS row ${fromPattern} ${toPattern} MERGE (a)-[r:${type}]->(b) SET r.last_seen = row.now, r.negative = row.negative`,
          { rows: list.map((relation) => ({ ...relation, now })), user },
        );
        linked += list.length;
      }
      return { upserted, relations: linked };
    },

    // The one explicit delete path in the app: a user removes one of their
    // OWN entities (the query is pinned to owner = the session user, so a
    // foreign id matches nothing and comes back exactly like a nonexistent
    // one — no enumeration, no cross-user write). The admin may delete any
    // :Entity. Only reachable from the panel's DELETE endpoint; the brain's
    // MCP server has no write or delete tool at all. :User account nodes are
    // not matchable here (the label is :Entity only).
    async removeEntity({ user, id, admin = false } = {}) {
      const cypher = (admin
        ? "MATCH (e:Entity) WHERE elementId(e) = $id "
        : "MATCH (e:Entity) WHERE elementId(e) = $id AND e.owner = $user ") +
        "WITH e.name AS name, e " +
        "DETACH DELETE e " +
        "RETURN name, 1 AS deleted";
      const resultRows = rows(await run(writeClient, cypher, admin ? { id } : { id, user }));
      const row = resultRows[0];
      return { deleted: row ? 1 : 0, name: row ? row.name : null };
    },

    async close() {
      await readClient.close().catch(() => {});
      await writeClient.close().catch(() => {});
    },
  };
}

// --- Memory store (tests / GRAPH_MEMORY=1) -----------------------------------

function createMemoryStore(users = []) {
  const nodes = new Map();
  const edges = [];
  let nextId = 1;

  function addNode({ name, type, owner = null, props = {} }) {
    // Entities are keyed by (name, type, owner): one node per owner, so each
    // user's world is private by construction (mirrors the Neo4j MERGE key).
    const existing = [...nodes.values()].find((node) => node.name === name && node.type === type && node.owner === owner);
    if (existing) return existing;
    const now = new Date().toISOString();
    const node = { id: `mem-${nextId++}`, name, type, owner, props, firstSeen: now, lastSeen: now, mentionCount: 0 };
    nodes.set(node.id, node);
    return node;
  }

  function addUser(name) {
    return addNode({ name, type: "person", owner: null, props: { role: "user" } });
  }

  function addEdge(from, to, type, negative = false) {
    const existing = edges.find((edge) => edge.source === from && edge.target === to && edge.type === type);
    if (!existing) {
      edges.push({ source: from, target: to, type, negative: negative === true });
      return edges[edges.length - 1];
    }
    // Re-stating a relation overwrites its polarity, like the Neo4j store.
    existing.negative = negative === true;
    return existing;
  }

  // A small starter graph so the panel and the brain context are not empty on
  // first run of a memory-mode deployment: Mila owns Rocky, Berlin and Kokoro
  // (Rocky -USES-> Kokoro is her only drawn fact; Berlin is an isolated
  // mention) and Roman owns Coffee (also isolated — no fact edge touches it).
  // Ownership is the provenance; no KNOWS edges exist in this model.
  addUser("Mila");
  addUser("Roman");
  const rocky = addNode({ name: "Rocky", type: "thing", owner: "Mila", props: { note: "the Jarvis voice assistant" } });
  addNode({ name: "Berlin", type: "place", owner: "Mila" });
  const kokoro = addNode({ name: "Kokoro-82M", type: "thing", owner: "Mila", props: { note: "self-hosted TTS model" } });
  addEdge(rocky.id, kokoro.id, "USES");
  addNode({ name: "Coffee", type: "thing", owner: "Roman" });

  // The :User node carries no `type` in the panel API (both stores): the UI
  // renders type-less nodes as user nodes, with "(you)" for the signed-in
  // one. This covers the signed-in user's own node AND any foreign :User
  // account marker (another registered user's node, name only) that appears
  // as a fact-edge endpoint — never a typed entity.
  function publicNode(node) {
    if (node.props.role === "user") return { id: node.id, name: node.name, owner: null };
    return { id: node.id, name: node.name, type: node.type, owner: node.owner };
  }

  function publicUserNode(node) {
    return publicNode(node);
  }

  function userNodeOf(user) {
    return [...nodes.values()].find((node) => node.name === user && node.type === "person" && node.props.role === "user") || null;
  }

  // Same visible-world rules as the Neo4j store: the user node, the entities
  // they own, and the fact edges between them. Ownership is the isolation
  // boundary — no neighbour expansion, no shared tier. A fact edge is visible
  // when every :Entity endpoint is the user's own node; :User endpoints are
  // account markers, and a pure user-to-user edge is visible only to its two
  // parties. Every node in the world is drawn; `isolated` marks an owned
  // entity no visible fact edge touches (the UI renders it dimmed). With
  // `admin`: the whole store — every user's nodes, entities and facts.
  function visibleWorld(user, cap, admin = false) {
    let byId;
    if (admin) {
      byId = new Map();
      for (const node of nodes.values()) {
        if (node.props.role === "user") byId.set(node.id, { node, isolated: false });
      }
      for (const node of [...nodes.values()]
        .filter((candidate) => candidate.props.role !== "user")
        .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
        .slice(0, cap)) {
        byId.set(node.id, { node, isolated: true });
      }
      const ids = new Set(byId.keys());
      const visible = (edge) => edge.type !== "KNOWS" && (ids.has(edge.source) || ids.has(edge.target));
      const worldEdges = edges.filter(visible).slice(0, 200);
      for (const edge of worldEdges) {
        if (!byId.has(edge.source)) byId.set(edge.source, { node: nodes.get(edge.source), isolated: false });
        if (!byId.has(edge.target)) byId.set(edge.target, { node: nodes.get(edge.target), isolated: false });
        byId.get(edge.source).isolated = false;
        byId.get(edge.target).isolated = false;
      }
      return { userNode: null, byId, drawnEdges: worldEdges };
    }
    const userNode = userNodeOf(user);
    if (!userNode) return null;
    const owned = [...nodes.values()]
      .filter((node) => node.props.role !== "user" && node.owner === user)
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, cap);
    byId = new Map([[userNode.id, { node: userNode, isolated: false }]]);
    for (const node of owned) byId.set(node.id, { node, isolated: true });
    const ids = new Set(byId.keys());
    const isUserNode = (id) => (nodes.get(id) || {}).props.role === "user";
    const visible = (edge) => {
      if (edge.type === "KNOWS") return false;
      const aOk = isUserNode(edge.source) || ids.has(edge.source);
      const bOk = isUserNode(edge.target) || ids.has(edge.target);
      if (!aOk || !bOk) return false;
      // A pure user-to-user edge is visible only to its two parties.
      if (isUserNode(edge.source) && isUserNode(edge.target) && !ids.has(edge.source) && !ids.has(edge.target)) return false;
      return true;
    };
    const drawnEdges = edges.filter(visible).slice(0, 200);
    for (const edge of drawnEdges) {
      if (!byId.has(edge.source)) byId.set(edge.source, { node: nodes.get(edge.source), isolated: false });
      if (!byId.has(edge.target)) byId.set(edge.target, { node: nodes.get(edge.target), isolated: false });
      byId.get(edge.source).isolated = false;
      byId.get(edge.target).isolated = false;
    }
    return { userNode, byId, drawnEdges };
  }

  return {
    memory: true,

    // Counts of the signed-in user's drawn world (must match the panel's
    // subgraph exactly): their :User node, the entities they own (isolated
    // mentions included) and those edges. Never another user's node or edge —
    // except for the admin, whose view is the whole store.
    async status({ user, admin = false } = {}) {
      // 60 = the panel's default /api/graph/subgraph?limit=60.
      const world = visibleWorld(user, 60, admin);
      const labels = [...new Set([...nodes.values()].map((node) => (node.props.role === "user" ? "User" : "Entity")))];
      // KNOWS is bookkeeping, not a link the panel should advertise.
      const relTypes = [...new Set(edges.map((edge) => edge.type))].filter((type) => type !== "KNOWS").sort();
      if (!world) return { nodes: 0, edges: 0, labels, relTypes };
      return {
        nodes: world.byId.size,
        edges: world.drawnEdges.length,
        labels,
        relTypes,
      };
    },

    // Scoped to the signed-in user's world, like the Neo4j store: their node,
    // the entities they own (isolated mentions drawn but flagged `isolated`)
    // and the fact edges between them, or a visible centre plus its
    // neighbours. Never another user's node or edge — except for the admin
    // (`admin: true`), whose view is the whole store.
    async subgraph({ user, limit = 60, center = null, admin = false } = {}) {
      const cap = Math.min(120, Math.max(1, Number(limit) || 60));
      const userNode = userNodeOf(user);
      const facts = edges.filter((edge) => edge.type !== "KNOWS");
      if (admin) {
        if (center) {
          // The admin may centre on ANY node; neighbours follow every real
          // fact edge, whoever owns them.
          const hub = nodes.get(center);
          if (!hub) return { nodes: [], edges: [], center };
          const byId = new Map([[hub.id, { node: hub, isolated: false }]]);
          const out = [];
          for (const edge of facts) {
            if (edge.source === center) { byId.set(edge.target, { node: nodes.get(edge.target), isolated: false }); out.push(edge); }
            else if (edge.target === center) { byId.set(edge.source, { node: nodes.get(edge.source), isolated: false }); out.push(edge); }
          }
          return {
            nodes: [...byId.values()].map((entry) => ({ ...publicNode(entry.node), isolated: entry.isolated })),
            edges: out.slice(0, 200),
            center,
          };
        }
        const world = visibleWorld(user, cap, true);
        return {
          nodes: [...world.byId.values()].map((entry) => ({ ...publicNode(entry.node), isolated: entry.isolated })),
          edges: world.drawnEdges,
          center: null,
        };
      }
      if (!userNode) return { nodes: [], edges: [], center: null };
      // A neighbour is drawable when it is the user's own node, an entity
      // they own, or a :User account marker (never another user's entity, no
      // matter which id the client sends).
      const inWorld = (node) => Boolean(node) && (node.id === userNode.id || node.props.role === "user" || node.owner === user);
      if (center) {
        // The centre must be the user's own node or an entity they own.
        const hub = nodes.get(center);
        const hubVisible = Boolean(hub) && (hub.id === userNode.id || (hub.props.role !== "user" && hub.owner === user));
        if (!hubVisible) return { nodes: [], edges: [], center };
        const hubIsolated = facts.every((edge) => edge.source !== hub.id && edge.target !== hub.id);
        const byId = new Map([[hub.id, { node: hub, isolated: hubIsolated }]]);
        const out = [];
        for (const edge of facts) {
          if (edge.source === center && inWorld(nodes.get(edge.target))) { byId.set(edge.target, { node: nodes.get(edge.target), isolated: false }); out.push(edge); }
          else if (edge.target === center && inWorld(nodes.get(edge.source))) { byId.set(edge.source, { node: nodes.get(edge.source), isolated: false }); out.push(edge); }
        }
        return {
          nodes: [...byId.values()].map((entry) => ({ ...(entry.node.id === userNode.id ? publicUserNode(entry.node) : publicNode(entry.node)), isolated: entry.isolated })),
          edges: out.slice(0, 200),
          center,
        };
      }
      const world = visibleWorld(user, cap, false);
      return {
        // Every node in the user's world is drawn; isolated owned mentions
        // (no fact edge touches them) carry the `isolated` flag the UI
        // renders dimmed — what the brain's list-my-knowledge reports is
        // what the panel shows.
        nodes: [...world.byId.values()].map((entry) => ({ ...(entry.node.id === userNode.id ? publicUserNode(entry.node) : publicNode(entry.node)), isolated: entry.isolated })),
        edges: world.drawnEdges,
        center: null,
      };
    },

    async schema() {
      const labels = [...new Set([...nodes.values()].map((node) => (node.props.role === "user" ? "User" : "Entity")))];
      // KNOWS is bookkeeping, not a fact the panel should advertise.
      return {
        labels,
        relTypes: [...new Set(edges.map((edge) => edge.type))].filter((type) => type !== "KNOWS").sort(),
        propertyKeys: [...new Set([...nodes.values()].flatMap((node) => Object.keys(node.props)))].sort(),
      };
    },

    // This user's own entities (owner = them), bounded like the Neo4j store.
    // No shared/public tier: a cross-user list would leak other users' entity
    // names into this user's brain.
    async readContext(user) {
      const userEntities = [...nodes.values()]
        .filter((node) => node.props.role !== "user" && node.owner === user)
        .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
        .slice(0, 25)
        .map((node) => ({ name: node.name, type: node.type }));
      return { userEntities };
    },

   async upsertTurn({ user, entities = [], relations = [] }) {
      // Same one-node-per-user rule as the Neo4j store: an entity or relation
      // endpoint named after a registered user is that user's node, never an
      // entity (a person entity with a user's name is a proxy for that
      // user's personal data). Entities are written keyed by owner = the
      // signed-in user of the turn.
      const userNames = new Set(users);
      userNames.add(user);
      const isUser = (name) => userNames.has(name);
      const userNode = [...nodes.values()].find((node) => node.name === user && node.props.role === "user") || addUser(user);
      let upserted = 0;
      for (const entity of entities) {
        if (isUser(entity.name)) continue;
        const node = addNode({ name: entity.name, type: entity.type, owner: user, props: entity.props || {} });
        node.mentionCount += 1;
        node.lastSeen = new Date().toISOString();
        upserted += 1;
      }
      let linked = 0;
      for (const relation of relations) {
        if (!RELATION_TYPES.has(relation.type)) continue;
        const resolve = (name) => {
          if (isUser(name)) return [...nodes.values()].find((node) => node.name === name && node.props.role === "user") || addUser(name);
          // Entity endpoints are the turn user's own copies (owner-keyed): a
          // relation to an entity this user has not mentioned yet is dropped,
          // like the Neo4j MATCH finds no row.
          return [...nodes.values()].find((node) => node.name === name && node.props.role !== "user" && node.owner === user) || null;
        };
        const from = resolve(relation.from);
        const to = resolve(relation.to);
        if (from && to && from !== to) {
          addEdge(from.id, to.id, relation.type, relation.negative === true);
          linked += 1;
        }
      }
      return { upserted, relations: linked };
    },

    // Mirrors the Neo4j store's explicit delete path: the id must be an
    // entity owned by the signed-in user (admin: any entity). :User account
    // nodes are never deletable; a foreign entity id is indistinguishable
    // from a nonexistent one.
    async removeEntity({ user, id, admin = false } = {}) {
      const node = nodes.get(id);
      if (!node || node.props.role === "user") return { deleted: 0, name: null };
      if (!admin && node.owner !== user) return { deleted: 0, name: null };
      nodes.delete(id);
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        if (edges[i].source === id || edges[i].target === id) edges.splice(i, 1);
      }
      return { deleted: 1, name: node.name };
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
