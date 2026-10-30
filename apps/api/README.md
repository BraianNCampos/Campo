# @campo/api

API NestJS de Campo 2.0: auth JWT con roles (revocables), plantas y catálogo de activos administrables, auditoría, histórico (TimescaleDB), motor de alarmas y WebSocket nativo (`ws`) en tiempo real. Contratos en [`docs/architecture.md`](../../docs/architecture.md) y tipos en `packages/shared` (alias `@campo/shared`).

La ruta caliente (Redis pub/sub → WebSocket) no toca Postgres; Postgres sólo guarda configuración, histórico y el ciclo de vida de las alarmas.

## Puesta en marcha

```bash
docker compose up -d                       # desde la raíz: TimescaleDB + Redis (+ Mosquitto)
cd apps/api && cp .env.example .env        # ajustar JWT_SECRET y credenciales
npm ci
npm run start:dev                          # http://localhost:3001
```

Los scripts SQL (`infra/timescaledb/init/010_telemetry.sql`, `020_app.sql`, `030_user_plants.sql`, `040_admin.sql` y `050_models.sql`) se aplican en ese orden al crear el volumen de TimescaleDB por primera vez; `020_app.sql` es idempotente y también incluye el seed de la planta `demo`. El esquema no se sincroniza desde código (no hay `synchronize`).

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

### Bases de datos ya existentes: aplicar `040_admin.sql` a mano (administración, §9.1)

Igual que con 030: **sólo corre al crear el volumen**, así que en una base existente hay que aplicarlo **antes** de arrancar la versión nueva de la API (sin él fallan el login y todas las rutas autenticadas, por la columna `users.token_version`, y `/api/plants`/`/api/audit`, por las tablas `plants`/`audit_log`). Requiere 020 y 030 ya aplicados. Es idempotente (se puede repetir):

```bash
docker compose exec -T timescaledb psql -U campo -d campo -v ON_ERROR_STOP=1 \
  < infra/timescaledb/init/040_admin.sql

# o contra cualquier PostgreSQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/timescaledb/init/040_admin.sql
```

Qué hace: crea `plants(id, name, created_at)` y la **siembra** con las plantas que ya aparecen en `assets` y `user_plants` (nombre = id; los nombres editados después no se pisan al repetirlo); añade `users.token_version INTEGER NOT NULL DEFAULT 0`; crea `audit_log` (+ índices). **No echa a nadie al migrar**: los tokens emitidos antes del despliegue no llevan `tv` y se tratan como versión 0, que es el valor que tienen todos los usuarios tras la migración. Orden recomendado: aplicar 040 → desplegar la API nueva (con la API vieja corriendo aún funciona: la columna y las tablas nuevas no le afectan).

### Bases de datos ya existentes: aplicar `050_models.sql` a mano (modelos 3D, §10.2)

Igual que 030/040: **sólo corre al crear el volumen**; en una base existente hay que aplicarlo **antes** de arrancar la versión nueva (sin él fallan `POST/GET/DELETE .../models`, `GET /api/models/:id`, la validación de `model3dRef` y el borrado de plantas, por la tabla `asset_models`). Requiere 020 (`users`) ya aplicado. Es idempotente:

```bash
docker compose exec -T timescaledb psql -U campo -d campo -v ON_ERROR_STOP=1 \
  < infra/timescaledb/init/050_models.sql

# o contra cualquier PostgreSQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/timescaledb/init/050_models.sql
```

Qué hace: crea `asset_models(id uuid PK default gen_random_uuid(), plant, name, size, sha256, data bytea, created_by → users ON DELETE SET NULL, created_at)` con `UNIQUE(plant, sha256)` (deduplicación), índice `(plant, created_at DESC)` y CHECKs (id de planta, nombre 1–100, `size` entre 1 y 10 MiB, `sha256` hexadecimal de 64, `octet_length(data) = size`). `gen_random_uuid()` es nativo desde PostgreSQL 13 (la imagen `timescale/timescaledb:*-pg16` y el PG16 del sistema lo traen; 020 ya dependía de él), no hace falta `pgcrypto`. No toca ninguna otra tabla: los `assets.model3d_ref` existentes (texto libre como `tank`) quedan como están (ver "Modelos 3D"). Las copias de seguridad crecen con los modelos (hasta 10 MB cada uno): `asset_models` es la única tabla grande de configuración.

