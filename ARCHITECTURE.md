# ARCHITECTURE — agent-browser-extension

Extensión de Chrome (Manifest V3) que deja a un agente controlar un navegador real por WebSocket. Es el lado «navegador» del par `agent-browser-extension` + `agent-browser-server`. Fork de `jibanez-staticduo/agent-jake-browser-mcp-extension` (que viene de SnakeO).

## Clientes y versiones

- Un único cliente: el navegador Chrome donde se instala (Mac y x86; el servidor las distingue por nombre de conexión), con dos superficies: el popup y el side panel (copiloto, Alt+J) en `src/sidepanel/`.
- Versión 2.4.0 (`package.json` y `manifest.json` coinciden; el nombre del manifiesto es «Browser Harness (pocharlies)»).
- Consumidor: `pocharlies-org/agent-browser-server` (protocolo WebSocket con token). No hay iOS, Mac nativo ni API pública.

## Dependencias (en ambos sentidos)

- Depende de: `agent-browser-server` (WebSocket; la extensión se empareja con un token que emite el servidor, `src/background/pairing.ts`) y de las API de Chrome `debugger`, `scripting`, `tabs`, `webNavigation`, `storage`, `alarms`, `sidePanel`.
- El copiloto del side panel llama a un endpoint OpenAI-compatible que configura el usuario (`baseUrl` en `src/types/copilot.ts`, vacío por defecto), sin servidor de por medio.
- Dependen de ella: el MCP `browser` de las sesiones (vía el servidor) y el despliegue `k8s-agentjake-browser-mcp-pocharlies` (el servidor sirve el zip de la extensión).
- El protocolo mensaje a mensaje no es un contrato versionado: cambiar un mensaje exige tocar el servidor en el mismo cambio.

## Stack

TypeScript 5.9, Vue 3.5 + Pinia 3 (popup; el side panel es Vue 3 en `src/sidepanel/`), Vite 7 con `@crxjs/vite-plugin` 2.0.0-beta.33, zod 4, sharp 0.34. Tests: Playwright 1.57 (e2e) y Vitest 2.1 (unitarios). Node 22.23.2 en CI.

## Componentes compartidos

- `src/background/tool-handlers.ts` y `src/background/tools/`: un handler por herramienta MCP. Una herramienta nueva se añade aquí y en `agent-browser-server/src/tools/`, nunca solo en uno.
- `src/content/` (árbol ARIA, selectores, estado compacto): lo único que toca el DOM de la página.
- `src/background/redact.ts` y `storage-privacy.ts`: redacción de datos sensibles antes de enviar al servidor; no se saltan.
- `src/background/agent/` (bucle del copiloto): ejecuta las herramientas por el mismo `handleMessage` que el WebSocket MCP, nunca con handlers propios. `src/types/copilot.ts`: tipos y ajustes del copiloto.
- `scripts/check-deltas.sh`: aserciones que protegen los cambios propios frente a un auto-update del upstream.

## Cómo se construye

Código en `src/` por contexto de ejecución (`background`, `content`, `popup`, `sidepanel`), constantes en `src/constants/`, configuración de runtime en `src/config/runtime.ts`. Cambio nuevo = rama + PR contra `main`. Una herramienta nueva entra con su test y el cambio simétrico en el servidor. No se añade lógica de negocio en el popup.

## Tests

`npm run typecheck`, `npm run test:unit` (Vitest) y `npm test` (Playwright, no se ejecuta en CI). Los e2e piden un Chrome con la extensión cargada.

## CI/CD y despliegue

`.github/workflows/ci.yml`: jobs `build-test` (tsc + vitest) y `deltas` (`scripts/check-deltas.sh`) en `arc-k8s`, con Node 22.23.2 bajado y verificado por sha256; además los workflows estándar `duplicados.yml` y `pr-review.yml`. No hay publicación en Chrome Web Store: la extensión se carga sin empaquetar o desde el zip que sirve el servidor. Tras cada merge a `main`, el job `desplegar` (runner self-hosted del x86, solo push a main) ejecuta `agent-browser-sync --force all` de `x86-host-runtime-pocharlies`: compila, copia y recarga la extensión en los Chrome del x86 y del Mac a través de `POST /extension/reload` del servidor. Un navegador cerrado o dormido lo pone al día `agent-browser-sync-watch` cuando se conecta.

## Decisiones y trampas

- Abre pestañas en segundo plano por defecto (#10), pero la captura y las herramientas que actúan con eventos CDP de ratón/teclado (`INPUT_TOOLS`: click, type, hover, drag, press_key) traen la pestaña al frente mientras dura la acción y devuelven la que se veía (`TabManager.withTabInFront`, en cola: las sesiones MCP llegan en paralelo). En el Chrome del x86 una pestaña oculta no recibe ningún evento CDP de entrada y las herramientas respondían éxito. Lo que va por JS o por CDP sin entrada (evaluate, state, fill_form, select_option, drop, iframe_click, navigate) sigue en segundo plano.
- Durante un turno del copiloto la ruta MCP devuelve el error `COPILOT_BUSY` (traffic gate `createCopilotTrafficGate` en `src/background/agent/bridge.ts`): el servidor debe tratarlo como reintentable.
- El job `deltas` falla si un merge de upstream revierte los cambios propios: es un fallo, no un éxito.
- **WebAuthn en las pestañas controladas** (`TabManager.installWebAuthnGuard`, #14–#17): autenticador virtual sin credenciales y sin UI, así que toda petición de llave o passkey falla en milisegundos y la web ofrece su otro método (TOTP de 1Password con `browser_fill_secret`). 1Password Nightly sustituye `navigator.credentials` en la página y se queda las peticiones sin cuenta (cuelgan y Chrome suelta el debugger): `pinWebAuthn` devuelve `get/create` a Chrome y, si 1Password los dejó no configurables, da a la página un contenedor sustituto. Va por CDP (documentos nuevos, antes que los content scripts) y por `chrome.scripting` (iframes de otro sitio). Residual: un override sobre `CredentialsContainer.prototype` hecho antes de llegar nosotros.
- `browser_new_tab` abre en `about:blank`, adjunta y luego navega (#16): el guard solo gana en documentos creados después de adjuntar. La primera entrada del historial es `about:blank`.
- Toda herramienta que actúa sobre un elemento acepta `ref` **o** `selector` (el servidor MCP anuncia los dos); el selector es del frame principal.
- Los clones de trabajo tienen tres remotos (`origin`, `upstream`, `fork`) y hay clones duplicados en el host (ver C5 de SC-1425).
