# Seguridad y despliegue endurecido — Campo 2.0

Guía operativa de lo definido en `docs/architecture.md` §8.2 (MQTT con TLS) y §8.3 (despliegue endurecido).
La autorización por planta de la API (§8.1) se documenta en el contrato y en `apps/api`.

Ficheros: `docker-compose.prod.yml` (se superpone al compose base), `infra/mosquitto/config/mosquitto.secure.conf` y
`acl.conf`, `infra/caddy/Caddyfile`, `scripts/bootstrap-secure.sh`, `scripts/smoke-secure.sh`, `.env.prod.example`.
El desarrollo local sigue funcionando sin TLS con `docker-compose.yml` tal cual.

## 1. Modelo de amenazas (breve)

Activos: la telemetría de las plantas (integridad y disponibilidad: un valor falso puede disparar o ocultar una
alarma), las credenciales de acceso al panel, los comandos hacia campo (reservados, Fase 3) y el histórico.

| Amenaza | Mitigación | Dónde |
|---|---|---|
| Escucha o manipulación del tráfico sensor → nube | MQTT sólo por TLS (8883, TLS ≥ 1.2); el cliente verifica cadena y nombre del certificado, sin opción de saltarse la verificación | Mosquitto, `ingest`, simulador |
| Cliente anónimo o con credenciales robadas de otra planta publica datos falsos | Sin acceso anónimo; un usuario por planta; ACL `pattern write campo/v1/%u/+/telemetry` | `mosquitto.secure.conf`, `acl.conf` |
| Una planta espía a otra | Los usuarios de planta no pueden suscribirse a telemetría (sólo a su `.../cmd`); `ingest` es de sólo lectura | `acl.conf` |
| Acceso directo a Redis o Postgres desde fuera | Sin puertos publicados; red `backend` interna; Redis con contraseña y Postgres con contraseña (scram) | `docker-compose.prod.yml` |
| Acceso a la API sin permiso o a otra planta | JWT + guard por planta (§8.1); 401 sin token | `apps/api` |
| Intercepción del tráfico web, clickjacking, XSS | HTTPS (Caddy), HSTS, CSP, `X-Frame-Options`/`frame-ancestors`, `nosniff`, `Referrer-Policy` | `Caddyfile` |
| Fuerza bruta de login | Límite de intentos en la API (`LOGIN_RATE_LIMIT`); `TRUST_PROXY=true` para que cuente por IP real | `apps/api`, compose |
| Secretos por defecto / de ejemplo | Contraseñas aleatorias generadas; `${VAR:?}` sin valores por defecto; la API se niega a arrancar en producción con secretos de ejemplo | bootstrap, compose |
| Compromiso de un contenedor | `read_only`, `cap_drop: ALL`, `no-new-privileges`, usuarios no root, redes separadas | compose |
| Filtración de secretos por logs o procesos | Las contraseñas no se registran (ingest/simulador); Redis recibe la suya por fichero tmpfs, no por argumentos; `passwd` de Mosquitto sólo con hashes | código, compose |

## 2. Qué protege cada capa

- **Borde MQTT.** Un único listener TLS 8883. No existen 1883 ni WebSocket (9001) en la config segura. `allow_anonymous false`,
  `password_file` (hashes), `acl_file`, `max_packet_size 65536`, `allow_zero_length_clientid false` (todo cliente debe
  indicar `client id`) y log de conexiones/fallos de autenticación. Usuarios: `ingest` (lee `campo/v1/#`), `healthcheck`
  (sólo `$SYS/broker/uptime`, para el healthcheck del contenedor) y uno por planta con el id de la planta como nombre.
  Los ids `ingest` y `healthcheck` están reservados. Las reglas `pattern` valen para todos los usuarios, también `ingest`
  (podría publicar en `campo/v1/ingest/...`, que no corresponde a ninguna planta real).
  El broker sólo acepta TLS ≥ 1.2: Mosquitto 2.1.2 rechaza TLS 1.0/1.1 por defecto (verificado en `smoke-secure.sh`);
  Mosquitto no ofrece un "mínimo" configurable sin fijar una versión única, así que con imágenes antiguas
  hay que revisarlo.
- **Ingesta y simulador.** TLS ≥ 1.2, verificación obligatoria (con `MQTT_CA_FILE` sólo se confía en esa CA).
  `MQTT_CA_FILE` con URL `tcp://` es error de configuración. Detalles en `apps/ingest/README.md`.
- **Redis y TimescaleDB.** Sin puertos en el host y en una red `internal` (sin salida a Internet). Sólo `api` e `ingest`
  están en esa red. El tráfico interno a Postgres va sin TLS (`sslmode=disable`) dentro de esa red.
