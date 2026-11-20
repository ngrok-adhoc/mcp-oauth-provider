FROM node:26-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY bin/ ./bin/
COPY lib/ ./lib/
RUN --mount=type=cache,target=/root/.npm npm ci && npm prune --omit=dev

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY assets/ ./assets/
RUN install -d -o node -g node -m 0700 /app/.mcp-oauth-provider

USER node
ENTRYPOINT ["node", "dist/bin/mcp-oauth-provider.js"]
