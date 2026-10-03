FROM node:20-alpine

WORKDIR /app
COPY server.js ./
COPY mcp ./mcp
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8094

CMD ["node", "server.js"]
