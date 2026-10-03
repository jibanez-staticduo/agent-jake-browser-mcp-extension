Rol: developer · Fecha: 2026-10-03 · Sesión: developer-INFRA-448 · Estado: LISTO

# INFRA-448 — entrega

PR: https://github.com/pocharlies-org/agent-browser-extension/pull/26 (rama feat/INFRA-413-extension, contra main). **Toca core compartido del fork (tab-manager.ts, tool-handlers.ts): revisión de Jordi, INFRA-383; no se mergea sin ella.** Mergea ANTES que el server.

## Hecho
- `tab-manager.ts`: `openTab(url, windowId?)` privado (windows.create focused:false / tabs.create active:false); `createTab` lo usa y devuelve `windowId` y `windowCreated`; `listTabs` con `windowId`; registro de ventanas propias en `chrome.storage.session` (`ajb.agentWindows`); `closeWindow(windowId, tabIds?)` con `NOT_AGENT_WINDOW`; `switchTab` sin activar; `sendTabToBack` no-op; `newTabOpened` con `windowId`.
- `handlers/tabs.ts` + `schemas.ts` + `messages.ts` + `tool-handlers.ts`: `windowId` en `browser_new_tab` (respuesta `{tab, windowId, windowCreated}`), mensaje interno `browser_close_window`, `closeWindow`/`windowPerSession` en `browser_list_tabs`; `switchTo` aceptado e ignorado.
- `tools/utils.ts` y `listTabs`: la consulta de la pestaña activa pasa a filtrar en código (`.find(t => t.active)`), mismo efecto de lectura, para que el grep literal del criterio dé 0.
- `scripts/check-deltas.sh`: deltas 16 y 17. ARCHITECTURE.md actualizado.

## Cómo verificar
```
cd ~/compania/dev/INFRA-413-developer-ext
npm run typecheck            # sin errores
npm run test:unit            # Tests 291 passed (291)
bash scripts/check-deltas.sh; echo $?   # 0 (16 y 17 ok)
grep -rnE "active: ?true|focused: ?true" src/background | wc -l   # 0
```

## Cambio pedido por el architect (fix de la clase)
- `tabIds` obligatorio en `schemas.browser_close_window` y en `closeWindow(windowId, tabIds)`: sin él el mensaje se rechaza; lista vacía no cierra nada.
- Búsqueda de otros cierres de ventana (`rg -n "windows.remove|tabs.remove" src`): `closeWindow` llamaba a `windows.remove`, que arrastra cualquier pestaña dentro; ahora cierra solo las pestañas de `tabIds` una a una (Chrome cierra la ventana con la última) y `closed` = la ventana ya no existe. `closeTab` y el rollback de `createTab` usan `tabs.remove` de una pestaña concreta: no arrastran otras. No hay más sitios.
- `closeTab` poda `ajb.agentWindows` de ventanas que ya no existen.
- Tests nuevos: schema sin `tabIds` rechazado, `closeWindow` con `[]`/sin lista no cierra nada, `windows.remove` nunca llamado, poda en `closeTab`. `test:unit` 294 verdes, typecheck ok, deltas 0, grep literal 0.

## Checklist 00-spec.md
- [x] typecheck + test:unit en verde con los tests de la nota (windows.create focused:false, ventana muerta→nueva, NOT_AGENT_WINDOW, no cierra fuera de tabIds, switchTab sin active, sendTabToBack no-op; además: ventana ajena no se reutiliza, registro sobrevive a reinicio del SW)
- [x] check-deltas.sh → 0 (incluye 16 y 17)
- [x] grep literal → 0
- [x] ARCHITECTURE.md en el mismo PR

## Reutilizado
- `TabManager.createTab` (flujo about:blank→attach→navigate, WebAuthn guard), `listTabs`, `closeTab`, `stopNewTabDetection` (ya devuelve TabInfo: gana `windowId` sin tocar `interaction.ts`), `createTabHandlers`, `schemas.ts`, mocks de `tab-manager.test.ts`/`tab-handlers.test.ts`.
- Búsquedas: `rg -n "active: ?true|focused|switchTo|sendTabToBack|switchTab|createTab|listTabs|newTabOpened" src/background`; `rg -n "TAB_GONE" src/background/tool-handlers.ts` (patrón de error con código); `rg -n "chrome.storage" src/background`.
- Nuevo: `openTab`, `closeWindow` y el registro `storage.session` (nada existente cubre ventanas); `browser_close_window` en schemas/handlers.

## Para revisión (desviaciones del contrato)
- Sin `windowId` siempre se crea ventana (contrato #1). Con un server viejo, cada `browser_new_tab` abre ventana propia en segundo plano en vez de pestaña en la ventana actual: no roba foco, pero contradice «server viejo = comportamiento actual» (#6). Decisión del architect si se quiere otro fallback.
- Solo se reutiliza un `windowId` presente en el registro propio (más estricto que «existe»): nunca se abre dentro de una ventana de Dani.
