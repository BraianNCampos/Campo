#!/usr/bin/env bash
# Prueba de humo del stack completo (simulador -> MQTT -> ingest -> Redis/TimescaleDB -> API -> web).
# Requisitos: stack levantado con `docker compose --profile apps --profile sim up -d` y un .env válido.
# Uso: scripts/smoke.sh        (variables opcionales: API_URL, WEB_URL, INGEST_URL, TIMEOUT)
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; [ -f .env ] && . ./.env; set +a
API_URL=${API_URL:-http://localhost:${API_PORT:-3001}}
WEB_URL=${WEB_URL:-http://localhost:${WEB_PORT:-3000}}
INGEST_URL=${INGEST_URL:-http://localhost:${INGEST_HTTP_PORT:-8080}}
TIMEOUT=${TIMEOUT:-180}
DB="docker compose exec -T timescaledb psql -U ${POSTGRES_USER:-campo} -d ${POSTGRES_DB:-campo} -qAt"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
fail() { printf '  \033[31mFALLA\033[0m %s\n' "$*"; exit 1; }
# wait_for "descripción" comando...  -> reintenta hasta TIMEOUT segundos
wait_for() {
  local what=$1; shift; local t=0
  until "$@" >/dev/null 2>&1; do
    t=$((t + 3)); [ "$t" -ge "$TIMEOUT" ] && fail "$what (timeout ${TIMEOUT}s)"; sleep 3
  done
  ok "$what"
}
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "Servicios"
wait_for "api /ready"            sh -c "curl -sf $API_URL/ready"
wait_for "ingest /readyz"        sh -c "curl -sf $INGEST_URL/readyz"
wait_for "web responde"          sh -c "curl -sf -o /dev/null $WEB_URL/login"

echo "Autenticación"
TOKEN=$(curl -sf "$API_URL/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"${ADMIN_EMAIL:-admin@campo.local}\",\"password\":\"${ADMIN_PASSWORD}\"}" | json 'd["accessToken"]') || fail "login"
ok "login admin"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/plants/demo/state")" = 401 ] && ok "sin token -> 401" || fail "ruta sin proteger"
AUTH="authorization: Bearer $TOKEN"

echo "Datos en vivo (Redis)"
assets20() { [ "$(curl -sf "$API_URL/api/plants/demo/state" -H "$AUTH" | json 'len(d.get("assets", d))')" = 20 ]; }
wait_for "estado de 20 activos (todos los módulos)" assets20

echo "Histórico (TimescaleDB)"
rows() { [ "$($DB -c 'select count(*) from telemetry')" -gt 100 ]; }
wait_for "filas en telemetry" rows
FROM=$(date -u -d '-30 minutes' +%Y-%m-%dT%H:%M:%SZ); TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
N=$(curl -sf "$API_URL/api/plants/demo/assets/tk-01/history?metric=level&from=$FROM&to=$TO&bucket=10s" -H "$AUTH" | json 'len(d["points"])')
[ "$N" -gt 0 ] && ok "histórico crudo (time_bucket): $N puntos" || fail "histórico crudo vacío"
hist1m() { $DB -c "CALL refresh_continuous_aggregate('telemetry_1m', NULL, now() - interval '1 minute')" >/dev/null 2>&1 || true
  curl -sf "$API_URL/api/plants/demo/assets/tk-01/history?metric=level&from=$FROM&to=$TO&bucket=1m" -H "$AUTH" | json 'sys.exit(0 if d["points"] else 1)'; }
wait_for "agregado continuo telemetry_1m con datos" hist1m

echo "Administración"
curl -sf "$API_URL/api/me" -H "$AUTH" | json 'sys.exit(0 if d["role"] == "platform_admin" and d["org"] is None and d["plants"] == ["*"] else 1)' && ok "GET /api/me (personal de plataforma, sin cliente)" || fail "/api/me"
curl -sf "$API_URL/api/plants" -H "$AUTH" | json 'sys.exit(0 if any(p["id"] == "demo" and p["assets"] == 20 for p in d) and any(p["id"] == "tanques" for p in d) else 1)' && ok "GET /api/plants incluye demo (20 activos) y tanques" || fail "/api/plants"
curl -sf "$API_URL/api/audit?limit=5" -H "$AUTH" >/dev/null && ok "GET /api/audit (solo admin)" || fail "/api/audit"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/audit")" = 401 ] && ok "auditoría sin token -> 401" || fail "auditoría sin proteger"

echo "Clientes: aislamiento y módulos"
TS=$(date +%s); CADM="admin-tanques-$TS@campo.test"; CPASS="clave-del-cliente-$TS"
curl -sf -X POST "$API_URL/api/orgs/cliente-tanques/admins" -H "$AUTH" -H 'content-type: application/json' -d "{\"email\":\"$CADM\",\"password\":\"$CPASS\"}" >/dev/null && ok "platform_admin crea el administrador del cliente solo-tanques" || fail "crear administrador de cliente"
CTOKEN=$(curl -sf "$API_URL/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$CADM\",\"password\":\"$CPASS\"}" | json 'd["accessToken"]') || fail "login del administrador del cliente"
CAUTH="authorization: Bearer $CTOKEN"
curl -sf "$API_URL/api/me" -H "$CAUTH" | json 'sys.exit(0 if d["role"] == "admin" and d["org"]["id"] == "cliente-tanques" and d["org"]["modules"] == ["tanks"] else 1)' && ok "el cliente ve su espacio y solo el módulo Tanques" || fail "/api/me del cliente"
curl -sf "$API_URL/api/plants" -H "$CAUTH" | json 'sys.exit(0 if [p["id"] for p in d] == ["tanques"] else 1)' && ok "el cliente solo lista su planta (tanques)" || fail "el cliente ve plantas ajenas"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
[ "$(code "$API_URL/api/plants/demo/state" -H "$CAUTH")" = 403 ] && ok "estado de la planta de otro cliente -> 403" || fail "aislamiento: estado ajeno"
[ "$(code "$API_URL/api/plants/demo/assets" -H "$CAUTH")" = 403 ] && ok "activos de otro cliente -> 403" || fail "aislamiento: activos ajenos"
[ "$(code "$API_URL/api/plants/inexistente/state" -H "$CAUTH")" = 403 ] && ok "planta inexistente -> el mismo 403 (no revela qué existe)" || fail "planta inexistente distinguible"
[ "$(code "$API_URL/api/plants/demo/limits" -H "$CAUTH")" = 403 ] && ok "límites de otro cliente -> 403" || fail "aislamiento: limits"
[ "$(code "$API_URL/api/orgs" -H "$CAUTH")" = 403 ] && ok "el administrador de cliente no accede a /api/orgs" || fail "escalada a plataforma"
curl -sf "$API_URL/api/alarms?state=active" -H "$CAUTH" | json 'sys.exit(0 if all(a["plant"] == "tanques" for a in d) else 1)' && ok "las alarmas del cliente son solo de su planta" || fail "alarmas de otro cliente"
curl -sf "$API_URL/api/audit?limit=200" -H "$CAUTH" | json 'sys.exit(0 if all(e.get("orgId") == "cliente-tanques" for e in d) else 1)' && ok "la auditoría del cliente es solo de su cliente" || fail "auditoría de otro cliente"
curl -sf "$API_URL/api/plants/tanques/limits" -H "$CAUTH" | json 'sys.exit(0 if len(d) >= 4 and all(l["asset"] in ("tk-a", "tk-b") for l in d) else 1)' && ok "límites de su planta (nivel alto y bajo de cada tanque)" || fail "limits del cliente"
MC=$(curl -s -o /tmp/smoke-mod.json -w '%{http_code}' -X POST "$API_URL/api/plants/tanques/assets" -H "$CAUTH" -H 'content-type: application/json' -d '{"id":"clima-x","name":"Clima X","type":"climate"}')
{ [ "$MC" = 403 ] && grep -q module_disabled /tmp/smoke-mod.json; } && ok "crear un activo de un módulo no contratado -> 403 module_disabled" || fail "módulo no contratado permitido ($MC)"
rm -f /tmp/smoke-mod.json
[ "$(code -X POST "$API_URL/api/plants/demo/models?name=x" -H "$CAUTH" -H 'content-type: model/gltf-binary' --data-binary 'x')" = 403 ] && ok "subir un modelo a la planta de otro cliente -> 403" || fail "aislamiento: modelos"
# activar el módulo desde plataforma surte efecto al instante
curl -sf -X PATCH "$API_URL/api/orgs/cliente-tanques" -H "$AUTH" -H 'content-type: application/json' -d '{"modules":["tanks","climate"]}' >/dev/null || fail "activar módulo"
MC2=$(code -X POST "$API_URL/api/plants/tanques/assets" -H "$CAUTH" -H 'content-type: application/json' -d '{"id":"clima-x","name":"Clima X","type":"climate"}')
{ [ "$MC2" = 201 ] || [ "$MC2" = 200 ]; } && ok "al activar el módulo desde plataforma, el cliente ya puede crear activos de clima" || fail "módulo activado sin efecto ($MC2)"
curl -s -X DELETE "$API_URL/api/plants/tanques/assets/clima-x" -H "$CAUTH" >/dev/null
curl -sf -X PATCH "$API_URL/api/orgs/cliente-tanques" -H "$AUTH" -H 'content-type: application/json' -d '{"modules":["tanks"]}' >/dev/null
curl -sf -X PATCH "$API_URL/api/orgs/cliente-tanques" -H "$AUTH" -H 'content-type: application/json' -d '{"active":false}' >/dev/null || fail "desactivar cliente"
[ "$(code "$API_URL/api/me" -H "$CAUTH")" = 401 ] && ok "desactivar el cliente corta su sesión (401)" || fail "cliente inactivo conserva acceso"
curl -sf -X PATCH "$API_URL/api/orgs/cliente-tanques" -H "$AUTH" -H 'content-type: application/json' -d '{"active":true}' >/dev/null
[ "$(code "$API_URL/api/me" -H "$CAUTH")" = 401 ] && ok "reactivar el cliente no resucita el token anterior" || fail "token anterior resucitado"

echo "Modelos 3D"
GLB=examples/models/sample-tank.glb
MCODE=$(curl -s -o /tmp/smoke-model.json -w '%{http_code}' -X POST "$API_URL/api/plants/demo/models?name=smoke-tank" -H "$AUTH" -H 'content-type: model/gltf-binary' --data-binary @"$GLB")
{ [ "$MCODE" = 201 ] || [ "$MCODE" = 200 ]; } && ok "subir GLB de ejemplo -> $MCODE" || fail "subida de GLB -> $MCODE"
MID=$(json 'd["id"]' < /tmp/smoke-model.json)
curl -sf "$API_URL/api/models/$MID" -H "$AUTH" -o /tmp/smoke-model.glb && cmp -s "$GLB" /tmp/smoke-model.glb && ok "la descarga es idéntica al archivo subido" || fail "descarga distinta"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/plants/demo/models?name=bad" -H "$AUTH" -H 'content-type: model/gltf-binary' --data-binary 'no es un glb')" = 400 ] && ok "archivo basura -> 400" || fail "GLB inválido aceptado"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$API_URL/api/plants/demo/models/$MID" -H "$AUTH")" = 200 ] && ok "borrar modelo" || fail "borrado de modelo"
rm -f /tmp/smoke-model.json /tmp/smoke-model.glb

echo "Alarmas"
curl -sf "$API_URL/api/alarms?state=active" -H "$AUTH" >/dev/null && ok "GET /api/alarms" || fail "alarmas"

echo; echo "Prueba de humo superada."
