FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web ./apps/web
ARG VERSION=0.0.0-dev
RUN VITE_APP_VERSION=${VERSION} npm run build -w @zuum/web

FROM nginx:1.27-alpine
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="zuum-web" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/mistersupri/Zuum"
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
