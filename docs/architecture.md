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
| `GET/POST /api/plants/:plant/models`, `GET /api/models/:id`, `DELETE /api/plants/:plant/models/:id` | modelos 3D (GLB), ver §10.2 |
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
- Toda ruta con `:plant` (state, assets, history), `GET /api/alarms` (se filtra por plantas permitidas; `?plant=` opcional), `POST /api/alarms/:id/ack` (según la planta de la alarma) y `/api/alarm-rules` (CRUD limitado a plantas permitidas) responde **403** si el usuario no tiene la planta (**403 también si la planta no existe o es de otro cliente**: un 404 distinto revelaría qué plantas existen en otros clientes; solo `platform_admin` recibe 404). WebSocket: `/ws?plant=` cierra con **4403** si no tiene acceso (4401 token inválido o usuario inactivo, 4400 planta inválida).
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

## 10. Catálogo vivo y modelos 3D (Fase 5)

> Detalles de la implementación de la API: `?name=` es obligatorio al subir (400 si falta); se acepta `Content-Type: model/gltf-binary` (o `application/octet-stream`), otro da 415; el 409 al borrar un modelo en uso lleva `assets:[ids]`; las respuestas de crear/editar activo pueden incluir `warnings: string[]` (ids de `connectsTo` inexistentes); el bloque JSON del GLB está limitado a 1 MiB; borrar una planta borra también sus modelos; `model3dRef` antiguos de texto libre (p. ej. `tank` en el seed) se tratan como "sin modelo". Esquema en `050_models.sql` (tabla `asset_models`, propiedad de `api`).

### 10.1 Catálogo como fuente de la lista en vivo

- La web construye la lista de activos (y el 3D) desde el **catálogo** (`GET /api/plants/:plant/assets`), no desde la telemetría recibida. Un activo del catálogo sin datos aún se muestra con estado **"Sin datos"** (gris, icono distinto, sin valores); un activo que envía telemetría pero no está en el catálogo se muestra como *no catalogado* (como hoy).
- WebSocket: nuevo mensaje servidor → cliente `{type:"catalog", plant}` (en `ServerMessage`). La API lo envía a los clientes de esa planta cuando cambian activos o modelos (a partir de `campo:catalog:changed`, que se publica al cambiar activos, modelos y plantas; la API fusiona ráfagas en ventanas de 250 ms por planta). El cliente vuelve a pedir el catálogo (con *debounce*) al recibirlo.
- En modo demo el catálogo es el de los 8 activos de `demo`.

### 10.2 Modelos glTF por activo

