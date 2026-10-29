# @campo/api

API NestJS de Campo 2.0: auth JWT con roles, catálogo de activos, histórico (TimescaleDB), motor de alarmas y WebSocket nativo (`ws`) en tiempo real. Contratos en [`docs/architecture.md`](../../docs/architecture.md) y tipos en `packages/shared` (alias `@campo/shared`).

La ruta caliente (Redis pub/sub → WebSocket) no toca Postgres; Postgres sólo guarda configuración, histórico y el ciclo de vida de las alarmas.

## Puesta en marcha

```bash
docker compose up -d                       # desde la raíz: TimescaleDB + Redis (+ Mosquitto)
cd apps/api && cp .env.example .env        # ajustar JWT_SECRET y credenciales
npm ci
npm run start:dev                          # http://localhost:3001
```

Los scripts SQL (`infra/timescaledb/init/010_telemetry.sql` y `020_app.sql`) se aplican al crear el volumen de TimescaleDB por primera vez; `020_app.sql` es idempotente y también incluye el seed de la planta `demo`. El esquema no se sincroniza desde código (no hay `synchronize`).

## Scripts

| Script | Qué hace |
|---|---|
| `npm run build` | `tsc` + `tsc-alias` → `dist/` (entrada: `dist/apps/api/src/main.js`) |
| `npm start` / `npm run start:dev` | ejecuta el build / ejecuta con ts-node |
| `npm run lint` · `format` · `format:check` | ESLint (type-checked) · Prettier |
| `npm test` | tests unitarios (alarmas, gateway/coalescing, guards, config...) |
| `npm run test:e2e` | e2e con supertest + ws, repositorios en memoria y `ioredis-mock` (sin servicios reales) |

Docker (contexto = raíz del repo): `docker build -f apps/api/Dockerfile -t campo-api .`

## Variables de entorno

Se validan al arrancar (el proceso falla con un mensaje claro si algo es inválido).

| Variable | Def. | Notas |
|---|---|---|
| `JWT_SECRET` | — | **Obligatoria**, ≥ 32 caracteres |
| `JWT_EXPIRES_IN` | `8h` | |
| `DATABASE_URL` | `postgres://campo:campo_dev@localhost:5432/campo` | Obligatoria en producción |
| `REDIS_URL` | `redis://localhost:6379` | Obligatoria en producción |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Admin semilla; se crea al arrancar si no existe (juntas, contraseña ≥ 8) |
| `PORT` / `HOST` | `3001` / `0.0.0.0` | |
| `CORS_ORIGINS` | `http://localhost:3000` | Lista separada por comas; `*` sólo fuera de producción |
| `TRUST_PROXY` | `false` | `true` si hay un proxy inverso delante (IP real para el rate limit) |
| `LOGIN_RATE_LIMIT` / `LOGIN_RATE_TTL_MS` | `10` / `60000` | Intentos de login por IP y ventana |
| `BCRYPT_ROUNDS` | `12` | |
| `WS_COALESCE_MS` | `100` | Ventana de coalescing de telemetría |
| `WS_PING_INTERVAL_MS` | `25000` | Ping/pong; sin pong en un ciclo → se cierra el socket |
| `WS_MAX_BUFFERED_BYTES` | `262144` | Backpressure: por encima se salta la telemetría de ese cliente |
| `HISTORY_MAX_POINTS` / `HISTORY_MAX_RANGE_DAYS` | `5000` / `366` | Límites de la consulta de histórico |
| `ALARM_ENGINE_ENABLED` | `true` | Poner `false` en réplicas extra (ver límites) |
| `ALARM_RULES_REFRESH_MS` | `60000` | Refresco periódico de la caché de reglas (además de al cambiar) |
| `PG_POOL_MAX`, `LOG_LEVEL`, `NODE_ENV` | `10`, `info`, `development` | |

## Endpoints

Prefijo `/api`, salvo sondas. Todo requiere `Authorization: Bearer <jwt>` excepto login y sondas.

| Ruta | Roles | Descripción |
|---|---|---|
| `POST /api/auth/login` | público (rate limit) | `{email,password}` → `{accessToken}` |
| `GET /health` · `GET /ready` | público | liveness · readiness (Redis + DB, 503 si falla) |
| `GET /api/plants/:plant/assets` | cualquiera | catálogo de activos |
| `GET /api/plants/:plant/state` | cualquiera | snapshot (`campo:state:{plant}`) |
| `GET /api/plants/:plant/assets/:asset/history?metric&from&to&bucket` | cualquiera | `from`/`to`: ISO-8601 o epoch ms (def.: última hora). `bucket`: `1s 10s 30s 1m 5m 15m 1h 6h 1d` (def.: automático, ≤ ~1000 puntos). Bucket < 1 min lee `telemetry`; ≥ 1 min lee `telemetry_1m`. Responde `{plant,asset,metric,source,bucket,from,to,points:[{t,avg,min,max,samples}]}` |
| `GET/POST /api/alarm-rules`, `GET/PATCH/DELETE /api/alarm-rules/:id` | admin, engineer | CRUD de reglas (`?plant=` filtra el listado) |
| `GET /api/alarms?state=active\|cleared&plant=&limit=` | cualquiera | alarmas (`AlarmEvent` + `clearedAt`, `acknowledged`, `acknowledgedBy`, `acknowledgedAt`) |
| `POST /api/alarms/:id/ack` | admin, engineer, operator | reconoce (idempotente) |

`admin` supera siempre la comprobación de rol.

**Regla de alarma**: `{plant, asset, metric, operator: gt|lt|gte|lte, threshold, severity: warning|critical, forSeconds=0, hysteresis=0, enabled=true}`. `asset` es un id exacto o un patrón con `*` (`tk-*`, `*`). La condición debe sostenerse `forSeconds` (debounce) para activar; una alarma `gt/gte` se normaliza cuando el valor baja a `threshold - hysteresis` (`lt/lte`: sube a `threshold + hysteresis`). Los datos con `quality: "bad"` se ignoran.

### WebSocket

`ws://host:3001/ws?plant={plant}&token={jwt}` (también acepta `Authorization: Bearer`). Códigos de cierre: `4400` planta inválida, `4401` token inválido. El primer mensaje es `snapshot`; luego `telemetry` (coalescido por activo en ventanas de ~100 ms, mezclando por métrica el último valor) y `alarm` (inmediato; incluye cambios de ack). El cliente no envía mensajes (se ignoran; uno de más de 1 KiB cierra el socket).
