FROM node:20-slim

WORKDIR /app

# The official Neo4j MCP server (stdio) that gives the brain read-only access
# to the knowledge graph. NEO4J_MCP_READ_ONLY is forced by the backend, so the
# write-cypher tool is never exposed; the connection itself uses the MATCH-only
# database user. The PyPI package ships glibc wheels only (no sdist, no musl
# wheels), so the base image is Debian-based rather than Alpine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages neo4j-mcp-server==1.6.0

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY graphdb.js ./
COPY mcp ./mcp
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8094

CMD ["node", "server.js"]