- Formato: **GLB (glTF 2.0 binario) autocontenido** (texturas y buffers embebidos). Se rechazan URIs externas, Draco y meshopt (`KHR_draco_mesh_compression`, `EXT_meshopt_compression`) y cualquier extensión requerida fuera de esta lista: `KHR_materials_unlit`, `KHR_materials_emissive_strength`, `KHR_materials_pbrSpecularGlossiness`, `KHR_texture_transform`, `KHR_mesh_quantization`. Tamaño máximo 10 MB; máximo 200 000 vértices en total (suma de `count` de los accesores `POSITION`) y 2 000 nodos.
- Subida: `POST /api/plants/:plant/models?name=<nombre>` con el GLB **crudo** en el cuerpo (`Content-Type: model/gltf-binary`, sin multipart) → `ModelInfo` (201). Roles `admin` y `engineer` con acceso a la planta. Deduplica por `sha256` dentro de la planta (si ya existe, devuelve la existente con 200). 400 con mensaje claro si no es un GLB válido o incumple los límites; 413 si supera el tamaño.
- `GET /api/plants/:plant/models` → `ModelInfo[]` (cualquier rol con acceso a la planta). `GET /api/models/:id` → binario (`model/gltf-binary`), exige autenticación y acceso a la planta del modelo (403 si no), con `ETag` = sha256 y `Cache-Control: private, max-age=31536000, immutable` (el id es inmutable). `DELETE /api/plants/:plant/models/:id` (admin/engineer) → 409 con la lista de activos que lo usan si está referenciado.
- Referencia desde el activo: `model3dRef` es `null` (modelo procedural según el tipo) o `"model:<uuid>"` de un modelo **de la misma planta** (400 si no existe o es de otra planta).
- Auditoría: `model.upload` y `model.delete` (sin contenido del archivo).
- **Convenciones de animación** (nombres de nodo, insensibles a mayúsculas, y también cuentan los hijos con ese prefijo):
  - `campo_level*`: se escala en Y de `0` a `1` según la métrica `level` (0–100 %) respecto a su posición original (el origen del nodo debe estar en su base).
  - `campo_rotor*`: gira sobre su eje Y proporcionalmente a `rpm` (1500 rpm ≈ 1 vuelta/s visual).
  - `campo_gate*`: rota/desplaza según `position` (0–100 %); sin convención más estricta, la web aplica una rotación de 0° a 90° sobre Z.
  - El resto de mallas se tiñen (emisivo) según el estado del activo: normal sin cambios, advertencia ámbar, crítica rojo, sin datos gris.
  - Ejemplos generados por `node scripts/make-sample-glb.mjs` (`examples/models/*.glb`).
- Normalización: la web ajusta cada modelo a su caja envolvente (escala unitaria configurable `layout.scale`), apoyado en el suelo (y=0).

### 10.3 Disposición en planta (metadata del activo)

`AssetDef.metadata` admite (todo opcional, validado en la API):

- `layout: {x, z, y?, rotY?, scale?}` — posición en metros (|x|,|z|,|y| ≤ 1000), rotación Y en grados, escala 0.05–50. Sin `layout`: el activo `demo` conocido usa su posición hecha a mano; los demás, una cuadrícula automática.
- `connectsTo: string[]` — ids de activos de la misma planta (≤ 32, sin duplicados ni a sí mismo): la web dibuja una tubería entre ambos (ortogonal, con partículas de flujo cuando el origen es una bomba en marcha o una válvula abierta). Sin `connectsTo` en ningún activo de la planta: se mantienen las tuberías manuales de `demo` o ninguna.

## 11. Clientes y módulos (Fase 6)

Campo es un producto de **Campos Ingeniería** que se entrega a **clientes**; cada cliente tiene su propio espacio y solo ve los **módulos** que contrató. Si un cliente solo quiere medir tanques, la plataforma solo muestra tanques; sumar un módulo es activarlo y conectar los sensores.

### 11.1 Clientes (organizaciones) y aislamiento