- **Proxy (Caddy).** Única entrada HTTP(S): 80 redirige a 443; `/api/*` y `/ws` → api; el resto → web; la API
  (`/health`, `/ready`) no se expone. Cuerpo máximo de 1 MB en `/api`. CSP: `default-src 'self'`, `connect-src 'self' wss://<host>`,
  `worker-src 'self' blob:`, `img-src 'self' data: blob:`, `frame-ancestors 'none'`, `object-src 'none'`. Se permite
  `'unsafe-inline'` en scripts y estilos porque Next.js inyecta scripts de hidratación sin nonce (ver §6).
  Se probó en Chromium (Playwright) con la CSP activa: login, WebSocket `wss://`, canvas WebGL de three.js,
  service worker y datos en vivo funcionan sin violaciones de CSP.
- **Web same-origin.** Se construye con `NEXT_PUBLIC_API_URL` y `NEXT_PUBLIC_WS_URL` vacíos y `NEXT_PUBLIC_MOCK=0`; el cliente
  deriva `https://dominio` y `wss://dominio/ws`. Estas variables se incrustan en el **build**: cambiar de dominio no
  exige reconstruir (el origen se deriva en el navegador), pero sí hay que reconstruir la imagen si se partió de una
  construida con URLs absolutas.
- **Contenedores.** `read_only`, `cap_drop: ALL`, `no-new-privileges`, rotación de logs (10 MB × 3). Excepciones:
  a TimescaleDB se le conceden `CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID` (su entrypoint ajusta permisos del volumen
  y baja de root) y a Caddy `NET_BIND_SERVICE`. Mosquitto y Redis corren sin root.

## 3. Despliegue en 5 pasos

1. **Prerrequisitos**: Docker con Compose v2.24+ (usa `!reset`/`!override`), `openssl`, y puertos 80/443/8883 libres.
2. **Generar secretos y certificados**:
   ```bash
   scripts/bootstrap-secure.sh --plants demo,planta-norte \
       --hosts broker.midominio.com --domain campo.midominio.com --acme-email ops@midominio.com
   ```
   (`--hosts` añade nombres/IP al certificado del broker: los que usarán los dispositivos; sin `--domain`, Caddy usa su CA
   interna en `localhost`.) Muestra la contraseña inicial del admin **una sola vez**; todo queda en `.env.prod` (600) y
   `secrets/` (ambos ignorados por git). El script es idempotente.
3. **Levantar la pila**:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod --profile apps up -d --build
   ```
   (añade `--profile sim` para el simulador de la planta `demo`).
4. **Verificar**: `scripts/smoke-secure.sh` (necesita la pila arriba con `--profile sim`).
5. **Entregar credenciales y abrir el firewall**: a cada planta, sólo su `secrets/mqtt-users/<planta>.pass` y
   `secrets/certs/ca.crt` (con CA propia); publica 80, 443 y 8883 y nada más. Entra en `https://<dominio>` como admin y
   cambia la contraseña inicial. Con un dominio real, Caddy obtiene y renueva el certificado web solo (ACME);
   conserva el volumen `caddy_data`.

Un dispositivo se conecta así (ejemplo con las herramientas de Mosquitto):
`mosquitto_pub -h broker.midominio.com -p 8883 --cafile ca.crt -i <client-id-único> -u planta-norte -P <contraseña> -t campo/v1/planta-norte/tk-01/telemetry -m '{...}'`

## 4. Operación

**Rotar credenciales** (MQTT, Redis, `JWT_SECRET`, Postgres):
```bash
scripts/bootstrap-secure.sh --rotate
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod --profile apps up -d --force-recreate
```
- Regenera `passwd` de Mosquitto y las contraseñas de `ingest`, `healthcheck` y todas las plantas: hay que **entregar
  las nuevas** de `secrets/mqtt-users/` a los dispositivos (las antiguas dejan de valer al recrear Mosquitto).
- Postgres: la contraseña vive en el volumen, así que sólo se rota si el contenedor `campo-timescaledb` está en marcha
  (el script aplica `ALTER ROLE`); si está parado se conserva y el script lo avisa.
- `JWT_SECRET` nuevo cierra todas las sesiones. La contraseña del admin **no** se rota aquí: `ADMIN_PASSWORD` sólo siembra
  la primera vez; después se cambia con `PATCH /api/users/:id`.

**Certificados del broker**:
- `scripts/bootstrap-secure.sh --rotate-certs` reemite el certificado del servidor con la misma CA (los clientes no cambian
  nada) y reinicia Mosquitto (`docker compose ... restart mosquitto`). Si faltan < 30 días o cambian los SAN
  (`--hosts`), **cualquier ejecución normal del script lo reemite sola**: conviene ejecutarlo periódicamente (cron).
