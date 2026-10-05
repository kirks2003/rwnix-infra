FROM node:20-slim

WORKDIR /app

# The knowledge-graph MCP server (mcp/graph.mjs, Node) runs from the copied
# source — no extra runtime beyond neo4j-driver (package.json) is needed.
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY graphdb.js ./
COPY mcp ./mcp
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8094

CMD ["node", "server.js"]
