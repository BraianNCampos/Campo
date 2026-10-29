#!/usr/bin/env bash
# Genera todo el material secreto del despliegue endurecido de Campo 2.0 (docs/architecture.md §8.2-8.3):
#   - CA propia + certificado de servidor del broker MQTT (SAN configurable)
#   - fichero de contraseñas de Mosquitto (hashes) con los usuarios `ingest`, `healthcheck` y uno por planta
#   - contraseñas aleatorias fuertes (Postgres, Redis, JWT_SECRET, admin de la API, MQTT)
#   - `.env.prod` (permisos 600) y los certificados bajo `secrets/` (ignorados por git)
#
# Es IDEMPOTENTE: si ya existe algo, lo conserva y sólo completa lo que falte (p. ej. una planta nueva,
# o reemite el certificado del broker si cambian los SAN o le quedan < 30 días).
#
# Uso:  scripts/bootstrap-secure.sh [opciones]
#   --plants a,b,c        plantas (usuarios MQTT; nombre = id de planta). Por defecto: demo. Aditivo.
#   --hosts h1,h2         SAN extra del broker (DNS o IP), además de localhost, mosquitto y 127.0.0.1
#                         (también env CAMPO_BROKER_HOSTS)
#   --domain d            dominio público del proxy Caddy (env CAMPO_DOMAIN; por defecto localhost)
#   --acme-email e        contacto ACME para dominios reales (env CAMPO_ACME_EMAIL)
#   --admin-email e       email del admin inicial de la API (por defecto admin@campo.local)
#   --rotate              regenera SÓLO credenciales (MQTT, Redis, JWT, Postgres si el contenedor corre);
#                         no toca CA ni certificados ni la contraseña del admin (vive en la BD)
#   --rotate-certs        reemite el certificado del servidor (misma CA)
#   --rotate-ca           crea una CA nueva y reemite el certificado (hay que redistribuir ca.crt)
#   --out-dir d           directorio de secretos (env SECRETS_DIR; por defecto secrets)
#   --env-file f          fichero de entorno (env ENV_FILE; por defecto .env.prod)
#   -h, --help
# Variables: MOSQUITTO_IMAGE (eclipse-mosquitto:2) para generar el passwd si no hay mosquitto_passwd local.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

OUT_DIR=${SECRETS_DIR:-secrets}
ENV_FILE=${ENV_FILE:-.env.prod}
PLANTS_ARG=""
HOSTS_ARG=${CAMPO_BROKER_HOSTS:-}
DOMAIN_ARG=${CAMPO_DOMAIN:-}
ACME_EMAIL_ARG=${CAMPO_ACME_EMAIL:-}
ADMIN_EMAIL_ARG=""
MOSQ_IMAGE=${MOSQUITTO_IMAGE:-eclipse-mosquitto:2}
MOSQ_UID=${MOSQUITTO_UID:-1883}
ROTATE=0 ROTATE_CERTS=0 ROTATE_CA=0
PLANT_RE='^[a-z0-9][a-z0-9_-]{0,63}$'

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'AVISO: %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --plants)      PLANTS_ARG=${2:?falta valor}; shift 2 ;;
    --hosts)       HOSTS_ARG=${2:?falta valor}; shift 2 ;;
    --domain)      DOMAIN_ARG=${2:?falta valor}; shift 2 ;;
    --acme-email)  ACME_EMAIL_ARG=${2:?falta valor}; shift 2 ;;
    --admin-email) ADMIN_EMAIL_ARG=${2:?falta valor}; shift 2 ;;
    --out-dir)     OUT_DIR=${2:?falta valor}; shift 2 ;;
    --env-file)    ENV_FILE=${2:?falta valor}; shift 2 ;;
    --rotate)      ROTATE=1; shift ;;
    --rotate-certs) ROTATE_CERTS=1; shift ;;
    --rotate-ca)   ROTATE_CA=1; ROTATE_CERTS=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) die "opción desconocida: $1 (usa --help)" ;;
  esac
done

command -v openssl >/dev/null || die "se necesita openssl"

CERTS=$OUT_DIR/certs
MQ=$OUT_DIR/mosquitto
USERS=$OUT_DIR/mqtt-users
mkdir -p "$CERTS" "$MQ" "$USERS"
chmod 700 "$OUT_DIR" "$CERTS" "$MQ" "$USERS"

