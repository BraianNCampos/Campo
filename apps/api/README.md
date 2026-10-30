# @campo/api

API NestJS de Campo 2.0: **multi-cliente** (organizaciones con módulos contratados y aislamiento total entre clientes), auth JWT con roles (revocables), plantas y catálogo de activos administrables, auditoría, histórico (TimescaleDB), motor de alarmas y WebSocket nativo (`ws`) en tiempo real. Contratos en [`docs/architecture.md`](../../docs/architecture.md) y tipos en `packages/shared` (alias `@campo/shared`).

La ruta caliente (Redis pub/sub → WebSocket) no toca Postgres; Postgres sólo guarda configuración, histórico y el ciclo de vida de las alarmas.

## Puesta en marcha

```bash
docker compose up -d                       # desde la raíz: TimescaleDB + Redis (+ Mosquitto)
cd apps/api && cp .env.example .env        # ajustar JWT_SECRET y credenciales
npm ci
npm run start:dev                          # http://localhost:3001
```

Los scripts SQL (`infra/timescaledb/init/010_telemetry.sql`, `020_app.sql`, `030_user_plants.sql`, `040_admin.sql`, `050_models.sql` y `060_orgs.sql`) se aplican en ese orden al crear el volumen de TimescaleDB por primera vez; `020_app.sql` es idempotente y también incluye el seed de la planta `demo`. El esquema no se sincroniza desde código (no hay `synchronize`).

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

### Bases de datos ya existentes: aplicar `060_orgs.sql` a mano (clientes y módulos, §11)

Igual que 030–050: **sólo corre al crear el volumen**; en una base existente hay que aplicarlo **antes** de arrancar la versión nueva de la API (sin él fallan el login y todo lo autenticado: `users.org_id` y `organizations` no existen). Requiere 020–050 ya aplicados. Es **idempotente** (se puede repetir) y transaccional (`BEGIN … COMMIT`: si algo falla no queda nada a medias; usar `-v ON_ERROR_STOP=1`):

```bash
docker compose exec -T timescaledb psql -U campo -d campo -v ON_ERROR_STOP=1 \
  < infra/timescaledb/init/060_orgs.sql

# o contra cualquier PostgreSQL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/timescaledb/init/060_orgs.sql
```

Qué hace, en orden:

1. Crea `organizations(id, name, modules text[], active, created_at)` (CHECK: `modules` ⊆ los 7 módulos) y los clientes `campos-demo` ("Agroindustria Ejemplo", todos los módulos) y `cliente-tanques` ("Cliente Solo Tanques", módulo `tanks`).
2. **Registra en `plants`** las plantas que sólo existían por `assets`, `user_plants`, `alarm_rules`, `alarms` o `asset_models` (nombre = id), añade `plants.org_id`, asigna **todas** las plantas existentes a `campos-demo` y recién entonces la hace `NOT NULL` (FK a `organizations`, índice).
3. Añade `users.org_id` (NULL = personal de plataforma) y asigna **todos los usuarios existentes a `campos-demo`**: los `admin` siguen siendo `admin` (ahora de ese cliente). Amplía el CHECK de `users.role` con `platform_admin` y añade `users_org_role_check`: *sólo* `platform_admin` puede no tener cliente (la base impide un usuario normal sin cliente).
4. Amplía el CHECK de `assets.type` a los 10 tipos (`tank pump valve sensor climate energy gas machine pressure flow`). Los CHECK viejos se localizan por contenido, no por nombre.
5. Añade `audit_log.org_id` (sin FK: la auditoría sobrevive al borrado del cliente) y atribuye a `campos-demo` las entradas anteriores **una sola vez** (al crear la columna; repetir el script no reetiqueta las nuevas).
6. Semillas de desarrollo (§11.3, `ON CONFLICT DO NOTHING`, y sólo si la planta pertenece al cliente esperado, para no meter nada en un cliente ajeno): `capacityM3: 60` en `tk-01..04` (sin pisar un valor editado), los activos nuevos de `demo` (`clima-01/02`, `en-linea1/compresores/clima/calderas` con `contractedKw`, `gas-01`, `maq-01..03`, `pres-01`, `cau-01`), la planta `tanques` del cliente `cliente-tanques` con `tk-a`/`tk-b` (`capacityM3: 40`) y las reglas de ejemplo (ids `00000000-0000-4000-8000-0000000000{11..1c,21,22}`).

**El usuario sembrado por `ADMIN_EMAIL` pasa a `platform_admin` al arrancar la API** (no en SQL): ver "Clientes y autorización". Tras migrar, ese usuario (que era `admin` de `campos-demo`) deja el cliente; si era su único admin, el cliente se queda sin administrador (la API lo avisa en el log) y se arregla con `POST /api/orgs/campos-demo/admins`.

**Verificado** contra PostgreSQL 16 real: sobre una base de la Fase 5 con datos (usuarios admin/operator/engineer, plantas sólo por activos/asignaciones/reglas/modelos, alarma activa, auditoría) y sobre un volumen nuevo, aplicando 020–050 y 060 dos y tres veces: el estado final es idéntico entre ejecuciones (`pg_dump` de datos sin diferencias).

