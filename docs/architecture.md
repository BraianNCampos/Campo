# Arquitectura y contratos — Campo 2.0

Este documento es la fuente de verdad de los contratos entre servicios.
Si un servicio necesita cambiarlos, se cambia **aquí y en `packages/shared/src/index.ts`** en el mismo commit.

```
sensor ─MQTT→ Mosquitto ─→ ingest (Go) ─┬─ Redis HSET  campo:state:{plant}      (estado actual)
                                         ├─ Redis PUBLISH campo:events:{plant}  (tiempo real)
                                         └─ TimescaleDB COPY telemetry          (histórico, por lotes)
api (NestJS) ─ SUBSCRIBE campo:events:* ─→ evalúa reglas ─→ PUBLISH campo:alarms:{plant}
api ─ WebSocket /ws ─→ web (snapshot + telemetry + alarm)
```

Principio: **la ruta caliente (sensor → pantalla) nunca pasa por la base de datos**. Postgres es solo histórico y configuración.

## 1. MQTT (borde)

| Tópico | Dirección | Payload |
|---|---|---|
| `campo/v1/{plant}/{asset}/telemetry` | sensor → nube | `TelemetryPayload` |
| `campo/v1/{plant}/{asset}/cmd` | nube → sensor | reservado (Fase 3) |

`plant` y `asset` cumplen `^[a-z0-9][a-z0-9_-]{0,63}$`. Mensajes con tópico o JSON inválido se descartan y se cuentan (métrica `ingest_dropped_total{reason}`), nunca bloquean.

`TelemetryPayload` (JSON):

```json
{ "ts": 1730213000000, "values": { "level": 72.5, "temp": 18.2 }, "quality": "good" }
```

- `ts`: epoch en ms, opcional (si falta o está a más de ±24 h del reloj del servidor, ingest usa la hora de recepción).
- `values`: mapa `metric → número finito`. Valores no numéricos se descartan.
- `quality`: `good` (def.) | `uncertain` | `bad`.

## 2. Redis

| Clave / canal | Tipo | Contenido |
|---|---|---|
| `campo:state:{plant}` | Hash | campo = `asset`, valor = JSON `{ts, values, quality}` (último dato) |
| `campo:events:{plant}` | Pub/Sub | `TelemetryEvent` |
| `campo:alarms:{plant}` | Pub/Sub | `AlarmEvent` |
| `campo:alarms:active:{plant}` | Hash | campo = `{asset}:{metric}:{ruleId}`, valor = JSON `AlarmEvent` activa |

## 3. TimescaleDB

Hypertable `telemetry` (ver `infra/timescaledb/init/010_telemetry.sql`), una fila por métrica. El servicio `api` es dueño de las tablas de configuración (`users`, `assets`, `alarm_rules`, `alarms`) en `infra/timescaledb/init/020_app.sql`.

## 4. API REST (NestJS, prefijo `/api`)

| Método y ruta | Descripción |
|---|---|
| `POST /api/auth/login` | `{email,password}` → `{accessToken}` (JWT) |
| `GET /api/plants/:plant/assets` | catálogo de activos de la planta |
| `GET /api/plants/:plant/state` | snapshot actual (lee `campo:state:{plant}`) |
| `GET /api/plants/:plant/assets/:asset/history?metric&from&to&bucket` | histórico agregado (continuous aggregates) |
| `GET/POST/PATCH/DELETE /api/alarm-rules` | reglas de alarma (rol `admin`/`engineer`) |
| `GET /api/alarms?state=active` | alarmas; `POST /api/alarms/:id/ack` reconoce |
| `GET /api/me` | usuario actual `{id,email,role,plants}` |
| `GET/POST /api/users`, `PATCH /api/users/:id`, `PUT /api/users/:id/plants` | administración de usuarios (solo `admin`, ver §8.1) |
| `GET /health`, `GET /ready` | sondas |

Roles: `admin`, `engineer`, `operator`, `viewer`.

## 5. WebSocket (`/ws?plant={plant}&token={jwt}`)

WebSocket nativo (librería `ws`), mensajes JSON, un tipo discriminado `ServerMessage`:

1. Al conectar: `{type:"snapshot", plant, assets:{[asset]:{ts,values,quality}}}`
2. Luego: `{type:"telemetry", ...}` y `{type:"alarm", ...}` en tiempo real.
3. El servidor agrupa telemetría en ventanas de ~100 ms por activo (coalescing: solo el último valor) para no saturar al cliente móvil.
4. Cierres: `4400` planta inválida, `4401` token inválido o usuario inactivo, `4403` sin acceso a la planta (ver §8.1); el cliente no reintenta ante 4401/4403.
5. Ping/pong cada 25 s. El cliente reconecta con backoff exponencial y vuelve a recibir `snapshot`.