# ---------------------------------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------------------------------
# Cadena aleatoria alfanumérica de n caracteres (sin símbolos: segura en URLs de Redis/Postgres y en .env).
# Se descartan las que contengan marcas de "valor de ejemplo" que la API rechaza en producción.
rand_alnum() {
  local n=$1 s="" low
  while :; do
    while [ "${#s}" -lt "$n" ]; do s+=$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9'); done
    s=${s:0:n}; low=$(printf %s "$s" | tr 'A-Z' 'a-z')
    case $low in *cambia*|*changeme*|*change-me*|*secret*|*example*|*password*) s="" ;; *) break ;; esac
  done
  printf %s "$s"
}

declare -A ENV_VALS=()
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in ''|'#'*) continue ;; esac
    k=${line%%=*}; v=${line#*=}
    [[ $k =~ ^[A-Z][A-Z0-9_]*$ ]] && ENV_VALS[$k]=$v
  done < "$ENV_FILE"
}
# get_or_gen CLAVE longitud  -> conserva el valor existente salvo que se rote
get_or_gen() {
  local k=$1 n=$2 force=${3:-0}
  if [ "$force" = 1 ] || [ -z "${ENV_VALS[$k]:-}" ]; then ENV_VALS[$k]=$(rand_alnum "$n"); NEW_KEYS+=("$k"); fi
}
NEW_KEYS=()
load_env
FIRST_RUN=0; [ -f "$ENV_FILE" ] || FIRST_RUN=1

