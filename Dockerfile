FROM node:26-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY bin/ ./bin/
COPY lib/ ./lib/
RUN --mount=type=cache,target=/root/.npm npm ci && npm prune --omit=dev

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
RUN apk upgrade --no-cache \
    && apk add --no-cache nodejs-current \
    && addgroup -g 1000 node \
    && adduser -D -u 1000 -G node node \
    && install -d -o node -g node -m 0700 /app/.mcp-oauth-provider
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ ./node_modules/
COPY --from=build /app/dist/ ./dist/
COPY assets/ ./assets/

USER node
ENTRYPOINT ["node", "dist/bin/mcp-oauth-provider.js"]