## Arranque endurecido (producción)

Con `NODE_ENV=production` la API **se niega a arrancar** (mensaje claro, código de salida 1) si `JWT_SECRET` tiene < 32 caracteres o parece un valor de ejemplo (contiene `cambia`, `changeme`, `change-me`, `secret` o `example`, sin distinguir mayúsculas), o si `ADMIN_PASSWORD` es de ejemplo (mismas palabras) o tiene < 12 caracteres. Genera un secreto con `openssl rand -base64 48`. En desarrollo sólo se registra un `warn` por cada problema. Ojo: la imagen Docker fija `NODE_ENV=production`, así que los valores de `.env.example` (`cambia-...`) **no sirven** para ella: hay que cambiarlos.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run build` | `tsc` + `tsc-alias` → `dist/` (entrada: `dist/apps/api/src/main.js`) |
| `npm start` / `npm run start:dev` | ejecuta el build / ejecuta con ts-node |
| `npm run lint` · `format` · `format:check` | ESLint (type-checked) · Prettier |
| `npm test` | tests unitarios (alarmas, gateway/coalescing, guards, config, plantas/activos, modelos 3D y validador GLB, revocación, auditoría, clientes/módulos, siembra y promoción del `platform_admin`, límites, coherencia de `060_orgs.sql`...) |
| `npm run test:e2e` | e2e con supertest + ws, repositorios en memoria y `ioredis-mock` (sin servicios reales). `test/tenancy.e2e-spec.ts` es la **matriz de aislamiento** (cada endpoint × admin/engineer/operator/viewer de A contra datos de B + control sobre A + platform_admin + escalada + WS); `test/orgs.e2e-spec.ts` cubre `/api/orgs`, módulos, límites, desactivación y auditoría por cliente |

Docker (contexto = raíz del repo): `docker build -f apps/api/Dockerfile -t campo-api .`

## Variables de entorno

Se validan al arrancar (el proceso falla con un mensaje claro si algo es inválido).

| Variable | Def. | Notas |
|---|---|---|
| `JWT_SECRET` | — | **Obligatoria**, ≥ 32 caracteres |
| `JWT_EXPIRES_IN` | `1h` | Duración del token de acceso. El acceso real lo decide la base en cada petición (ver Autorización) |
| `AUTH_CACHE_TTL_MS` | `30000` | TTL de la caché en memoria de usuario/rol/cliente/plantas (0–30000; `0` = sin caché, útil en tests). Los cambios hechos por la API (usuario o cliente) la invalidan al instante |
| `WS_REVALIDATE_MS` | = `AUTH_CACHE_TTL_MS` (10000 si es 0) | Cada cuánto se revalidan, contra la base y saltando la caché, los WebSocket abiertos |
| `DATABASE_URL` | `postgres://campo:campo_dev@localhost:5432/campo` | Obligatoria en producción |
| `REDIS_URL` | `redis://localhost:6379` | Obligatoria en producción |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Siembran el **`platform_admin`** (sin cliente): se crea al arrancar si no existe; si el email ya existe con otro rol/cliente se **promueve** (sin tocar su contraseña) y queda en el log. Nunca degrada a un `platform_admin`. Juntas, contraseña ≥ 8 (≥ 12 en producción) |
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

Prefijo `/api`, salvo sondas. Todo requiere `Authorization: Bearer <jwt>` excepto login y sondas. "Sus plantas" = las asignadas (`user_plants`) **que pertenecen a su cliente**; `admin` accede a todas las de su cliente; `platform_admin` a todas.

