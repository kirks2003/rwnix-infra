const fs = require("node:fs");
const path = require("node:path");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

function defaultLocalRepoBase() {
  return process.env.JARVIS_LOCAL_REPO_BASE || "/data/repos/workspaces";
}

function isDirectory(fsModule, target) {
  try {
    return fsModule.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listDirectories(fsModule, target) {
  try {
    return fsModule
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function inferLocalRepoPath({
  workspaceId,
  title = "",
  prompt = "",
  base,
  fsModule = fs,
} = {}) {
  const workspace = coerceText(workspaceId);
  if (!workspace) return "";
  const root = path.join(base || defaultLocalRepoBase(), workspace, "github");
  const owners = listDirectories(fsModule, root);
  const text = `${coerceText(title)}\n${coerceText(prompt)}`.toLowerCase();
  const matches = new Set();
  for (const owner of owners) {
    if (/^\d+$/.test(owner)) continue;
    for (const repo of listDirectories(fsModule, path.join(root, owner))) {
      const slug = `${owner}/${repo}`.toLowerCase();
      if (!text.includes(slug)) continue;
      const candidate = path.join(root, owner, repo);
      if (isDirectory(fsModule, candidate)) matches.add(candidate);
    }
  }
  if (matches.size !== 1) return "";
  return [...matches][0];
}

function normalizeCreateTaskKandev(args, inputSchema, options = {}) {
  if (!isPlainObject(args)) return args;
  const next = { ...args };
  const rawProperties = isPlainObject(inputSchema) && isPlainObject(inputSchema.properties)
    ? inputSchema.properties
    : null;
  const properties = rawProperties && Object.keys(rawProperties).length > 0 ? rawProperties : null;

  const originalTitle = coerceText(args.title);
  const description = coerceText(args.description);
  if (!coerceText(next.prompt) && description) next.prompt = description;
  delete next.description;

  if (typeof next.title === "string" && properties) {
    const maxLength = Number(properties.title && properties.title.maxLength);
    if (Number.isInteger(maxLength) && maxLength >= 0 && next.title.length > maxLength) {
      next.title = next.title.slice(0, maxLength);
    }
  }

  if (properties) {
    for (const key of Object.keys(next)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) delete next[key];
    }
  } else {
    delete next.priority;
  }

  const hasRepository = [
    "local_path",
    "repository_id",
    "repository_url",
    "parent_id",
  ].some((key) => coerceText(next[key]) || (key === "parent_id" && next[key] !== undefined && next[key] !== null));
  if (!hasRepository) {
    const inferred = inferLocalRepoPath({
      workspaceId: next.workspace_id,
      title: originalTitle,
      prompt: next.prompt,
      base: options.localRepoBase,
      fsModule: options.fsModule,
    });
    if (inferred) next.local_path = inferred;
  }

  return next;
}

function normalizeExternalMcpArgs(toolName, args, inputSchema, options = {}) {
  if (String(toolName || "") !== "create_task_kandev") return args;
  return normalizeCreateTaskKandev(args, inputSchema, options);
}

module.exports = {
  normalizeExternalMcpArgs,
  normalizeCreateTaskKandev,
  inferLocalRepoPath,
};