# ---------------------------------------------------------------------------------------------------
# Plantas (= usuarios MQTT). Conjunto = ficheros *.pass existentes ∪ --plants (por defecto: demo)
# ---------------------------------------------------------------------------------------------------
declare -A PLANT_SET=()
for f in "$USERS"/*.pass; do [ -e "$f" ] && PLANT_SET[$(basename "$f" .pass)]=1; done
if [ -n "$PLANTS_ARG" ]; then
  IFS=',' read -r -a _p <<< "$PLANTS_ARG"
  for p in "${_p[@]}"; do p=${p// /}; [ -n "$p" ] && PLANT_SET[$p]=1; done
elif [ "${#PLANT_SET[@]}" -eq 0 ]; then
  PLANT_SET[demo]=1
fi
for p in "${!PLANT_SET[@]}"; do
  [[ $p =~ $PLANT_RE ]] || die "id de planta inválido: '$p' (debe cumplir $PLANT_RE)"
  case $p in ingest|healthcheck) die "'$p' es un usuario reservado; elige otro id de planta" ;; esac
done
PLANTS=$(printf '%s\n' "${!PLANT_SET[@]}" | sort)

# ---------------------------------------------------------------------------------------------------
# Credenciales
# ---------------------------------------------------------------------------------------------------
R=$ROTATE
[ -n "$DOMAIN_ARG" ] && ENV_VALS[CAMPO_DOMAIN]=$DOMAIN_ARG
ENV_VALS[CAMPO_DOMAIN]=${ENV_VALS[CAMPO_DOMAIN]:-localhost}
if [ -n "$ADMIN_EMAIL_ARG" ]; then ENV_VALS[ADMIN_EMAIL]=$ADMIN_EMAIL_ARG; fi
ENV_VALS[ADMIN_EMAIL]=${ENV_VALS[ADMIN_EMAIL]:-admin@campo.local}
ENV_VALS[POSTGRES_USER]=${ENV_VALS[POSTGRES_USER]:-campo}
ENV_VALS[POSTGRES_DB]=${ENV_VALS[POSTGRES_DB]:-campo}

# TLS del proxy Caddy: CA interna para localhost/IP/nombres locales; ACME (Let's Encrypt) para dominios reales.
is_local_name() {
  [[ $1 == localhost || $1 == *.localhost || $1 == *.local || $1 == *.internal || $1 == *.test || $1 == *.lan ||
     $1 == *.home.arpa || $1 =~ ^[0-9.]+$ || $1 == *:* || $1 != *.* ]]
}
if [ -n "$ACME_EMAIL_ARG" ]; then ENV_VALS[CAMPO_TLS]=$ACME_EMAIL_ARG
elif [ -z "${ENV_VALS[CAMPO_TLS]:-}" ] || [ -n "$DOMAIN_ARG" ]; then
  is_local_name "${ENV_VALS[CAMPO_DOMAIN]}" || die "dominio público '${ENV_VALS[CAMPO_DOMAIN]}': indica --acme-email tu@correo (contacto ACME / Let's Encrypt)"
  ENV_VALS[CAMPO_TLS]=internal
fi
if [ -z "${ENV_VALS[CAMPO_HSTS]:-}" ] || [ -n "$DOMAIN_ARG" ]; then
  # En local HSTS corto (5 min): un max-age largo "pegaría" https a TODO http://localhost:* del navegador.
  if is_local_name "${ENV_VALS[CAMPO_DOMAIN]}"; then ENV_VALS[CAMPO_HSTS]="max-age=300"; else ENV_VALS[CAMPO_HSTS]="max-age=31536000;includeSubDomains"; fi
fi
is_local_name "${ENV_VALS[CAMPO_DOMAIN]}" && [ "${ENV_VALS[CAMPO_TLS]}" != internal ] && warn "CAMPO_TLS=${ENV_VALS[CAMPO_TLS]} con dominio local: Let's Encrypt no emite para '${ENV_VALS[CAMPO_DOMAIN]}'"

# Postgres: la contraseña vive en el volumen de datos. Al rotar sólo se cambia si el contenedor corre
# (se aplica con ALTER ROLE); si no, se conserva para no dejar la pila inconsistente.
PG_ROTATED=0
if [ "$R" = 1 ] && [ -n "${ENV_VALS[POSTGRES_PASSWORD]:-}" ]; then
  if command -v docker >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' campo-timescaledb 2>/dev/null || true)" = true ]; then
    NEWPG=$(rand_alnum 32)
    printf "ALTER ROLE \"%s\" PASSWORD '%s';\n" "${ENV_VALS[POSTGRES_USER]}" "$NEWPG" |
      docker exec -i campo-timescaledb psql -U "${ENV_VALS[POSTGRES_USER]}" -d "${ENV_VALS[POSTGRES_DB]}" -v ON_ERROR_STOP=1 -q >/dev/null \
      || die "no se pudo aplicar ALTER ROLE en campo-timescaledb"
    ENV_VALS[POSTGRES_PASSWORD]=$NEWPG; PG_ROTATED=1
  fi
fi
get_or_gen POSTGRES_PASSWORD 32
get_or_gen REDIS_PASSWORD 40 "$R"
get_or_gen JWT_SECRET 64 "$R"
get_or_gen ADMIN_PASSWORD 24            # nunca se rota aquí: la contraseña real del admin vive en la BD
get_or_gen MQTT_INGEST_PASSWORD 32 "$R"

# hc y plantas: viven en ficheros de secrets/ (el .env.prod sólo lleva la del simulador)
gen_file_secret() { # fichero longitud rotar
  if [ "$3" = 1 ] || [ ! -s "$1" ]; then rand_alnum "$2" > "$1"; chmod 600 "$1"; NEW_FILES+=("$1"); fi
}
NEW_FILES=()
gen_file_secret "$MQ/healthcheck.pw" 32 "$R"
for p in $PLANTS; do gen_file_secret "$USERS/$p.pass" 32 "$R"; done
SIM_PLANT=${ENV_VALS[MQTT_SIM_PLANT]:-}
if [ -z "$SIM_PLANT" ] || [ -z "${PLANT_SET[$SIM_PLANT]:-}" ]; then SIM_PLANT=$(printf '%s\n' "$PLANTS" | head -n1); fi
ENV_VALS[MQTT_SIM_PLANT]=$SIM_PLANT
ENV_VALS[MQTT_SIM_PASSWORD]=$(cat "$USERS/$SIM_PLANT.pass")

# ---------------------------------------------------------------------------------------------------
# CA propia y certificado del servidor
# ---------------------------------------------------------------------------------------------------
CA_KEY=$CERTS/ca.key CA_CRT=$CERTS/ca.crt SRV_KEY=$CERTS/server.key SRV_CRT=$CERTS/server.crt SAN_FILE=$CERTS/server.san
CA_CREATED=0 SRV_ISSUED=0

if [ "$ROTATE_CA" = 1 ] || [ ! -s "$CA_KEY" ] || [ ! -s "$CA_CRT" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$CA_KEY" 2>/dev/null
  openssl req -x509 -new -key "$CA_KEY" -sha256 -days 3650 -subj "/O=Campo 2.0/CN=Campo MQTT CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$CA_CRT" 2>/dev/null
  chmod 600 "$CA_KEY"; chmod 644 "$CA_CRT"; CA_CREATED=1; ROTATE_CERTS=1
fi

# SAN deseados: localhost, mosquitto, 127.0.0.1 + hosts indicados + los SAN que ya tuviera el certificado
# (unión: re-ejecutar sin --hosts no pierde nombres. Para QUITAR alguno, edita/borra server.san y usa --rotate-certs).
SANS=("DNS:localhost" "DNS:mosquitto" "IP:127.0.0.1")
if [ -n "$HOSTS_ARG" ]; then
  IFS=',' read -r -a _h <<< "$HOSTS_ARG"
  for h in "${_h[@]}"; do
    h=${h// /}; [ -z "$h" ] && continue
    if [[ $h =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || $h =~ ^[0-9a-fA-F:]+:[0-9a-fA-F:]*$ ]]; then SANS+=("IP:$h")
    elif [[ $h =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then SANS+=("DNS:$h")
    else die "host inválido para SAN: '$h'"; fi
  done
fi
if [ -s "$SAN_FILE" ]; then
  DESIRED_SAN=$( (tr ',' '\n' < "$SAN_FILE"; echo; printf '%s\n' "${SANS[@]}") | sort -u | paste -sd, -)
else
  DESIRED_SAN=$(printf '%s\n' "${SANS[@]}" | sort -u | paste -sd, -)
fi

need_issue=0
[ "$ROTATE_CERTS" = 1 ] && need_issue=1
{ [ ! -s "$SRV_CRT" ] || [ ! -s "$SRV_KEY" ]; } && need_issue=1
if [ "$need_issue" = 0 ]; then
  [ "$(cat "$SAN_FILE" 2>/dev/null || true)" != "$DESIRED_SAN" ] && need_issue=1 && info "los SAN cambiaron: se reemite el certificado del broker"
  openssl x509 -in "$SRV_CRT" -noout -checkend $((30*86400)) >/dev/null 2>&1 || { need_issue=1; info "el certificado del broker caduca en < 30 días: se reemite"; }
  openssl verify -CAfile "$CA_CRT" "$SRV_CRT" >/dev/null 2>&1 || { need_issue=1; info "el certificado del broker no valida contra la CA actual: se reemite"; }
fi
if [ "$need_issue" = 1 ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  openssl ecparam -name prime256v1 -genkey -noout -out "$SRV_KEY" 2>/dev/null
  openssl req -new -key "$SRV_KEY" -subj "/O=Campo 2.0/CN=mosquitto" -out "$tmp/server.csr" 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$DESIRED_SAN" > "$tmp/ext.cnf"
  openssl x509 -req -in "$tmp/server.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -set_serial "0x$(openssl rand -hex 16)" \
    -days 825 -sha256 -extfile "$tmp/ext.cnf" -out "$SRV_CRT" 2>/dev/null
  printf '%s' "$DESIRED_SAN" > "$SAN_FILE"; chmod 644 "$SAN_FILE" "$SRV_CRT"; chmod 600 "$SRV_KEY"
  SRV_ISSUED=1
fi

# ---------------------------------------------------------------------------------------------------
# passwd de Mosquitto (hashes). Se reconstruye si falta, si cambió el conjunto de usuarios o se rotó.
# ---------------------------------------------------------------------------------------------------
PASSWD=$MQ/passwd
want_users=$( { echo ingest; echo healthcheck; printf '%s\n' $PLANTS; } | sort)
have_users=""; [ -s "$PASSWD" ] && have_users=$(cut -d: -f1 "$PASSWD" | sort)
rebuild_passwd=0
{ [ "$R" = 1 ] || [ ! -s "$PASSWD" ] || [ "$want_users" != "$have_users" ] || [ "${#NEW_FILES[@]}" -gt 0 ] || [[ " ${NEW_KEYS[*]:-} " == *" MQTT_INGEST_PASSWORD "* ]]; } && rebuild_passwd=1

if [ "$rebuild_passwd" = 1 ]; then
  # Script que se entrega por STDIN a sh: las contraseñas no aparecen en argv del host ni en el entorno.
  script='set -e'$'\n''first=1'$'\n'
  add_user() { script+="if [ \$first = 1 ]; then mosquitto_passwd -b -c /tmp/passwd '$1' '$2' >/dev/null; first=0; else mosquitto_passwd -b /tmp/passwd '$1' '$2' >/dev/null; fi"$'\n'; }
  add_user ingest "${ENV_VALS[MQTT_INGEST_PASSWORD]}"
  add_user healthcheck "$(cat "$MQ/healthcheck.pw")"
  for p in $PLANTS; do add_user "$p" "$(cat "$USERS/$p.pass")"; done
  script+='cat /tmp/passwd'$'\n'
  newpw=$(mktemp)
  if command -v mosquitto_passwd >/dev/null 2>&1; then
    d=$(mktemp -d); sed 's#/tmp/passwd#'"$d"'/passwd#g' <<< "$script" | sh -s >/dev/null && cat "$d/passwd" > "$newpw"; rm -rf "$d"
  elif command -v docker >/dev/null 2>&1; then
    printf '%s' "$script" | docker run --rm -i --network none --entrypoint sh "$MOSQ_IMAGE" -s > "$newpw" \
      || { rm -f "$newpw"; die "no se pudo ejecutar mosquitto_passwd en $MOSQ_IMAGE (¿imagen descargada? prueba: docker pull $MOSQ_IMAGE)"; }
  else
    rm -f "$newpw"; die "se necesita mosquitto_passwd (paquete mosquitto-clients/mosquitto) o Docker para generar el fichero passwd"
  fi
  [ -s "$newpw" ] || { rm -f "$newpw"; die "el fichero passwd generado está vacío"; }
  [ "$(cut -d: -f1 "$newpw" | sort)" = "$want_users" ] || { rm -f "$newpw"; die "el passwd generado no contiene los usuarios esperados"; }
  mv "$newpw" "$PASSWD"; chmod 600 "$PASSWD"
fi

# ---------------------------------------------------------------------------------------------------
# Permisos: el contenedor de Mosquitto corre como uid 1883 y debe poder LEER passwd, server.key y healthcheck.pw.
#  - root:        chown 1883 + 0600 (lo ideal).
#  - sin root:    0644 dentro de directorios 0700 (nadie más del host llega hasta ellos; los bind mounts sí).
# ---------------------------------------------------------------------------------------------------
PERM_NOTE=""
if [ "$(id -u)" = 0 ]; then
  chown "$MOSQ_UID:$MOSQ_UID" "$PASSWD" "$SRV_KEY" "$MQ/healthcheck.pw"
else
  chmod 644 "$PASSWD" "$SRV_KEY" "$MQ/healthcheck.pw"
  PERM_NOTE="no eres root: passwd, server.key y healthcheck.pw quedan 0644 (protegidos por los directorios 0700). Para 0600 exacto: sudo chown $MOSQ_UID:$MOSQ_UID $PASSWD $SRV_KEY $MQ/healthcheck.pw && sudo chmod 600 ..."
fi

# ---------------------------------------------------------------------------------------------------
# .env.prod (0600) — escritura atómica
# ---------------------------------------------------------------------------------------------------
case $OUT_DIR in /*) ENV_VALS[SECRETS_DIR]=$OUT_DIR ;; *) ENV_VALS[SECRETS_DIR]=./${OUT_DIR#./} ;; esac
tmpenv=$(mktemp "${ENV_FILE}.XXXXXX")
{
  echo "# Generado por scripts/bootstrap-secure.sh — NO versionar (está en .gitignore). Permisos 600."
  echo "# Uso: docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file $ENV_FILE --profile apps up -d"
  echo
  echo "# --- Proxy / dominio ---"
  echo "CAMPO_DOMAIN=${ENV_VALS[CAMPO_DOMAIN]}"
  echo "# internal = CA interna de Caddy (localhost/redes privadas). Con dominio real: tu email para ACME (Let's Encrypt)."
  echo "CAMPO_TLS=${ENV_VALS[CAMPO_TLS]}"
  echo "# Strict-Transport-Security (corto en local; un año con dominio real)."
  echo "CAMPO_HSTS=${ENV_VALS[CAMPO_HSTS]}"
  echo "SECRETS_DIR=${ENV_VALS[SECRETS_DIR]}"
  echo
  echo "# --- TimescaleDB ---"
  echo "POSTGRES_USER=${ENV_VALS[POSTGRES_USER]}"
  echo "POSTGRES_DB=${ENV_VALS[POSTGRES_DB]}"
  echo "POSTGRES_PASSWORD=${ENV_VALS[POSTGRES_PASSWORD]}"
  echo
  echo "# --- Redis ---"
  echo "REDIS_PASSWORD=${ENV_VALS[REDIS_PASSWORD]}"
  echo
  echo "# --- API ---"
  echo "JWT_SECRET=${ENV_VALS[JWT_SECRET]}"
  echo "ADMIN_EMAIL=${ENV_VALS[ADMIN_EMAIL]}"
  echo "# Sólo siembra el admin la PRIMERA vez; después la contraseña real vive (hash) en la BD."
  echo "ADMIN_PASSWORD=${ENV_VALS[ADMIN_PASSWORD]}"
  echo
  echo "# --- MQTT ---"
  echo "MQTT_INGEST_PASSWORD=${ENV_VALS[MQTT_INGEST_PASSWORD]}"
  echo "# Simulador (perfil sim): publica como el usuario de esta planta."
  echo "MQTT_SIM_PLANT=${ENV_VALS[MQTT_SIM_PLANT]}"
  echo "MQTT_SIM_PASSWORD=${ENV_VALS[MQTT_SIM_PASSWORD]}"
} > "$tmpenv"
chmod 600 "$tmpenv"; mv "$tmpenv" "$ENV_FILE"

# ---------------------------------------------------------------------------------------------------
# Resumen (sin imprimir secretos, salvo la contraseña inicial del admin la primera vez)
# ---------------------------------------------------------------------------------------------------
echo "Campo 2.0 — material seguro listo"
info "entorno:      $ENV_FILE (600)"
info "certificados: $CERTS/ (ca.crt = confianza de clientes; server.crt/server.key = broker)"
info "SAN broker:   $(cat "$SAN_FILE")"
info "usuarios MQTT: ingest, healthcheck, plantas: $(printf '%s ' $PLANTS)"
info "contraseñas por planta: $USERS/<planta>.pass (entrégalas sólo a los dispositivos de esa planta)"
[ "$CA_CREATED" = 1 ] && info "CA nueva creada (válida 10 años); ca.key puede guardarse fuera de línea tras emitir certificados"
[ "$SRV_ISSUED" = 1 ] && info "certificado del servidor emitido (825 días)"
[ "$rebuild_passwd" = 1 ] && info "passwd de Mosquitto (re)generado"
if [ "$ROTATE" = 1 ]; then
  info "credenciales rotadas: MQTT (ingest, healthcheck, plantas), Redis, JWT_SECRET (cierra las sesiones)$([ "$PG_ROTATED" = 1 ] && echo ', Postgres (ALTER ROLE aplicado)')"
  [ "$PG_ROTATED" = 0 ] && info "Postgres NO rotada (contenedor campo-timescaledb parado: su contraseña vive en el volumen)"
  info "la contraseña del admin de la API no se toca aquí: cámbiala con PATCH /api/users/:id"
  info "aplica los cambios:  docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file $ENV_FILE --profile apps up -d --force-recreate"
fi
[ -n "$PERM_NOTE" ] && warn "$PERM_NOTE"
if [ "$FIRST_RUN" = 1 ]; then
  echo
  echo "Contraseña inicial del admin (${ENV_VALS[ADMIN_EMAIL]}) — se muestra UNA sola vez: ${ENV_VALS[ADMIN_PASSWORD]}"
  echo "(También está en $ENV_FILE; cámbiala tras el primer acceso.)"
else
  info "la contraseña del admin está en $ENV_FILE (ADMIN_PASSWORD)"
fi