## 6. Frontend

- Escritorio: gemelo digital 3D (React Three Fiber) + panel lateral de alarmas y curvas.
- Móvil (`< 768px`): **sin canvas 3D por defecto**; tarjetas de estado por activo, lista de alarmas con ack rápido, sparkline. El 3D es opt-in.
- Zustand: un store `useLiveStore` actualizado por el WebSocket; los componentes 3D leen con selectores finos / `subscribe` transitorio (sin re-render de React por cada mensaje).
- PWA: manifest + service worker, shell offline, último snapshot cacheado.

## 7. Decisiones (ADR resumidas)

- **Go para ingesta**: goroutines + canal acotado + lotes → absorbe picos; si el canal se llena se descarta telemetría *de histórico* antes que bloquear la ruta en vivo (política configurable).
- **Pub/Sub de Redis para tiempo real, no Streams**: el tiempo real tolera pérdida (el snapshot corrige); el histórico se escribe directo desde ingest. Revisar si se exige entrega garantizada de alarmas.
- **WebSocket nativo, no Socket.IO**: menos overhead, protocolo simple y estándar.
- **Una fila por métrica en `telemetry`**: simple, comprime muy bien en Timescale, permite métricas nuevas sin migrar.

## 8. Seguridad (Fase 3)

### 8.1 Autorización por planta (API)

- Tabla `user_plants(user_id, plant)`. El rol `admin` accede a **todas** las plantas; `engineer`, `operator` y `viewer` solo a las asignadas. Sin asignaciones = sin acceso.
- El JWT lleva `sub`, `role` y `tv` (versión de token, ver §9.1), **no** las plantas ni el estado activo: en cada petición el guard consulta al usuario (activo, rol, plantas) a través de una caché en memoria de ≤30 s, que se invalida al instante cuando el propio proceso modifica al usuario. Un usuario desactivado o con plantas revocadas pierde acceso en ≤30 s (no hasta que expire el token).
- Toda ruta con `:plant` (state, assets, history), `GET /api/alarms` (se filtra por plantas permitidas; `?plant=` opcional), `POST /api/alarms/:id/ack` (según la planta de la alarma) y `/api/alarm-rules` (CRUD limitado a plantas permitidas) responde **403** si el usuario no tiene la planta (404 si la planta no existe para un admin). WebSocket: `/ws?plant=` cierra con **4403** si no tiene acceso (4401 token inválido o usuario inactivo, 4400 planta inválida).
- `GET /api/me` → `{id,email,role,plants}` (`plants` = `["*"]` para admin). `POST /api/auth/login` añade `user` con la misma forma. El token de acceso dura 1 h por defecto (`JWT_EXPIRES_IN`).
- Administración (solo `admin`): `GET/POST /api/users`, `PATCH /api/users/:id` (rol, activo, contraseña), `PUT /api/users/:id/plants` (`{plants:[...]}`). Nunca se devuelve el hash. No se puede desactivar ni degradar al último admin activo.
- En producción (`NODE_ENV=production`) la API se niega a arrancar si `JWT_SECRET` es corto (<32) o parece un valor de ejemplo (`cambia`, `changeme`, `secret`), o si `ADMIN_PASSWORD` es de ejemplo.

### 8.2 MQTT autenticado con TLS

- Usuarios: `ingest` (solo lectura de `campo/v1/#`) y **un usuario por planta cuyo nombre es el id de la planta** (`demo`, …): solo puede publicar en `campo/v1/{plant}/+/telemetry` (ACL `pattern write campo/v1/%u/+/telemetry`) y leer `campo/v1/%u/+/cmd`. Nada más. Sin acceso anónimo.
- Listener TLS 8883 (TLS ≥ 1.2, CA propia en desarrollo/pruebas; certificados reales en producción). Sin listener en claro ni WebSocket abiertos hacia el exterior.
- El servicio de ingesta (`MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_CA_FILE`, y `ssl://` en `MQTT_BROKER_URL`) y el simulador (mismas opciones) se conectan con credenciales y verificando el certificado del broker.

### 8.3 Despliegue endurecido (`docker-compose.prod.yml`, se superpone al compose base)

