# ARCHITECTURE — agent-browser-extension

Extensión de Chrome (Manifest V3) que deja a un agente controlar un navegador real por WebSocket. Es el lado «navegador» del par `agent-browser-extension` + `agent-browser-server`. Fork de `jibanez-staticduo/agent-jake-browser-mcp-extension` (que viene de SnakeO).

## Clientes y versiones

- Un único cliente: el navegador Chrome donde se instala (Mac y x86; el servidor las distingue por nombre de conexión), con una sola superficie: el side panel (`src/sidepanel/`). El botón de la barra lo abre (`setPanelBehavior({ openPanelOnActionClick: true })`, sin `default_popup`) y Alt+J también. El popup se retiró (INFRA-421).
- Versión 2.4.0 (`package.json` y `manifest.json` coinciden; el nombre del manifiesto es «Browser Harness (pocharlies)»).
- Consumidor: `pocharlies-org/agent-browser-server` (protocolo WebSocket con token). No hay iOS, Mac nativo ni API pública.

## Dependencias (en ambos sentidos)

- Depende de: `agent-browser-server` (WebSocket; la extensión se empareja con un token que emite el servidor, `src/background/pairing.ts`) y de las API de Chrome `debugger`, `scripting`, `tabs`, `webNavigation`, `storage`, `alarms`, `sidePanel`.
- El copiloto del side panel llama a un endpoint OpenAI-compatible (`baseUrl` en `src/types/copilot.ts`), sin servidor de por medio. Lo siembra la provisión (ver «Decisiones y trampas»); si el usuario lo cambia en Opciones, manda lo suyo.
- Dependen de ella: el MCP `browser` de las sesiones (vía el servidor) y el despliegue `k8s-agentjake-browser-mcp-pocharlies` (el servidor sirve el zip de la extensión).
- El protocolo mensaje a mensaje no es un contrato versionado: cambiar un mensaje exige tocar el servidor en el mismo cambio.

## Stack

TypeScript 5.9, Vue 3.5 + Pinia 3 (el side panel es Vue 3 en `src/sidepanel/`; Pinia y `popup/styles` se montan en `sidepanel/main.ts`), Vite 7 con `@crxjs/vite-plugin` 2.0.0-beta.33, zod 4, sharp 0.34. Tests: Playwright 1.57 (e2e) y Vitest 2.1 (unitarios). Node 22.23.2 en CI.

## Componentes compartidos

- `src/background/tool-handlers.ts` y `src/background/tools/`: un handler por herramienta MCP. Una herramienta nueva se añade aquí y en `agent-browser-server/src/tools/`, nunca solo en uno.
- `src/content/` (árbol ARIA, selectores, estado compacto): lo único que toca el DOM de la página.
- `src/background/redact.ts` y `storage-privacy.ts`: redacción de datos sensibles antes de enviar al servidor; no se saltan.
- `src/background/agent/` (bucle del copiloto): ejecuta las herramientas por el mismo `handleMessage` que el WebSocket MCP, nunca con handlers propios. `src/types/copilot.ts`: tipos y ajustes del copiloto.
- `src/sidepanel/`: `App.vue` (barra, conversación, composer), `OptionsView.vue` («Opciones»: conexión MCP, pestaña, actividad, aviso de versión y ajustes del copiloto) y `ModelPicker.vue`. Los estilos de botón, campo y foco del panel viven una sola vez en `src/popup/styles/base.css` (y los tokens, con tema oscuro y claro, en `variables.css`; `tests/unit/sidepanel/contrast.test.ts` exige ≥ 4,5:1 al texto en los dos temas); un componente no redefine el botón. «Qué falta» para enviar es `copilotMissing` en `src/types/copilot.ts` (endpoint, key salvo loopback, modelo), la única regla del worker, el chat y Opciones. `src/popup/` ya no tiene entrada propia: queda como librería de componentes y stores que importa Opciones (`ServerSettings`, `ConnectionStatus`, `TabSelector`, `ActivityLog`, `ActivityModal`, `stores/`, `styles/`); no se copian. `chatModels`/`groupChatModels`/`modelLabel` en `src/sidepanel/chats.ts` son la única lista de modelos de chat (grupos Local / Alibaba / OpenRouter por prefijo `alibaba-` / `or-`). `src/background/provision.ts`: siembra de los ajustes del copiloto.
- `scripts/check-deltas.sh`: aserciones que protegen los cambios propios frente a un auto-update del upstream.

## Cómo se construye

Código en `src/` por contexto de ejecución (`background`, `content`, `popup`, `sidepanel`), constantes en `src/constants/`, configuración de runtime en `src/config/runtime.ts`. Cambio nuevo = rama + PR contra `main`. Una herramienta nueva entra con su test y el cambio simétrico en el servidor. No se añade lógica de negocio en el popup.

## Tests

`npm run typecheck`, `npm run test:unit` (Vitest) y `npm test` (Playwright, no se ejecuta en CI). Los e2e piden un Chrome con la extensión cargada.

## CI/CD y despliegue

`.github/workflows/ci.yml`: jobs `build-test` (tsc + vitest) y `deltas` (`scripts/check-deltas.sh`) en `arc-k8s`, con Node 22.23.2 bajado y verificado por sha256; además los workflows estándar `duplicados.yml` y `pr-review.yml`. No hay publicación en Chrome Web Store: la extensión se carga sin empaquetar o desde el zip que sirve el servidor. Tras cada merge a `main`, el job `desplegar` (runner self-hosted del x86, solo push a main) ejecuta `agent-browser-sync --force all` de `x86-host-runtime-pocharlies`: compila, copia y recarga la extensión en los Chrome del x86 y del Mac a través de `POST /extension/reload` del servidor. Un navegador cerrado o dormido lo pone al día `agent-browser-sync-watch` cuando se conecta.

