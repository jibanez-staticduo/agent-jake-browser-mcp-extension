# Autoactualización de la extensión (sin pipelines por navegador)

Fecha: 2026-10-05 · Repo: `pocharlies-org/agent-browser-extension` · Estado: diseño aprobado, spec en revisión

## 1. Objetivo

La extensión se pone al día ella sola en cada Chrome (x86, MacBook Air personal y Mac de
CloudBlue), sin scripts en las máquinas. Después se retiran el job `desplegar`, el script
`agent-browser-sync.sh` con su vigilante `agent-browser-sync-watch` en el x86, y el job de launchd
`com.pocharlies.agent-browser-update` del Mac de CloudBlue.

**Criterios de éxito**
- C1. Tras un merge a `main`, cada navegador migrado y abierto corre la build nueva en ≤ 35 min si
  no hay un agente usándolo (comprobación cada 30 min + 5 min sin llamadas MCP), sin intervención
  ni script de host.
- C2. Ninguna build publicada lleva token WS, URL de servidor ni clave del copiloto.
- C3. La extensión no escribe ni un byte si la firma o algún sha256 no cuadran.
- C4. Un navegador que no cumple las condiciones (carpeta fuera de Descargas, «Preguntar dónde
  guardar» activo) no se rompe: sigue con su versión y avisa de qué cambiar.

## 2. Restricciones verificadas (spike del 2026-10-05, Chrome 154 y Chromium 148 en macOS)

Funciona: `chrome.downloads.download` con `conflictAction:'overwrite'` y `saveAs:false` reescribe la
carpeta de la extensión si está dentro del directorio de descargas, y `chrome.runtime.reload()`
arranca la versión nueva con el mismo id. Ed25519 de WebCrypto funciona en el service worker. Un
`data:` de 3 MB pasa. Las marcas `com.apple.quarantine` no impiden la carga.

Condiciones:
- R1. «Preguntar dónde guardar cada archivo» desactivado (`download.prompt_for_download`): si está
  activo, `saveAs:false` NO lo anula y la descarga se cuelga (con ventana) o se cancela (headless).
- R2. Modo desarrollador activo: si no, `chrome.runtime.reload()` deja la extensión deshabilitada
  (`unsupportedDeveloperExtension`). Hoy ya se cumple: la recarga que usa el sync funciona.
- R3. Nombres que empiezan por `.` dan «Invalid filename».
- R4. El MIME del `data:` decide la extensión: `text/plain` para un `.js` lo guarda como `.txt`.
  Hay que usar el MIME correcto por tipo de fichero.
- R5. La carpeta instalada tiene que estar dentro del directorio de descargas del perfil.

## 3. Diseño

### 3.1 Paquete publicado

El zip que sirve `/download` lleva en la raíz, además de la extensión:
- `update-files.json`: `{"version":"2.4.0.N","build":N,"sha":"<short>","files":[{"path":"assets/x.js","sha256":"<hex>","size":123}, …]}`.
  Lista todos los ficheros de la extensión menos él mismo y su firma.
- `update-files.json.sig`: firma Ed25519 (base64) de los bytes exactos de `update-files.json`.

`latest.json` no cambia (`version`, `build`, `sha`, `publishedAt`), así que **el servidor no se
toca**. El `config.json` que el servidor inyecta en el zip no está en la lista y se ignora.

### 3.2 Módulo `src/background/self-update.ts`

Inyección de dependencias como `update-check.ts` (fetch, downloads, storage, reload, notify, now)
para poder testearlo sin Chrome. Se llama desde el mismo punto que `checkForUpdate` (arranque,
instalación/recarga y alarma `ajb-update-check` de 30 min) cuando `state.available` es true.

Pasos:
1. **Cerrojo** en `chrome.storage.local` (`ajb.selfUpdate.lock` con timestamp, caduca a los 10 min).
2. **Inactividad**: si hubo una llamada de herramienta MCP en los últimos 5 min (último timestamp
   de `activity-log`), no se aplica; lo reintenta la siguiente pasada.
3. **Sonda de carpeta** (R5): descarga `agent-jake-probe-<rand>.txt` a `<carpeta>/` y lo lee con
   `fetch(chrome.runtime.getURL(...))`. `<carpeta>` = `agent-jake-browser` (constante). Si no se
   lee, o la descarga sigue `in_progress` a los 15 s (R1), cancela, borra y avisa (3.4). Al acabar
   borra la sonda (`removeFile` + `erase`).
4. **Descarga y verificación**: baja el zip, lo abre en memoria (`fflate`), verifica la firma de
   `update-files.json` con la clave pública fijada en `src/config/update-key.ts`, comprueba
   `build === latest.build`, `build > CONFIG.BUILD_NUMBER` (sin downgrade ni repetición) y el
   sha256 y tamaño de cada fichero. Cualquier fallo: aborta sin escribir.
5. **Escritura** con `downloads.setUiOptions({enabled:false})` (restaurado en `finally`), en este
   orden: ficheros con hash en el nombre (`assets/*`), después `manifest.json`, al final los de
   entrada sin hash (`service-worker-loader.js`, `src/**/index.html`, iconos). Cada uno como `data:`
   con el MIME de su extensión (R4), `conflictAction:'overwrite'`, `saveAs:false`. Se comprueba que
   cada descarga acaba `complete` con el nombre exacto (sin « (1)»).