- Tabla `organizations(id, name, modules text[], active, created_at)` (`id` con `ID_PATTERN`). `plants.org_id` (NOT NULL) y `users.org_id` (NULL = personal de Campos Ingeniería). Los ids de planta siguen siendo únicos globalmente (los tópicos MQTT no cambian).
- Roles: **`platform_admin`** (personal de Campos Ingeniería; `org_id` nulo; gestiona clientes y ve todo), **`admin`** (administrador del cliente), `engineer`, `operator`, `viewer`. Sustituye a §8.1: `admin` ve **todas las plantas de su cliente**; `platform_admin` todas; el resto solo las asignadas (que deben pertenecer a su cliente).
- **Regla de oro (aislamiento):** todo recurso (plantas, activos, modelos, reglas, alarmas, auditoría, usuarios) se filtra por cliente en el servidor. Un `admin` no puede: ver ni tocar recursos de otro cliente, asignar plantas de otro cliente, crear/editar clientes, ni otorgar `platform_admin`. Un id de otro cliente responde **403 genérico** (igual que una planta ajena hoy). El WebSocket verifica además que el cliente esté `active`. Un cliente `active=false` no puede iniciar sesión (401) y sus sockets se cierran (4401).
- Auditoría: los `admin` ven solo la auditoría de su cliente (`audit_log.org_id`); `platform_admin` ve todo y puede filtrar por cliente.
- API de plataforma (solo `platform_admin`): `GET/POST /api/orgs`, `GET/PATCH /api/orgs/:id` (`name`, `modules`, `active`), `DELETE /api/orgs/:id` (409 si tiene plantas o usuarios), `POST /api/orgs/:id/admins` (`{email,password}` crea el primer administrador del cliente). `GET /api/orgs` devuelve `Org[]` con contadores.
- Crear plantas, usuarios y activos: un `admin` lo hace siempre en su cliente; un `platform_admin` debe indicar `orgId` (400 si falta). `Plant` incluye `orgId`.
- `GET /api/me` añade `org: {id,name,modules} | null`. `POST /api/auth/login` devuelve el mismo `user`.
- `ADMIN_EMAIL`/`ADMIN_PASSWORD` siembran un **`platform_admin`** (sin cliente). Migración `060_orgs.sql`: crea el cliente `campos-demo` ("Agroindustria Ejemplo", todos los módulos), le asigna las plantas y usuarios existentes (los `admin` existentes siguen siendo `admin` de ese cliente; el sembrado por `ADMIN_EMAIL` pasa a `platform_admin`), y siembra el cliente `cliente-tanques` ("Cliente Solo Tanques", módulo `tanks`) para demostrar la adaptación.

### 11.2 Módulos y tipos de activo

- Registro compartido (`packages/shared`: `MODULES`, `ASSET_KINDS`, `METRICS`). Módulos: `tanks` (Tanques y llenado: `tank`, `pump`, `valve`), `climate` (Temperatura y humedad: `climate`), `energy` (Energía: `energy`), `gas` (Consumo de gases: `gas`), `machines` (Estado de máquinas: `machine`), `flow` (Presión y caudal: `pressure`, `flow`), `view3d` (Vista 3D y modelos). Siempre activos (núcleo): alarmas, administración, mi cuenta, modo pared. `sensor` es genérico (sin módulo).
- Tipos nuevos de activo: `climate`, `energy`, `gas`, `machine`, `pressure`, `flow`. Métricas: `level` (%), `temp` (°C), `humidity` (%), `rpm`, `current` (A), `position` (%), `kw`, `kwh` (contador acumulado), `pf` (cos φ), `flow` (m³/h), `total` (m³, contador), `pressure` (bar), `state` (0 = detenida, 1 = en marcha).
- Crear un activo cuyo tipo pertenece a un módulo **no contratado** por el cliente → **403** `{error:"module_disabled", module}`. Crear/editar un cliente con un módulo desconocido → 400. Desactivar un módulo no borra datos: la web oculta sus pantallas y los activos siguen en la API (límite documentado).
- Metadatos de dominio (opcionales, validados): `capacityM3` (tanques, número > 0), `contractedKw` (energía, número > 0), `scale: {[métrica]: {min,max}}` (rango de la barra; si falta, el registro `METRICS` da uno por defecto).
- **Límites visibles para todos los roles:** `GET /api/plants/:plant/limits` → `Limit[]` `{asset, metric, operator, threshold, severity}` resueltos desde las reglas de alarma activas (los patrones se expanden a ids de activos existentes). La web los usa para dibujar las barras de rango y calcular "cerca del límite".

### 11.3 Semillas (desarrollo/pruebas)

