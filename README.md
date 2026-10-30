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

## Clientes y módulos

Campo se entrega a **clientes**, cada uno con su espacio y solo los **módulos** que contrató (Tanques y llenado, Temperatura y humedad, Energía, Consumo de gases, Estado de máquinas, Presión y caudal, Vista 3D). Si un cliente solo mide tanques, solo ve tanques; sumar un módulo es un interruptor en **Administración → Clientes** y conectar los sensores.

- **Personal de Campos Ingeniería** (`platform_admin`, sembrado con `ADMIN_EMAIL`/`ADMIN_PASSWORD`): crea clientes, activa módulos y crea el primer administrador de cada uno.
- **Administrador del cliente** (`admin`): gestiona usuarios, plantas, activos y reglas **de su cliente**. Un cliente jamás ve, modifica ni puede adivinar la existencia de recursos de otro: todo se filtra en el servidor y lo ajeno responde el mismo 403 que una planta inexistente.
- **Pantallas por módulo** con resumen, tarjetas con barra de rango y límites, tendencia y filtro "Requieren atención"; **plantilla maestra** con cabecera, navegación y pie global de alarmas; **Modo pared** para TVs de planta; modo de **alto contraste** para luz solar.
- **Demo:** la web sin backend incluye dos clientes de ejemplo y un selector "Ver como" para ver la adaptación (cliente con todos los módulos, cliente solo tanques, personal de plataforma).

Administración desde la web (`/admin`): clientes y módulos, usuarios y asignación de plantas, plantas y activos (con su modelo 3D, posición y conexiones), modelos 3D, reglas de alarma, auditoría de cambios y cambio de contraseña propio. Cada acción de administración queda en un registro de auditoría de solo lectura (nunca guarda contraseñas ni tokens).

Seguridad ya implementada: **aislamiento entre clientes** (matriz de 215 casos que corre en cada cambio), acceso por planta (REST y WebSocket) con revocación en ≤30 s, MQTT autenticado con TLS y ACL por planta, secretos obligatorios en producción y proxy HTTPS con cabeceras de seguridad. El CI verifica la pila endurecida (`scripts/smoke-secure.sh`, 80 comprobaciones) y el aislamiento entre clientes contra Postgres real (`scripts/smoke.sh`).

Límites conocidos:

- Ingesta: no escala a varias réplicas con el mismo `MQTT_CLIENT_ID` (haría falta suscripción compartida). Un corte de Postgres de más de ~30 s pierde esa porción del histórico.
- API: el motor de alarmas corre en memoria; con varias réplicas, activarlo en una sola (`ALARM_ENGINE_ENABLED=false` en el resto). Un WebSocket abierto sobrevive a la expiración de su token (solo se corta al revocar el acceso, cambiar la contraseña o desactivar al usuario).
- Seguridad: sin mTLS por dispositivo, sin rotación automática de credenciales ni WAF, y sin TLS en el tráfico interno hacia Postgres. La CSP mantiene `'unsafe-inline'` porque Next.js inyecta scripts sin nonce.
- Web: la lista en vivo y el 3D se construyen desde el catálogo (un activo sin telemetría aparece como "Sin datos" y el resto de la UI se actualiza sola cuando alguien cambia el catálogo). Los modelos 3D son GLB autocontenidos de hasta 10 MB (sin Draco ni meshopt) y se animan con datos en vivo mediante nodos con nombres convencionales (`campo_level`, `campo_rotor`, `campo_gate`; ver `docs/architecture.md` §10.2 y `examples/models/`). Las tuberías de una planta nueva se definen con `connectsTo` y se trazan en ángulos rectos aproximados, sin conocer los puertos reales del modelo. Las variables `NEXT_PUBLIC_*` se fijan en el build.
- Modelos: sin cuota por planta ni límite de subidas simultáneas; un modelo descargado queda un año en la caché del navegador.

## Siguientes pasos

El plan de rediseño según ISA-101 / ISA-18.2 (niveles de pantalla, indicadores de desviación, gestión de alarmas, tags estándar, 3D realista y alto contraste) está en [`docs/ux-isa.md`](docs/ux-isa.md):

1. **7a** — niveles 1 y 2: vista general de la planta, indicadores de desviación respecto del setpoint y tendencia a un clic.
2. **7b** — gestión de alarmas ISA-18.2: tipos HH/HI/LO/LL/DEV/ROC, ciclo de vida, shelving, supresión por estado y métricas.
3. **7c** — 3D realista con contornos brillantes y medición de latencia extremo a extremo.
4. **7d** — tags estándar (`TNK-101`…), niveles 3 y 4, y comandos hacia los equipos con confirmación y auditoría.

Pendientes aparte: histórico y alarmas cerradas en la web, escalado horizontal (suscripción compartida MQTT y un único evaluador de alarmas) y un editor 3D directo.
