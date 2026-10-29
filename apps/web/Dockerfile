# Imagen del frontend (Next.js, output standalone).
# Contexto de build = RAÍZ del monorepo (necesita packages/shared):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_WS_URL=wss://api.example.com/ws \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t campo-web .
# Sin NEXT_PUBLIC_WS_URL la imagen arranca en MODO DEMO (stream simulado).
# Nota: NEXT_PUBLIC_* se incrustan en build, no en runtime.

FROM node:22-alpine AS deps
WORKDIR /repo/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_WS_URL=
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_PLANT=demo
ARG NEXT_PUBLIC_MOCK=
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL \
    NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_PLANT=$NEXT_PUBLIC_PLANT \
    NEXT_PUBLIC_MOCK=$NEXT_PUBLIC_MOCK
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
WORKDIR /repo/apps/web
RUN npm run build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
# standalone conserva la estructura del monorepo: server.js queda en apps/web/
COPY --from=builder --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=app:app /repo/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
