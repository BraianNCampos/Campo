#!/usr/bin/env bash
# Prueba de humo de la pila ENDURECIDA (docker-compose.prod.yml): demuestra las garantías de seguridad
# (docs/architecture.md §8.2-8.3) y que el flujo de datos funciona con TLS + credenciales.
#
# Requisitos: pila levantada con
#   docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod --profile apps --profile sim up -d
# (el perfil `sim` pone el simulador publicando como el usuario `demo`), y `.env.prod` + `secrets/` de
# scripts/bootstrap-secure.sh. Los clientes MQTT de la prueba usan mosquitto_pub/sub locales si existen y, si no,
# un contenedor efímero eclipse-mosquitto:2 con `--network host` (Linux).
#
# Uso: scripts/smoke-secure.sh      (env opcionales: ENV_FILE, TIMEOUT, MOSQUITTO_IMAGE, SMOKE_HOST)
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=${ENV_FILE:-.env.prod}
[ -f "$ENV_FILE" ] || { echo "No existe $ENV_FILE: ejecuta scripts/bootstrap-secure.sh" >&2; exit 2; }
set -a; . "./$ENV_FILE"; set +a
TIMEOUT=${TIMEOUT:-180}
MOSQ_IMAGE=${MOSQUITTO_IMAGE:-eclipse-mosquitto:2}
SECRETS=${SECRETS_DIR:-./secrets}
CA=$SECRETS/certs/ca.crt
HOST=${SMOKE_HOST:-localhost}
MQTT_PORT=${MQTT_TLS_PORT:-8883}
DOMAIN=${CAMPO_DOMAIN:-localhost}
HTTPS_PORT=${CAMPO_HTTPS_PORT:-443}
HTTP_PORT=${CAMPO_HTTP_PORT:-80}
BASE=https://$DOMAIN$([ "$HTTPS_PORT" = 443 ] || echo ":$HTTPS_PORT")
PLANT=${MQTT_SIM_PLANT:-demo}
PLANT_PW=${MQTT_SIM_PASSWORD:?}
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
TMP=$(mktemp -d); trap 'docker rm -f smoke-sub >/dev/null 2>&1; rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31mFALLA\033[0m %s\n' "$*"; FAIL=$((FAIL + 1)); }
note() { printf '       %s\n' "$*"; }
# check "descripción" comando...   -> OK si el comando sale con 0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
# deny "descripción" comando...    -> OK si el comando FALLA
deny()  { local d=$1; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
wait_for() { local what=$1 t=0; shift; until "$@" >/dev/null 2>&1; do t=$((t + 3)); [ "$t" -ge "$TIMEOUT" ] && { bad "$what (timeout ${TIMEOUT}s)"; return 1; }; sleep 3; done; ok "$what"; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
# tcp_open host puerto  -> 0 si algo escucha
tcp_open() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# Cliente MQTT: mq mosquitto_pub|mosquitto_sub args...  (con la CA montada como /ca.crt si es contenedor)
if command -v mosquitto_pub >/dev/null 2>&1 && command -v mosquitto_sub >/dev/null 2>&1; then
  MQ_LOCAL=1; CAF=$CA
  mq() { "$@"; }
else
  MQ_LOCAL=0; CAF=/ca.crt
  mq() { local tool=$1; shift; docker run --rm --network host -v "$(cd "$(dirname "$CA")" && pwd)/$(basename "$CA"):/ca.crt:ro" --entrypoint "$tool" "$MOSQ_IMAGE" "$@"; }
fi
TLSARGS=(-h "$HOST" -p "$MQTT_PORT" --cafile "$CAF")

echo "Pila"
https_up() { curl -sk -o /dev/null --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "$BASE/"; }
ctr_healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "campo-$1" 2>/dev/null)" = healthy ]; }
wait_for "Caddy responde por HTTPS" https_up
for c in mosquitto redis timescaledb ingest api web caddy; do
  wait_for "contenedor campo-$c healthy" ctr_healthy "$c"
done

echo; echo "MQTT (a, b, c, d)"
# (a) anónimo rechazado
OUT=$(mq mosquitto_pub "${TLSARGS[@]}" -i smoke-anon -t "campo/v1/$PLANT/x/telemetry" -m "smoke" 2>&1); RC=$?
{ [ "$RC" != 0 ] && grep -qi "not authori" <<<"$OUT"; } && ok "(a) MQTT anónimo rechazado ('Connection Refused: not authorised')" || bad "(a) MQTT anónimo NO rechazado (rc=$RC): $OUT"

# (b) usuario válido con contraseña mala
OUT=$(mq mosquitto_pub "${TLSARGS[@]}" -i smoke-badpw -u "$PLANT" -P "contrasena-incorrecta" -t "campo/v1/$PLANT/x/telemetry" -m "smoke" 2>&1); RC=$?
{ [ "$RC" != 0 ] && grep -qi "not authori" <<<"$OUT"; } && ok "(b) usuario '$PLANT' con contraseña incorrecta rechazado" || bad "(b) contraseña incorrecta NO rechazada (rc=$RC): $OUT"
# y con la correcta conecta (control positivo)
OUT=$(mq mosquitto_pub "${TLSARGS[@]}" -i smoke-ctl -u "$PLANT" -P "$PLANT_PW" -t "campo/v1/$PLANT/x/telemetry" -m "smoke-control" 2>&1); RC=$?
[ "$RC" = 0 ] && ok "(b+) usuario '$PLANT' con su contraseña conecta y publica en su planta" || bad "(b+) credenciales válidas fallan (rc=$RC): $OUT"

# (c) ACL: un suscriptor `ingest` ve lo permitido y NO ve lo denegado
docker rm -f smoke-sub >/dev/null 2>&1
if [ "$MQ_LOCAL" = 1 ]; then
  mosquitto_sub "${TLSARGS[@]}" -i smoke-sub -u ingest -P "$MQTT_INGEST_PASSWORD" -t 'campo/v1/+/x/telemetry' -t 'campo/v1/+/x/cmd' -v -W 25 > "$TMP/sub.out" 2>&1 &
  SUBPID=$!
else
  docker run -d --name smoke-sub --network host -v "$(cd "$(dirname "$CA")" && pwd)/$(basename "$CA"):/ca.crt:ro" --entrypoint mosquitto_sub "$MOSQ_IMAGE" \
    "${TLSARGS[@]}" -i smoke-sub -u ingest -P "$MQTT_INGEST_PASSWORD" -t 'campo/v1/+/x/telemetry' -t 'campo/v1/+/x/cmd' -v -W 25 >/dev/null
fi
sleep 2
# Los payloads NO son JSON válido a propósito: si llegaran a ingest se descartarían (bad_json) sin ensuciar el estado.
TAG=smoke-$$-$RANDOM
mq mosquitto_pub "${TLSARGS[@]}" -i smoke-pub1 -u "$PLANT" -P "$PLANT_PW" -q 1 -t "campo/v1/otra/x/telemetry" -m "DENEGADO-otra-$TAG" >/dev/null 2>&1
mq mosquitto_pub "${TLSARGS[@]}" -i smoke-pub2 -u "$PLANT" -P "$PLANT_PW" -q 1 -t "campo/v1/$PLANT/x/cmd" -m "DENEGADO-cmd-$TAG" >/dev/null 2>&1
mq mosquitto_pub "${TLSARGS[@]}" -i smoke-pub3 -u ingest -P "$MQTT_INGEST_PASSWORD" -q 1 -t "campo/v1/$PLANT/x/telemetry" -m "DENEGADO-ingest-escribe-$TAG" >/dev/null 2>&1
mq mosquitto_pub "${TLSARGS[@]}" -i smoke-pub4 -u "$PLANT" -P "$PLANT_PW" -q 1 -t "campo/v1/$PLANT/x/telemetry" -m "PERMITIDO-$TAG" >/dev/null 2>&1
for _ in $(seq 1 20); do
  if [ "$MQ_LOCAL" = 1 ]; then cp "$TMP/sub.out" "$TMP/seen" 2>/dev/null; else docker logs smoke-sub > "$TMP/seen" 2>&1; fi
  grep -q "PERMITIDO-$TAG" "$TMP/seen" && break; sleep 0.5
done
if [ "$MQ_LOCAL" = 1 ]; then kill "$SUBPID" 2>/dev/null; wait "$SUBPID" 2>/dev/null; else docker rm -f smoke-sub >/dev/null 2>&1; fi
grep -q "campo/v1/$PLANT/x/telemetry PERMITIDO-$TAG" "$TMP/seen" && ok "(c) '$PLANT' publica en campo/v1/$PLANT/x/telemetry y llega al suscriptor ingest" || bad "(c) el mensaje permitido NO llegó: $(tr '\n' '|' < "$TMP/seen")"
grep -q "DENEGADO-otra-$TAG" "$TMP/seen" && bad "(c) ACL ROTA: '$PLANT' publicó en campo/v1/otra/x/telemetry" || ok "(c) publicar en campo/v1/otra/x/telemetry es descartado por el broker (no llega a ingest)"
grep -q "DENEGADO-cmd-$TAG" "$TMP/seen" && bad "(c) ACL ROTA: '$PLANT' publicó en .../cmd" || ok "(c) '$PLANT' no puede publicar en su canal cmd (sólo leerlo)"
grep -q "DENEGADO-ingest-escribe-$TAG" "$TMP/seen" && bad "(c) ACL ROTA: ingest pudo publicar" || ok "(c) el usuario ingest es de sólo lectura (su publicación se descarta)"
# Lectura: un usuario de planta no puede espiar telemetría (suscripción denegada / sin mensajes)
OUT=$(mq mosquitto_sub "${TLSARGS[@]}" -i smoke-spy -u "$PLANT" -P "$PLANT_PW" -t 'campo/v1/#' -v -W 3 2>&1);
[ -z "$(grep -E '^campo/v1/' <<<"$OUT")" ] && ok "(c) '$PLANT' no recibe telemetría ajena al suscribirse a campo/v1/# (aunque la simulación fluye)" || bad "(c) '$PLANT' recibió tráfico con campo/v1/#: $OUT"

# (d) sin TLS / puertos en claro
OUT=$(mq mosquitto_pub -h "$HOST" -p "$MQTT_PORT" -i smoke-plain -u "$PLANT" -P "$PLANT_PW" -t "campo/v1/$PLANT/x/telemetry" -m "plano" 2>&1); RC=$?
[ "$RC" != 0 ] && ok "(d) MQTT en claro contra el puerto TLS $MQTT_PORT falla ($OUT)" || bad "(d) el puerto $MQTT_PORT aceptó MQTT sin TLS"
deny "(d) puerto 1883 (MQTT en claro) cerrado en el host" tcp_open 127.0.0.1 1883
deny "(d) puerto 9001 (MQTT/WebSocket en claro) cerrado en el host" tcp_open 127.0.0.1 9001
LPORTS=$(docker exec campo-mosquitto sh -c 'netstat -ltn' 2>/dev/null | awk 'NR>2 && $4 !~ /^127\.0\.0\.11:/ {n=split($4,a,":"); print a[n]}' | sort -un | tr '\n' ' ')
[ "$LPORTS" = "8883 " ] && ok "(d) Mosquitto sólo escucha en 8883 dentro del contenedor (sin 1883/9001)" || bad "(d) puertos en escucha de Mosquitto: '$LPORTS'"
if command -v openssl >/dev/null 2>&1; then
  OS="openssl s_client -connect $HOST:$MQTT_PORT -CAfile $CA -verify_hostname localhost -verify_return_error"
  check "(d) TLS 1.2 aceptado con certificado verificado por la CA propia" sh -c "echo | $OS -tls1_2 2>&1 | grep -q 'Verification: OK'"
  check "(d) TLS 1.3 aceptado" sh -c "echo | $OS -tls1_3 2>&1 | grep -q 'TLSv1.3'"
  deny  "(d) TLS 1.1 rechazado" sh -c "echo | $OS -tls1_1 -cipher 'ALL:@SECLEVEL=0' 2>&1 | grep -q 'Cipher is [A-Za-z0-9]'"
  deny  "(d) TLS 1.0 rechazado" sh -c "echo | $OS -tls1 -cipher 'ALL:@SECLEVEL=0' 2>&1 | grep -q 'Cipher is [A-Za-z0-9]'"
else
  note "(d) openssl no disponible: se omite la comprobación de versiones TLS"
fi

echo; echo "Aislamiento de red y contraseñas (e)"
for p in 5432 6379 3000 3001 8080; do deny "(e) puerto $p no accesible desde el host (127.0.0.1)" tcp_open 127.0.0.1 $p; done
HOSTIP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -n "$HOSTIP" ]; then for p in 5432 6379; do deny "(e) puerto $p no accesible en $HOSTIP" tcp_open "$HOSTIP" $p; done; fi
PUB=$(docker ps --format '{{.Ports}}' | tr ',' '\n' | grep -oE '(0\.0\.0\.0|\[::\]|::):[0-9]+->' | sed -E 's/^.*:([0-9]+)->$/\1/' | sort -un | tr '\n' ' ')
EXPECT=$(printf '%s\n' 80 443 "$MQTT_PORT" | sort -un | tr '\n' ' ')
[ "$PUB" = "$EXPECT" ] && ok "(e) los únicos puertos publicados al host son 80, 443 y $MQTT_PORT" || bad "(e) puertos publicados inesperados: '$PUB' (esperado '$EXPECT')"
# Redis y Postgres desde la red interna: exigen contraseña
OUT=$(docker run --rm --network campo_backend --entrypoint redis-cli redis:7-alpine -h redis ping 2>&1)
grep -q NOAUTH <<<"$OUT" && ok "(e) Redis sin contraseña -> NOAUTH" || bad "(e) Redis respondió sin contraseña: $OUT"
OUT=$(docker run --rm --network campo_backend --entrypoint redis-cli redis:7-alpine -h redis --no-auth-warning -a "$REDIS_PASSWORD" ping 2>&1)
[ "$OUT" = PONG ] && ok "(e) Redis con contraseña -> PONG" || bad "(e) Redis con contraseña falla: $OUT"
IMG=$(docker inspect -f '{{.Config.Image}}' campo-timescaledb)
OUT=$(docker run --rm --network campo_backend -e PGCONNECT_TIMEOUT=5 --entrypoint psql "$IMG" -h timescaledb -U "$POSTGRES_USER" -d "$POSTGRES_DB" -w -c 'select 1' 2>&1)
grep -qiE "password|no password supplied|authentication" <<<"$OUT" && ok "(e) Postgres sin contraseña desde la red -> rechazado" || bad "(e) Postgres aceptó conexión sin contraseña: $OUT"
OUT=$(docker run --rm --network campo_backend -e PGPASSWORD="$POSTGRES_PASSWORD" --entrypoint psql "$IMG" -h timescaledb -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -c 'select 1' 2>&1)
[ "$OUT" = 1 ] && ok "(e) Postgres con contraseña desde la red interna -> OK" || bad "(e) Postgres con contraseña falla: $OUT"
check "(e) la red 'backend' (db, redis, api, ingest) es interna: sin salida a Internet" sh -c "[ \"\$(docker network inspect campo_backend -f '{{.Internal}}')\" = true ]"
deny "(e) el contenedor web no resuelve redis/timescaledb (redes separadas)" docker exec campo-web sh -c 'getent hosts redis || getent hosts timescaledb'
# Endurecimiento de contenedores
for c in mosquitto redis timescaledb ingest api web caddy; do
  R=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' campo-$c)
  [[ $R == "true [ALL] [no-new-privileges"* ]] && ok "(e) campo-$c: read_only, cap_drop ALL, no-new-privileges" || bad "(e) campo-$c sin endurecer: $R"
