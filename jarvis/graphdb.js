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
    // Negation is a flag on the relation, never a separate type: "I don't
    // like X" is LIKES + negative, and it overwrites an earlier positive one.
    relations.push({ from, to, type, negative: raw && raw.negative === true });
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
  // know, one entity-hop of world knowledge around those, and the real fact
  // edges between them. Never another user's node or edge. `drawn` marks the
  // nodes the panel shows: the user node plus every entity a visible fact
  // edge actually touches. Isolated mentions — entities the user knows but no
  // visible fact edge touches — are kept in the database (KNOWS stays, so the
  // brain context and list-my-knowledge still see them) but are not drawn or
  // counted, so a mere mention does not float in the other users' 3D view.
  async function visibleWorld(user, cap, userRows = null) {
    if (!userRows) {
      userRows = rows(await run(readClient, "MATCH (u:User {name: $user}) RETURN elementId(u) AS id, u.name AS name", { user }));
    }
    if (!userRows.length) return null;
    const knownRows = rows(await run(readClient,
      "MATCH (u:User {name: $user})-[:KNOWS]->(e:Entity) " +
      "ORDER BY e.last_seen DESC LIMIT $limit " +
      "RETURN elementId(e) AS id, e.name AS name, e.type AS type, e.common AS common",
      // The JS driver encodes plain numbers as floats and Neo4j LIMIT
      // rejects them ("'60.0' is not a valid value"), so wrap in neo4j.int.
      { user, limit: neo4j.int(cap) },
    ));
    const byId = new Map([[userRows[0].id, { id: userRows[0].id, name: userRows[0].name, type: null, common: false, drawn: true }]]);
    for (const row of knownRows) byId.set(row.id, { id: row.id, name: row.name, type: row.type, common: row.common, drawn: false });
    if (knownRows.length) {
      const neighborRows = rows(await run(readClient,
        "MATCH (u:User {name: $user})-[:KNOWS]->(e:Entity) MATCH (e)-[r]-(n:Entity) " +
        "WHERE type(r) <> 'KNOWS' AND NOT elementId(n) IN $knownIds " +
        "RETURN DISTINCT elementId(n) AS id, n.name AS name, n.type AS type, n.common AS common " +
        "LIMIT $limit",
        { user, knownIds: knownRows.map((row) => row.id), limit: neo4j.int(cap) },
      ));
      for (const row of neighborRows) if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.name, type: row.type, common: row.common, drawn: false });
    }
    const ids = [...byId.keys()];
    let edgeRows = [];
    if (ids.length) {
      edgeRows = rows(await run(readClient,
        "MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids AND type(r) <> 'KNOWS' " +
        "RETURN elementId(a) AS source, elementId(b) AS target, type(r) AS type, coalesce(r.negative, false) AS negative " +
        "LIMIT 300",
        { ids },
      ));
    }
    for (const row of edgeRows) {
      const source = byId.get(row.source);
      const target = byId.get(row.target);
      if (source) source.drawn = true;
      if (target) target.drawn = true;
    }
    return { byId, edges: edgeRows };
  }

  return {
    memory: false,

    // Counts of the signed-in user's drawn world (must match the panel's
    // subgraph exactly): their :User node, the entities a visible fact edge
    // touches, and those edges. Never another user's node or edge.
    async status({ user } = {}) {
      // 60 = the panel's default /api/graph/subgraph?limit=60.
      const [world, labelRows, relRows] = await Promise.all([
        visibleWorld(user, 60),
        rows(await run(readClient, "MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "MATCH ()-[r]->() UNWIND [type(r)] AS t RETURN DISTINCT t ORDER BY t LIMIT 50")),
      ]);
      // KNOWS is bookkeeping, not a link the panel should advertise.
      const relTypes = relRows.map((row) => row.t).filter((type) => type !== "KNOWS");
      if (!world) return { nodes: 0, edges: 0, labels: labelRows.map((row) => row.label), relTypes };
      const drawnNodes = [...world.byId.values()].filter((node) => node.drawn);
      return {
        nodes: drawnNodes.length,
        edges: world.edges.length,
        labels: labelRows.map((row) => row.label),
        relTypes,
      };
    },

    // Bounded neighbourhood for the panel, scoped to the signed-in user's
    // visible world: their :User node plus the entities a visible fact edge
    // touches in that world (their own facts and one entity-hop of world
    // knowledge around what they know). Isolated mentions — known entities
    // with no visible fact edge — are not drawn. With `center`: one visible
    // node plus its direct neighbours. Never another user's node or edge —
    // the panel is per-user by construction.
    async subgraph({ user, limit = 60, center = null } = {}) {
      const cap = Math.min(120, Math.max(1, Number(limit) || 60));
      const userRows = rows(await run(readClient, "MATCH (u:User {name: $user}) RETURN elementId(u) AS id, u.name AS name", { user }));
      if (!userRows.length) return { nodes: [], edges: [], center: null };
      if (center) {
        // The centre must be visible to this user: their own node, an entity
        // they know, or an entity one entity-hop from a known one. Neighbours
        // are :Entity nodes plus the user's own node — never another user's
        // node, no matter which elementId the client sends. KNOWS is
        // bookkeeping; the panel only draws real facts.
        const nodeRows = rows(await run(readClient,
          "MATCH (u:User {name: $user}) " +
          "MATCH (a) WHERE elementId(a) = $center " +
          "WITH u, a WHERE elementId(a) = elementId(u) " +
          "OR (a:Entity AND EXISTS { (u)-[:KNOWS]->(a) }) " +
          "OR (a:Entity AND EXISTS { (a)-[]-(:Entity)<-[:KNOWS]-(u) }) " +
          "OPTIONAL MATCH (a)-[r]-(b) " +
          "WHERE type(r) <> 'KNOWS' AND (NOT (b:User) OR elementId(b) = elementId(u)) " +
          "RETURN elementId(a) AS id, a.name AS name, a.type AS type, a.common AS common, " +
          "elementId(b) AS other, b.name AS otherName, b.type AS otherType, b.common AS otherCommon, type(r) AS rel, " +
          "coalesce(r.negative, false) AS negative " +
          "LIMIT 200",
          { user, center },
        ));
        const byId = new Map();
        const edges = [];
        for (const row of nodeRows) {
          if (!byId.has(row.id)) byId.set(row.id, { id: row.id, name: row.name, type: row.type, common: row.common });
          if (row.other && !byId.has(row.other)) byId.set(row.other, { id: row.other, name: row.otherName, type: row.otherType, common: row.otherCommon });
          if (row.other && row.rel) edges.push({ source: row.id, target: row.other, type: row.rel, negative: row.negative === true });
        }
        return { nodes: [...byId.values()], edges: edges.slice(0, 200), center };
      }
      const world = await visibleWorld(user, cap, userRows);
      const drawnNodes = [...world.byId.values()].filter((node) => node.drawn);
      return {
        // Only the drawn nodes: the user node plus entities a visible fact
        // edge touches. Isolated mentions (no fact edge in the user's world)
        // stay in the database and out of the panel.
        nodes: drawnNodes.map(({ drawn, ...node }) => node),
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
      // Every registered user is ONE node: their :User account doubles as the
      // person entity. So any entity or relation endpoint named after a
      // registered user resolves to that user's :User node, never to an
      // :Entity — a person entity carrying another user's name is a proxy for
      // that user's personal data, and it leaked into the other users' panels
      // as world knowledge ("Mila -LIKES-> Lego" visible while signed in as
      // Roman). The own-person case (the old "Mila -> Mila -> Lego" duplicate)
      // is a special case of this rule.
      const userNames = new Set(users);
      userNames.add(user);
      const isUser = (name) => userNames.has(name);
      const otherEntities = entities.filter((entity) => !isUser(entity.name));
      // Referenced users' :User nodes must exist before relations target them.
      const referencedUsers = new Set(relations.flatMap((relation) => [relation.from, relation.to]).filter(isUser));
      await run(writeClient, "UNWIND $names AS name MERGE (u:User {name: name})", { names: [...new Set([user, ...referencedUsers])] });
      if (otherEntities.length) {
        await run(writeClient,
          "UNWIND $rows AS row " +
          "MATCH (u:User {name: $user}) " +
          "MERGE (e:Entity {name: row.name, type: row.type}) " +
          "ON CREATE SET e.first_seen = row.now " +
          "SET e.last_seen = row.now, " +
          "    e.mention_count = coalesce(e.mention_count, 0) + 1, " +
          "    e.common = coalesce(row.common, e.common, false) " +
          "SET e += row.props " +
          "MERGE (u)-[:KNOWS]->(e)",
          { rows: otherEntities.map((entity) => ({ name: entity.name, type: entity.type, common: entity.common, props: entity.props || {}, now })), user },
        );
        // `common` is only ever the extractor's flag (public knowledge). The
        // old "known by two or more users" auto-flag is gone: it leaked the
        // fact that another user mentioned an entity, which per-user isolation
        // forbids.
      }
    const upserted = otherEntities.length;
      // Each endpoint is matched by the label it actually is: an endpoint
      // named after a registered user is that user's :User node, everything
      // else is an :Entity. Group by (type, from-label, to-label) so the
      // MERGE targets the right nodes (the parser already drops from === to).
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
        const fromPattern = fromLabel === "U" ? "MATCH (a:User {name: row.from})" : "MATCH (a:Entity {name: row.from})";
        const toPattern = toLabel === "U" ? "MATCH (b:User {name: row.to})" : "MATCH (b:Entity {name: row.to})";
        // SET (not just ON CREATE): a later "I don't like X" flips an
        // existing edge to negative, and vice versa.
        await run(writeClient,
          `UNWIND $rows AS row ${fromPattern} ${toPattern} MERGE (a)-[r:${type}]->(b) SET r.last_seen = row.now, r.negative = row.negative`,
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

function createMemoryStore(users = []) {
  const nodes = new Map();
  const edges = [];
  let nextId = 1;

  function addNode({ name, type, common = false, props = {}, user = null }) {
    const existing = [...nodes.values()].find((node) => node.name === name && node.type === type);
    if (existing) return existing;
    const now = new Date().toISOString();
    const node = { id: `mem-${nextId++}`, name, type, common, props, firstSeen: now, lastSeen: now, mentionCount: 0 };
    nodes.set(node.id, node);
    return node;
  }

  function addUser(name) {
    return addNode({ name, type: "person", common: false, props: { role: "user" } });
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

  // The :User node carries no `type` in the panel API (both stores): the UI
  // renders type-less nodes as user nodes, with "(you)" for the signed-in one.
  function publicUserNode(node) {
    return { id: node.id, name: node.name, common: false };
  }

  function userNodeOf(user) {
    return [...nodes.values()].find((node) => node.name === user && node.type === "person" && node.props.role === "user") || null;
  }

  // Same visible-world rules as the Neo4j store: the user node, the entities
  // a visible fact edge touches (candidate world = user + known entities +
  // one entity-hop, exactly like the Neo4j queries), and those edges.
  // `drawn` marks the user node plus every entity a visible fact edge
  // actually touches; isolated mentions are kept in the store (KNOWS stays)
  // but not drawn or counted.
  function visibleWorld(user, cap) {
    const userNode = userNodeOf(user);
    if (!userNode) return null;
    const facts = edges.filter((edge) => edge.type !== "KNOWS");
    const isEntity = (node) => Boolean(node) && node.props.role !== "user";
    const known = new Set(edges.filter((edge) => edge.source === userNode.id && edge.type === "KNOWS").map((edge) => edge.target));
    const knownNodes = [...known].map((id) => nodes.get(id)).filter(Boolean)
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, cap);
    const neighborIds = new Set();
    for (const edge of facts) {
      if (knownNodes.some((node) => node.id === edge.source) && !known.has(edge.target) && isEntity(nodes.get(edge.target))) neighborIds.add(edge.target);
      if (knownNodes.some((node) => node.id === edge.target) && !known.has(edge.source) && isEntity(nodes.get(edge.source))) neighborIds.add(edge.source);
    }
    const byId = new Map([[userNode.id, { node: userNode, drawn: true }]]);
    for (const node of knownNodes) byId.set(node.id, { node, drawn: false });
    for (const id of neighborIds) {
      const node = nodes.get(id);
      if (node && !byId.has(id)) byId.set(id, { node, drawn: false });
    }
    const candidateIds = new Set(byId.keys());
    const drawnEdges = facts
      .filter((edge) => candidateIds.has(edge.source) && candidateIds.has(edge.target))
      .slice(0, 200);
    for (const edge of drawnEdges) {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (source) source.drawn = true;
      if (target) target.drawn = true;
    }
    return { userNode, byId, drawnEdges };
  }

  return {
    memory: true,

    // Counts of the signed-in user's drawn world (must match the panel's
    // subgraph exactly): their :User node, the entities a visible fact edge
    // touches, and those edges.
    async status({ user } = {}) {
      // 60 = the panel's default /api/graph/subgraph?limit=60.
      const world = visibleWorld(user, 60);
      const labels = [...new Set([...nodes.values()].map((node) => (node.props.role === "user" ? "User" : "Entity")))];
      // KNOWS is bookkeeping, not a link the panel should advertise.
      const relTypes = [...new Set(edges.map((edge) => edge.type))].filter((type) => type !== "KNOWS").sort();
      if (!world) return { nodes: 0, edges: 0, labels, relTypes };
      const drawnNodes = [...world.byId.values()].filter((entry) => entry.drawn);
      return {
        nodes: drawnNodes.length,
        edges: world.drawnEdges.length,
        labels,
        relTypes,
      };
    },

    // Scoped to the signed-in user's drawn world, like the Neo4j store:
    // their node plus the entities a visible fact edge touches in that world
    // (isolated mentions are not drawn), or a visible centre plus its
    // neighbours. Never another user's node or edge.
    async subgraph({ user, limit = 60, center = null } = {}) {
      const cap = Math.min(120, Math.max(1, Number(limit) || 60));
      const userNode = userNodeOf(user);
      if (!userNode) return { nodes: [], edges: [], center: null };
      // KNOWS is bookkeeping (provenance for the brain context); the panel
      // only draws real facts, so it is excluded here, not in the UI.
      const facts = edges.filter((edge) => edge.type !== "KNOWS");
      const known = new Set(edges.filter((edge) => edge.source === userNode.id && edge.type === "KNOWS").map((edge) => edge.target));
      const visible = (node) => Boolean(node) && (node.id === userNode.id || node.props.role !== "user");
      if (center) {
        const hub = nodes.get(center);
        const hubVisible = visible(hub) && (hub.id === userNode.id ||
          known.has(hub.id) ||
          facts.some((edge) =>
            (edge.source === hub.id && known.has(edge.target)) ||
            (edge.target === hub.id && known.has(edge.source))));
        if (!hub || !hubVisible) return { nodes: [], edges: [], center };
        const byId = new Map([[hub.id, hub]]);
        const out = [];
        for (const edge of facts) {
          if (edge.source === center && visible(nodes.get(edge.target))) { byId.set(edge.target, nodes.get(edge.target)); out.push(edge); }
          else if (edge.target === center && visible(nodes.get(edge.source))) { byId.set(edge.source, nodes.get(edge.source)); out.push(edge); }
        }
        return {
          nodes: [...byId.values()].map((node) => (node.id === userNode.id ? publicUserNode(node) : publicNode(node))),
          edges: out.slice(0, 200),
          center,
        };
      }
      const world = visibleWorld(user, cap);
      const drawn = [...world.byId.values()].filter((entry) => entry.drawn);
      return {
        // Only the drawn nodes: the user node plus entities a visible fact
        // edge touches. Isolated mentions stay in the store and out of the
        // panel.
        nodes: drawn.map((entry) => (entry.node.id === userNode.id ? publicUserNode(entry.node) : publicNode(entry.node))),
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
      // Same one-node-per-user rule as the Neo4j store: an entity or relation
      // endpoint named after a registered user is that user's node, never an
      // entity (a person entity with a user's name is a proxy for that
      // user's personal data).
      const userNames = new Set(users);
      userNames.add(user);
      const isUser = (name) => userNames.has(name);
      const userNode = [...nodes.values()].find((node) => node.name === user && node.props.role === "user") || addUser(user);
      let upserted = 0;
      for (const entity of entities) {
        if (isUser(entity.name)) continue;
        const node = addNode({ name: entity.name, type: entity.type, common: entity.common, props: entity.props || {} });
        node.mentionCount += 1;
        node.lastSeen = new Date().toISOString();
        // `common` is only the extractor's flag: the old "known by two or more
        // users" auto-flag leaked other users' mentions (see the Neo4j store).
        if (entity.common) node.common = true;
        addEdge(userNode.id, node.id, "KNOWS");
        upserted += 1;
      }
      let linked = 0;
      for (const relation of relations) {
        if (!RELATION_TYPES.has(relation.type)) continue;
        const resolve = (name) => {
          if (isUser(name)) return [...nodes.values()].find((node) => node.name === name && node.props.role === "user") || addUser(name);
          return [...nodes.values()].find((node) => node.name === name && node.props.role !== "user");
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
