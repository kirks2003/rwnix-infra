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
// The one type the ingestion itself books: it must never be emittable by an
// extraction (KNOWS is internal bookkeeping, never a stored fact).
const RESERVED_RELATION_TYPES = new Set(["KNOWS"]);
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

// A relation type is either one of the known types or a well-formed
// UPPER_SNAKE_CASE name the extraction introduced for a relation none of the
// known types covers ("I'm interested in X" -> INTERESTED_IN). Neo4j creates
// the type on first use, so no migration and no static registry update: the
// schema, the panel labels and the brain's fact formatting are all
// type-agnostic and pick it up as soon as the edge exists.
function normalizeRelationType(raw) {
  return String(raw == null ? "" : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function isRelationType(type) {
  if (typeof type !== "string" || !type || RESERVED_RELATION_TYPES.has(type)) return false;
  if (RELATION_TYPES.has(type)) return true;
  // An introduced type is a short (at most 3 words) UPPER_SNAKE_CASE name —
  // anything longer is prose, not a type.
  return /^[A-Z][A-Z0-9_]{0,23}$/.test(type) && type.split("_").length <= 3;
}

// --- Search ------------------------------------------------------------------
// Entity search is index-backed, never a scan: a Neo4j full-text (Lucene)
// index over (name, owner) answers a query in log time, which is what makes
// the panel's search usable at millions of nodes. The query text is always
// data — Lucene's own syntax characters are escaped, so a stray "(" or "~"
// cannot become an operator or a parse error.
const LUCENE_SPECIAL = /[+\-&|!(){}[\]^"~*?:\\/]/g;

function escapeLucene(value) {
  return String(value == null ? "" : value).replace(LUCENE_SPECIAL, (character) => `\\${character}`);
}

function searchTokens(query) {
  return String(query == null ? "" : query).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
}

// Each token must match (AND); within a token the exact term outranks a
// prefix, which outranks a typo (fuzzy) match — so "btcusd" finds BTCUSD by
// case, "nvi" finds Nvidia by prefix and "nvidea" finds it by edit distance.
// Fuzzy and prefix are skipped on very short tokens, where they match almost
// anything. The owner is a REQUIRED term for a non-admin session: pushing the
// per-user boundary into the index is not an optimisation but the only correct
// way to page it — filtering a global top-N afterwards would silently drop a
// user's own hits off the end once the graph is large.
function buildLuceneQuery(query, { owner = null } = {}) {
  const tokens = searchTokens(query);
  if (!tokens.length) return null;
  const clauses = tokens.map((raw) => {
    const token = escapeLucene(raw);
    const alternatives = [`name:${token}^4`];
    if (raw.length >= 2) alternatives.push(`name:${token}*^2`);
    if (raw.length >= 4) alternatives.push(`name:${token}~^1`);
    return `+(${alternatives.join(" OR ")})`;
  });
  if (owner) clauses.unshift(`+owner:${escapeLucene(String(owner).toLowerCase())}`);
  return clauses.join(" ");
}

// Bounded edit distance (Levenshtein). Used only against the small, bounded
// sets the index cannot cover: relation types, and the memory store's nodes.
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// How many typos to forgive at a given term length: none on a 3-character
// term (where one edit reaches half the alphabet), one up to 5, two beyond.
function typoBudget(length) {
  if (length >= 6) return 2;
  if (length >= 4) return 1;
  return 0;
}

// Does a token match this word, by prefix/substring or within the typo budget?
function tokenMatchesWord(token, word) {
  if (!word) return false;
  if (word.includes(token)) return true;
  return editDistance(token, word) <= typoBudget(token.length);
}

// Relation types ("connectors") cannot go in a node full-text index, and
// Neo4j's token store already knows every type that exists — a bounded list,
// however large the graph gets — so they are matched in JS. A type matches
// when EVERY token of the query hits one of its words, so "interested in"
// and "interest" both find INTERESTED_IN.
function matchRelationTypes(query, types) {
  const tokens = searchTokens(query);
  if (!tokens.length) return [];
  const scored = [];
  for (const type of types || []) {
    if (typeof type !== "string" || RESERVED_RELATION_TYPES.has(type)) continue;
    const words = type.toLowerCase().split("_").filter(Boolean);
    const haystack = words.join(" ");
    let distance = 0;
    const matched = tokens.every((token) => {
      if (haystack.includes(token)) return true;
      const best = words.reduce((lowest, word) => Math.min(lowest, editDistance(token, word)), Infinity);
      if (best <= typoBudget(token.length)) {
        distance += best;
        return true;
      }
      return false;
    });
    if (matched) scored.push({ type, distance });
  }
  // Closest first, then alphabetical so the order is stable between calls.
  scored.sort((a, b) => a.distance - b.distance || a.type.localeCompare(b.type));
  return scored.slice(0, 10).map((entry) => entry.type);
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
    // One entity per turn per NAME (case-insensitive): the store's key is
    // (name, owner) without the type, so a same-turn name+type and
    // name+other-type pair would just bump the same node twice — the first
    // occurrence wins, and the count stays honest.
    const key = entity.name.toLowerCase();
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
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    // Known types pass through; a well-formed new type is introduced as-is
    // (the store creates it on first use); malformed prose falls back to the
    // generic RELATED_TO so the fact itself is never lost.
    const normalised = normalizeRelationType(raw && raw.type);
    const type = isRelationType(normalised) ? normalised : "RELATED_TO";
    // Endpoint names case-insensitive: entity identity is (name, owner)
    // without the type, so "likes btcusd" and "likes BTCUSD" are one fact.
    const key = `${from.toLowerCase()}|${to.toLowerCase()}|${type}`;
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
  // boundary: an :Entity exists once per owner (keyed by name, case-insensitive), so
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

    // Schema the store needs to stay fast as the graph grows. Idempotent
    // (IF NOT EXISTS), so startup converges on an existing database and a
    // redeploy is a no-op. Without these, every owner-scoped read is a label
    // scan and search is impossible above demo size:
    //  - entity_search: the full-text (Lucene) index search queries, over the
    //    name AND the owner, so the per-user filter is answered by the index.
    //  - entity_owner: every read pinned to owner = the session user.
    //  - entity_owner_last_seen: the panel's own world, newest first. The
    //    composite index serves the equality AND the ordering, so the query
    //    stops after `limit` rows instead of sorting the owner's whole set.
    //  - entity_last_seen: the same read for the admin's global view.
    //  - user_name: the account lookups the ingest and the fact endpoints do.
    async ensureIndexes() {
      const statements = [
        "CREATE FULLTEXT INDEX entity_search IF NOT EXISTS FOR (e:Entity) ON EACH [e.name, e.owner]",
        "CREATE INDEX entity_owner IF NOT EXISTS FOR (e:Entity) ON (e.owner)",
        "CREATE INDEX entity_owner_last_seen IF NOT EXISTS FOR (e:Entity) ON (e.owner, e.last_seen)",
        "CREATE INDEX entity_last_seen IF NOT EXISTS FOR (e:Entity) ON (e.last_seen)",
        "CREATE INDEX user_name IF NOT EXISTS FOR (u:User) ON (u.name)",
      ];
      for (const statement of statements) await run(writeClient, statement);
      return { created: statements.length };
    },

    // Fuzzy entity search, scoped like every other read: a user searches
    // their own world, the admin session searches the whole graph. The
    // owner term is inside the Lucene query AND re-checked here — the
    // isolation boundary must not depend on the query string being built
    // right. Bounded by `limit`, with one row fetched beyond it so the UI can
    // say the list was cut without a second counting query.
    async search({ user, query, admin = false, limit = 25 } = {}) {
      const lucene = buildLuceneQuery(query, { owner: admin ? null : user });
      const relTypeRows = rows(await run(readClient, "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType AS type"));
      const relTypes = matchRelationTypes(query, relTypeRows.map((row) => row.type));
      if (!lucene) return { nodes: [], relTypes, truncated: false };
      const cap = Math.min(Math.max(1, Number(limit) || 25), 100);
      const nodeRows = rows(await run(readClient,
        "CALL db.index.fulltext.queryNodes('entity_search', $lucene, {limit: $limit}) YIELD node, score " +
        "WITH node, score " +
        (admin ? "" : "WHERE node.owner = $user ") +
        "RETURN elementId(node) AS id, node.name AS name, node.type AS type, node.owner AS owner, score " +
        "ORDER BY score DESC, name",
        { lucene, limit: neo4j.int(cap + 1), user },
      ));
      return {
        nodes: nodeRows.slice(0, cap).map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          owner: row.owner,
          score: Math.round(Number(row.score) * 1000) / 1000,
        })),
        relTypes,
        truncated: nodeRows.length > cap,
      };
    },

    // Counts of the signed-in user's drawn world (must match the panel's
    // subgraph exactly): their :User node, the entities they own (isolated
    // mentions included, flagged by the subgraph) and those fact edges.
    // Never another user's node or edge — except for the admin, whose view is
    // the whole graph (every user's world at once).
    async status({ user, admin = false } = {}) {
      // 60 = the panel's default /api/graph/subgraph?limit=60.
      const [world, labelRows, relRows] = await Promise.all([
        visibleWorld(user, 60, null, admin),
        // db.labels()/db.relationshipTypes() read the token store: the answer
        // costs the same on ten nodes as on ten million. The equivalent
        // "MATCH (n) UNWIND labels(n)" is a full scan of the graph, and the
        // panel asks for this every 15 seconds.
        rows(await run(readClient, "CALL db.labels() YIELD label RETURN label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "CALL db.relationshipTypes() YIELD relationshipType AS t RETURN t ORDER BY t LIMIT 50")),
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
        // db.labels()/db.relationshipTypes() read the token store: the answer
        // costs the same on ten nodes as on ten million. The equivalent
        // "MATCH (n) UNWIND labels(n)" is a full scan of the graph, and the
        // panel asks for this every 15 seconds.
        rows(await run(readClient, "CALL db.labels() YIELD label RETURN label ORDER BY label LIMIT 50")),
        rows(await run(readClient, "CALL db.relationshipTypes() YIELD relationshipType AS t RETURN t ORDER BY t LIMIT 50")),
        rows(await run(readClient, "CALL db.propertyKeys() YIELD propertyKey AS key RETURN key ORDER BY key LIMIT 50")),
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
    // (name, owner) — the name case-insensitively, the type NOT part of the
    // identity — with owner = the signed-in user of the turn: each user gets
    // their own copy of every entity they mention (and one copy only, no
    // matter how the type or casing is re-extracted), which is what makes the
    // whole graph per-user private by construction (reads match on owner, so
    // no query can cross the boundary).
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
      const candidates = entities.filter((entity) => !isUser(entity.name));
      const skippedUsers = entities.length - candidates.length;
      // An entity is only worth storing when a fact connects it: a bare
      // mention ("we talked about Vienna") would otherwise land as a node no
      // edge touches, which is noise in the panel and in the brain's context.
      // So the writable facts are resolved FIRST, and only their endpoints are
      // created. An endpoint resolves when it is a registered user (their
      // :User node is merged below), an entity this turn is about to store, or
      // one this owner already has — the last one needs a read, otherwise a
      // fact onto an earlier entity would look unresolvable and its endpoint
      // would be dropped.
      const typed = relations.filter((relation) => isRelationType(relation.type));
      const lower = (name) => String(name).toLowerCase();
      const candidateNames = new Set(candidates.map((entity) => lower(entity.name)));
      const referenced = [...new Set(typed.flatMap((relation) => [lower(relation.from), lower(relation.to)]))];
      const storedNames = new Set();
      if (referenced.length) {
        const storedRows = rows(await run(readClient,
          "MATCH (e:Entity {owner: $user}) WHERE toLower(e.name) IN $names RETURN toLower(e.name) AS name",
          { user, names: referenced },
        ));
        for (const row of storedRows) storedNames.add(row.name);
      }
      const resolvable = (name) => isUser(name) || candidateNames.has(lower(name)) || storedNames.has(lower(name));
      const writable = typed.filter((relation) => resolvable(relation.from) && resolvable(relation.to) && lower(relation.from) !== lower(relation.to));
      const connected = new Set(writable.flatMap((relation) => [lower(relation.from), lower(relation.to)]));
      const otherEntities = candidates.filter((entity) => connected.has(lower(entity.name)));
      const skippedUnconnected = candidates.length - otherEntities.length;
      // Referenced users' :User nodes must exist before relations target them.
      const referencedUsers = new Set(writable.flatMap((relation) => [relation.from, relation.to]).filter(isUser));
      await run(writeClient, "UNWIND $names AS name MERGE (u:User {name: name})", { names: [...new Set([user, ...referencedUsers])] });
     if (otherEntities.length) {
        // Keyed by (name, owner), the name CASE-INSENSITIVELY — the type is a
        // property, not part of the identity: a thing first stored as "topic"
        // and later extracted as "thing" (or with different casing) is ONE
        // node per owner, and the first stored copy's spelling+type is kept.
        // (A MERGE on {name, type, owner} would create one node per type —
        // the "two BTCUSD" bug.) "Lego" mentioned by two users is still two
        // nodes, one per owner — no common flag, no KNOWS edge, ownership IS
        // the provenance.
        await run(writeClient,
          "UNWIND $rows AS row " +
          "OPTIONAL MATCH (e:Entity {owner: $user}) " +
          "WHERE toLower(e.name) = toLower(row.name) " +
          "FOREACH (_ IN CASE WHEN e IS NULL THEN [1] ELSE [] END | " +
          "CREATE (e:Entity {name: row.name, type: row.type, owner: $user, first_seen: row.now}) " +
          ") " +
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
      for (const relation of writable) {
        const key = `${relation.type}|${isUser(relation.from) ? "U" : "E"}|${isUser(relation.to) ? "U" : "E"}`;
        const list = buckets.get(key) || [];
        list.push({ from: relation.from, to: relation.to, negative: relation.negative === true });
        buckets.set(key, list);
      }
      let linked = 0;
      for (const [key, list] of buckets) {
        const [type, fromLabel, toLabel] = key.split("|");
        // Entity endpoints match by (owner, lower(name)) — the same identity
        // as the upsert above, so a casing variant of a stored name resolves
        // to the existing copy instead of a fact edge into thin air.
        const fromPattern = fromLabel === "U" ? "MATCH (a:User {name: row.from})" : "MATCH (a:Entity {owner: $user}) WHERE toLower(a.name) = toLower(row.from)";
        const toPattern = toLabel === "U" ? "MATCH (b:User {name: row.to})" : "MATCH (b:Entity {owner: $user}) WHERE toLower(b.name) = toLower(row.to)";
        // SET (not just ON CREATE): a later "I don't like X" flips an
        // existing edge to negative, and vice versa.
        await run(writeClient,
          `UNWIND $rows AS row ${fromPattern} ${toPattern} MERGE (a)-[r:${type}]->(b) SET r.last_seen = row.now, r.negative = row.negative`,
          { rows: list.map((relation) => ({ ...relation, now })), user },
        );
        linked += list.length;
      }
      // The check at the end of every ingest: nothing this turn touched may be
      // left without a fact edge. The write above is built not to make one,
      // but an orphan can still appear — a fact whose other endpoint failed to
      // match, or a concurrent turn — so the invariant is verified against the
      // database instead of trusted, and what it finds is removed and
      // reported. KNOWS is bookkeeping, not a fact, so it does not count as a
      // connection (the same rule the panel's `isolated` flag uses).
      //
      // Deliberately scoped to this turn's names, not to everything the owner
      // has: the check must cost the same on a graph of millions as on one of
      // ten, and "this ingest created no orphan" is the invariant an ingest
      // can actually own. A pre-existing orphan (one an older write or a
      // delete left behind) is a maintenance job, not this code path.
      const touched = [...new Set([
        ...otherEntities.map((entity) => lower(entity.name)),
        ...writable.flatMap((relation) => [lower(relation.from), lower(relation.to)]),
      ])];
      const orphanRows = touched.length ? rows(await run(writeClient,
        "MATCH (e:Entity {owner: $user}) WHERE toLower(e.name) IN $names " +
        "AND NOT EXISTS { MATCH (e)-[r]-() WHERE type(r) <> 'KNOWS' } " +
        "WITH e, e.name AS name " +
        "DETACH DELETE e " +
        "RETURN name",
        { user, names: touched },
      )) : [];
      return {
        upserted,
        relations: linked,
        skippedUsers,
        skippedUnconnected,
        orphansRemoved: orphanRows.map((row) => row.name),
      };
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
    // Entities are keyed by (name, owner), the name CASE-INSENSITIVELY (the
    // type is not part of the identity — mirrors the Neo4j upsert): one node
    // per owner, so each user's world is private by construction. The first
    // stored copy's spelling+type is kept. User nodes keep the exact
    // configured spelling (they are only ever created with one).
    const existing = owner === null
      ? [...nodes.values()].find((node) => node.name === name && node.type === type && node.owner === owner)
      : [...nodes.values()].find((node) => node.owner === owner && node.props.role !== "user" && node.name.toLowerCase() === name.toLowerCase());
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

    // No schema to create in memory; the method exists so the backend can
    // call it without caring which store it got.
    async ensureIndexes() {
      return { created: 0 };
    },

    // The Lucene index's behaviour, scored in JS over the store's handful of
    // nodes: exact name, then prefix/substring, then a typo within the budget.
    // Scoped like every other read — own world, or the whole store for admin.
    async search({ user, query, admin = false, limit = 25 } = {}) {
      const relTypes = matchRelationTypes(query, [...new Set(edges.map((edge) => edge.type))]);
      const tokens = searchTokens(query);
      if (!tokens.length) return { nodes: [], relTypes, truncated: false };
      const cap = Math.min(Math.max(1, Number(limit) || 25), 100);
      const scored = [];
      for (const node of nodes.values()) {
        if (node.props.role === "user") continue;
        if (!admin && node.owner !== user) continue;
        const name = String(node.name).toLowerCase();
        const words = name.split(/\s+/).filter(Boolean);
        let score = 0;
        const matched = tokens.every((token) => {
          if (name === token) { score += 4; return true; }
          if (name.startsWith(token) || words.some((word) => word.startsWith(token))) { score += 2; return true; }
          if (name.includes(token)) { score += 1.5; return true; }
          if (words.some((word) => tokenMatchesWord(token, word))) { score += 1; return true; }
          return false;
        });
        if (matched) scored.push({ node, score });
      }
      scored.sort((a, b) => b.score - a.score || String(a.node.name).localeCompare(String(b.node.name)));
      return {
        nodes: scored.slice(0, cap).map(({ node, score }) => ({
          id: node.id,
          name: node.name,
          type: node.type,
          owner: node.owner,
          score,
        })),
        relTypes,
        truncated: scored.length > cap,
      };
    },

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
      // Same rule as the Neo4j store: only an entity a fact actually connects
      // is stored, so the writable facts are resolved before anything is
      // created (an endpoint resolves when it is a registered user, an entity
      // this turn stores, or one this owner already has).
      const lower = (name) => String(name).toLowerCase();
      const candidates = entities.filter((entity) => !isUser(entity.name));
      const skippedUsers = entities.length - candidates.length;
      const typed = relations.filter((relation) => isRelationType(relation.type));
      const candidateNames = new Set(candidates.map((entity) => lower(entity.name)));
      const storedNames = new Set([...nodes.values()]
        .filter((node) => node.props.role !== "user" && node.owner === user)
        .map((node) => lower(node.name)));
      const resolvable = (name) => isUser(name) || candidateNames.has(lower(name)) || storedNames.has(lower(name));
      const writable = typed.filter((relation) => resolvable(relation.from) && resolvable(relation.to) && lower(relation.from) !== lower(relation.to));
      const connected = new Set(writable.flatMap((relation) => [lower(relation.from), lower(relation.to)]));
      let upserted = 0;
      let skippedUnconnected = 0;
      for (const entity of candidates) {
        if (!connected.has(lower(entity.name))) {
          skippedUnconnected += 1;
          continue;
        }
        const node = addNode({ name: entity.name, type: entity.type, owner: user, props: entity.props || {} });
        node.mentionCount += 1;
        node.lastSeen = new Date().toISOString();
        upserted += 1;
      }
      let linked = 0;
      for (const relation of writable) {
        const resolve = (name) => {
          if (isUser(name)) return [...nodes.values()].find((node) => node.name === name && node.props.role === "user") || addUser(name);
          // Entity endpoints are the turn user's own copies (keyed by name,
          // case-insensitive — like the Neo4j MATCH): a relation to an entity
          // this user has not mentioned yet is dropped.
          return [...nodes.values()].find((node) => node.props.role !== "user" && node.owner === user && node.name.toLowerCase() === name.toLowerCase()) || null;
        };
        const from = resolve(relation.from);
        const to = resolve(relation.to);
        if (from && to && from !== to) {
          addEdge(from.id, to.id, relation.type, relation.negative === true);
          linked += 1;
        }
      }
      // The same end-of-ingest check as the Neo4j store, over the same scope:
      // the names this turn touched, so the cost does not grow with the graph.
      const touched = new Set([
        ...candidates.map((entity) => lower(entity.name)),
        ...writable.flatMap((relation) => [lower(relation.from), lower(relation.to)]),
      ]);
      const orphansRemoved = [];
      for (const node of [...nodes.values()]) {
        if (node.props.role === "user" || node.owner !== user) continue;
        if (!touched.has(lower(node.name))) continue;
        const connectedByFact = edges.some((edge) => edge.type !== "KNOWS" && (edge.source === node.id || edge.target === node.id));
        if (connectedByFact) continue;
        orphansRemoved.push(node.name);
        nodes.delete(node.id);
        for (let i = edges.length - 1; i >= 0; i -= 1) {
          if (edges[i].source === node.id || edges[i].target === node.id) edges.splice(i, 1);
        }
      }
      return { upserted, relations: linked, skippedUsers, skippedUnconnected, orphansRemoved };
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

// Recover OpenAI-shaped tool calls when the brain returned them as native
// XML inside the message content (DeepSeek behind an OpenAI-compatible proxy
// does this intermittently):
//   <|tool_calls|><|invoke| name="list-my-facts"><|parameter|
//   name="relation" string="true">PART_OF<|/parameter|><|/invoke|>
//   <|/tool_calls|>
// Unparsed, that XML would be spoken and rendered as the answer. The anchors
// (invoke/parameter tags with name="...") are matched leniently: the wrapper
// tokens vary between model builds. Returns [] for ordinary answers — the
// gate requires the tool_calls wrapper, or both an invoke and a parameter
// tag, so prose that merely mentions these words is never reinterpreted.
function parseToolCallsFromContent(content) {
  const text = typeof content === "string" ? content : "";
  const looksLikeToolCallXml = /<\|?tool_calls\|?/.test(text)
    || (/<\|?invoke\|?\s+name="/.test(text) && /<\|?parameter\|?\s+name="/.test(text));
  if (!looksLikeToolCallXml) return [];
  const calls = [];
  const invokeRe = /<\|?invoke\|?\s+name="([^"]+)"[^>]*>([\s\S]*?)<\|?\/invoke\|?/g;
  const paramRe = /<\|?parameter\|?\s+name="([^"]+)"[^>]*>([\s\S]*?)<\|?\/parameter\|?/g;
  let block;
  while ((block = invokeRe.exec(text)) !== null && calls.length < 8) {
    const args = {};
    let param;
    paramRe.lastIndex = 0;
    while ((param = paramRe.exec(block[2])) !== null) {
      const raw = param[2].trim();
      let value = raw;
      try { value = JSON.parse(raw); } catch { /* plain string value */ }
      args[param[1]] = value;
    }
    calls.push({ id: `xml_${calls.length}_${block[1]}`, type: "function", function: { name: block[1], arguments: JSON.stringify(args) } });
  }
  return calls;
}

module.exports = {
  ENTITY_TYPES,
  RELATION_TYPES,
  MAX_ENTITIES,
  MAX_RELATIONS,
  parseExtraction,
  parseToolCallsFromContent,
  isRelationType,
  normalizeRelationType,
  sanitizeName,
  formatGraphContext,
  buildLuceneQuery,
  matchRelationTypes,
  createGraphStore,
  createMemoryStore,
};
