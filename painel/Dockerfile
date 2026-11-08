# Painel do OnDaqui (site estático). Construir a partir da raiz do projeto:
#   docker build -f apps/painel/Dockerfile --build-arg VITE_API_URL=https://api.ondaqui.com.br -t ondaqui-painel .

FROM node:22-alpine AS build
ARG VITE_API_URL
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/painel/package.json apps/painel/
RUN npm ci -w apps/painel --include-workspace-root=false
COPY apps/painel apps/painel
RUN test -n "$VITE_API_URL" || (echo "Defina VITE_API_URL" && exit 1)
RUN VITE_API_URL=$VITE_API_URL npm run build -w apps/painel

FROM nginx:1.27-alpine
COPY apps/painel/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/painel/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1
