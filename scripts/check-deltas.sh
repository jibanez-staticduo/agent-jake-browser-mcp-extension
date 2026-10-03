#!/usr/bin/env bash
# Copia versionada en este fork del subset de aserciones de
# ~/mcp-servers/agent-browser/scripts/check-deltas.sh que le toca a la extension
# (deltas 2, 2b y 3-10). Ruling CTO DGX-309: el script compartido NO se mueve ni
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
# El servidor cierra por id las pestañas inactivas del agente: ignorar el id cerraba la conectada.
chk "10 browser_close_tab cierra el tabId pedido"   bash -c 'grep -q "schemas.browser_close_tab.parse" src/background/tools/handlers/tabs.ts && grep -q "closeById: true" src/background/tools/handlers/tabs.ts'
chk "11 guard de WebAuthn (sin diálogo nativo, 1Password fijado)" bash -c 'grep -q "WebAuthn.addVirtualAuthenticator" src/background/tab-manager.ts && grep -q "export function pinWebAuthn" src/background/tab-manager.ts && grep -q "pinWebAuthnInFrames" src/background/tab-manager.ts'
chk "12 ref o selector en las herramientas de elemento" grep -q "resolveTarget" src/background/tools/utils.ts
chk "13 foco emulado: la entrada llega a pestañas en segundo plano" grep -q "Emulation.setFocusEmulationEnabled" src/background/tab-manager.ts
chk "14 cada comando va a la pestaña de su sesión (targetTabId)" grep -q "routeToTargetTab(tabManager, payload)" src/background/tool-handlers.ts
chk "15 aviso de versión nueva (al arrancar y cada 30 min)" bash -c 'grep -q "UPDATE_PERIOD_MINUTES = 30" src/background/update-check.ts && grep -q "onStartup" src/background/index.ts'
exit $fail