6. **Registro**: guarda en `ajb.selfUpdate.files` el mapa `path → downloadId` de lo escrito.
7. **Recarga**: `chrome.runtime.reload()`.
8. **Tras arrancar**: antes de recargar se deja `ajb.selfUpdate.pendingCleanup` en storage; el
   service worker, al arrancar con esa marca y la versión nueva, borra con `removeFile` los ficheros de la
   versión anterior que ya no están en la lista, y con `erase` todo el historial de descargas del
   update. Los ficheros de la instalación inicial (sin downloadId) se quedan: son inofensivos.

### 3.3 Build única y configuración

- La build publicada es neutra: sin `VITE_WS_*`, `VITE_COPILOT_*` ni token. URL, token y ajustes del
  copiloto viven en `chrome.storage.local` (Opciones o pairing, que ya existen).
- `VITE_LATEST_URL` se fija en la build publicada a `https://browser-mcp.lan.e-dani.com/download/latest.json`
  (no es secreto), para que los navegadores en modo local también comprueben.
- `manifest.json`: campo `key` (id estable aunque cambie la carpeta) y permisos `downloads` y
  `downloads.ui`.

### 3.4 Avisos

Badge + notificación de Chrome (una por causa y build), sin texto con secretos:
- carpeta fuera de Descargas → «Instálala desde Descargas/agent-jake-browser para que se actualice sola»;
- descarga colgada → «Desactiva "Preguntar dónde guardar cada archivo"»;
- firma o hash inválidos → «Actualización rechazada: firma no válida» (y log).
El aviso actual de versión nueva se mantiene para esos casos.

### 3.5 Publicación (CI)

El job `publicar` sustituye a `desplegar` (solo `push` a `main`, runner `[self-hosted, x86, agent-browser]`,
porque es el que tiene `kubectl` hacia el pod; nunca en `pull_request`). Ejecuta `scripts/publicar.sh`,
del repo:
1. `git archive HEAD` a un directorio temporal (sin `.env.local`) y build con
   `VITE_BUILD_NUMBER=$(git rev-list --count HEAD)`, `VITE_BUILD_SHA`, `VITE_LATEST_URL` y nada más.
2. Sella `manifest.version` a `2.4.0.N`.
3. Comprueba que no lleva tokens (patrón de `publicar()` de agent-browser-sync).
4. Genera `update-files.json` y lo firma con `AJB_UPDATE_SIGNING_KEY` (secreto de GitHub Actions,
   Ed25519 PKCS8). La clave privada no se escribe en disco.
5. Sube zip + `latest.json` al PVC del pod (`/data/extension`) con `kubectl cp` + `mv` atómico, y
   comprueba que `latest.json` público anuncia la build.

## 4. Migración (una vez por navegador)

1. Bajar el zip de `/download` y descomprimirlo en `~/Downloads/agent-jake-browser/`.
2. Quitar la extensión vieja y «Cargar descomprimida» la nueva (id nuevo por el `key`).
3. Configurar en Opciones la URL y el token (o pairing). Lo hace Daniel: son credenciales.
   Mac de CloudBlue: `ws://127.0.0.1:8765`; x86 y MacBook Air: `wss://browser-mcp.lan.e-dani.com/ws`.
4. Copiloto: en x86 y MacBook Air, la clave en Opciones (antes la sembraba el build del host).
5. Pod: actualizar `AGENT_BROWSER_CONNECTION_LABELS` con los `connectionId` nuevos.

## 5. Retirada por fases

- F1: merge de este PR → `publicar` publica la build firmada.
- F2: migración de los tres navegadores (4).
- F3: prueba real: un merge cualquiera y los tres se actualizan solos (C1).
- F4: PR en `x86-host-runtime-pocharlies` que borra `agent-browser-sync.sh`, `agent-browser-sync-watch.py`
  y su unidad; desinstalar `com.pocharlies.agent-browser-update` del Mac de CloudBlue.
  Hasta F4 conviven: el vigilante sigue sincronizando las carpetas viejas, que ya no usa nadie.

## 6. Seguridad

- La firma es la frontera: un pod comprometido no puede colar código sin la clave de CI.
- Quien hace merge a `main` despliega en los tres navegadores (igual que hoy).
- La clave privada solo existe como secreto del repo, usada solo en `publicar` (`push` a `main`).
- Sin downgrade: `build` tiene que crecer.
- Nunca se escribe un fichero fuera de la lista firmada ni fuera de `agent-jake-browser/`
  (se rechazan rutas absolutas, `..` y nombres con `.` inicial).

## 7. Tests

Vitest con dependencias falsas (`tests/unit/background/self-update.test.ts`): firma válida/ inválida,
sha256 que no cuadra, downgrade y build repetida, sonda que falla, descarga colgada, orden de
escritura y MIME por tipo, rutas peligrosas, cerrojo, puerta de inactividad, limpieza tras recarga.
`scripts/check-deltas.sh`: aserción nueva para `self-update.ts` y los permisos. `publicar.sh`: modo
`--dry-run` que construye, firma con una clave de prueba y verifica, sin subir.

## 8. Fuera de alcance

Servidor (sin cambios), Chrome Web Store, actualización del servidor MCP local del Mac de CloudBlue
(sigue con su aviso de deriva), siembra del copiloto en build (pasa a Opciones).