| Ruta | Roles | Descripción |
|---|---|---|
| `POST /api/auth/login` | público (rate limit) | `{email,password}` → `{accessToken, user:{id,email,role,plants,org}}` (`plants:["*"]` para admin y platform_admin; `org:{id,name,modules}`, `null` para platform_admin). **401** también si el cliente está desactivado |
| `GET /api/me` | cualquiera | `{id,email,role,plants,org}` vigentes (de la base, no del token) |
| `POST /api/me/password` | cualquiera (rate limit por usuario) | `{currentPassword,newPassword}` → `{accessToken}` nuevo. `newPassword`: ≥ 12 caracteres, ≤ 72 bytes y distinta de la actual. Actual errónea → **400** (no 401). Revoca todos los tokens y WebSockets anteriores del usuario (también los de otros dispositivos); el `accessToken` devuelto lleva la versión nueva |
| `GET /api/plants[?orgId=]` | cualquiera | `Plant[]` `{id,name,assets,orgId}`: platform_admin = todas las registradas de todos los clientes (`?orgId=` filtra; un admin lo ignora); admin = las de su cliente; resto = las asignadas de su cliente. Una planta que sólo emite telemetría (sin registrar) no pertenece a nadie y no se lista |
| `POST /api/plants` | admin, platform_admin | `{id,name,orgId?}` → `Plant`. `admin`: siempre en su cliente (`orgId` ajeno → 403); `platform_admin`: `orgId` **obligatorio** (400; cliente inexistente 404). 409 si el id ya existe en cualquier cliente (los ids de planta son únicos globalmente), tiene activos, o —para un admin— ya emite telemetría sin estar registrada |
| `PATCH /api/plants/:plant` | admin, platform_admin | `{name}` → `Plant` (el cliente no se cambia). Planta ajena o inexistente → 403 (admin) / 404 (platform_admin) |
| `DELETE /api/plants/:plant` | admin, platform_admin | `{deleted:true}`. **409 si tiene activos**; en una transacción borra sus asignaciones de usuario (cierra los WebSockets de esa planta con 4403), **sus modelos 3D, sus reglas y sus alarmas**: el id queda libre y quien lo reutilice (otro cliente) no hereda nada |
| `GET /health` · `GET /ready` | público | liveness · readiness (Redis + DB, 503 si falla) |
| `GET /api/plants/:plant/assets` | cualquiera, **sólo sus plantas** | catálogo de activos |
| `POST /api/plants/:plant/assets` | admin, engineer (con acceso a la planta) | `{id,name,type,model3dRef?,metadata?}` → `AssetDef`. `id` con `ID_PATTERN`; `name` 1–100; `type` uno de los 10 tipos (`tank pump valve sensor climate energy gas machine pressure flow`; si su módulo no está contratado por el **cliente dueño de la planta** → **403** `{statusCode:403,error:"module_disabled",module,message}`; `sensor` es genérico); `model3dRef` `null` o `"model:<uuid>"` de un modelo **de la misma planta** (400 si no existe, es de otra planta o es texto libre); `metadata` objeto JSON ≤ 8 KB (UTF-8) cuyas claves `layout`, `connectsTo`, `capacityM3` (>0), `contractedKw` (>0) y `scale` (`{métrica:{min<max}}`) se validan (ver "Disposición en planta"). Responde `AssetDef` y, si `connectsTo` nombra ids que aún no existen, además `warnings: string[]` (informativo; no es un error). 409 si el activo ya existe; la planta debe estar registrada (403 si no es de su cliente o no existe; platform_admin sobre una planta inexistente o sin registrar: 404) |
| `PATCH /api/plants/:plant/assets/:asset` | ídem | `{name?,type?,model3dRef?,metadata?}` (cambiar `type` a un módulo no contratado → 403 `module_disabled`; editar el resto de un activo ya existente nunca se bloquea) (al menos uno; el `id` no se cambia: enviarlo es 400; `model3dRef: null` quita el modelo; `metadata` reemplaza el objeto entero) → `AssetDef` (+ `warnings` si se envió `metadata`). Las mismas validaciones; un valor antiguo de `model3dRef` que no se modifica no se revalida. 404 si no existe |
| `DELETE /api/plants/:plant/assets/:asset` | ídem | `{deleted:true, affectedRules:n}`. `n` = reglas de alarma **de esa planta** cuyo `asset` nombra el activo (id exacto o patrón con `*`, incluido `*`); las reglas **no se borran ni modifican** |
| `POST /api/plants/:plant/models?name=<nombre>` | admin, engineer (con acceso a la planta) | Sube un GLB **crudo** (cuerpo = el archivo, `Content-Type: model/gltf-binary`; también se acepta `application/octet-stream`; **sin multipart**) → `ModelInfo` `{id,plant,name,size,sha256,createdAt}`. **201** si es nuevo, **200** si la planta ya tenía ese contenido (dedup por `sha256`: devuelve el existente, con su nombre original). `name` obligatorio, 1–100 caracteres sin caracteres de control. 400 con `GLB no válido: <motivo>` (ver "Modelos 3D"), 413 si supera 10 MB, 415 si el `Content-Type` es otro |
| `GET /api/plants/:plant/models` | cualquiera, **sólo sus plantas** | `ModelInfo[]`, más recientes primero (nunca incluye el contenido) |
| `GET /api/models/:id` | cualquiera autenticado, **sólo la planta del modelo** | El GLB (`model/gltf-binary`). `ETag: "<sha256>"`, `Cache-Control: private, max-age=31536000, immutable`; con `If-None-Match` coincidente (lista, `W/` o `*`) → **304** sin leer el contenido de la base. 403 genérico si el modelo es de una planta ajena, 404 si no existe, 400 si el id no es UUID |
| `DELETE /api/plants/:plant/models/:id` | admin, engineer (con acceso a la planta) | `{deleted:true}`. **409** `{statusCode:409,error,message,assets:[ids]}` si algún activo de la planta lo referencia (no se borra nada); 404 si no existe en esa planta |
| `GET /api/plants/:plant/state` | cualquiera, **sólo sus plantas** | snapshot (`campo:state:{plant}`) |
| `GET /api/plants/:plant/limits` | cualquiera, **sólo sus plantas** | `Limit[]` `{asset,metric,operator,threshold,severity}`: las reglas **activas** de la planta expandidas (patrón con `*`) a los activos que existen hoy; sin duplicados y ordenado por activo, métrica, umbral, operador y severidad |
| `GET /api/plants/:plant/assets/:asset/history?metric&from&to&bucket` | cualquiera, **sólo sus plantas** | `from`/`to`: ISO-8601 o epoch ms (def.: última hora). `bucket`: `1s 10s 30s 1m 5m 15m 1h 6h 1d` (def.: automático, ≤ ~1000 puntos). Bucket < 1 min lee `telemetry`; ≥ 1 min lee `telemetry_1m`. Responde `{plant,asset,metric,source,bucket,from,to,points:[{t,avg,min,max,samples}]}` |
| `GET/POST /api/alarm-rules`, `GET/PATCH/DELETE /api/alarm-rules/:id` | admin, engineer | CRUD de reglas **sólo de sus plantas** (`?plant=` filtra el listado; sin él, sólo las suyas). Una regla no se puede mover a una planta de otro cliente (403 si no tiene acceso; 400 para un platform_admin) |
| `GET /api/alarms?state=active\|cleared&plant=&limit=` | cualquiera | alarmas (`AlarmEvent` + `clearedAt`, `acknowledged`, `acknowledgedBy`, `acknowledgedAt`) **sólo de sus plantas**; `?plant=` ajena → 403 |
| `POST /api/alarms/:id/ack` | admin, engineer, operator | reconoce (idempotente); la alarma debe ser de una de sus plantas |
| `GET /api/users[?orgId=]` | admin, platform_admin | usuarios `{id,email,role,active,plants,org}` (`plants` = asignaciones guardadas). Un admin sólo ve a los de su cliente; platform_admin a todos (`?orgId=` filtra). Nunca el hash |
| `POST /api/users` | admin, platform_admin | `{email,password,role,orgId?,plants?}`; contraseña 12–72 bytes. `admin`: siempre en su cliente; `role: platform_admin` o `orgId` ajeno → 403; las `plants` deben ser de su cliente (403 genérico). `platform_admin`: `orgId` obligatorio (400) salvo al crear otro `platform_admin` (sin `orgId` ni `plants`). 409 si el email existe (los emails son únicos globalmente) |
| `PATCH /api/users/:id` | admin, platform_admin | `{role?,active?,password?}` (al menos uno; no existe campo para cambiar de cliente: `orgId` → 400). Un admin sobre un usuario de otro cliente o de plataforma → 403; `role: platform_admin` → 403 (admin) / 400 (no se asigna ni se quita por PATCH). 409 si deja a su cliente sin admin activo (o a la plataforma sin `platform_admin`). **Cambiar `password` o poner `active:false` revoca los tokens y WebSockets del usuario** (reactivar no los resucita: hay que volver a entrar) |
| `POST /api/users/:id/revoke` | admin, platform_admin | cierra todas las sesiones del usuario (JWT y WebSockets) sin tocar su cuenta → `ManagedUser`. 404 si no existe |
| `PUT /api/users/:id/plants` | admin, platform_admin | `{plants:["demo",...]}` reemplaza las asignaciones (ids `^[a-z0-9][a-z0-9_-]{0,63}$`, sin repetidos). Todas deben ser plantas **registradas del cliente del usuario**: si no → 403 genérico (admin) / 400 con detalle (platform_admin); a un `platform_admin` no se le asignan plantas (400) |
| `GET /api/audit?limit&before&actor&action[&orgId]` | admin, platform_admin | **admin: sólo la auditoría de su cliente** (ignora `?orgId=`/`?org=`); platform_admin: todo, con `?orgId=` (o `?org=`) para filtrar. `AuditEntry[]` `{id,ts,actorId,actorEmail,action,target,detail}`, más recientes primero. `limit` 1–200 (def. 50); `before` = `id` de la última entrada de la página anterior; `actor` = id (UUID) o email; `action` exacta (p. ej. `asset.delete`). Sólo lectura |

