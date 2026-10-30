# Campo 2.0

Plataforma SCADA moderno para plantas agroindustriales: gemelo digital 3D en tiempo real, ingesta de baja latencia y una UI móvil pensada para operar desde el campo.

| Escritorio | Móvil |
|---|---|
| ![Escritorio](docs/img/desktop.png) | ![Móvil](docs/img/mobile.png) |

## Arquitectura

```
sensor ─MQTT→ Mosquitto → ingest (Go) ─┬─ Redis   (estado actual + pub/sub)
                                        └─ TimescaleDB (histórico, por lotes)
                         api (NestJS) ← Redis → alarmas + WebSocket → web (Next.js, R3F, PWA)
```

La ruta caliente (sensor → pantalla) no pasa por la base de datos. Contratos completos en [`docs/architecture.md`](docs/architecture.md).

```
apps/
  ingest/     Go: MQTT → Redis / TimescaleDB, métricas Prometheus, simulador de planta
  api/        NestJS: auth y roles, histórico, motor de alarmas, WebSocket
  web/        Next.js + React Three Fiber + Zustand + Tailwind, PWA
packages/shared/   tipos compartidos (contratos)
infra/             Mosquitto y esquema de TimescaleDB
docs/              arquitectura
```

## Puesta en marcha

Requiere Docker. Todo el stack, con datos simulados:

```bash
cp .env.example .env        # edita JWT_SECRET y ADMIN_PASSWORD
docker compose --profile apps --profile sim up -d --build
```

- Web: <http://localhost:3000> (usuario `ADMIN_EMAIL` / `ADMIN_PASSWORD` del `.env`)
- API: <http://localhost:3001> · métricas de ingesta: <http://localhost:8080/metrics>

Solo infraestructura (TimescaleDB `:5432`, Redis `:6379`, Mosquitto `:1883`), para desarrollar cada app a mano:

```bash
docker compose up -d
```

Cada app tiene su propio README con variables y scripts. La web funciona sola en **modo demo** (sin backend) con `cd apps/web && npm i && npm run dev`.

## Despliegue seguro

El compose base es solo para desarrollo (credenciales de ejemplo, puertos en loopback, MQTT sin TLS). Para un entorno real hay un overlay endurecido: MQTT autenticado con TLS y permisos por planta, Redis con contraseña, bases de datos sin puertos publicados y Caddy como única entrada HTTPS.

```bash
scripts/bootstrap-secure.sh        # genera secretos, CA y certificados -> .env.prod y secrets/ (nunca se versionan)
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod --profile apps up -d --build
```

Guía completa, modelo de amenazas y rotación de credenciales en [`docs/security.md`](docs/security.md).

## Pruebas

```bash
(cd apps/ingest && go vet ./... && go test -race ./...)
(cd apps/api && npm ci && npm run lint && npm test && npm run test:e2e)
(cd apps/web && npm ci && npm run lint && npm test)
```

El CI (`.github/workflows/ci.yml`) ejecuta lo mismo en cada push.

## Estado y límites conocidos

Verificado de punta a punta con Docker y TimescaleDB real: simulador → MQTT → ingesta → Redis/TimescaleDB → API → WebSocket → navegador. Eso incluye el histórico con `time_bucket`, el agregado continuo `telemetry_1m` (coincide con la tabla cruda), consultas y escrituras sobre chunks comprimidos, y las tres imágenes construidas con sus Dockerfiles. La prueba es repetible y el CI la ejecuta en cada push:

```bash
docker compose --profile apps --profile sim up -d --build
scripts/smoke.sh
```

Pendiente de verificar con carga real: el rendimiento de la web en una GPU física (solo se midió con render por software) y el comportamiento con muchas más plantas y activos.

Administración desde la web (`/admin`): usuarios y asignación de plantas, plantas y activos (con su modelo 3D, posición y conexiones), modelos 3D, reglas de alarma, auditoría de cambios y cambio de contraseña propio. Cada acción de administración queda en un registro de auditoría de solo lectura (nunca guarda contraseñas ni tokens).

Seguridad ya implementada: acceso por planta (REST y WebSocket) con revocación en ≤30 s, MQTT autenticado con TLS y ACL por planta, secretos obligatorios en producción y proxy HTTPS con cabeceras de seguridad. El CI verifica la pila endurecida (`scripts/smoke-secure.sh`, 80 comprobaciones, incluidos los límites de subida de modelos a través de Caddy).

Límites conocidos:

- Ingesta: no escala a varias réplicas con el mismo `MQTT_CLIENT_ID` (haría falta suscripción compartida). Un corte de Postgres de más de ~30 s pierde esa porción del histórico.
- API: el motor de alarmas corre en memoria; con varias réplicas, activarlo en una sola (`ALARM_ENGINE_ENABLED=false` en el resto). Un WebSocket abierto sobrevive a la expiración de su token (solo se corta al revocar el acceso, cambiar la contraseña o desactivar al usuario).
- Seguridad: sin mTLS por dispositivo, sin rotación automática de credenciales ni WAF, y sin TLS en el tráfico interno hacia Postgres. La CSP mantiene `'unsafe-inline'` porque Next.js inyecta scripts sin nonce.
- Web: la lista en vivo y el 3D se construyen desde el catálogo (un activo sin telemetría aparece como "Sin datos" y el resto de la UI se actualiza sola cuando alguien cambia el catálogo). Los modelos 3D son GLB autocontenidos de hasta 10 MB (sin Draco ni meshopt) y se animan con datos en vivo mediante nodos con nombres convencionales (`campo_level`, `campo_rotor`, `campo_gate`; ver `docs/architecture.md` §10.2 y `examples/models/`). Las tuberías de una planta nueva se definen con `connectsTo` y se trazan en ángulos rectos aproximados, sin conocer los puertos reales del modelo. Las variables `NEXT_PUBLIC_*` se fijan en el build.
- Modelos: sin cuota por planta ni límite de subidas simultáneas; un modelo descargado queda un año en la caché del navegador.

## Siguientes pasos sugeridos

1. Comandos hacia los equipos (`campo/v1/{planta}/{activo}/cmd`) con confirmación y auditoría; los permisos MQTT por planta y el registro de auditoría ya están preparados.
2. Histórico y alarmas en la web: curvas históricas con rangos largos y una vista de alarmas cerradas (la API ya las sirve).
3. Escalado horizontal: suscripción compartida MQTT y un único evaluador de alarmas elegido por elección de líder.
4. Editor 3D directo (arrastrar activos y trazar tuberías sobre la escena) en lugar de coordenadas numéricas.
