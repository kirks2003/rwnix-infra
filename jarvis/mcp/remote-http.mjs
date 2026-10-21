#!/usr/bin/env node
// stdio -> MCP Streamable-HTTP bridge. The jarvis McpClient speaks JSON-RPC
// over a child's stdio; the remote server (the Kandev MCP endpoints, and any
// other MCP-over-HTTP service) speaks the MCP Streamable HTTP transport:
// POST one JSON-RPC message, answer as application/json or a text/event-
// stream, session tracked via the Mcp-Session-Id header. This child
// translates both ways so the backend can treat the remote server exactly
// like its local stdio MCP servers.
//
// Usage:  node remote-http.mjs <mcp-http-url>
// Env:    KANDEV_HTTP_URL         (alternative to the URL argument)
//         KANDEV_HTTP_HEADERS     (optional JSON object of extra request headers)
//         KANDEV_HTTP_TIMEOUT_MS  (per-request timeout, default 30000)
//
// Requests are serialized on a queue: the session is stateful (initialize
// must answer before tools/list may run), and a single in-flight request is
// all this bridge ever needs.
import readline from "node:readline";

const url = process.argv[2] || process.env.KANDEV_HTTP_URL;
if (!url) {
  process.stderr.write("usage: remote-http.mjs <mcp-http-url>\n");
  process.exit(2);
}
const timeoutMs = Number(process.env.KANDEV_HTTP_TIMEOUT_MS || 30000);
let extraHeaders = {};
const rawHeaders = process.env.KANDEV_HTTP_HEADERS;
if (rawHeaders) {
  try {
    const parsed = JSON.parse(rawHeaders);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) extraHeaders = parsed;
  } catch (error) {
    process.stderr.write(`KANDEV_HTTP_HEADERS is not a JSON object, ignoring it: ${error.message}\n`);
  }
}

let sessionId = null;
let queue = Promise.resolve();

// The answer to a request is the message that carries the request's id —
// once as application/json, or as one of the data: events of an SSE stream
// (the others are server pushes this bridge does not need).
function extractResponse(body, contentType, requestId) {
  if (!body || !body.trim()) return null;
  if (contentType.includes("text/event-stream")) {
    const messages = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch (error) {
        // keep-alive comment or non-JSON data line: nothing to deliver
      }
    }
    return messages.find((message) => message && message.id === requestId) || null;
  }
  const parsed = JSON.parse(body);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.find((message) => message && message.id === requestId) || messages[0] || null;
}

async function post(message) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) sessionId = nextSession;
  if (message.id === undefined) {
    // Notifications get no response body (202 is the documented answer);
    // anything else is worth a stderr line but never kills the bridge.
    if (!response.ok && response.status !== 202) {
      process.stderr.write(`notification ${message.method}: HTTP ${response.status}\n`);
    }
    return null;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const body = await response.text();
  return extractResponse(body, response.headers.get("content-type") || "", message.id);
}

const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return;
  }
  queue = queue.then(async () => {
    try {
      const reply = await post(message);
      if (reply) write(reply);
    } catch (error) {
      if (message.id !== undefined) {
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error.message || error) } });
      } else {
        process.stderr.write(`notification ${message.method} failed: ${error.message}\n`);
      }
    }
  });
});
rl.on("close", () => process.exit(0));
