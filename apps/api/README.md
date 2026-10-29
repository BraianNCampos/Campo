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

Los scripts SQL (`infra/timescaledb/init/010_telemetry.sql`, `020_app.sql` y `030_user_plants.sql`) se aplican al crear el volumen de TimescaleDB por primera vez; `020_app.sql` es idempotente y también incluye el seed de la planta `demo`. El esquema no se sincroniza desde código (no hay `synchronize`).

### Bases de datos ya existentes: aplicar `030_user_plants.sql` a mano

Los scripts de `init/` **sólo corren al crear el volumen**. Si tu volumen ya existe, la tabla `user_plants` no existirá y la API fallará al autenticar (`relation "user_plants" does not exist`). Aplícala (es idempotente, se puede repetir) **antes** de arrancar la versión nueva de la API:

```bash
# con el compose del repo (usuario/BD por defecto: campo/campo)
docker compose exec -T timescaledb psql -U campo -d campo -v ON_ERROR_STOP=1 \
  < infra/timescaledb/init/030_user_plants.sql

# o contra cualquier PostgreSQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/timescaledb/init/030_user_plants.sql
```

Tras aplicarla, los usuarios existentes que no sean `admin` **no tienen ninguna planta** (sin asignaciones = sin acceso): asígnalas con `PUT /api/users/:id/plants` (ver más abajo). Los `admin` ven todas las plantas sin asignaciones.

## Arranque endurecido (producción)

Con `NODE_ENV=production` la API **se niega a arrancar** (mensaje claro, código de salida 1) si `JWT_SECRET` tiene < 32 caracteres o parece un valor de ejemplo (contiene `cambia`, `changeme`, `change-me`, `secret` o `example`, sin distinguir mayúsculas), o si `ADMIN_PASSWORD` es de ejemplo (mismas palabras) o tiene < 12 caracteres. Genera un secreto con `openssl rand -base64 48`. En desarrollo sólo se registra un `warn` por cada problema. Ojo: la imagen Docker fija `NODE_ENV=production`, así que los valores de `.env.example` (`cambia-...`) **no sirven** para ella: hay que cambiarlos.

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
| `JWT_EXPIRES_IN` | `1h` | Duración del token de acceso. El acceso real lo decide la base en cada petición (ver Autorización) |
| `AUTH_CACHE_TTL_MS` | `30000` | TTL de la caché en memoria de usuario/rol/plantas (0–30000; `0` = sin caché, útil en tests) |
| `WS_REVALIDATE_MS` | = `AUTH_CACHE_TTL_MS` (10000 si es 0) | Cada cuánto se revalidan, contra la base y saltando la caché, los WebSocket abiertos |
| `DATABASE_URL` | `postgres://campo:campo_dev@localhost:5432/campo` | Obligatoria en producción |
| `REDIS_URL` | `redis://localhost:6379` | Obligatoria en producción |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Admin semilla; se crea al arrancar si no existe (juntas, contraseña ≥ 8; ≥ 12 en producción) |
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

Prefijo `/api`, salvo sondas. Todo requiere `Authorization: Bearer <jwt>` excepto login y sondas. "Sus plantas" = las de `user_plants`; `admin` accede a todas.

| Ruta | Roles | Descripción |
|---|---|---|
| `POST /api/auth/login` | público (rate limit) | `{email,password}` → `{accessToken, user:{id,email,role,plants}}` (`plants:["*"]` para admin) |
| `GET /api/me` | cualquiera | `{id,email,role,plants}` vigentes (de la base, no del token) |
| `GET /health` · `GET /ready` | público | liveness · readiness (Redis + DB, 503 si falla) |
| `GET /api/plants/:plant/assets` | cualquiera, **sólo sus plantas** | catálogo de activos |
| `GET /api/plants/:plant/state` | cualquiera, **sólo sus plantas** | snapshot (`campo:state:{plant}`) |
| `GET /api/plants/:plant/assets/:asset/history?metric&from&to&bucket` | cualquiera, **sólo sus plantas** | `from`/`to`: ISO-8601 o epoch ms (def.: última hora). `bucket`: `1s 10s 30s 1m 5m 15m 1h 6h 1d` (def.: automático, ≤ ~1000 puntos). Bucket < 1 min lee `telemetry`; ≥ 1 min lee `telemetry_1m`. Responde `{plant,asset,metric,source,bucket,from,to,points:[{t,avg,min,max,samples}]}` |
| `GET/POST /api/alarm-rules`, `GET/PATCH/DELETE /api/alarm-rules/:id` | admin, engineer | CRUD de reglas **sólo de sus plantas** (`?plant=` filtra el listado; sin él, sólo las suyas) |
| `GET /api/alarms?state=active\|cleared&plant=&limit=` | cualquiera | alarmas (`AlarmEvent` + `clearedAt`, `acknowledged`, `acknowledgedBy`, `acknowledgedAt`) **sólo de sus plantas**; `?plant=` ajena → 403 |
| `POST /api/alarms/:id/ack` | admin, engineer, operator | reconoce (idempotente); la alarma debe ser de una de sus plantas |
| `GET /api/users` | admin | usuarios `{id,email,role,active,plants}` (`plants` = asignaciones guardadas). Nunca el hash |
| `POST /api/users` | admin | `{email,password,role,plants?}`; contraseña 12–72 bytes. 409 si el email existe |
| `PATCH /api/users/:id` | admin | `{role?,active?,password?}` (al menos uno). 409 si deja al sistema sin admin activo |
| `PUT /api/users/:id/plants` | admin | `{plants:["demo",...]}` reemplaza las asignaciones (ids `^[a-z0-9][a-z0-9_-]{0,63}$`, sin repetidos) |