| `GET /api/orgs` | platform_admin | `Org[]` `{id,name,modules,active,createdAt,plants,users}` (contadores) |
| `POST /api/orgs` | platform_admin | `{id,name,modules,active?}` → `Org` (201). `modules` ⊆ `MODULE_IDS`, sin repetidos (400 si hay uno desconocido). 409 si el id existe |
| `GET /api/orgs/:id` · `PATCH /api/orgs/:id` | platform_admin | `Org` · `{name?,modules?,active?}` (al menos uno; `id` inmutable). Todo cambio invalida al instante la caché de acceso de los usuarios del cliente en todas las réplicas; **desactivar (`active:false`) además revoca sus sesiones** (`token_version`+1 a todos sus usuarios) |
| `DELETE /api/orgs/:id` | platform_admin | `{deleted:true}`; **409** si tiene plantas o usuarios (lo garantizan las FK) |
| `POST /api/orgs/:id/admins` | platform_admin | `{email,password}` → `ManagedUser` (201) con rol `admin` del cliente. 404/409 |

`platform_admin` y `admin` superan la comprobación de rol salvo en las rutas de plataforma (`/api/orgs*`), donde sólo pasa `platform_admin`.

**Regla de alarma**: `{plant, asset, metric, operator: gt|lt|gte|lte, threshold, severity: warning|critical, forSeconds=0, hysteresis=0, enabled=true}`. `asset` es un id exacto o un patrón con `*` (`tk-*`, `*`). La condición debe sostenerse `forSeconds` (debounce) para activar; una alarma `gt/gte` se normaliza cuando el valor baja a `threshold - hysteresis` (`lt/lte`: sube a `threshold + hysteresis`). Los datos con `quality: "bad"` se ignoran.

