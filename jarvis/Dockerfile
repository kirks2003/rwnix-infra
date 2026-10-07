FROM node:20-slim

WORKDIR /app

# The knowledge-graph MCP server (mcp/graph.mjs, Node) runs from the copied
# source; the web-search MCP server (mcp/websearch.mjs) additionally opens
# pages in a real headless Chromium (the web_fetch tool), so the image ships
# the browser binary plus its system libraries.
COPY package.json ./
# Skip the browser download during npm install (it would land in a separate
# cache and lack the system libraries); it is installed explicitly below.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --omit=dev
# The Vikunja MCP server (@eargollo/vikunja-mcp, stdio) is a published
# package: server.js spawns /usr/local/bin/vikunja-mcp, one child per
# (region, user), pinned to that user's own API token for that region's
# instance (region-pinned service-MCP policy, see AGENTS.md).
RUN npm install -g @eargollo/vikunja-mcp@1.2.3
# Chromium for the web_fetch tool + the Debian libraries it needs. ~500 MB
# larger image; the host has the space (measured on vm104).
RUN npx playwright install --with-deps chromium

COPY server.js ./
COPY graphdb.js ./
COPY mcp ./mcp
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8094

CMD ["node", "server.js"]
