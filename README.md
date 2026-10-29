# Campo 2.0

Plataforma SCADA moderno para plantas agroindustriales: gemelo digital 3D, ingesta de baja latencia y UI móvil.

## Estructura del monorepo

```
campo/
├── apps/
│   ├── web/        # Next.js + React Three Fiber + Zustand + Tailwind (PWA)   [pendiente]
│   ├── api/        # NestJS: usuarios, roles, reglas de alarma, config, WS    [pendiente]
│   └── ingest/     # Go: ingesta MQTT -> Redis / TimescaleDB
│       └── cmd/ingest/main.go
├── packages/
│   └── shared/     # Tipos TS compartidos (contratos de tópicos y eventos)    [pendiente]
├── infra/
│   └── mosquitto/config/mosquitto.conf
├── docs/           # ADRs y documentación
├── docker-compose.yml
└── .env.example
```

Flujo de datos previsto:
`sensor → MQTT (Mosquitto) → ingest (Go) → Redis (estado actual + pub/sub) + TimescaleDB (histórico) → api (NestJS, WebSocket) → web`

## Puesta en marcha (Fase 1)

```bash
cp .env.example .env
docker compose up -d
docker compose ps        # los 3 servicios deben quedar "healthy"
```

Servicios locales: TimescaleDB `:5432`, Redis `:6379`, Mosquitto `:1883` (MQTT) y `:9001` (WebSocket).

Cliente MQTT de prueba (requiere Go 1.24+):

```bash
cd apps/ingest
go run ./cmd/ingest
```

En otra terminal, publica un dato:

```bash
docker compose exec mosquitto mosquitto_pub -t campo/test -q 1 -m '{"sensor":"tk-01","level":72.5}'
```

Variables del servicio: `MQTT_BROKER_URL` (def. `tcp://localhost:1883`), `MQTT_TOPIC` (def. `campo/test`), `MQTT_CLIENT_ID`.

> La configuración de Mosquitto es solo para desarrollo (anónimo, sin TLS).
