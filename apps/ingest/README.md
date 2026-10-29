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
go run ./cmd/simulator                   # planta `demo`: 4 tanques, 2 bombas, 2 válvulas a 1 Hz
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

Flags (o env): `-broker`/`MQTT_BROKER_URL`, `-username`/`MQTT_USERNAME`, `-password`/`MQTT_PASSWORD`
(preferir el env: los argumentos de proceso son visibles en `ps`), `-ca-file`/`MQTT_CA_FILE`,
`-plant`/`SIM_PLANT`, `-tanks`/`SIM_TANKS`, `-pumps`/`SIM_PUMPS`,
`-valves`/`SIM_VALVES`, `-rate`/`SIM_RATE_HZ` (msg/s por activo), `-conns`/`SIM_CONNS`, `-qos`/`SIM_QOS`,
`-duration`, `-excursion-every` (media por activo, `0` desactiva), `-seed`.

En el broker seguro el usuario del simulador **es** el id de planta (sólo puede publicar en
`campo/v1/{plant}/+/telemetry`):

```bash
MQTT_PASSWORD=... go run ./cmd/simulator -broker ssl://localhost:8883 -ca-file secrets/certs/ca.crt -username demo -plant demo
```

Excursiones que cruzan umbrales típicos: `level` > 90 ó < 10, `temp` > 35, `current` > 18, `position` > 95.

Prueba de carga de ~5000 msg/s:

```bash
go run ./cmd/simulator -tanks 2000 -pumps 2000 -valves 1000 -rate 1 -conns 4
```