- Mosquitto con la configuración segura de 8.2; Redis con `requirepass`; TimescaleDB y Redis **sin puertos publicados** al host; contraseñas obligatorias (`:?`) sin valores por defecto.
- Proxy inverso con TLS (Caddy) como única entrada HTTP(S): `/` → web, `/api/*` y `/ws` → api. La web se construye same-origin (sin URLs absolutas). Cabeceras de seguridad (HSTS, CSP razonable, etc.).
- `scripts/bootstrap-secure.sh` genera secretos, CA y certificados del broker, el `passwd` de Mosquitto y un `.env.prod` (permisos 600, nunca versionado).

## 9. Administración (Fase 4)

Pantallas de administración en la web (`/admin`) sobre la API. Los endpoints ya existentes (`/api/users*`, `/api/alarm-rules*`, `GET /api/plants/:plant/assets`, `/api/me`) **no cambian de forma**; esto añade lo que falta.

### 9.1 API nueva (`apps/api`)

| Método y ruta | Roles | Descripción |
|---|---|---|
| `GET /api/plants` | todos | `Plant[]` visibles para el usuario (admin: todas; resto: las asignadas). `assets` = nº de activos |
| `POST /api/plants` | admin | `{id,name}` crea una planta (id con `ID_PATTERN`; 409 si existe) |
| `PATCH /api/plants/:plant` | admin | `{name}` |
| `DELETE /api/plants/:plant` | admin | 409 si tiene activos; limpia asignaciones; responde `200 {deleted:true}` |
| `POST /api/plants/:plant/assets` | admin, engineer (con acceso a la planta) | `{id,name,type,model3dRef?,metadata?}` → `AssetDef` (409 si existe) |
| `PATCH /api/plants/:plant/assets/:asset` | ídem | `{name?,type?,model3dRef?,metadata?}` (el `id` no se cambia) |
| `DELETE /api/plants/:plant/assets/:asset` | ídem | borra el activo (las reglas de alarma que lo nombran siguen existiendo; se informa en la respuesta con `affectedRules: n`) |
| `POST /api/users/:id/revoke` | admin | cierra las sesiones del usuario (sube su `token_version`); responde `200 ManagedUser` |
| `POST /api/me/password` | todos | `{currentPassword,newPassword}` (≥12 chars, distinta); 400 si la actual no coincide |
| `GET /api/audit?limit&before&actor&action` | admin | `AuditEntry[]` más recientes primero (paginado por `before` = id) |

- **Tabla `plants(id, name, created_at)`**: se siembra con las plantas ya presentes en `assets` y `user_plants` (nombre = id). Crear un activo en una planta inexistente da 404; para el admin `GET /api/plants` incluye también las plantas conocidas solo por `assets`/Redis.
- **Esquema** (`040_admin.sql`, propiedad de `api`): tablas `plants` y `audit_log`, y `users.token_version`. Los tokens sin `tv` previos al despliegue cuentan como versión 0. Desactivar y reactivar a un usuario obliga a iniciar sesión de nuevo.
- **Revocación de tokens**: `users.token_version`; el JWT lleva `tv`; el guard rechaza (401) si `tv` ≠ versión actual. Se incrementa al cambiar la contraseña (propia o por un admin), al desactivar y con `POST /api/users/:id/revoke` (admin, cierra sesiones). Cambiar la propia contraseña devuelve un token nuevo `{accessToken}` para no echar al usuario.
- **Auditoría (`audit_log`)**: se registra quién, cuándo, qué y sobre qué para: alta/baja/edición de usuarios y asignación de plantas, cambios de contraseña (sin valores), revocaciones, alta/edición/baja de plantas, activos y reglas de alarma, ack de alarmas, y logins fallidos repetidos NO (eso va al log). Nunca se guardan contraseñas ni tokens. Solo lectura por API; sin edición ni borrado.
- Las altas/ediciones de activos publican en Redis `campo:catalog:changed` para que los clientes refresquen el catálogo.

### 9.2 Web (`apps/web`)

- Selector de planta en la cabecera (de `GET /api/plants`; se recuerda la última; si solo hay una, no se muestra). Cambiar de planta reconecta el WebSocket.
- `/admin` con navegación por rol: **Usuarios** (admin), **Plantas y activos** (admin y engineer), **Reglas de alarma** (admin y engineer), **Auditoría** (admin) y **Mi cuenta** (todos; cambio de contraseña). operator/viewer solo ven Mi cuenta.
- Cliente tipado `AdminApi` con dos implementaciones: HTTP y un mock en memoria (modo demo), de modo que todo se pueda probar sin backend.
- Todas las acciones destructivas piden confirmación; los errores de la API (400/403/409) se muestran en español junto al formulario; usable en móvil (tablas → tarjetas).
