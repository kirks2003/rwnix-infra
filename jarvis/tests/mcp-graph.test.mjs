import { test } from "node:test";
import assert from "node:assert/strict";
import { QUERIES, formatEntity, formatKnowledge, formatFacts } from "../mcp/graph.mjs";

// The MCP graph server is the brain's only window into the database. These
// pins keep every query bounded by the signed-in user (owner = them): a
// foreign or unknown entity name must come back exactly like a nonexistent
// one, and no query may return another user's entity.

test("get-entity is owner-scoped: a foreign entity name is indistinguishable from a nonexistent one", () => {
  // The entity match is pinned to owner = $user — the parameter the backend
  // injects; the brain never sees or sets it.
  assert.ok(QUERIES.getEntity.includes("MATCH (e:Entity {name: $name, owner: $user})"), QUERIES.getEntity);
  assert.doesNotMatch(QUERIES.getEntity, /MATCH \(e:Entity \{name: \$name\}\)/, "no unscoped entity match");
  // Links are only to :User account markers or the user's own entities —
  // never to another user's entity.
  assert.ok(QUERIES.getEntity.includes("other:User OR coalesce(other.owner, '') = $user"), QUERIES.getEntity);
  // The KNOWS bookkeeping is gone; the negative flag is still returned.
  assert.doesNotMatch(QUERIES.getEntity, /KNOWS/);
  assert.ok(QUERIES.getEntity.includes("coalesce(r.negative, false)"), QUERIES.getEntity);
});

test("list-my-knowledge returns only the user's own entities", () => {
  assert.ok(QUERIES.listMyKnowledge.includes("MATCH (e:Entity {owner: $user})"), QUERIES.listMyKnowledge);
  assert.doesNotMatch(QUERIES.listMyKnowledge, /common/);
});

test("list-my-facts stays pinned to the user's :User node", () => {
  assert.ok(QUERIES.listMyFacts.includes("MATCH (u:User {name: $user})-[r]->(e:Entity)"), QUERIES.listMyFacts);
  assert.ok(QUERIES.listMyFacts.includes("type(r) <> 'KNOWS'"), QUERIES.listMyFacts);
});

test("formatEntity renders the entity, its props and its links", () => {
  const text = formatEntity(
    { name: "Lego", type: "thing", props: { name: "Lego", type: "thing", owner: "Mila", mention_count: 2, note: "toy bricks" } },
    [
      { other: "Mila", rel: "LIKES", dir: "INCOMING", negative: false },
      { other: "Kokoro-82M", rel: "USES", dir: "OUTGOING", negative: true },
    ],
  );
  assert.match(text, /^Lego \(thing\)\./);
  assert.match(text, /Properties: note=toy bricks\./);
  assert.match(text, /Mila likes -> Lego/);
  assert.match(text, /Lego uses -> Kokoro-82M \(negative\)/);
  // The owner bookkeeping never leaks into the rendered properties.
  assert.doesNotMatch(text, /owner/);
});

test("formatEntity renders no-links cleanly", () => {
  assert.equal(formatEntity({ name: "Berlin", type: "place", props: { name: "Berlin", type: "place", owner: "Mila" } }, []), "Berlin (place). Links: none.");
});

test("formatKnowledge lists the user's entities (or the empty state)", () => {
  assert.equal(formatKnowledge([]), "This user has no stored knowledge yet.");
  assert.equal(
    formatKnowledge([{ name: "Amelie", type: "person" }, { name: "Berlin" }]),
    "This user knows: Amelie (person), Berlin (thing).",
  );
});

test("formatFacts renders facts and the empty state with filters", () => {
  assert.equal(formatFacts([], "Lego", "LIKES"), 'No stored facts about this user mentioning "Lego" of type LIKES yet.');
  assert.equal(formatFacts([{ type: "LIKES", name: "Lego", negative: true }]), "Facts about this user: likes (negative) -> Lego.");
});
