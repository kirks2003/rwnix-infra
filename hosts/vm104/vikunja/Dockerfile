FROM node:22-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8
RUN npm install -g @eargollo/vikunja-mcp@1.2.3 && npm cache clean --force
USER node
CMD ["sleep","infinity"]