## Decisiones y trampas

- Abre pestañas en segundo plano por defecto (#10) y trabaja en ellas sin traerlas delante: al adjuntarse activa `Emulation.setFocusEmulationEnabled`. Sin él, una pestaña oculta con una página http no recibe ningún evento CDP de ratón/teclado (es Chrome, medido también en un Chrome limpio) y las herramientas respondían éxito; con él la página cuenta como visible y con foco, recibe la entrada y pinta para la captura. Queda mientras el debugger está adjunto.
- Durante un turno del copiloto la ruta MCP devuelve el error `COPILOT_BUSY` (traffic gate `createCopilotTrafficGate` en `src/background/agent/bridge.ts`): el servidor debe tratarlo como reintentable.
- El job `deltas` falla si un merge de upstream revierte los cambios propios: es un fallo, no un éxito.
- **WebAuthn en las pestañas controladas** (`TabManager.installWebAuthnGuard`, #14–#17): autenticador virtual sin credenciales y sin UI, así que toda petición de llave o passkey falla en milisegundos y la web ofrece su otro método (TOTP de 1Password con `browser_fill_secret`). 1Password Nightly sustituye `navigator.credentials` en la página y se queda las peticiones sin cuenta (cuelgan y Chrome suelta el debugger): `pinWebAuthn` devuelve `get/create` a Chrome y, si 1Password los dejó no configurables, da a la página un contenedor sustituto. Va por CDP (documentos nuevos, antes que los content scripts) y por `chrome.scripting` (iframes de otro sitio). Residual: un override sobre `CredentialsContainer.prototype` hecho antes de llegar nosotros.
- `browser_new_tab` abre en `about:blank`, adjunta y luego navega (#16): el guard solo gana en documentos creados después de adjuntar. La primera entrada del historial es `about:blank`.
- **Aviso de versión nueva** (`background/update-check.ts`): tras instalar en x86 y Mac, `agent-browser-sync.sh all` (x86-host-runtime, el único camino que construye y copia la extensión) publica en el servidor MCP la build de main: zip neutro + `latest.json` con `build` = nº de commits (main no se reescribe). Cada extensión instalada lee `/download/latest.json` de su servidor al arrancar el navegador, al instalarse o recargarse y cada 30 min (alarma `ajb-update-check`); si `build` supera el suyo (`VITE_BUILD_NUMBER`, lo pone `vite.config.ts` desde git), icono con NEW, aviso en el popup y una notificación de Chrome por build. Un navegador con servidor local (127.0.0.1) solo comprueba si su build trae `VITE_LATEST_URL` (el Mac de CloudBlue apunta al pod).
- La extensión sigue una sola pestaña por navegador; el servidor manda en cada comando la pestaña de la sesión que lo pide (`targetTabId`) y `routeToTargetTab` se conecta a ella antes, sin activarla. Así varias sesiones MCP comparten un Chrome sin actuar en la pestaña de otra. Si esa pestaña ya no existe, `TAB_GONE` (se comprueba antes de `connectTab`, que suelta la pestaña actual primero). Trampas del modelo:
  - **Depende de la cola del servidor** (`session-tabs`, un comando a la vez por navegador): la extensión atiende los mensajes en paralelo, y la atomicidad de «conectar + ejecutar» la da el servidor. 
  - Cada cambio de pestaña entre sesiones es un detach/attach: se reinicia la captura de red y consola (`pageEvents`), se reinstala el guard de WebAuthn y lo que vive en la sesión del debugger (p. ej. un `browser_resize_viewport`) se pierde. El destino es un debugger adjunto a varias pestañas con `pageEvents` por pestaña.
  - Una extensión anterior a esto ignora `targetTabId` y actúa en la pestaña conectada, como antes.
- Toda herramienta que actúa sobre un elemento acepta `ref` **o** `selector` (el servidor MCP anuncia los dos); el selector es del frame principal.
- Los clones de trabajo tienen tres remotos (`origin`, `upstream`, `fork`) y hay clones duplicados en el host (ver C5 de SC-1425).
- **Provisión de los ajustes del copiloto** (`background/provision.ts`, INFRA-452): `agent-browser-sync` (x86-host-runtime) compila con `VITE_COPILOT_BASE_URL` y `VITE_COPILOT_API_KEY`, leídos de ficheros locales del host fuera de cualquier repo, en los dos builds (x86 y Mac) y nunca en el zip neutro que sirve `/download`. En `onInstalled` y `onStartup` el service worker siembra `chrome.storage.local[copilotSettings]`: sobrescribe `baseUrl`/`apiKey` si lo guardado está vacío o es igual a lo último sembrado (`copilotProvisioned` guarda los SHA-256, no la key), así una key rotada llega al navegador; lo que el usuario cambió en Opciones no se toca. El modelo por defecto es `DEFAULT_COPILOT_SETTINGS.model` (`qwen38-flash-next`). La key queda en el bundle compilado del host (como el token WS): clave virtual de LiteLLM solo de chat, rotable. Sin esas variables en el build, no hace nada y el panel muestra el aviso «Abrir Opciones».