`admin` supera siempre la comprobación de rol.

**Regla de alarma**: `{plant, asset, metric, operator: gt|lt|gte|lte, threshold, severity: warning|critical, forSeconds=0, hysteresis=0, enabled=true}`. `asset` es un id exacto o un patrón con `*` (`tk-*`, `*`). La condición debe sostenerse `forSeconds` (debounce) para activar; una alarma `gt/gte` se normaliza cuando el valor baja a `threshold - hysteresis` (`lt/lte`: sube a `threshold + hysteresis`). Los datos con `quality: "bad"` se ignoran.

### Autorización por planta

Contrato en [`docs/architecture.md` §8.1](../../docs/architecture.md). Resumen de la implementación:

- El JWT sólo identifica (`sub`). En **cada** petición `JwtAuthGuard` carga el usuario desde `AccessService` (rol, `active`, plantas) con una caché en memoria de `AUTH_CACHE_TTL_MS` (30 s). Usuario inexistente o inactivo → **401**; el rol efectivo es el de la base, aunque el token diga otra cosa.
- **Invalidación**: cualquier cambio hecho por la API (`PATCH`/`PUT /api/users/...`) invalida al instante la caché de ese proceso y publica el id en el canal Redis `campo:auth:invalidate` (abstracción `AuthInvalidationBus`; implementación `RedisInvalidationBus`) para que las demás réplicas invaliden la suya. Si el aviso se pierde, o el cambio se hace por SQL directo, el TTL acota el retraso a ≤ 30 s.
- `PlantAccessGuard` protege toda ruta con `:plant`: id inválido → 400; sin acceso → **403** genérico (`No tiene acceso a esta planta`, idéntico exista o no la planta); un admin sobre una planta que no existe (ni activos en el catálogo ni estado en Redis) → 404.
- Alarmas y reglas se filtran/validan en el servicio (no hay `:plant` en la ruta): listados restringidos a sus plantas, `ack` según la planta de la alarma, y una regla sólo se crea/edita/borra/mueve dentro de sus plantas. Alarma o regla inexistente → 404.
- Las denegaciones 401/403 se registran (log JSON, nivel `warn`, `msg: "acceso denegado"`) con `userId`, `method`, `path` (sin query) y `plant`; nunca tokens ni contraseñas.

#### Matriz rol × acción

| Acción | admin | engineer | operator | viewer |
|---|---|---|---|---|
| Estado / activos / histórico / WebSocket de una planta | todas | sólo asignadas | sólo asignadas | sólo asignadas |
| Listar alarmas | todas | sólo asignadas | sólo asignadas | sólo asignadas |
| Reconocer (ack) alarmas | todas | sólo asignadas | sólo asignadas | no |
| Reglas de alarma (CRUD) | todas | sólo asignadas | no | no |
| Usuarios (`/api/users`) | sí | no | no | no |
| `GET /api/me` | sí | sí | sí | sí |

Sin asignaciones = sin acceso (los listados devuelven `[]`; el resto, 403).

### WebSocket

`ws://host:3001/ws?plant={plant}&token={jwt}` (también acepta `Authorization: Bearer`). Códigos de cierre: `4400` planta inválida, `4401` token inválido o usuario inactivo/inexistente, `4403` sin acceso a la planta. Tras validar el token se consulta el usuario (misma caché) y se comprueba la planta antes de enviar nada. Los sockets abiertos se **revalidan**: al cambiar un usuario en este proceso se re-evalúan al instante, y cada `WS_REVALIDATE_MS` (por defecto = TTL de la caché) contra la base saltando la caché; si el usuario ya no está activo (4401) o perdió la planta (4403) el servidor cierra el socket, así que la revocación llega a los sockets abiertos en ≤ 30 s aunque el token siga vigente. El gateway sólo reenvía eventos de la planta suscrita. El primer mensaje es `snapshot`; luego `telemetry` (coalescido por activo en ventanas de ~100 ms, mezclando por métrica el último valor) y `alarm` (inmediato; incluye cambios de ack). El cliente no envía mensajes (se ignoran; uno de más de 1 KiB cierra el socket).