### Clientes y autorización (§8.1 + §11.1)

Un **cliente** (organización) tiene módulos contratados y un espacio propio; todo recurso (plantas, activos, modelos, reglas, alarmas, auditoría, usuarios) pertenece a uno. Roles: `platform_admin` (personal de Campos Ingeniería, sin cliente, lo ve todo y gestiona clientes), `admin` (administrador de SU cliente), `engineer`, `operator`, `viewer` (sólo las plantas asignadas, que deben ser de su cliente).

**Una sola fuente de verdad** (no hay filtros sueltos por endpoint):

- `auth/plant-access.ts` — reglas **puras**: `plantAllowed(user, plant, plantOrg)` y `scopeOf(user)` → `PlantScope {orgId?, plants?}` (platform `{}`, admin `{orgId}`, resto `{orgId, plants}`; un usuario sin cliente que no es platform no accede a nada).
- `auth/tenant-scope.ts` — `TenantScope`: aplica las reglas con el cliente propietario de la planta (`plants.org_id`, **consultado en la base en cada decisión, sin caché**: una planta borrada y recreada por otro cliente no hereda accesos). `assertPlant(user, plant)` lo usan `PlantAccessGuard` (toda ruta con `:plant`) y los servicios cuyo recurso no lleva `:plant` en la ruta (reglas, alarmas, modelos por id); `canAccessPlant` lo usa el WebSocket.
- Los repositorios reciben un `PlantScope` y filtran en SQL (`plant IN (SELECT id FROM plants WHERE org_id = $n)`): alarmas y reglas.
- `AccessService` (sesión) resuelve `{role, org, plants}` en cada petición/socket: usuario inactivo, **cliente desactivado o inexistente**, o `tv` distinto → 401 (sockets 4401). `RolesGuard`: `platform_admin` pasa siempre; `admin` pasa salvo en `@PlatformOnly()`.
- Las plantas asignadas (`user_plants`) sólo cuentan si pertenecen al cliente del usuario (el SQL de usuarios las une con `plants` por `org_id`, y el acceso lo vuelve a comprobar): una fila cruzada es inerte.

**Respuestas que no revelan existencia**: planta de otro cliente, no asignada, sin registrar o inexistente → el **mismo 403** `No tiene acceso a esta planta` (los ids de planta son adivinables y globalmente únicos, así que un 404 distinto filtraría qué plantas existen en otros clientes). Sólo `platform_admin` recibe 404 ante una planta inexistente. *Cambio de contrato respecto a §8.1* ("404 si la planta no existe para un admin"): ahora es 403 para el admin de cliente. Recursos con UUID (reglas, alarmas, modelos, usuarios): inexistente → 404, de otro cliente → 403 (los UUID v4 no se adivinan).

- El JWT sólo identifica (`sub`, `tv`). La caché de acceso (≤ 30 s) guarda también el cliente; **`PATCH /api/orgs/:id`** (cualquier cambio) y `PUT/PATCH /api/users/...` la invalidan al instante en este proceso y en las demás réplicas (canal Redis `campo:auth:invalidate`; payload = id de usuario, o `org:<id>` para un cliente entero) y el gateway WS revalida todos sus sockets. Si el aviso se pierde, el TTL acota el retraso a ≤ 30 s.
- **Cliente desactivado** (`active:false`): login 401, tokens existentes 401 (y además revocados: reactivar no los resucita; hay que volver a entrar), sockets cerrados con 4401; los datos se conservan y `platform_admin` los sigue viendo.
- **Primer `platform_admin`**: `ADMIN_EMAIL`/`ADMIN_PASSWORD` lo siembran al arrancar (sin cliente). Si ese email ya existía con otro rol/cliente (p. ej. el admin de antes de la migración 060) se **promueve**: `role=platform_admin`, `org_id=NULL`, sin plantas asignadas, `token_version`+1 y una línea `warn` en el log; su contraseña **no** se toca. Nunca degrada a un `platform_admin` existente. Para crear más: `POST /api/users {role:"platform_admin"}` (sólo platform_admin); para el primer admin de un cliente: `POST /api/orgs/:id/admins`.
- Un `admin` **no puede**: ver ni tocar recursos de otro cliente, crear/editar/revocar usuarios de otro cliente o de plataforma, crear u otorgar `platform_admin`, mover usuarios de cliente (no existe tal operación), asignar plantas ajenas, leer la auditoría de otro cliente, ni tocar `/api/orgs*`.
- Las denegaciones 401/403 se registran (log JSON, nivel `warn`, `msg: "acceso denegado"`) con `userId`, `method`, `path` (sin query) y `plant`; nunca tokens ni contraseñas.
- **El motor de alarmas** evalúa reglas de todas las plantas (las reglas llevan `plant`; el cliente sale de `plants`). Al arrancar, las alarmas activas de una planta sin cliente propietario se **cierran** en vez de restaurarse. Los eventos viajan por canales `campo:alarms:{plant}`: el WS sólo los entrega a los sockets de esa planta, que ya pasaron la comprobación de cliente.