- `--rotate-ca` crea una CA nueva (10 años): hay que redistribuir `ca.crt` a ingest, simuladores y dispositivos.
  Guarda `secrets/certs/ca.key` fuera de línea cuando no emitas certificados.
- Los SAN existentes se conservan al añadir `--hosts`; para quitar uno, edita `secrets/certs/server.san` y usa `--rotate-certs`.
- Certificado web: lo gestiona Caddy (ACME) o su CA interna; no hay nada que rotar a mano.

**Añadir o quitar plantas**: `scripts/bootstrap-secure.sh --plants nueva` (aditivo; reconstruye `passwd`; no cambia las
demás contraseñas) y `docker compose ... restart mosquitto`. Para quitar una, borra `secrets/mqtt-users/<planta>.pass` y
ejecuta el script de nuevo.

**Permisos**: el contenedor de Mosquitto corre como uid 1883 y debe poder leer `passwd`, `server.key` y `healthcheck.pw`.
Como root, el script les pone dueño 1883 y modo 600. Sin root los deja en 0644 dentro de directorios 0700 (nadie más del
host llega a ellos; probado que el contenedor los lee igualmente) y avisa de cómo endurecerlo con `sudo chown`.

## 5. Qué falta (límites conocidos)

- **Rotación automática**: la rotación es manual (script); no hay caducidad de contraseñas, ni integración con un gestor
  de secretos (Vault, Docker/Kubernetes secrets, SOPS). Los secretos viven en `.env.prod` y `secrets/` en disco.
- **mTLS por dispositivo**: hoy la identidad es usuario/contraseña por **planta** (compartida por sus dispositivos). Un
  dispositivo comprometido compromete su planta hasta rotar la contraseña. Mejora: certificado de cliente por
  dispositivo (`require_certificate true`, `use_identity_as_username`), con CRL/revocación.
- **WAF y anti-abuso en el borde**: Caddy no incluye WAF ni límite de peticiones global (sólo el límite de login de la
  API); habría que añadir un módulo (rate-limit/Coraza) o un proxy/CDN delante. No hay límite de conexiones MQTT por IP.
- **CSP con `'unsafe-inline'`**: una CSP estricta con nonces exige un middleware de Next.js en `apps/web`.
- **Rechazo silencioso de ACL**: con MQTT 3.1.1, Mosquitto confirma (PUBACK) un publish no autorizado y lo descarta; el
  dispositivo no se entera. Sólo se ve en métricas/logs del broker.
- **Postgres interno sin TLS**, imágenes con etiquetas móviles (`latest`, `2`, `7-alpine`) sin fijar por digest ni escáner de
  vulnerabilidades, sin límites de memoria/CPU por contenedor, sin copias de seguridad cifradas, sin alertas sobre fallos de autenticación.
- **Sesiones**: un WebSocket abierto sobrevive a la expiración de su JWT (solo se corta al revocar el acceso, cambiar la contraseña, desactivar al usuario o revocar sus sesiones). Cambiar la contraseña, desactivar o revocar sube `token_version` y deja inservibles los tokens previos. Mejora: refresh tokens de corta vida.
- **Auditoría**: las acciones de administración se registran en `audit_log` (solo lectura por API, solo admin), pero de forma *best effort* y sin firma ni envío a un sistema externo inmutable.
- **Disponibilidad**: un único broker, Redis y Postgres (sin réplicas); un fallo derriba el servicio.
- **Endurecimiento del host** (firewall, actualizaciones, acceso SSH, daemon de Docker) queda fuera de este repositorio.

## 6. Verificación

`scripts/smoke-secure.sh` comprueba contra la pila real: MQTT anónimo y contraseña incorrecta rechazados; el usuario de
planta no publica fuera de su planta ni en `cmd` ni lee telemetría ajena; `ingest` no puede publicar; MQTT sin TLS contra 8883
falla y 1883/9001 están cerrados; TLS 1.0/1.1 rechazados y 1.2/1.3 aceptados; Postgres y Redis no accesibles desde el host y
con contraseña desde la red interna; sólo 80/443/8883 publicados; contenedores endurecidos; compose se niega a arrancar sin
contraseñas; HTTPS por Caddy con la CA interna, HTTP → HTTPS, cabeceras de seguridad, `/api/plants/demo/state` sin token → 401;
y el flujo completo simulador → ingest → Redis/TimescaleDB → API (login admin, estado con 8 activos, snapshot por `wss://`).
Los tests Go (`go test -race ./...` en `apps/ingest`) cubren la configuración TLS del cliente y un broker embebido con TLS,
usuarios y ACL.
