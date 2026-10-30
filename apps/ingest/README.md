# ingest — servicio de ingesta (Go)

MQTT `campo/v1/+/+/telemetry` → Redis (en vivo) y TimescaleDB (histórico por lotes).
Contratos en `docs/architecture.md`.

```
handler MQTT ─▶ cola acotada ─▶ workers ─┬─▶ Redis: HSET campo:state:{plant} + PUBLISH campo:events:{plant} (pipeline)
 (sólo encola)    (LIVE_QUEUE_SIZE)      └─▶ Batcher ─▶ COPY telemetry (BATCH_SIZE filas o FLUSH_INTERVAL)
```

La ruta en vivo nunca espera al histórico: si la cola del batcher se llena, se descarta histórico
(`ingest_history_rows_dropped_total{reason="queue_full"}`). Si Postgres cae, los lotes se
reintentan con backoff mientras la cola absorbe el pico.

## Variables de entorno

| Variable | Defecto | Descripción |
|---|---|---|
| `MQTT_BROKER_URL` | `tcp://localhost:1883` | broker; `ssl://host:8883` para TLS |
| `MQTT_TOPIC` | `campo/v1/+/+/telemetry` | filtro de suscripción |
| `MQTT_CLIENT_ID` | `campo-ingest` | único por réplica |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | vacío | credenciales del broker (el usuario `ingest` en el despliegue seguro). La contraseña nunca se registra |
| `MQTT_CA_FILE` | vacío | CA propia (PEM) con la que verificar el certificado del broker. Sólo con `ssl://`; vacío = raíces del sistema |
| `MQTT_QOS` / `MQTT_CLEAN_SESSION` | `1` / `false` | sesión persistente retiene QoS 1 mientras estamos caídos |
| `REDIS_URL` | `redis://localhost:6379/0` | |
| `DATABASE_URL` | `postgres://campo:campo_dev@localhost:5432/campo?sslmode=disable` | vacío = histórico deshabilitado |
| `INGEST_WORKERS` | `2 × CPU` | workers de la ruta en vivo |
| `LIVE_QUEUE_SIZE` | `50000` | mensajes pendientes antes de descartar |
| `HISTORY_QUEUE_SIZE` | `100000` | lecturas pendientes para el batcher |
| `BATCH_SIZE` | `5000` | filas por COPY |
| `FLUSH_INTERVAL` | `1s` | flush aunque el lote no esté lleno |
| `HISTORY_MAX_RETRIES` | `10` | reintentos por lote (backoff 200 ms → 5 s) antes de descartarlo |
| `HISTORY_RETRY_BASE` / `HISTORY_WRITE_TIMEOUT` | `200ms` / `10s` | |
| `REDIS_TIMEOUT` | `2s` | timeout por lote hacia Redis |
| `HTTP_ADDR` | `:8080` | `/healthz`, `/readyz`, `/metrics` |
| `SHUTDOWN_TIMEOUT` | `20s` | tiempo máximo del cierre ordenado (SIGTERM) |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | `json` o `text` |

Arranque tolerante: MQTT, Redis y Postgres pueden estar caídos al iniciar; se reintenta sin matar el proceso.
`/readyz` devuelve 503 mientras falte MQTT (conexión + suscripción) o Redis. Postgres no afecta la readiness.

## Métricas (`/metrics`)

`ingest_messages_received_total`, `ingest_dropped_total{reason}` (`bad_topic`, `bad_json`, `bad_quality`,
`no_valid_values`, `payload_too_large`, `live_queue_full`, `shutting_down`), `ingest_values_discarded_total`,
`ingest_redis_latency_seconds`, `ingest_redis_errors_total`, `ingest_queue_length{queue="live|history"}`,
`ingest_rows_written_total`, `ingest_history_rows_dropped_total{reason}`, `ingest_batch_errors_total`,
`ingest_batch_write_seconds`.

## Correr

```bash
go run ./cmd/ingest                      # con docker compose levantado en la raíz (mosquitto, redis, timescaledb)
go run ./cmd/simulator                   # plantas `demo` (20 activos) y `tanques` (2) a 1 Hz
go vet ./... && go test -race ./...      # tests; no requieren Docker (miniredis + broker MQTT embebido)
go test -bench . ./internal/parser       # benchmark del parser
docker build -t campo-ingest .           # imagen distroless con /ingest y /simulator
```

## MQTT con TLS y credenciales (despliegue seguro)

Contrato: `docs/architecture.md` §8.2; guía operativa: `docs/security.md`.

```bash
MQTT_BROKER_URL=ssl://mosquitto:8883 MQTT_USERNAME=ingest MQTT_PASSWORD=... MQTT_CA_FILE=/certs/ca.crt ./ingest
```

- TLS **mínimo 1.2** y verificación del certificado (cadena **y** nombre/SAN del host de la URL) **siempre activa**.
  No existe ninguna opción para desactivarla (a propósito: no hay `INSECURE_SKIP_VERIFY`).
- Con `MQTT_CA_FILE` sólo se confía en esa CA (CA propia); sin él, en las raíces del sistema (certificados públicos).
  `MQTT_CA_FILE` con una URL en claro (`tcp://`) es un error de configuración y el servicio no arranca.
- Credenciales con `tcp://` (sin TLS) arrancan pero emiten un aviso: viajarían en claro.
- Ni la contraseña ni los datos de usuario incrustados en URLs (`scheme://user:pass@host`) se escriben en logs;
  `Config` impresa con `%v` oculta secretos.
- `ingest healthcheck` consulta `/readyz` por loopback y sale con 0/1 (la imagen distroless no trae curl);
  lo usa el `healthcheck` de `docker-compose.prod.yml`.