- Cliente `campos-demo`, planta `demo`: los 8 activos actuales (con `capacityM3: 60` en los tanques) más `clima-01`, `clima-02` (climate), `en-linea1`, `en-compresores`, `en-clima`, `en-calderas` (energy, con `contractedKw`), `gas-01` (gas), `maq-01`, `maq-02`, `maq-03` (machine), `pres-01` (pressure), `cau-01` (flow). Reglas de ejemplo para los tipos nuevos (temp > 30, humedad > 80, kw cerca de la contratada, presión > 8 crítica).
- Cliente `cliente-tanques`, planta `tanques`: `tk-a`, `tk-b` (tank, `capacityM3: 40`) con reglas de nivel alto/bajo.
- No se siembran usuarios con contraseña (excepto `platform_admin` por variables de entorno).
- El simulador (`apps/ingest/cmd/simulator`) emite telemetría para ambas plantas: `-plants demo,tanques` (por defecto) y genera las métricas de arriba para los tipos nuevos.

### 11.4 Web: pantallas por módulo (lenguaje de diseño de Campo)

- Navegación **dirigida por módulos** (`me.org.modules`; `platform_admin` ve el módulo según la planta elegida): una sección por módulo activo (`/m/tanks`, `/m/climate`, `/m/energy`, `/m/gas`, `/m/machines`, `/m/flow`, `/m/view3d`). Cada pantalla de módulo tiene pestañas **En vivo · Alarmas · Reglas**. Un cliente con un solo módulo no ve selector de secciones, solo su pantalla.
- **En vivo:** franja de resumen (números grandes, p. ej. Tanques: cantidad y capacidad total; en alarma; fuera o cerca del límite; nivel más bajo), filtros **Todos / Requieren atención**, y tarjetas por activo con: nombre, estado (**En rango / Cerca del límite / Alarma / Sin datos**), valor grande con unidad, barra con la escala y los límites, tendencia (**estable / subiendo / bajando** con la tasa por hora) y mini-curva. "Cerca del límite" = a menos del 10 % de la escala de un límite de alarma. Color solo cuando importa: normal en verde azulado atenuado, ámbar = atención, rojo = alarma.
- **Modo pared** (`/pared`): pantalla completa para TVs de planta, sin menús, números grandes, rotación automática entre los módulos activos, reloj, reconexión y *wake lock*; se sale con Esc o un toque largo.
- **Alarmas** (pestaña): activas con reconocer (si el rol puede), filtradas a los activos del módulo. **Reglas** (pestaña): enlace a `/admin/rules?plant=&module=`, que respeta esos parámetros.
- Administración de plataforma (`platform_admin`): sección **Clientes** (`/admin/orgs`): alta/edición, módulos con interruptores y descripciones, activar/desactivar, crear el primer administrador. Los `admin` de un cliente ven en "Mi cuenta" los módulos contratados ("Para sumar más, contactá a Campos Ingeniería").
- Textos en **voseo rioplatense** ("Contactá", "Elegí", "Querés"), claros y sin jerga. Identidad: ver `apps/web/src/components/Brand.tsx` y los *tokens* de `globals.css` (azul noche, blanco frío, ámbar; Barlow y JetBrains Mono).

### 11.5 Precisiones de la implementación (API)

- **Un solo 403 para lo ajeno:** para un `admin` de cliente, una planta de otro cliente o inexistente responde el mismo 403. Los recursos con UUID (reglas, alarmas, modelos, usuarios) dan 404 si no existen y 403 si son de otro cliente.
- **Plantas registradas:** `GET /api/plants` lista solo plantas de la tabla `plants` (con `orgId`). Las plantas que solo existen por telemetría o activos no pertenecen a ningún cliente: `platform_admin` las registra con `POST /api/plants {id,name,orgId}`; un `admin` recibe 409 si intenta crear una planta que ya tiene telemetría viva sin registrar (para que nadie se quede con telemetría ajena).
- **Borrar una planta** borra también sus reglas de alarma, alarmas y modelos (en la misma transacción), para que quien reutilice el id no herede datos.
- **Último administrador:** se cuenta por cliente; también se protege al último `platform_admin`. Un `admin` no crea ni edita `platform_admin`, no cambia de cliente (`orgId` en PATCH → 400) ni asigna plantas ajenas.
- **Cliente inactivo:** corta sesiones (401) y sockets (4401); reactivarlo **no** resucita los tokens anteriores (sube `token_version` de todos sus usuarios).
- **Auditoría:** `audit_log.org_id`; un `admin` solo ve su cliente; `platform_admin` filtra con `?orgId=` (alias `?org=`).
- **Semilla de `ADMIN_EMAIL`:** crea o promueve a `platform_admin` (sin cliente) y nunca degrada a uno existente; si era el único admin de `campos-demo`, ese cliente queda sin administrador (aviso en el log) hasta crear uno con `POST /api/orgs/campos-demo/admins`.
- **Límites conocidos:** el módulo `view3d` aún no restringe la subida de modelos en la API; los ids de planta y los emails son únicos globalmente (un 409 revela que existe).

