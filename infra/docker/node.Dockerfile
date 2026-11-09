# Builds apps/api or apps/worker. Usage: --build-arg APP=api|worker
FROM node:22-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps ./apps
ARG APP
RUN npm run build -w @zuum/db && npm run build -w @zuum/$APP && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG APP
ENV NODE_ENV=production APP=${APP}
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/${APP}/dist ./apps/${APP}/dist
COPY --from=build /repo/apps/${APP}/package.json ./apps/${APP}/package.json
USER node
WORKDIR /repo/apps/${APP}
CMD ["node", "dist/index.js"]