#### Matriz rol × acción

| Acción | platform_admin | admin | engineer | operator | viewer |
|---|---|---|---|---|---|
| Estado / activos (GET) / histórico / límites / WebSocket de una planta | todas | las de su cliente | sólo asignadas | sólo asignadas | sólo asignadas |
| `GET /api/plants` | todas (`?orgId=`) | las de su cliente | sólo asignadas | sólo asignadas | sólo asignadas |
| Crear, renombrar, borrar plantas | sí (indica `orgId`) | en su cliente | no | no | no |
| Crear, editar, borrar activos | todas (módulo del cliente dueño) | su cliente | sólo asignadas | no | no |
| Subir y borrar modelos 3D | todas | su cliente | sólo asignadas | no | no |
| Listar / descargar modelos | todas | su cliente | sólo asignadas | sólo asignadas | sólo asignadas |
| Listar alarmas | todas | su cliente | sólo asignadas | sólo asignadas | sólo asignadas |
| Reconocer (ack) alarmas | todas | su cliente | sólo asignadas | sólo asignadas | no |
| Reglas de alarma (CRUD) | todas | su cliente | sólo asignadas | no | no |
| Usuarios (`/api/users`, `PUT .../plants`, `POST .../revoke`) | todos | los de su cliente (no platform_admin) | no | no | no |
| Auditoría (`GET /api/audit`) | todo (`?orgId=`) | la de su cliente | no | no | no |
| Clientes (`/api/orgs*`) | sí | no | no | no | no |
| `GET /api/me`, `POST /api/me/password` | sí | sí | sí | sí | sí |

Un usuario sin acceso a la planta recibe **403** (exista o no, sea de quien sea); operator/viewer reciben 403 al intentar escribir activos o plantas. Sin asignaciones = sin acceso (los listados devuelven `[]`; el resto, 403).

### Revocación de tokens (`token_version`)

Contrato en [`docs/architecture.md` §9.1](../../docs/architecture.md). `users.token_version` (entero, 0 por defecto) y el claim `tv` del JWT: en cada petición `JwtAuthGuard` pasa el `tv` del token a `AccessService`, que lo compara con la versión vigente (misma caché de ≤ 30 s, invalidada al instante al cambiar) y responde **401** si no coinciden.

- Se incrementa al **cambiar la contraseña** (propia con `POST /api/me/password`, o por un admin con `PATCH /api/users/:id`), al **desactivar** al usuario (`active:false`) y con **`POST /api/users/:id/revoke`**. Cambiar el rol o las plantas no revoca (ya surten efecto por la base).
- **Compatibilidad**: un token sin `tv` (emitido antes del despliegue) se trata como versión 0, así que sigue valiendo hasta la primera revocación del usuario; un `tv` que no sea un entero ≥ 0 invalida el token. El login siempre emite `tv`.
- **WebSockets**: cada socket recuerda el `tv` con el que conectó. Al revocar, el mismo mecanismo de revalidación de siempre (aviso inmediato en este proceso y vía Redis `campo:auth:invalidate` a las demás réplicas; revalidación periódica `WS_REVALIDATE_MS` como cota) lo cierra con **4401**; un token revocado tampoco puede abrir sockets nuevos.
- Varias réplicas: si el aviso por Redis se pierde, la revocación converge por TTL de la caché (≤ 30 s), igual que el resto de cambios de usuario.

### Auditoría (`audit_log`)

Servicio `AuditService` (módulo global `audit/`), tabla `audit_log(id bigserial, ts, actor_id, actor_email, action, target, org_id, detail jsonb)`. `org_id` = el **cliente del recurso afectado** (no el del actor: un `platform_admin` que edita una planta de un cliente la deja en la auditoría de ese cliente); `NULL` sólo para acciones de plataforma sin cliente. `record(actor, action, target, orgId, detail?)` exige el cliente explícito. Sólo se inserta y se lee por API (`GET /api/audit`); no hay edición ni borrado.

| `action` | `target` | `detail` (únicos campos permitidos) |
|---|---|---|
| `org.create` | `org:<id>` | `name, modules, active` |
| `org.update` | `org:<id>` | `changed`, `name, modules, active` |
| `org.delete` | `org:<id>` | `name` |
| `org.admin.create` | `user:<id>` | `email` — nunca la contraseña |
| `user.create` | `user:<id>` | `email, role, plants, orgId` |
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