## 12. Alarmas ISA-18.2 y desviación (Fases 7a/7b)

Implementa lo pedido en `docs/ux-isa.md`. Todo lo nuevo es **aditivo**: una regla existente sigue funcionando igual.

### 12.1 Reglas

`alarm_rules` gana columnas opcionales (valores por defecto que conservan el comportamiento actual):

- `kind`: `HH | HI | LO | LL | DEV | ROC`. Por defecto se deriva del operador y la severidad: `gt/gte` + `critical` → `HH`, `gt/gte` + `warning` → `HI`, `lt/lte` + `critical` → `LL`, `lt/lte` + `warning` → `LO`. `DEV`: se activa si `|valor − SP| > umbral` (el SP sale de `metadata.setpoints[métrica]` del activo o de la métrica `<métrica>_sp` de la telemetría, que manda; **sin SP la regla no se evalúa** y el estado de la regla lo informa). `ROC`: tasa de cambio absoluta por minuto, calculada sobre `rocWindowSeconds` (def. 60, 10–600) y comparada con el umbral; `rocDirection`: `any | rise | fall`.
- Banda muerta (`hysteresis`, ya existe) y retardos: `forSeconds` (activación, ya existe) y **`offDelaySeconds`** (retorno a normal, def. 0): la condición debe dejar de cumplirse este tiempo antes de normalizar.
- **Supresión por estado** `suppressWhen: {asset, metric, operator: 'eq'|'neq'|'gt'|'lt', value}`: mientras la condición se cumpla sobre el último dato del activo indicado (p. ej. bomba detenida: `{asset:'pump-01', metric:'rpm', operator:'lt', value:1}`), la alarma **no se genera** y se cuenta como suprimida.
- **Racionalización** (texto para el operador): `description` (≤200), `consequence` (≤300), `response` (≤300).
- Fuera de servicio: `enabled=false` exige `outOfServiceReason` (≥3 caracteres) y queda auditado (`rule.out_of_service`).

### 12.2 Ciclo de vida de una alarma

`AlarmEvent` y los registros REST ganan campos opcionales: `kind`, `lifecycle`, `rationale {description,consequence,response}`, `shelvedUntil`, `shelvedReason`. Se conserva `state: 'active'|'cleared'` (condición cumplida o no) y se añade `lifecycle`:

| `state` | `lifecycle` | Significado |
|---|---|---|
| active | `unacked` | activa, sin reconocer |
| active | `acked` | activa, reconocida |
| cleared | `rtn_unacked` | volvió a normal, **falta reconocer**: sigue en la lista |
| cleared | `closed` | volvió a normal y fue reconocida: sale de la lista |
| active | `shelved` | postergada con motivo y vencimiento: no cuenta ni se muestra como activa |

