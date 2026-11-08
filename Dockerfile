# API do OnDaqui. Construir a partir da raiz do projeto:
#   docker build -f apps/api/Dockerfile -t ondaqui-api .

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/painel/package.json apps/painel/
RUN npm ci -w apps/api --include-workspace-root=false
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/painel/package.json apps/painel/
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev && npm cache clean --force && mkdir -p apps/api/node_modules

FROM node:22-alpine
ENV NODE_ENV=production PORT=3333 UPLOAD_DIR=/data/uploads
WORKDIR /repo/apps/api
COPY --from=deps /repo/node_modules /repo/node_modules
COPY --from=deps /repo/apps/api/node_modules ./node_modules
COPY apps/api/package.json ./
COPY apps/api/db ./db
COPY --from=build /repo/apps/api/dist ./dist
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3333/health > /dev/null || exit 1
CMD ["node", "dist/server.js"]