done
# Contraseñas obligatorias
OUT=$(env -u POSTGRES_PASSWORD -u REDIS_PASSWORD -u JWT_SECRET -u ADMIN_PASSWORD $COMPOSE --profile apps config 2>&1 >/dev/null) || true
grep -q "required variable" <<<"$OUT" && ok "(e) compose rechaza arrancar sin contraseñas (\${VAR:?}): $(head -1 <<<"$OUT" | cut -c1-110)" || bad "(e) compose no exige contraseñas: $OUT"

echo; echo "HTTPS por Caddy (f)"
CURL=(curl -s --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" --resolve "$DOMAIN:$HTTP_PORT:127.0.0.1")
if [ "${CAMPO_TLS:-internal}" = internal ]; then
  docker cp campo-caddy:/data/caddy/pki/authorities/local/root.crt "$TMP/caddy-root.crt" >/dev/null 2>&1 && CURL+=(--cacert "$TMP/caddy-root.crt") || { note "no se pudo copiar la CA de Caddy; se usa -k"; CURL+=(-k); }
fi
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/login")
[ "$CODE" = 200 ] && ok "(f) GET $BASE/login -> 200 (certificado validado contra la CA interna de Caddy)" || bad "(f) $BASE/login -> $CODE"
R=$("${CURL[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$DOMAIN$([ "$HTTP_PORT" = 80 ] || echo ":$HTTP_PORT")/login")
[[ $R == 30[1278]\ https://* ]] && ok "(f) HTTP redirige a HTTPS ($R)" || bad "(f) HTTP no redirige: $R"
HDRS=$("${CURL[@]}" -D - -o /dev/null "$BASE/login")
for h in strict-transport-security x-content-type-options x-frame-options referrer-policy content-security-policy permissions-policy cross-origin-opener-policy; do
  grep -qi "^$h:" <<<"$HDRS" && ok "(f) cabecera $h presente" || bad "(f) falta la cabecera $h"
done
grep -qi "^content-security-policy:.*frame-ancestors 'none'" <<<"$HDRS" && ok "(f) CSP con frame-ancestors 'none'" || bad "(f) CSP sin frame-ancestors"
grep -qi "^server:" <<<"$HDRS" && bad "(f) la cabecera Server se filtra" || ok "(f) sin cabecera Server"
grep -qi "^x-powered-by:" <<<"$HDRS" && bad "(f) X-Powered-By se filtra" || ok "(f) sin X-Powered-By"
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/plants/$PLANT/state")
[ "$CODE" = 401 ] && ok "(f) /api/plants/$PLANT/state sin token -> 401" || bad "(f) /api/plants/$PLANT/state sin token -> $CODE"
CODE=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/health")
[ "$CODE" != 200 ] && ok "(f) /health de la API no se expone por el proxy ($CODE)" || bad "(f) /health de la API expuesto por Caddy"

echo; echo "Flujo de datos: simulador (TLS+credenciales) -> ingest -> Redis/TimescaleDB -> API"
check "ingest conectado al broker por TLS con el usuario ingest (log)" sh -c "docker logs campo-ingest 2>&1 | grep -q '\"msg\":\"MQTT conectado\".*\"tls\":true.*\"user\":\"ingest\"'"
check "el simulador publica como '$PLANT' con TLS (log)" sh -c "docker logs campo-simulator 2>&1 | grep -q 'usernames=\[$PLANT\] tls=true'"
! docker logs campo-ingest 2>&1 | grep -q "$MQTT_INGEST_PASSWORD" && ok "la contraseña MQTT de ingest no aparece en sus logs" || bad "la contraseña MQTT aparece en los logs de ingest"
! docker logs campo-simulator 2>&1 | grep -q "$PLANT_PW" && ok "la contraseña MQTT del simulador no aparece en sus logs" || bad "la contraseña MQTT aparece en los logs del simulador"
TOKEN=$("${CURL[@]}" "$BASE/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL:-admin@campo.local}\",\"password\":\"$ADMIN_PASSWORD\"}" | json 'd["accessToken"]' 2>/dev/null) && [ -n "$TOKEN" ] && ok "login admin con la contraseña generada (vía HTTPS)" || bad "login admin falló"
AUTH="authorization: Bearer ${TOKEN:-}"
assets8() { [ "$("${CURL[@]}" -f "$BASE/api/plants/$PLANT/state" -H "$AUTH" | json 'len(d.get("assets", d))')" = 20 ]; }
wait_for "estado de $PLANT con 20 activos (Redis -> API)" assets8
rows() { [ "$(docker exec campo-timescaledb psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -c 'select count(*) from telemetry')" -gt 50 ]; }
wait_for "filas en TimescaleDB (telemetry)" rows
BAD=$(docker exec campo-timescaledb psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qAt -c "select count(*) from telemetry where plant <> '$PLANT'" 2>/dev/null || echo "?")
[ "$BAD" = 0 ] && ok "no hay filas de otras plantas en telemetry (la ACL frenó la suplantación)" || bad "hay filas de otras plantas en telemetry: $BAD"
if command -v node >/dev/null 2>&1 && [ -n "${TOKEN:-}" ]; then
  EXTRA=(); [ -f "$TMP/caddy-root.crt" ] && EXTRA=(NODE_EXTRA_CA_CERTS="$TMP/caddy-root.crt")
  OUT=$(env "${EXTRA[@]}" WS="wss://$DOMAIN$([ "$HTTPS_PORT" = 443 ] || echo ":$HTTPS_PORT")/ws?plant=$PLANT&token=$TOKEN" HOSTRES="$DOMAIN" timeout 20 node -e '
    const ws = new WebSocket(process.env.WS);
    const t = setTimeout(() => { console.log("timeout"); process.exit(1); }, 15000);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === "snapshot") { console.log("snapshot " + Object.keys(m.assets).length); clearTimeout(t); ws.close(); process.exit(0); } };
    ws.onerror = (e) => { console.log("error " + (e.message || "")); process.exit(1); };
  ' 2>&1)
  [ "$OUT" = "snapshot 20" ] && ok "WebSocket wss://$DOMAIN/ws por Caddy entrega snapshot de 20 activos" || bad "WebSocket vía Caddy: $OUT"
else
  note "node no disponible: se omite la prueba del WebSocket"
fi

echo; echo "Modelos 3D por Caddy (límites de cuerpo, validación y caché)"
if [ -n "${TOKEN:-}" ] && command -v node >/dev/null 2>&1; then
  TMPM=$(mktemp -d)
  node --input-type=module -e "
    import { buildGlb } from '$PWD/scripts/make-sample-glb.mjs'; import { writeFileSync } from 'node:fs';
    const nodes = Array.from({length: 1000}, (_, i) => ({ name: 'b' + i, geometry: {w: .1, h: .1, d: .1}, translation: [(i % 40) * .2, 0, Math.floor(i / 40) * .2] }));
    writeFileSync('$TMPM/big.glb', buildGlb(nodes));" 2>/dev/null
  head -c 12000000 /dev/zero > "$TMPM/huge.bin"; head -c 2000000 /dev/zero | tr '\0' 'a' > "$TMPM/two.json"; echo "no es un glb" > "$TMPM/bad.glb"
  HTTP() { "${CURL[@]}" -o "${2:-/dev/null}" -w '%{http_code}' "${@:3}" "$1"; }
  MURL="$BASE/api/plants/$PLANT/models"
  [ "$(stat -c %s "$TMPM/big.glb")" -gt 1048576 ] && ok "GLB de prueba de $(( $(stat -c %s "$TMPM/big.glb") / 1024 )) KB (supera el límite general de 1 MB de /api)" || bad "no se pudo generar el GLB de prueba"
  CODE=$(HTTP "$MURL?name=smoke-big" "$TMPM/up.json" -X POST -H "$AUTH" -H 'content-type: model/gltf-binary' --data-binary @"$TMPM/big.glb")
  [ "$CODE" = 201 ] || [ "$CODE" = 200 ] && ok "subir un GLB de >1 MB por Caddy -> $CODE (regla específica de 11 MB)" || bad "subida de GLB por Caddy -> $CODE"
  MID=$(python3 -c 'import json;print(json.load(open("'"$TMPM"'/up.json"))["id"])' 2>/dev/null)
  [ "$(HTTP "$MURL?name=huge" /dev/null -X POST -H "$AUTH" -H 'content-type: model/gltf-binary' --data-binary @"$TMPM/huge.bin")" = 413 ] && ok "cuerpo de 12 MB a /models -> 413" || bad "el cuerpo de 12 MB no se rechazó con 413"
  [ "$(HTTP "$BASE/api/auth/login" /dev/null -X POST -H 'content-type: application/json' --data-binary @"$TMPM/two.json")" = 413 ] && ok "cuerpo de 2 MB al resto de /api -> 413 (el límite de 1 MB se mantiene)" || bad "el límite de 1 MB del resto de /api no se aplica"
  [ "$(HTTP "$MURL?name=bad" /dev/null -X POST -H "$AUTH" -H 'content-type: model/gltf-binary' --data-binary @"$TMPM/bad.glb")" = 400 ] && ok "archivo que no es GLB -> 400" || bad "un archivo basura no se rechazó con 400"
  [ "$(HTTP "$MURL?name=x" /dev/null -X POST -H 'content-type: model/gltf-binary' --data-binary @"$TMPM/big.glb")" = 401 ] && ok "subir sin token -> 401" || bad "subida sin token no devolvió 401"
  if [ -n "${MID:-}" ]; then
    HTTP "$BASE/api/models/$MID" "$TMPM/back.glb" -D "$TMPM/h.txt" -H "$AUTH" >/dev/null
    cmp -s "$TMPM/big.glb" "$TMPM/back.glb" && ok "la descarga devuelve los mismos bytes que se subieron" || bad "la descarga difiere del archivo subido"
    ETAG=$(grep -i '^etag:' "$TMPM/h.txt" | cut -d' ' -f2 | tr -d '\r')
    [ "$(HTTP "$BASE/api/models/$MID" /dev/null -H "$AUTH" -H "If-None-Match: $ETAG")" = 304 ] && ok "If-None-Match -> 304" || bad "la caché por ETag no responde 304"
    [ "$(HTTP "$BASE/api/models/$MID" /dev/null)" = 401 ] && ok "descargar sin token -> 401" || bad "descarga sin token no devolvió 401"
    [ "$(HTTP "$MURL/$MID" /dev/null -X DELETE -H "$AUTH")" = 200 ] && ok "borrar el modelo de prueba" || bad "no se pudo borrar el modelo de prueba"
  fi
  rm -rf "$TMPM"
else
  note "sin token o sin node: se omite la prueba de modelos 3D"
fi

if [ -n "${TOKEN:-}" ]; then
  LEAK=0; for c in caddy api web ingest; do docker logs "campo-$c" 2>&1 | grep -qF "$TOKEN" && { LEAK=1; note "el JWT aparece en los logs de campo-$c"; }; done
  [ "$LEAK" = 0 ] && ok "el JWT (query de /ws) no aparece en los logs de caddy, api, web ni ingest" || bad "el JWT se filtra a los logs"
fi

echo
if [ "$FAIL" = 0 ]; then printf '\033[32mPrueba de humo SEGURA superada (%d comprobaciones).\033[0m\n' "$PASS"; exit 0; fi
printf '\033[31m%d comprobación(es) fallaron (%d OK).\033[0m\n' "$FAIL" "$PASS"; exit 1
