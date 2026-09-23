#!/usr/bin/env bash
# Copia versionada en este fork del subset de aserciones de
# ~/mcp-servers/agent-browser/scripts/check-deltas.sh que le toca a la extension
# (deltas 2, 2b y 3-9). Ruling CTO DGX-309: el script compartido NO se mueve ni
# se cambia (lo usa el timer systemd de producción); esta copia está adaptada
# a un checkout de un solo repo, con rutas relativas a la raíz del repo.
# Un auto-update que revierta cualquiera de estos es un FALLO, no un exito.
set -u
cd "$(dirname "$0")/.."
fail=0
chk() { # chk <descripcion> <comando grep...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok    $desc"; else echo "  FALLO $desc"; fail=1; fi
}
not() { local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  FALLO $desc"; fail=1; else echo "  ok    $desc"; fi
}
chk "2 default extension es 127.0.0.1"              grep -q "VITE_WS_HOST ?? '127.0.0.1'" src/types/config.ts
not "2b el host de terceros no volvio (en codigo)"   bash -c "grep -v '^[[:space:]]*//' src/types/config.ts | grep -q agent-browser.staticduo.com"
not "3 permiso identity retirado"                   grep -q '"identity"' manifest.json
chk "4 keep-alive sin condicion de pestana"         bash -c "! grep -q 'alarms.clear(KEEPALIVE_ALARM)' src/background/index.ts"
chk "5 auto-enganche de la pestana activa"          grep -q "lastFocusedWindow" src/background/tools/utils.ts
chk "6 sonda del content script"                    grep -q "Receiving end does not exist" src/background/tools/utils.ts
chk "7 browser_state DOM-first"                     test -f src/content/compact-state.ts
chk "8 all_frames activo"                           grep -q '"all_frames": true' manifest.json
# upstream #8 movio el token de ws-client.ts a src/config/runtime.ts
# (ajb.token ?? CONFIG.WS_TOKEN, lo manda buildWsUrl). La funcionalidad sigue:
# se comprueba ahi, no en el fichero viejo.
chk "9 token soportado en el cliente WS"            grep -q WS_TOKEN src/config/runtime.ts
exit $fail
