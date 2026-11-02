#!/usr/bin/env bash
# Comprueba que cada servicio de la pila se apaga de forma ordenada: rápido (< MAX s) y sin que Docker
# tenga que matarlo (código 137). Un cierre colgado retrasa cada despliegue y puede cortar peticiones.
# Uso: scripts/check-shutdown.sh [contenedor...]   (por defecto, los servicios de Campo que estén corriendo)
set -uo pipefail
MAX=${MAX:-5}
CONTAINERS=("$@")
[ ${#CONTAINERS[@]} -eq 0 ] && mapfile -t CONTAINERS < <(docker ps --format '{{.Names}}' | grep '^campo-' | sort)
[ ${#CONTAINERS[@]} -gt 0 ] || { echo "No hay contenedores campo-* en marcha." >&2; exit 2; }
FAIL=0
for c in "${CONTAINERS[@]}"; do
  s=$(date +%s.%N); docker stop "$c" >/dev/null 2>&1; e=$(date +%s.%N)
  secs=$(awk -v a="$s" -v b="$e" 'BEGIN { printf "%.1f", b - a }'); code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  # 0 = salida limpia; 143 = terminado por SIGTERM sin handler (aceptable); 137 = SIGKILL por exceder el plazo
  if [ "$code" = 137 ] || awk -v t="$secs" -v m="$MAX" 'BEGIN { exit !(t > m) }'; then
    printf '  \033[31mFALLA\033[0m %-22s %5s s  exit=%s\n' "$c" "$secs" "$code"; FAIL=1
  else
    printf '  \033[32mOK\033[0m    %-22s %5s s  exit=%s\n' "$c" "$secs" "$code"
  fi
done
exit "$FAIL"
