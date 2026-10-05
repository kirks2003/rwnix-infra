// Plain-word labels for relation types, with the negative form where the
// graph stores negation as a flag on the same relation ("I don't like X" is
// LIKES + negative, displayed as "doesn't like").
const RELATION_LABELS = {
  WORKS_AT: ["works at", "doesn't work at"],
  LIVES_IN: ["lives in", "doesn't live in"],
  STUDIES_AT: ["studies at", "doesn't study at"],
  BORN_IN: ["born in", "wasn't born in"],
  FRIEND_OF: ["friend of", "not a friend of"],
  FAMILY_OF: ["family of", "not family of"],
  PART_OF: ["part of", "not part of"],
  LOCATED_IN: ["located in", "not located in"],
  RELATED_TO: ["related to", "not related to"],
  MENTIONED_IN: ["mentioned in", "not mentioned in"],
  LIKES: ["likes", "doesn't like"],
  WENT_TO: ["went to", "didn't go to"],
  OWNS: ["owns", "doesn't own"],
  USES: ["uses", "doesn't use"],
};

export function relationLabel(type, negative = false) {
  const entry = RELATION_LABELS[String(type || "").toUpperCase()];
  if (entry) return entry[negative ? 1 : 0];
  const base = String(type || "link").toLowerCase().replace(/_/g, " ");
  return negative ? `not ${base}` : base;
}
