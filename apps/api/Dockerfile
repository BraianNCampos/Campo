# syntax=docker/dockerfile:1
#
# Construir DESDE LA RAÍZ del monorepo (necesita packages/shared):
#   docker build -f apps/api/Dockerfile -t campo-api .
# Variables de entorno: ver apps/api/README.md (JWT_SECRET, DATABASE_URL y REDIS_URL son obligatorias).

# --- 1. Dependencias (capa cacheable) ---------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /repo/apps/api
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci

# --- 2. Build: tsc + resolución del alias @campo/shared, y poda a dependencias de producción ---
FROM deps AS build
WORKDIR /repo
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
WORKDIR /repo/apps/api
RUN npm run build && npm prune --omit=dev

# --- 3. Runtime mínimo, sin root ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "dist/apps/api/src/main.js"]