- `plants(id, name, org_id NOT NULL, created_at)` es el registro: **una planta pertenece a un cliente** y sólo las registradas son accesibles a admin/engineer/operator/viewer (una que sólo emite telemetría solo la ve `platform_admin`, que debe registrarla con `POST /api/plants {id,name,orgId}`; para un admin ese `POST` da 409 mientras tenga estado vivo, para que nadie se quede con la telemetría ajena). `PlantCatalog.orgOf` resuelve el cliente; `exists` (registrada o viva) sólo se usa para el 404 de `platform_admin`.
- `GET /api/plants/:plant/assets` devuelve `AssetDef` (camelCase `model3dRef`, `metadata` objeto): ya devolvía exactamente esa forma, sin cambios. Las altas/ediciones/bajas de activos publican en Redis **`campo:catalog:changed`** el payload `{"plant":"<id>"}` (best effort: si Redis falla se registra un `warn` y la operación sigue).
- Crear, renombrar y borrar plantas, y subir/borrar modelos 3D, también publican `campo:catalog:changed` (además de las altas/ediciones/bajas de activos). Un modelo subido que ya existía (dedup) no cambia nada y no publica.
- Borrar una planta borra también sus reglas, alarmas y modelos (ver `DELETE /api/plants/:plant`); su estado en Redis no es nuestro: si el ingest sigue escribiendo, la planta queda como "sólo con telemetría" (sin cliente).

### Modelos 3D (GLB, §10.2)

- **Subida**: `curl -X POST "$API/api/plants/demo/models?name=Bomba" -H "Authorization: Bearer $T" -H "Content-Type: model/gltf-binary" --data-binary @bomba.glb`. El cuerpo se lee con el *body parser* `raw` de Express **sólo en esa ruta**, con límite de **10 MB** (el resto de la API conserva su límite global de 100 KB para JSON); se ejecuta como interceptor, es decir **después** de JWT, rol y acceso a la planta, de modo que quien no tiene permiso recibe 403 sin que el servidor almacene su cuerpo. Más de 10 MB (con o sin `Content-Length`, también 200 MB) → **413** `El modelo supera el límite de 10 MB`, sin tumbar la API.
- **Almacenamiento**: `asset_models.data` (bytea), con `sha256` calculado por la API; el listado y el 304 no leen `data`. Deduplicación por `UNIQUE(plant, sha256)` (el mismo contenido en otra planta es otro modelo). No hay cuota por planta.
- **Validador** (`src/models/glb-validator.ts`, módulo puro; falla con `400 GLB no válido: <motivo en español>`): contenedor `glTF` v2 con la longitud de la cabecera igual al tamaño real, bloques que caben, primer bloque JSON y BIN justo después; JSON ≤ **1 MiB** (las texturas van en el BIN; `JSON.parse` es síncrono y se acota su coste), anidación ≤ 64 niveles (comprobada **antes** de parsear), UTF-8 válido; `asset.version == "2.0"`; **sin `uri` externas** (sólo `data:`); extensiones **requeridas** sólo `KHR_materials_unlit`, `KHR_materials_emissive_strength`, `KHR_materials_pbrSpecularGlossiness`, `KHR_texture_transform`, `KHR_mesh_quantization`; **Draco y meshopt se rechazan** con mensaje explícito (también si sólo figuran en `extensionsUsed` o dentro de una primitiva/bufferView); ≤ **2000 nodos**; ≤ **200 000 vértices** (suma de los `count` de los accesores `POSITION` distintos de las mallas que algún nodo referencia); índices de accesores, bufferViews, buffers, mallas, materiales, texturas, imágenes, nodos, escenas, skins y animaciones dentro de rango; cada accesor cabe en su bufferView (con `byteStride`) y cada bufferView en su buffer; `buffers[0].byteLength` coherente con el BIN (sobran ≤ 3 bytes de relleno); jerarquía de nodos **sin ciclos y sin nodos con varios padres** (un rombo haría exponencial el recorrido del cliente); al menos una malla referenciada. Devuelve el primer problema.
- **Descarga y caché**: el id es inmutable (contenido direccionado por `sha256`), por eso `Cache-Control: private, max-age=31536000, immutable`. Un navegador compartido conserva en su caché los bytes ya descargados aunque cierre sesión (contrapartida aceptada por el contrato; son geometrías, no datos personales). Con CORS, `GLTFLoader` necesita enviar `Authorization` (`loader.setRequestHeader`).
- **Referencias** (`model3dRef`): `null` o `model:<uuid>` de un modelo de la **misma** planta, validado **sólo al escribir** (crear/editar activo). Los activos antiguos con texto libre (`tank`, `pump`...) se siguen listando; un `PATCH` que no toca `model3dRef` —o que reenvía exactamente el mismo valor antiguo— no falla; cambiarlo a otro texto libre sí. La comprobación "no está en uso" del borrado y la de "existe" al referenciar no son atómicas entre sí (ventana de milisegundos): un modelo borrado justo mientras se crea un activo que lo referencia dejaría una referencia colgante (la web cae al modelo procedural).

