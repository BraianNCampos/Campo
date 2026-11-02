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
# como json, pero acepta varias sentencias (sin print implícito)
jx() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }

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
assets24() { [ "$(curl -sf "$API_URL/api/plants/demo/state" -H "$AUTH" | json 'len(d.get("assets", d))')" = 24 ]; }
wait_for "estado de 24 activos con telemetría (todos los módulos; la nave es decorativa)" assets24

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
curl -sf "$API_URL/api/plants" -H "$AUTH" | json 'sys.exit(0 if any(p["id"] == "demo" and p["assets"] == 25 for p in d) and any(p["id"] == "tanques" for p in d) else 1)' && ok "GET /api/plants incluye demo (25 activos) y tanques" || fail "/api/plants"
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

echo "Alarmas ISA-18.2: ciclo de vida de punta a punta"
CTOKEN=$(curl -sf "$API_URL/api/auth/login" -H 'content-type: application/json' -d "{\"email\":\"$CADM\",\"password\":\"$CPASS\"}" | json 'd["accessToken"]') || fail "nuevo login del cliente"; CAUTH="authorization: Bearer $CTOKEN"
JH='content-type: application/json'
POL=$(curl -sf "$API_URL/api/plants/demo/alarm-policy" -H "$AUTH" | json 'd["ratePerDay"]') && [ "$POL" = 150 ] && ok "política por defecto: 150 alarmas por día" || fail "alarm-policy"
curl -sf "$API_URL/api/plants/demo/alarm-kpis?window=24h" -H "$AUTH" | json 'sys.exit(0 if d["status"] in ("ok","warning","critical") and d["policy"]["peak10min"] == 10 else 1)' && ok "indicadores de salud de alarmas (alarm-kpis)" || fail "alarm-kpis"
curl -sf "$API_URL/api/alarm-rules?plant=demo" -H "$AUTH" | json 'sys.exit(0 if all("kind" in r for r in d) and any(r["kind"] == "DEV" for r in d) else 1)' && ok "las reglas traen su tipo (HH/HI/LO/LL/DEV/ROC); hay una de desviación sembrada" || fail "kind en reglas"
for OLD in $(curl -sf "$API_URL/api/alarm-rules?plant=demo" -H "$AUTH" | json '" ".join(r["id"] for r in d if (r.get("description") or "").endswith("(prueba de humo)"))'); do curl -s -X DELETE "$API_URL/api/alarm-rules/$OLD" -H "$AUTH" >/dev/null; done
RULE=$(curl -sf -X POST "$API_URL/api/alarm-rules" -H "$AUTH" -H "$JH" -d '{"plant":"demo","asset":"pres-01","metric":"pressure","operator":"gt","threshold":0.5,"severity":"critical","forSeconds":0,"hysteresis":0,"enabled":true,"kind":"HH","description":"Presión de línea (prueba de humo)","consequence":"Ninguna: regla de prueba","response":"Reconocer y borrar la regla"}' | json 'd["id"]') || fail "crear regla de prueba"
findalarm() { curl -sf "$API_URL/api/alarms?state=$1&plant=demo" -H "$AUTH" | json 'next((a["id"] for a in d if a["ruleId"] == "'"$RULE"'"), "")'; }
waitalarm() { local t=0; AID=""; while [ -z "$AID" ]; do AID=$(findalarm "$1"); [ -n "$AID" ] && break; t=$((t + 2)); [ "$t" -ge 40 ] && return 1; sleep 2; done; }
waitalarm active && ok "la regla genera una alarma activa" || fail "la alarma de prueba no se activó"
curl -sf "$API_URL/api/alarms?state=active&plant=demo" -H "$AUTH" | jx 'a = next(x for x in d if x["id"] == "'"$AID"'"); sys.exit(0 if a["lifecycle"] == "unacked" and a["kind"] == "HH" and a["rationale"]["description"].startswith("Presi") else 1)' && ok "nace sin reconocer, con tipo HH y su racionalización" || fail "lifecycle inicial"
[ "$(code -X POST "$API_URL/api/alarms/$AID/ack" -H "$AUTH")" = 200 ] && ok "reconocer la alarma" || fail "ack"
curl -sf "$API_URL/api/alarms?state=active&plant=demo" -H "$AUTH" | jx 'a = next(x for x in d if x["id"] == "'"$AID"'"); sys.exit(0 if a["lifecycle"] == "acked" else 1)' && ok "queda reconocida (sigue activa)" || fail "lifecycle acked"
[ "$(code -X POST "$API_URL/api/alarms/$AID/shelve" -H "$AUTH" -H "$JH" -d '{"minutes":1,"reason":"prueba de humo"}')" = 200 ] && ok "postergar la alarma 1 minuto con motivo" || fail "shelve"
[ -z "$(findalarm active)" ] && [ -n "$(findalarm shelved)" ] && ok "postergada: sale de las activas y aparece en Postergadas" || fail "shelved en la lista equivocada"
[ "$(code -X POST "$API_URL/api/alarms/$AID/unshelve" -H "$AUTH")" = 200 ] && ok "reactivar la alarma postergada" || fail "unshelve"
curl -sf "$API_URL/api/alarms/$AID/journal" -H "$AUTH" | jx 'types = [e["type"] for e in d]; sys.exit(0 if "activate" in types and "ack" in types and "shelve" in types and "unshelve" in types else 1)' && ok "el diario registró activación, reconocimiento y postergación" || fail "journal"
[ "$(code -X PUT "$API_URL/api/plants/demo/alarm-policy" -H "$CAUTH" -H "$JH" -d '{"ratePerDay":999,"peak10min":99,"staleHours":99}')" = 403 ] && ok "un cliente no puede cambiar la política de otra planta -> 403" || fail "política ajena"
[ "$(code "$API_URL/api/alarms/$AID/journal" -H "$CAUTH")" = 403 ] && ok "el diario de otro cliente -> 403" || fail "aislamiento: journal"
[ "$(code -X POST "$API_URL/api/alarms/$AID/shelve" -H "$CAUTH" -H "$JH" -d '{"minutes":5,"reason":"intento ajeno"}')" = 403 ] && ok "postergar una alarma de otro cliente -> 403" || fail "aislamiento: shelve"
curl -sf -X DELETE "$API_URL/api/alarm-rules/$RULE" -H "$AUTH" >/dev/null || fail "borrar regla de prueba"
sleep 2; [ -z "$(findalarm active)" ] && ok "al borrar la regla, su alarma se cierra" || fail "alarma huérfana tras borrar la regla"

