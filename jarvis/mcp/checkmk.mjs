#!/usr/bin/env node
// Checkmk REST API as a stdio MCP server: wraps the Checkmk 2.x /api/1.0
// HTTP API in a handful of monitoring tools, so the brain can query hosts,
// services and states the same way it queries the graph or the web.
//
// Env (the deployment sets both; without them the server lists no tools and
// every call answers "not configured", so the UI switch can exist without a
// working instance behind it):
//   CHECKMK_BASE_URL   e.g. https://host/checkmk/api/1.0
//   CHECKMK_TOKEN      API token (sent as Bearer)
//   CHECKMK_INSECURE   "1" = skip TLS verification (self-signed internal cert)
//   CHECKMK_TIMEOUT_MS per-request timeout, default 15000
import readline from "node:readline";
import http from "node:http";
import https from "node:https";

const baseUrl = process.env.CHECKMK_BASE_URL;
const token = process.env.CHECKMK_TOKEN;
const insecure = process.env.CHECKMK_INSECURE === "1";
const timeoutMs = Number(process.env.CHECKMK_TIMEOUT_MS || 15000);
const configured = Boolean(baseUrl && token);

const STATES = { 0: "OK", 1: "WARNING", 2: "CRITICAL", 3: "UNKNOWN" };

function request(pathname, params = {}) {
  if (!configured) {
    return Promise.reject(new Error("Checkmk is not configured (CHECKMK_BASE_URL/CHECKMK_TOKEN missing)"));
  }
  const target = new URL(baseUrl.replace(/\/$/, "") + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") target.searchParams.set(key, String(value));
  }
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(
      target,
      {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        rejectUnauthorized: !insecure,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Checkmk HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Checkmk returned non-JSON: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Checkmk request timed out after ${timeoutMs} ms`)));
    req.on("error", reject);
  });
}

function hostLine(item) {
  const name = item.host_name || "(unnamed)";
  const address = item.address ? ` ${item.address}` : "";
  const site = item.site ? ` [${item.site}]` : "";
  const active = item.is_active === false ? " (inactive)" : "";
  return `${name}${address}${site}${active}`;
}

function hostsText(data) {
  const rows = data.data || [];
  const more = data.is_truncated
    ? `\n… ${data.total} hosts total, first ${rows.length} shown — narrow the search or raise the limit.`
    : "";
  return `${rows.length} host(s)${data.total != null ? ` of ${data.total}` : ""}.\n${rows.map(hostLine).join("\n")}${more}`;
}

function servicesText(data, host) {
  const rows = data.data || [];
  const lines = rows.map((item) => {
    const state = STATES[item.state] ?? `state ${item.state}`;
    const soft = item.state_type === "soft" ? " (soft)" : "";
    const plugin = item.plugin_name ? ` [${item.plugin_name}]` : "";
    return `${item.service_description || "(unnamed)"}: ${state}${soft}${plugin}`;
  });
  const more = data.is_truncated ? ` of ${data.total}` : "";
  return `${host}: ${rows.length} service(s) shown${more}.\n${lines.join("\n")}`;
}

const TOOLS = [
  {
    name: "cmk_status",
    description: "Check the Checkmk instance itself (version, edition, API health). Call this first if any other Checkmk tool fails.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cmk_hosts",
    description: "List the hosts Checkmk monitors with address, site and active state. Use search to narrow by (part of) a host name; raise limit for more rows.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional substring to filter host names." },
        limit: { type: "integer", description: "Max hosts to list (default 50, max 200)." },
      },
    },
  },
  {
    name: "cmk_host",
    description: "Show the attributes of one monitored host by exact host name (address, site, active state, labels, contact groups).",
    inputSchema: {
      type: "object",
      properties: { host_name: { type: "string" } },
      required: ["host_name"],
    },
  },
  {
    name: "cmk_services",
    description: "List the services of one host with their current state (OK/WARNING/CRITICAL/UNKNOWN). This is how you answer 'is X down' or 'what is failing on X'.",
    inputSchema: {
      type: "object",
      properties: {
        host_name: { type: "string" },
        limit: { type: "integer", description: "Max services to list (default 50, max 200)." },
      },
      required: ["host_name"],
    },
  },
];

function clampLimit(value, fallback = 50) {
  const limit = Math.trunc(Number(value));
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : fallback;
}

async function callTool(name, args = {}) {
  switch (name) {
    case "cmk_status": {
      const data = await request("/status");
      const info = data.data || {};
      return `Checkmk ${info.version || "unknown"} (${info.edition || "unknown edition"}) is up and answering its API.`;
    }
    case "cmk_hosts": {
      const data = await request("/hosts", {
        columns: "host_name,address,site,is_active",
        limit: clampLimit(args.limit),
        search: args.search,
      });
      return hostsText(data);
    }
    case "cmk_host": {
      if (!args.host_name) return "Missing host_name.";
      const data = await request(`/hosts/${encodeURIComponent(args.host_name)}`, {
        columns: "host_name,address,site,is_active,labels,contact_groups",
      });
      const info = data.data || {};
      const lines = [`Host: ${hostLine(info)}`];
      for (const key of ["labels", "contact_groups"]) {
        if (Array.isArray(info[key]) && info[key].length) lines.push(`${key}: ${info[key].join(", ")}`);
      }
      return lines.join("\n");
    }
    case "cmk_services": {
      if (!args.host_name) return "Missing host_name.";
      const data = await request(`/hosts/${encodeURIComponent(args.host_name)}/services`, {
        columns: "service_description,plugin_name,state,state_type",
        limit: clampLimit(args.limit),
      });
      return servicesText(data, args.host_name);
    }
    default:
      return `Unknown tool ${name}. Use: ${TOOLS.map((tool) => tool.name).join(", ")}.`;
  }
}

const respond = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return; // notifications: nothing to answer
  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "jarvis-checkmk", version: "1.0.0" },
        instructions: configured
          ? "Checkmk monitoring tools: cmk_status, cmk_hosts, cmk_host, cmk_services. States are OK/WARNING/CRITICAL/UNKNOWN."
          : "Checkmk is not configured on this deployment; every tool call answers with the missing configuration.",
      });
      return;
    case "tools/list":
      respond(id, { tools: configured ? TOOLS : [] });
      return;
    case "tools/call": {
      const name = params && params.name;
      if (!configured) {
        respond(id, { content: [{ type: "text", text: "Checkmk is not configured on this deployment (no CHECKMK_BASE_URL/CHECKMK_TOKEN)." }], isError: true });
        return;
      }
      if (!TOOLS.some((tool) => tool.name === name)) {
        respond(id, { content: [{ type: "text", text: `Unknown tool ${name}. Use: ${TOOLS.map((tool) => tool.name).join(", ")}.` }], isError: true });
        return;
      }
      try {
        const text = await callTool(name, (params && params.arguments) || {});
        respond(id, { content: [{ type: "text", text }] });
      } catch (error) {
        respond(id, { content: [{ type: "text", text: `Checkmk lookup failed: ${error.message}` }], isError: true });
      }
      return;
    }
    default:
      respond(id, { tools: [] }); // unknown method: answer with an empty result rather than an error
      return;
  }
});