- Tests: `internal/mqttsec` (tls.Config, validación, redacción) y `internal/mqttin/mqttin_tls_test.go`
  (broker mochi-mqtt embebido con TLS + usuarios + ACL equivalentes a `infra/mosquitto/config/acl.conf`:
  conexión válida, contraseña/anónimo/CA no confiable/host fuera del SAN rechazados, publicar fuera de la
  propia planta descartado).

### Simulador

Publica en `campo/v1/{planta}/{activo}/telemetry` (contrato §1) con números finitos y `quality` `good`
casi siempre. Modelos de dominio puros (`cmd/simulator/models*.go`), sin I/O y con semilla (`-seed`).

**Flags (o env)**: `-broker`/`MQTT_BROKER_URL`, `-ca-file`/`MQTT_CA_FILE`, `-plants`/`SIM_PLANTS`,
`-plant`/`SIM_PLANT`, `-username`/`MQTT_USERNAME`, `-password`/`MQTT_PASSWORD`,
`-passwords`/`MQTT_SIM_PASSWORDS`, `-tanks`/`SIM_TANKS`, `-pumps`/`SIM_PUMPS`, `-valves`/`SIM_VALVES`,
`-rate`/`SIM_RATE_HZ` (msg/s por activo, 1 por defecto), `-conns`/`SIM_CONNS` (conexiones **por planta**),
`-qos`/`SIM_QOS`, `-duration`/`SIM_DURATION`, `-excursion-every`/`SIM_EXCURSION_EVERY` (media por activo,
`0` desactiva), `-seed`, `-stats`.

**Plantas.** `-plants demo,tanques` (por defecto). `-plant` es el alias de **una** sola planta (compatibilidad).
Precedencia: flag `-plants` > flag `-plant` > env `SIM_PLANTS` > env `SIM_PLANT` > `demo,tanques`
(un flag explícito siempre gana al entorno). Los ids deben cumplir `^[a-z0-9][a-z0-9_-]{0,63}$` y no repetirse.

| Planta | Activos (tipo: métricas) |
|---|---|
| `demo` | `tk-01..04` (tank: `level`, `temp`), `pump-01..02` (pump: `rpm`, `current`), `valve-01..02` (valve: `position`), `clima-01`, `clima-02` (climate: `temp` °C con ciclo diario, `humidity` % anticorrelada, 35-80), `en-linea1` (~120-180 kW), `en-compresores` (~80-110), `en-clima` (~50-70), `en-calderas` (~60-95 con picos) (energy: `kw`, `kwh` contador acumulado, `pf` 0,88-0,98), `gas-01` (gas: `flow` 0-30 m³/h a escalones, `total` m³ contador), `maq-01..03` (machine: `state` 0/1, cambios cada varios minutos), `pres-01` (pressure: `pressure` 4-7 bar, con excursiones > 8), `cau-01` (flow: `flow` 5-40 m³/h) |
| `tanques` | `tk-a`, `tk-b` (tank: `level`, `temp`) |
| cualquier otra | solo `tk-NN`, `pump-NN`, `valve-NN` (comportamiento histórico de `-plant <id>`) |

Los contadores `kwh` y `total` integran `kw`/`flow` con el tiempo real transcurrido y nunca decrecen
durante la ejecución (arrancan en un valor inicial plausible, no persistido: al reiniciar el simulador
vuelven a empezar). Excursiones que cruzan umbrales típicos: `level` > 90 ó < 10, `temp` > 35 (tanques),
`current` > 18, `position` > 95, `pressure` > 8.

**Carga.** `-tanks/-pumps/-valves` escalan solo los activos heredados `tk-NN/pump-NN/valve-NN` de `demo` (y de
las plantas sin perfil propio); `demo` publica además siempre sus 12 activos nuevos y `tanques` siempre
`tk-a`/`tk-b`. `-rate` es por activo y `-conns` por planta (cada planta tiene sus propias conexiones).
Para una prueba de carga conviene `-plants demo`.

**Credenciales MQTT.** Cada planta es una identidad distinta (usuario = id de planta, §8.2) con **su propia
conexión**:

- Una planta: como siempre, `-username` y `MQTT_PASSWORD`/`-password` (si solo se da `-passwords`, el usuario
  es la planta).
- Varias plantas: `-passwords demo=xxx,tanques=yyy` o `MQTT_SIM_PASSWORDS` (mismo formato; `-passwords`
  manda sobre el env). Cada planta publica con `usuario = su id` y su contraseña. Si falta la de alguna
  planta, sobra una de una planta no simulada, o se usa `-username`/`-password` con varias plantas, el
  simulador **no arranca** (error de configuración): jamás publica una planta con credenciales de otra.
  Sin ninguna credencial, todas conectan en anónimo (broker de desarrollo).
- Las contraseñas no pueden contener comas. Nunca se escriben en logs, en mensajes de error ni en `-h`; usa el
  env en vez de flags (los argumentos son visibles en `ps`).

```bash
go run ./cmd/simulator                                        # demo + tanques, broker de desarrollo
go run ./cmd/simulator -plants demo -rate 2                   # solo demo
MQTT_SIM_PASSWORDS=demo=...,tanques=... go run ./cmd/simulator -broker ssl://localhost:8883 -ca-file secrets/certs/ca.crt
MQTT_PASSWORD=... go run ./cmd/simulator -broker ssl://localhost:8883 -ca-file secrets/certs/ca.crt -username demo -plant demo
```

Prueba de carga de ~5000 msg/s:

```bash
go run ./cmd/simulator -plants demo -tanks 2000 -pumps 2000 -valves 1000 -rate 1 -conns 4
```