echo "Tags y control de llenado (orden real: API -> MQTT -> simulador -> acuse -> telemetría)"
curl -sf "$API_URL/api/plants/demo/assets" -H "$AUTH" | json 'sys.exit(0 if {a["id"]: a.get("tag") for a in d}.get("tk-01") == "TNK-101" and {a["id"]: a.get("tag") for a in d}.get("silo-01") == "TNK-301" and {a["id"]: a.get("tag") for a in d}.get("nave-01") is None else 1)' && ok "los activos sembrados tienen su tag (TNK-101, TNK-301…); la nave decorativa no" || fail "tags sembrados"
[ "$(code "$API_URL/api/plants/tanques/assets/tk-a/commands/preview" -H "$CAUTH" -H "$JH" -d '{"command":"stop"}')" = 403 ] && ok "un cliente sin el módulo de control no puede ordenar -> 403 (module_disabled)" || fail "control sin contratar"
[ "$(code "$API_URL/api/plants/demo/assets/tk-01/commands/preview" -H "$CAUTH" -H "$JH" -d '{"command":"stop"}')" = 403 ] && ok "ordenar en la planta de otro cliente -> 403" || fail "aislamiento: órdenes"
[ "$(code "$API_URL/api/plants/demo/orders" -H "$CAUTH")" = 403 ] && ok "el registro de órdenes de otro cliente -> 403" || fail "aislamiento: registro de órdenes"
curl -sf "$API_URL/api/plants/demo/assets/tk-01/interlocks" -H "$AUTH" | json 'sys.exit(0 if all(i["ok"] for i in d) and len(d) >= 5 else 1)' && ok "enclavamientos de TNK-101 todos en verde" || fail "enclavamientos"
LVL=$(curl -sf "$API_URL/api/plants/demo/state" -H "$AUTH" | json 'int(d.get("assets", d)["tk-01"]["values"]["level"])')
if [ "$LVL" -gt 50 ]; then CMD=drain; TGT=$((LVL - 10)); else CMD=fill; TGT=$((LVL + 10)); fi
PV=$(curl -sf -X POST "$API_URL/api/plants/demo/assets/tk-01/commands/preview" -H "$AUTH" -H "$JH" -d "{\"command\":\"$CMD\",\"target\":$TGT}") || fail "preview"
CID=$(printf '%s' "$PV" | json 'd["confirmId"]'); [ -n "$CID" ] && ok "vista previa ($CMD TNK-101 a $TGT %): confirmId de un solo uso" || fail "preview bloqueada: $PV"
ORD=$(curl -sf -X POST "$API_URL/api/plants/demo/assets/tk-01/commands" -H "$AUTH" -H "$JH" -d "{\"confirmId\":\"$CID\"}") || fail "ejecutar orden"
OID=$(printf '%s' "$ORD" | json 'd["id"]'); ok "orden creada ($OID)"
[ "$(code -X POST "$API_URL/api/plants/demo/assets/tk-01/commands" -H "$AUTH" -H "$JH" -d "{\"confirmId\":\"$CID\"}")" = 409 ] && ok "el confirmId no se puede reutilizar -> 409" || fail "confirmId reutilizable"
[ "$(code -X POST "$API_URL/api/orders/$OID/cancel" -H "$CAUTH")" = 403 ] && ok "cancelar la orden de otro cliente -> 403" || fail "aislamiento: cancelar"
ostatus() { curl -sf "$API_URL/api/plants/demo/orders?asset=tk-01&limit=5" -H "$AUTH" | json 'next((o["status"] for o in d if o["id"] == "'"$OID"'"), "")'; }
t=0; ST=""; while [ "$ST" != done ]; do ST=$(ostatus); case $ST in rejected|failed|timeout|cancelled) fail "la orden terminó en $ST";; esac; t=$((t + 3)); [ "$t" -ge 90 ] && fail "la orden no terminó (estado: $ST)"; [ "$ST" = done ] || sleep 3; done
ok "el simulador aceptó, ejecutó y completó la orden (pending → accepted → running → done)"
NOW=$(curl -sf "$API_URL/api/plants/demo/state" -H "$AUTH" | json 'int(round(d.get("assets", d)["tk-01"]["values"]["level"]))')
[ "$((NOW - TGT))" -le 2 ] && [ "$((TGT - NOW))" -le 2 ] && ok "el nivel real llegó al objetivo ($NOW % ≈ $TGT %)" || fail "el nivel no siguió a la orden ($NOW vs $TGT)"
curl -sf "$API_URL/api/audit?limit=50" -H "$AUTH" | json 'sys.exit(0 if any(e["action"] == "order.create" for e in d) else 1)' && ok "la orden quedó en la auditoría (order.create)" || fail "auditoría de órdenes"

echo; echo "Prueba de humo superada."
