# Vikunja MCP sidecar (host-local gap on nbg-1, now tracked): a parked
# stdio MCP server for the @eargollo/vikunja-mcp package. It runs on the
# vikunja network with a sleep infinity command (nothing spawns it on the
# gateway hosts; the Jarvis backends on vm104 ship the same package baked
# into their own images). Kept for parity with nbg-1.
FROM node:22-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8
RUN npm install -g @eargollo/vikunja-mcp@1.2.3 && npm cache clean --force
USER node
CMD ["sleep","infinity"]