### Disposición en planta (`metadata.layout` / `metadata.connectsTo`, §10.3)

Se validan al crear/editar un activo (el resto de claves de `metadata` es libre; sigue el límite de 8 KB). Metadatos de dominio (§11.2): `capacityM3` y `contractedKw` números finitos > 0; `scale` = `{[métrica]: {min, max}}` con `min < max` finitos (≤ 32 métricas, claves `[A-Za-z0-9_.-]{1,64}`, sin otras propiedades). `layout: {x, z, y?, rotY?, scale?}` — `x`, `z`, `y` números finitos con |valor| ≤ 1000 (m), `rotY` finito con |valor| ≤ 3600 (grados), `scale` entre 0.05 y 50, ninguna otra clave; `connectsTo: string[]` — ≤ 32 ids con `ID_PATTERN`, sin duplicados ni el propio activo. No se exige que los ids existan (los activos se pueden crear en cualquier orden): los que no existan en la planta en ese momento se informan en `warnings` de la respuesta (no se guardan).

### WebSocket

`ws://host:3001/ws?plant={plant}&token={jwt}` (también acepta `Authorization: Bearer`). Códigos de cierre: `4400` planta inválida, `4401` token inválido, revocado (`tv`), usuario inactivo/inexistente o **cliente desactivado**, `4403` sin acceso a la planta (otra planta, **otro cliente**, sin registrar o inexistente). Tras validar el token se consulta el usuario (misma caché) y se comprueba la planta antes de enviar nada. Los sockets abiertos se **revalidan**: al cambiar un usuario en este proceso se re-evalúan al instante, y cada `WS_REVALIDATE_MS` (por defecto = TTL de la caché) contra la base saltando la caché; si el usuario ya no está activo o su token fue revocado (4401) o perdió la planta (4403) el servidor cierra el socket, así que la revocación llega a los sockets abiertos en ≤ 30 s aunque el token siga vigente. Un cambio del cliente (desactivarlo, cambiar módulos) revalida **todos** los sockets al instante. Si una planta cambia de cliente, el socket se corta con 4403 en la siguiente revalidación. El gateway sólo reenvía eventos de la planta suscrita (la barrera es la comprobación de cliente+planta al conectar y al revalidar; no hay filtrado por cliente en cada mensaje). El primer mensaje es `snapshot`; luego `telemetry` (coalescido por activo en ventanas de ~100 ms, mezclando por métrica el último valor), `alarm` (inmediato; incluye cambios de ack) y `{type:"catalog", plant}` (el catálogo de la planta cambió —activos, modelos 3D, la propia planta—: el cliente vuelve a pedirlo por HTTP). Los avisos de catálogo llegan por `RealtimeBus` (la misma conexión Redis de suscripción de siempre, ahora también `SUBSCRIBE campo:catalog:changed`, sin conexiones nuevas por cliente) y se agrupan por planta en ventanas de `WS_CATALOG_COALESCE_MS` (250 ms): una ráfaga de altas produce un único mensaje por cliente. El cliente no envía mensajes (se ignoran; uno de más de 1 KiB cierra el socket).

## Límites conocidos (clientes)

- **Unicidad global**: los ids de planta y los emails son únicos en toda la plataforma (los tópicos MQTT no llevan cliente). Un `POST /api/plants` o `POST /api/users` con un id/email que existe en otro cliente responde 409, lo que revela que existe. Es inherente al contrato; no se filtra nada más (ni cliente ni datos).
- Los recursos con UUID responden 404 si no existen y 403 si son de otro cliente (no se adivinan por ser UUID v4).
- **Caché de acceso**: en otras réplicas un cambio de usuario/cliente converge por el aviso en Redis o, si se pierde, por el TTL (≤ 30 s). Cambios hechos por SQL directo sólo se ven al expirar el TTL.
- El módulo `view3d` no restringe nada en la API (subir modelos no exige tenerlo): sólo lo usa la web para mostrar la pantalla. Desactivar un módulo bloquea nuevas altas de ese tipo, pero no oculta ni borra los activos existentes.
- Una planta que sólo tiene telemetría (sin registrar) no se lista ni es accesible para nadie salvo `platform_admin`; hay que registrarla.
- El motor de alarmas es global (una instancia evalúa todos los clientes); su caché de reglas se refresca cada `ALARM_RULES_REFRESH_MS` además de al cambiar una regla, así que borrar una planta limpia sus reglas en la base al instante pero el motor puede evaluarlas hasta el siguiente refresco (las alarmas resultantes se cierran como huérfanas).
- La auditoría anterior a la migración 060 se atribuye entera a `campos-demo`.
- `AuditEntry` (contrato compartido) no expone `org_id`: el filtrado por cliente es sólo de servidor.
