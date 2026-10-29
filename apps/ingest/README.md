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
| `MQTT_BROKER_URL` | `tcp://localhost:1883` | broker |
| `MQTT_TOPIC` | `campo/v1/+/+/telemetry` | filtro de suscripción |
| `MQTT_CLIENT_ID` | `campo-ingest` | único por réplica |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | vacío | credenciales opcionales |
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
go run ./cmd/simulator                   # planta `demo`: 4 tanques, 2 bombas, 2 válvulas a 1 Hz
go vet ./... && go test -race ./...      # tests; no requieren Docker (miniredis + broker MQTT embebido)
go test -bench . ./internal/parser       # benchmark del parser
docker build -t campo-ingest .           # imagen distroless con /ingest y /simulator
```

### Simulador

Flags (o env): `-broker`/`MQTT_BROKER_URL`, `-plant`/`SIM_PLANT`, `-tanks`/`SIM_TANKS`, `-pumps`/`SIM_PUMPS`,
`-valves`/`SIM_VALVES`, `-rate`/`SIM_RATE_HZ` (msg/s por activo), `-conns`/`SIM_CONNS`, `-qos`/`SIM_QOS`,
`-duration`, `-excursion-every` (media por activo, `0` desactiva), `-seed`.

Excursiones que cruzan umbrales típicos: `level` > 90 ó < 10, `temp` > 35, `current` > 18, `position` > 95.

Prueba de carga de ~5000 msg/s:

```bash
go run ./cmd/simulator -tanks 2000 -pumps 2000 -valves 1000 -rate 1 -conns 4
```