- Reconocer una `rtn_unacked` la cierra. Reconocer una `unacked` la pasa a `acked`; si luego se normaliza, pasa a `closed` directamente.
- `GET /api/alarms?state=active` devuelve la **lista de alarmas** (lifecycle `unacked`, `acked`, `rtn_unacked`; no `shelved` ni `closed`); `?state=cleared` las `closed`; `?state=shelved` las postergadas.
- **Postergar:** `POST /api/alarms/:id/shelve {minutes: 1–480, reason ≥3}` (roles `engineer`, `admin`, `platform_admin`) y `POST /api/alarms/:id/unshelve`. Al vencer vuelve sola (la alarma se reanuncia si sigue activa). Auditado (`alarm.shelve|unshelve`).
- **Diario** (`alarm_events`: activación, reconocimiento, normalización, postergación, supresión, quién): `GET /api/alarms/:id/journal`.

### 12.3 Salud de alarmas (EEMUA 191 / ISA-18.2)

- Política por planta `AlarmPolicy {ratePerDay: 150, peak10min: 10, staleHours: 24}` (valores por defecto): `GET /api/plants/:plant/alarm-policy` (cualquier rol con acceso) y `PUT` (`admin`, `platform_admin`; validación de rangos; auditado). Los valores por defecto siguen las referencias habituales (≈150 por operador y día; ≤10 en los 10 minutos posteriores a una perturbación); pendiente de confirmar con el equipo.
- `GET /api/plants/:plant/alarm-kpis?window=24h|7d|30d` → `AlarmKpis`: `total`, `perDay`, `perHour`, `peak10min {count, at}`, `byPriority {critical, warning}`, `top` (10 reglas/activos más frecuentes), `chattering` (≥3 activaciones en 10 min), `stale` (activas más de `staleHours`), `shelved`, `suppressed`, `outOfService` y `status: 'ok'|'warning'|'critical'` (ok si cumple la política; warning hasta 1,5×; critical por encima).

### 12.4 Setpoints

`metadata.setpoints: {[métrica]: número finito}` en el activo (validado). La telemetría puede traer `<métrica>_sp` (setpoint informado por el controlador), que tiene prioridad. Semillas de `demo`/`tanques`: SP de nivel 60 % en tanques, de temperatura 20 °C en clima, de presión 6 bar en `pres-01`.

### 12.5 Web (7a/7b)

- **Barra de desviación** centrada en el SP, con extremos en los límites de alarma más cercanos (LL/HH); color por estado: neutro en rango, **ámbar al llegar al 90 % de la distancia SP→límite**, rojo en alarma; sin SP se mantiene la barra de rango actual.
- **Tendencia a un clic:** cualquier tarjeta (nivel 2) o fila abre un panel (lateral en escritorio, hoja inferior en móvil) con la curva de la métrica, las líneas de SP y límites, y ventanas 15 min / 1 h / 6 h / 24 h (API de histórico; búfer en vivo en el demo).
- **Pie global de alarmas:** cuenta por ciclo de vida (sin reconocer, normalizadas sin reconocer, postergadas) y las 3 más importantes con **tag/activo, descripción, valor y límite**.
- **Lista de alarmas** (`/alarmas`): pestañas Activas · Postergadas · Historial; columnas tag/activo, descripción, valor, límite, tipo (HH/HI/…), prioridad, tiempo; acciones Reconocer (una o todas las visibles), Postergar (diálogo con minutos y motivo) y detalle con racionalización (consecuencia y acción) y diario.
- **Salud de alarmas** (`/alarmas/salud`): indicadores contra la política (tasa por día, pico de 10 min), top 10, alarmas intermitentes, estancadas, postergadas y suprimidas; ventana 24 h / 7 d / 30 d.
- **Editor de reglas:** tipo (HH/HI/LO/LL/DEV/ROC) con campos dependientes, banda muerta, retardos, ventana y dirección de ROC, condición de supresión, racionalización y "fuera de servicio" con motivo.
- **Vista general de la planta (nivel 1)** en `/`: KPIs de alto nivel y alertas agregadas por módulo, **sin valores de instrumentos**; con 3D si el cliente tiene `view3d` (paneles de vidrio sobre la escena) o mapa 2D de módulos si no.