## Arranque endurecido (producción)

Con `NODE_ENV=production` la API **se niega a arrancar** (mensaje claro, código de salida 1) si `JWT_SECRET` tiene < 32 caracteres o parece un valor de ejemplo (contiene `cambia`, `changeme`, `change-me`, `secret` o `example`, sin distinguir mayúsculas), o si `ADMIN_PASSWORD` es de ejemplo (mismas palabras) o tiene < 12 caracteres. Genera un secreto con `openssl rand -base64 48`. En desarrollo sólo se registra un `warn` por cada problema. Ojo: la imagen Docker fija `NODE_ENV=production`, así que los valores de `.env.example` (`cambia-...`) **no sirven** para ella: hay que cambiarlos.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run build` | `tsc` + `tsc-alias` → `dist/` (entrada: `dist/apps/api/src/main.js`) |
| `npm start` / `npm run start:dev` | ejecuta el build / ejecuta con ts-node |
| `npm run lint` · `format` · `format:check` | ESLint (type-checked) · Prettier |
| `npm test` | tests unitarios (alarmas, gateway/coalescing, guards, config, plantas/activos, modelos 3D y validador GLB, revocación, auditoría...) |
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
| `LOGIN_RATE_LIMIT` / `LOGIN_RATE_TTL_MS` | `10` / `60000` | Intentos de login por IP y ventana. **El mismo límite se aplica a `POST /api/me/password`, contado por usuario** (contadores independientes de los del login) |
| `BCRYPT_ROUNDS` | `12` | |
| `WS_COALESCE_MS` | `100` | Ventana de coalescing de telemetría |
| `WS_CATALOG_COALESCE_MS` | `250` | Ventana de coalescing, por planta, del aviso `{type:"catalog"}` (10–5000) |
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
| `POST /api/me/password` | cualquiera (rate limit por usuario) | `{currentPassword,newPassword}` → `{accessToken}` nuevo. `newPassword`: ≥ 12 caracteres, ≤ 72 bytes y distinta de la actual. Actual errónea → **400** (no 401). Revoca todos los tokens y WebSockets anteriores del usuario (también los de otros dispositivos); el `accessToken` devuelto lleva la versión nueva |
| `GET /api/plants` | cualquiera | `Plant[]` `{id,name,assets}`: admin = tabla `plants` ∪ plantas con activos ∪ plantas con estado vivo en Redis (`campo:state:*`; las que sólo existen ahí salen con nombre = id y `assets: 0`); resto = sólo las asignadas |
| `POST /api/plants` | admin | `{id,name}` → `Plant`. 409 si ya está registrada (en `plants` o por tener activos); id con `ID_PATTERN`, nombre 1–100 caracteres |
| `PATCH /api/plants/:plant` | admin | `{name}` → `Plant`. Si la planta sólo se conocía por activos o Redis, se registra con ese nombre. 404 si no existe en ningún sitio |
| `DELETE /api/plants/:plant` | admin | `{deleted:true}`. **409 si tiene activos**; borra sus asignaciones de usuario (y cierra los WebSockets de esa planta con 4403) **y sus modelos 3D**. 404 si no está registrada ni asignada |
| `GET /health` · `GET /ready` | público | liveness · readiness (Redis + DB, 503 si falla) |
| `GET /api/plants/:plant/assets` | cualquiera, **sólo sus plantas** | catálogo de activos |
| `POST /api/plants/:plant/assets` | admin, engineer (con acceso a la planta) | `{id,name,type,model3dRef?,metadata?}` → `AssetDef`. `id` con `ID_PATTERN`; `name` 1–100; `type` `tank\|pump\|valve\|sensor`; `model3dRef` `null` o `"model:<uuid>"` de un modelo **de la misma planta** (400 si no existe, es de otra planta o es texto libre); `metadata` objeto JSON ≤ 8 KB (UTF-8) cuyas claves `layout` y `connectsTo` se validan (ver "Disposición en planta"). Responde `AssetDef` y, si `connectsTo` nombra ids que aún no existen, además `warnings: string[]` (informativo; no es un error). 409 si el activo ya existe; 404 si la planta no existe |
| `PATCH /api/plants/:plant/assets/:asset` | ídem | `{name?,type?,model3dRef?,metadata?}` (al menos uno; el `id` no se cambia: enviarlo es 400; `model3dRef: null` quita el modelo; `metadata` reemplaza el objeto entero) → `AssetDef` (+ `warnings` si se envió `metadata`). Las mismas validaciones; un valor antiguo de `model3dRef` que no se modifica no se revalida. 404 si no existe |
| `DELETE /api/plants/:plant/assets/:asset` | ídem | `{deleted:true, affectedRules:n}`. `n` = reglas de alarma **de esa planta** cuyo `asset` nombra el activo (id exacto o patrón con `*`, incluido `*`); las reglas **no se borran ni modifican** |
| `POST /api/plants/:plant/models?name=<nombre>` | admin, engineer (con acceso a la planta) | Sube un GLB **crudo** (cuerpo = el archivo, `Content-Type: model/gltf-binary`; también se acepta `application/octet-stream`; **sin multipart**) → `ModelInfo` `{id,plant,name,size,sha256,createdAt}`. **201** si es nuevo, **200** si la planta ya tenía ese contenido (dedup por `sha256`: devuelve el existente, con su nombre original). `name` obligatorio, 1–100 caracteres sin caracteres de control. 400 con `GLB no válido: <motivo>` (ver "Modelos 3D"), 413 si supera 10 MB, 415 si el `Content-Type` es otro |
| `GET /api/plants/:plant/models` | cualquiera, **sólo sus plantas** | `ModelInfo[]`, más recientes primero (nunca incluye el contenido) |
| `GET /api/models/:id` | cualquiera autenticado, **sólo la planta del modelo** | El GLB (`model/gltf-binary`). `ETag: "<sha256>"`, `Cache-Control: private, max-age=31536000, immutable`; con `If-None-Match` coincidente (lista, `W/` o `*`) → **304** sin leer el contenido de la base. 403 genérico si el modelo es de una planta ajena, 404 si no existe, 400 si el id no es UUID |
| `DELETE /api/plants/:plant/models/:id` | admin, engineer (con acceso a la planta) | `{deleted:true}`. **409** `{statusCode:409,error,message,assets:[ids]}` si algún activo de la planta lo referencia (no se borra nada); 404 si no existe en esa planta |
| `GET /api/plants/:plant/state` | cualquiera, **sólo sus plantas** | snapshot (`campo:state:{plant}`) |
| `GET /api/plants/:plant/assets/:asset/history?metric&from&to&bucket` | cualquiera, **sólo sus plantas** | `from`/`to`: ISO-8601 o epoch ms (def.: última hora). `bucket`: `1s 10s 30s 1m 5m 15m 1h 6h 1d` (def.: automático, ≤ ~1000 puntos). Bucket < 1 min lee `telemetry`; ≥ 1 min lee `telemetry_1m`. Responde `{plant,asset,metric,source,bucket,from,to,points:[{t,avg,min,max,samples}]}` |
| `GET/POST /api/alarm-rules`, `GET/PATCH/DELETE /api/alarm-rules/:id` | admin, engineer | CRUD de reglas **sólo de sus plantas** (`?plant=` filtra el listado; sin él, sólo las suyas) |
| `GET /api/alarms?state=active\|cleared&plant=&limit=` | cualquiera | alarmas (`AlarmEvent` + `clearedAt`, `acknowledged`, `acknowledgedBy`, `acknowledgedAt`) **sólo de sus plantas**; `?plant=` ajena → 403 |
| `POST /api/alarms/:id/ack` | admin, engineer, operator | reconoce (idempotente); la alarma debe ser de una de sus plantas |
| `GET /api/users` | admin | usuarios `{id,email,role,active,plants}` (`plants` = asignaciones guardadas). Nunca el hash |
| `POST /api/users` | admin | `{email,password,role,plants?}`; contraseña 12–72 bytes. 409 si el email existe |
| `PATCH /api/users/:id` | admin | `{role?,active?,password?}` (al menos uno). 409 si deja al sistema sin admin activo. **Cambiar `password` o poner `active:false` revoca los tokens y WebSockets del usuario** (reactivar no los resucita: hay que volver a entrar) |
| `POST /api/users/:id/revoke` | admin | cierra todas las sesiones del usuario (JWT y WebSockets) sin tocar su cuenta → `ManagedUser`. 404 si no existe |
| `PUT /api/users/:id/plants` | admin | `{plants:["demo",...]}` reemplaza las asignaciones (ids `^[a-z0-9][a-z0-9_-]{0,63}$`, sin repetidos) |
| `GET /api/audit?limit&before&actor&action` | admin | `AuditEntry[]` `{id,ts,actorId,actorEmail,action,target,detail}`, más recientes primero. `limit` 1–200 (def. 50); `before` = `id` de la última entrada de la página anterior; `actor` = id (UUID) o email; `action` exacta (p. ej. `asset.delete`). Sólo lectura |

`admin` supera siempre la comprobación de rol.

**Regla de alarma**: `{plant, asset, metric, operator: gt|lt|gte|lte, threshold, severity: warning|critical, forSeconds=0, hysteresis=0, enabled=true}`. `asset` es un id exacto o un patrón con `*` (`tk-*`, `*`). La condición debe sostenerse `forSeconds` (debounce) para activar; una alarma `gt/gte` se normaliza cuando el valor baja a `threshold - hysteresis` (`lt/lte`: sube a `threshold + hysteresis`). Los datos con `quality: "bad"` se ignoran.

### Autorización por planta

Contrato en [`docs/architecture.md` §8.1](../../docs/architecture.md). Resumen de la implementación:

- El JWT sólo identifica (`sub`; además lleva `tv`, ver Revocación). En **cada** petición `JwtAuthGuard` carga el usuario desde `AccessService` (rol, `active`, plantas) con una caché en memoria de `AUTH_CACHE_TTL_MS` (30 s). Usuario inexistente, inactivo o con `tv` distinto del vigente → **401**; el rol efectivo es el de la base, aunque el token diga otra cosa.
- **Invalidación**: cualquier cambio hecho por la API (`PATCH`/`PUT /api/users/...`) invalida al instante la caché de ese proceso y publica el id en el canal Redis `campo:auth:invalidate` (abstracción `AuthInvalidationBus`; implementación `RedisInvalidationBus`) para que las demás réplicas invaliden la suya. Si el aviso se pierde, o el cambio se hace por SQL directo, el TTL acota el retraso a ≤ 30 s.
- `PlantAccessGuard` protege toda ruta con `:plant`: id inválido → 400; sin acceso → **403** genérico (`No tiene acceso a esta planta`, idéntico exista o no la planta); un admin sobre una planta que no existe (ni activos en el catálogo ni estado en Redis) → 404.
- Alarmas y reglas se filtran/validan en el servicio (no hay `:plant` en la ruta): listados restringidos a sus plantas, `ack` según la planta de la alarma, y una regla sólo se crea/edita/borra/mueve dentro de sus plantas. Alarma o regla inexistente → 404.
- Las denegaciones 401/403 se registran (log JSON, nivel `warn`, `msg: "acceso denegado"`) con `userId`, `method`, `path` (sin query) y `plant`; nunca tokens ni contraseñas.

#### Matriz rol × acción

| Acción | admin | engineer | operator | viewer |
|---|---|---|---|---|
| Estado / activos (GET) / histórico / WebSocket de una planta | todas | sólo asignadas | sólo asignadas | sólo asignadas |
| `GET /api/plants` | todas (+ las conocidas sólo por Redis) | sólo asignadas | sólo asignadas | sólo asignadas |
| Crear, renombrar, borrar plantas | sí | no | no | no |
| Crear, editar, borrar activos (`/api/plants/:plant/assets`) | todas | sólo asignadas | no | no |
| Subir y borrar modelos 3D (`POST/DELETE /api/plants/:plant/models`) | todas | sólo asignadas | no | no |
| Listar modelos (`GET /api/plants/:plant/models`) y descargar uno (`GET /api/models/:id`, según la planta del modelo) | todas | sólo asignadas | sólo asignadas | sólo asignadas |
| Listar alarmas | todas | sólo asignadas | sólo asignadas | sólo asignadas |
| Reconocer (ack) alarmas | todas | sólo asignadas | sólo asignadas | no |
| Reglas de alarma (CRUD) | todas | sólo asignadas | no | no |
| Usuarios (`/api/users`, `PUT .../plants`, `POST .../revoke`) | sí | no | no | no |
| Auditoría (`GET /api/audit`) | sí | no | no | no |
| `GET /api/me`, `POST /api/me/password` | sí | sí | sí | sí |

Un engineer sin acceso a la planta recibe **403** (exista o no); operator/viewer reciben 403 al intentar escribir activos o plantas. Un admin sobre una planta inexistente recibe 404.

Sin asignaciones = sin acceso (los listados devuelven `[]`; el resto, 403).

### Revocación de tokens (`token_version`)

Contrato en [`docs/architecture.md` §9.1](../../docs/architecture.md). `users.token_version` (entero, 0 por defecto) y el claim `tv` del JWT: en cada petición `JwtAuthGuard` pasa el `tv` del token a `AccessService`, que lo compara con la versión vigente (misma caché de ≤ 30 s, invalidada al instante al cambiar) y responde **401** si no coinciden.

- Se incrementa al **cambiar la contraseña** (propia con `POST /api/me/password`, o por un admin con `PATCH /api/users/:id`), al **desactivar** al usuario (`active:false`) y con **`POST /api/users/:id/revoke`**. Cambiar el rol o las plantas no revoca (ya surten efecto por la base).
- **Compatibilidad**: un token sin `tv` (emitido antes del despliegue) se trata como versión 0, así que sigue valiendo hasta la primera revocación del usuario; un `tv` que no sea un entero ≥ 0 invalida el token. El login siempre emite `tv`.
- **WebSockets**: cada socket recuerda el `tv` con el que conectó. Al revocar, el mismo mecanismo de revalidación de siempre (aviso inmediato en este proceso y vía Redis `campo:auth:invalidate` a las demás réplicas; revalidación periódica `WS_REVALIDATE_MS` como cota) lo cierra con **4401**; un token revocado tampoco puede abrir sockets nuevos.
- Varias réplicas: si el aviso por Redis se pierde, la revocación converge por TTL de la caché (≤ 30 s), igual que el resto de cambios de usuario.

### Auditoría (`audit_log`)

Servicio `AuditService` (módulo global `audit/`), tabla `audit_log(id bigserial, ts, actor_id, actor_email, action, target, detail jsonb)`. Sólo se inserta y se lee por API (`GET /api/audit`); no hay edición ni borrado.

| `action` | `target` | `detail` (únicos campos permitidos) |
|---|---|---|
| `user.create` | `user:<id>` | `email, role, plants` |
| `user.update` | `user:<id>` | `changed` (nombres de campo), `role, active` — **nunca el valor de `password`** |
| `user.plants` | `user:<id>` | `plants` |
| `user.revoke`, `me.password` | `user:<id>` | — |
| `plant.create` / `plant.update` | `plant:<id>` | `name` |
| `plant.delete` | `plant:<id>` | `name, unassignedUsers` |
| `asset.create` | `asset:<plant>/<id>` | `name, type, model3dRef` |
| `asset.update` | `asset:<plant>/<id>` | `changed`, `name, type, model3dRef` — el contenido de `metadata` no se audita |
| `asset.delete` | `asset:<plant>/<id>` | `affectedRules` |
| `rule.create` | `rule:<id>` | `plant, asset, metric, operator, threshold, severity, forSeconds, hysteresis, enabled` |
| `rule.update` | `rule:<id>` | `changed, plant` |
| `rule.delete` | `rule:<id>` | `plant, asset, metric` |
| `model.upload` | `model:<plant>/<id>` | `name, size, sha256, dedup` (`dedup: true` = ya existía, se devolvió el existente) — **nunca el contenido** |
| `model.delete` | `model:<plant>/<id>` | `name, id` |
| `alarm.ack` | `alarm:<id>` | `plant, asset, metric, severity` (sólo el primer ack; el idempotente no registra) |

- **Qué nunca se guarda**: contraseñas, hashes, tokens. La lista de campos por acción está en `src/audit/audit.fields.ts` y `AuditService.record` descarta todo lo que no esté en ella (además de objetos anidados, y cualquier valor con forma de hash bcrypt o JWT); los tests lo demuestran para todas las acciones.
- **Decisión de fallo**: la auditoría es *best effort*. Se escribe **después** de que la operación principal se confirmó; si la escritura falla, la operación **no** se deshace ni se rechaza: `record()` no lanza y deja un `error` en el log (`"no se pudo escribir la auditoría"`, con acción, destino y actor, sin el detalle). Un hueco visible en el log es preferible a rechazar o revertir un cambio legítimo (p. ej. un ack de alarma) por un fallo de la tabla de auditoría. Consecuencia: no es un registro transaccional (puede faltar una entrada si la base falla justo entonces); vigilar ese `error` en el log.
- No se audita: logins (fallidos o no), lecturas ni el tráfico de telemetría.

### Plantas y catálogo

- `plants` es el registro con nombre; una planta también "existe" si tiene activos o estado vivo en Redis (`campo:state:{plant}`). `PlantCatalog.exists` (usado por `PlantAccessGuard` para dar 404 al admin) considera las tres fuentes, de modo que una planta recién creada y vacía ya es accesible al admin.
- `GET /api/plants/:plant/assets` devuelve `AssetDef` (camelCase `model3dRef`, `metadata` objeto): ya devolvía exactamente esa forma, sin cambios. Las altas/ediciones/bajas de activos publican en Redis **`campo:catalog:changed`** el payload `{"plant":"<id>"}` (best effort: si Redis falla se registra un `warn` y la operación sigue).
- Crear, renombrar y borrar plantas, y subir/borrar modelos 3D, también publican `campo:catalog:changed` (además de las altas/ediciones/bajas de activos). Un modelo subido que ya existía (dedup) no cambia nada y no publica.
- Borrar una planta no toca sus reglas de alarma ni su estado en Redis (si el ingest sigue escribiendo, la planta seguirá apareciendo para el admin como "sólo Redis").

### Modelos 3D (GLB, §10.2)

- **Subida**: `curl -X POST "$API/api/plants/demo/models?name=Bomba" -H "Authorization: Bearer $T" -H "Content-Type: model/gltf-binary" --data-binary @bomba.glb`. El cuerpo se lee con el *body parser* `raw` de Express **sólo en esa ruta**, con límite de **10 MB** (el resto de la API conserva su límite global de 100 KB para JSON); se ejecuta como interceptor, es decir **después** de JWT, rol y acceso a la planta, de modo que quien no tiene permiso recibe 403 sin que el servidor almacene su cuerpo. Más de 10 MB (con o sin `Content-Length`, también 200 MB) → **413** `El modelo supera el límite de 10 MB`, sin tumbar la API.
- **Almacenamiento**: `asset_models.data` (bytea), con `sha256` calculado por la API; el listado y el 304 no leen `data`. Deduplicación por `UNIQUE(plant, sha256)` (el mismo contenido en otra planta es otro modelo). No hay cuota por planta.
- **Validador** (`src/models/glb-validator.ts`, módulo puro; falla con `400 GLB no válido: <motivo en español>`): contenedor `glTF` v2 con la longitud de la cabecera igual al tamaño real, bloques que caben, primer bloque JSON y BIN justo después; JSON ≤ **1 MiB** (las texturas van en el BIN; `JSON.parse` es síncrono y se acota su coste), anidación ≤ 64 niveles (comprobada **antes** de parsear), UTF-8 válido; `asset.version == "2.0"`; **sin `uri` externas** (sólo `data:`); extensiones **requeridas** sólo `KHR_materials_unlit`, `KHR_materials_emissive_strength`, `KHR_materials_pbrSpecularGlossiness`, `KHR_texture_transform`, `KHR_mesh_quantization`; **Draco y meshopt se rechazan** con mensaje explícito (también si sólo figuran en `extensionsUsed` o dentro de una primitiva/bufferView); ≤ **2000 nodos**; ≤ **200 000 vértices** (suma de los `count` de los accesores `POSITION` distintos de las mallas que algún nodo referencia); índices de accesores, bufferViews, buffers, mallas, materiales, texturas, imágenes, nodos, escenas, skins y animaciones dentro de rango; cada accesor cabe en su bufferView (con `byteStride`) y cada bufferView en su buffer; `buffers[0].byteLength` coherente con el BIN (sobran ≤ 3 bytes de relleno); jerarquía de nodos **sin ciclos y sin nodos con varios padres** (un rombo haría exponencial el recorrido del cliente); al menos una malla referenciada. Devuelve el primer problema.
- **Descarga y caché**: el id es inmutable (contenido direccionado por `sha256`), por eso `Cache-Control: private, max-age=31536000, immutable`. Un navegador compartido conserva en su caché los bytes ya descargados aunque cierre sesión (contrapartida aceptada por el contrato; son geometrías, no datos personales). Con CORS, `GLTFLoader` necesita enviar `Authorization` (`loader.setRequestHeader`).
- **Referencias** (`model3dRef`): `null` o `model:<uuid>` de un modelo de la **misma** planta, validado **sólo al escribir** (crear/editar activo). Los activos antiguos con texto libre (`tank`, `pump`...) se siguen listando; un `PATCH` que no toca `model3dRef` —o que reenvía exactamente el mismo valor antiguo— no falla; cambiarlo a otro texto libre sí. La comprobación "no está en uso" del borrado y la de "existe" al referenciar no son atómicas entre sí (ventana de milisegundos): un modelo borrado justo mientras se crea un activo que lo referencia dejaría una referencia colgante (la web cae al modelo procedural).

### Disposición en planta (`metadata.layout` / `metadata.connectsTo`, §10.3)

Se validan al crear/editar un activo (el resto de claves de `metadata` es libre; sigue el límite de 8 KB): `layout: {x, z, y?, rotY?, scale?}` — `x`, `z`, `y` números finitos con |valor| ≤ 1000 (m), `rotY` finito con |valor| ≤ 3600 (grados), `scale` entre 0.05 y 50, ninguna otra clave; `connectsTo: string[]` — ≤ 32 ids con `ID_PATTERN`, sin duplicados ni el propio activo. No se exige que los ids existan (los activos se pueden crear en cualquier orden): los que no existan en la planta en ese momento se informan en `warnings` de la respuesta (no se guardan).

### WebSocket

`ws://host:3001/ws?plant={plant}&token={jwt}` (también acepta `Authorization: Bearer`). Códigos de cierre: `4400` planta inválida, `4401` token inválido, revocado (`tv`) o usuario inactivo/inexistente, `4403` sin acceso a la planta. Tras validar el token se consulta el usuario (misma caché) y se comprueba la planta antes de enviar nada. Los sockets abiertos se **revalidan**: al cambiar un usuario en este proceso se re-evalúan al instante, y cada `WS_REVALIDATE_MS` (por defecto = TTL de la caché) contra la base saltando la caché; si el usuario ya no está activo o su token fue revocado (4401) o perdió la planta (4403) el servidor cierra el socket, así que la revocación llega a los sockets abiertos en ≤ 30 s aunque el token siga vigente. El gateway sólo reenvía eventos de la planta suscrita. El primer mensaje es `snapshot`; luego `telemetry` (coalescido por activo en ventanas de ~100 ms, mezclando por métrica el último valor), `alarm` (inmediato; incluye cambios de ack) y `{type:"catalog", plant}` (el catálogo de la planta cambió —activos, modelos 3D, la propia planta—: el cliente vuelve a pedirlo por HTTP). Los avisos de catálogo llegan por `RealtimeBus` (la misma conexión Redis de suscripción de siempre, ahora también `SUBSCRIBE campo:catalog:changed`, sin conexiones nuevas por cliente) y se agrupan por planta en ventanas de `WS_CATALOG_COALESCE_MS` (250 ms): una ráfaga de altas produce un único mensaje por cliente. El cliente no envía mensajes (se ignoran; uno de más de 1 KiB cierra el socket).
