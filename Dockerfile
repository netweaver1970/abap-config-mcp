# abap-config-mcp over stdio, for MCP clients and registries that run servers in a container.
#
#   docker build -t abap-config-mcp .
#   docker run -i --rm -e SAP_URL=https://host:44300 -e SAP_USER=DEVELOPER \
#     -e SAP_PASSWORD=... -e SAP_CLIENT=100 abap-config-mcp
#
# Or mount a connections.json and point ABAP_MCP_CONFIG at it:
#   docker run -i --rm -v $PWD/connections.json:/config/connections.json:ro \
#     -e ABAP_MCP_CONFIG=/config/connections.json abap-config-mcp
#
# Without any SAP system configured the server still starts and lists its tools,
# so registries can inspect it; every tool call then answers that no system is set up.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json esbuild.config.js ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/netweaver1970/abap-config-mcp" \
      org.opencontainers.image.description="SAP customizing and ABAP development MCP server (stdio)" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The engine ABAP that engine_deploy and the customizing tools install into SAP, read at
# runtime from <dist>/../src/abap.
COPY --from=build /app/src/abap/*.abap ./src/abap/
COPY package.json LICENSE NOTICE README.md ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
