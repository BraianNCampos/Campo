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
| `GET /health`, `GET /ready` | sondas |

Roles: `admin`, `engineer`, `operator`, `viewer`.

## 5. WebSocket (`/ws?plant={plant}&token={jwt}`)

WebSocket nativo (librería `ws`), mensajes JSON, un tipo discriminado `ServerMessage`:

1. Al conectar: `{type:"snapshot", plant, assets:{[asset]:{ts,values,quality}}}`
2. Luego: `{type:"telemetry", ...}` y `{type:"alarm", ...}` en tiempo real.
3. El servidor agrupa telemetría en ventanas de ~100 ms por activo (coalescing: solo el último valor) para no saturar al cliente móvil.
4. Ping/pong cada 25 s. El cliente reconecta con backoff exponencial y vuelve a recibir `snapshot`.

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
