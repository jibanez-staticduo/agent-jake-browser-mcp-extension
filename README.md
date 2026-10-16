# Agent Jake Browser MCP Extension

[![Version](https://img.shields.io/badge/version-2.5.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Chrome Extension](https://img.shields.io/badge/chrome-extension-yellow.svg)](https://developer.chrome.com/docs/extensions/)

A Chrome extension that enables AI agents to automate browser interactions through the Model Context Protocol (MCP) and Laravel Reverb WebSocket.

## Overview

This extension bridges AI agents with browser automation, supporting two connection modes:

- **Local Mode**: Direct WebSocket connection to [agent-jake-browser-mcp-server](https://github.com/SnakeO/agent-jake-browser-mcp-server) for AI agents like Claude
- **Remote Mode**: WebSocket connection to Laravel backend via Reverb for server-coordinated automation

Together, these provide a complete browser automation solution enabling AI agents to navigate websites, click elements, fill forms, take screenshots, and more.

## Session windows (2.5.0)

`browser_list_tabs` advertises `closeById`, `closeWindow` and `windowPerSession`.
`browser_new_tab` accepts an optional session `windowId` and returns
`{ tab, windowId, windowCreated }`. A missing, closed or unverified window opens a
new unfocused window; a verified window receives an inactive tab. `switchTo` is
accepted for compatibility and ignored. Agent switching and screenshot capture
never activate tabs or focus windows; popup buttons remain explicit user actions.
Older servers remain compatible but open a separate window for each new tab.

The internal `browser_close_window` message requires `{ windowId, tabIds }`.
It removes only named tabs still in a verified agent window, never calls
`windows.remove`, and returns `{ windowId, closed, closedTabIds }`. Missing tabs
are omitted from `closedTabIds`; user tabs moved into the window remain open.
An empty list removes nothing. Failed removals of still-live tabs are errors.

Ownership survives worker restarts and extension reloads/updates through private
`storage.local` records of created tabs and their Chrome debugger target UUIDs.
A numeric window/tab ID alone grants no ownership: live UUID and window membership
must match. Browser restarts create new targets, so restored or reused numeric IDs
are rejected. If every created witness tab is closed or moved out, the remaining
window loses agent ownership. Registry operations are serialized and rejected
operations do not block later cleanup.

Chrome API references: [debugger targets](https://developer.chrome.com/docs/extensions/reference/api/debugger)
and [storage session lifetime](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Architecture

```
┌─────────────────┐     stdio      ┌─────────────────┐   WebSocket    ┌──────────────────┐
│   AI Agent      │◄──────────────►│   MCP Server    │◄──────────────►│ Chrome Extension │
│ (Claude, etc.)  │   JSON-RPC     │  (Node.js)      │   port 8765    │  (This project)  │
└─────────────────┘                └─────────────────┘                └────────┬─────────┘
                                                                               │
                  ┌─────────────────┐   Reverb WS    ┌──────────────────────────┤
                  │  Laravel Server │◄──────────────►│                          │
                  │ (agent-jake-app)│   port 8085    │                          │
                  └─────────────────┘                │   Chrome Debugger API    │
                                                     ▼                          │
                                            ┌──────────────────┐               │
                                            │   Browser Tab    │◄──────────────┘
                                            │  (Any website)   │
                                            └──────────────────┘
```

### Connection Details

#### 1. AI Agent ↔ MCP Server (stdio/JSON-RPC)

| Aspect | Details |
|--------|---------|
| **What** | Claude (or other AI) communicates with a local Node.js MCP server |
| **How** | The AI spawns the MCP server as a subprocess. Communication happens via stdin/stdout using JSON-RPC 2.0 protocol |
| **Why** | MCP (Model Context Protocol) is Anthropic's standard for giving AI agents access to external tools. The server translates AI tool calls into browser commands |
| **Protocol** | JSON-RPC 2.0 over stdio (stdin/stdout pipes) |

#### 2. MCP Server ↔ Chrome Extension (WebSocket)

| Aspect | Details |
|--------|---------|
| **What** | The MCP server relays browser commands to the extension |
| **How** | WebSocket connection on `localhost:8765`. Server sends tool requests, extension returns results |
| **Why** | WebSockets provide persistent, bidirectional communication. The extension runs in Chrome's isolated context and needs a bridge to receive external commands |
| **Protocol** | WebSocket with JSON messages |
| **File** | `src/background/ws-client.ts` |

#### 3. Laravel Server ↔ Chrome Extension (Reverb WebSocket)

| Aspect | Details |
|--------|---------|
| **What** | Laravel backend sends browser commands via real-time WebSocket |
| **How** | Extension authenticates with Sanctum token, subscribes to private channel `extension.{userId}` via Laravel Reverb (Pusher protocol) |
| **Why** | Enables server-coordinated automation. Commands can be queued in the database and broadcast when the extension is online. Supports multiple extensions per user |
| **Protocol** | Pusher protocol over WebSocket (port 8085) |
| **File** | `src/background/reverb-client.ts` |

#### 4. Chrome Extension ↔ Browser Tab (Chrome Debugger API)

| Aspect | Details |
|--------|---------|
| **What** | Extension controls the browser tab using Chrome DevTools Protocol (CDP) |
| **How** | Extension attaches debugger to target tab, sends CDP commands for mouse/keyboard events, JavaScript evaluation, screenshots |
| **Why** | CDP provides low-level browser control that works on any website without content script limitations. Can simulate real user input |
| **Protocol** | Chrome Debugger API (CDP wrapper) |
| **File** | `src/background/tab-manager.ts` |

#### 5. Chrome Extension ↔ Content Script (Chrome Messaging)

| Aspect | Details |
|--------|---------|
| **What** | Extension communicates with injected content script for DOM operations |
| **How** | `chrome.tabs.sendMessage()` / `chrome.runtime.onMessage` |
| **Why** | Content scripts run in the page context and can build the ARIA accessibility tree, maintain element references, and access DOM APIs not available via CDP |
| **Protocol** | Chrome extension messaging API |
| **Files** | `src/content/index.ts`, `src/content/aria-tree.ts` |

### Data Flow Example

**AI requests "click the login button":**

1. Claude sends `tools/call` with `click` tool → MCP Server (stdio)
2. MCP Server sends `{"tool": "click", "selector": "s1e42"}` → Extension (WebSocket)
3. Extension looks up element reference `s1e42` → Content Script (messaging)
4. Content Script returns element coordinates → Extension
5. Extension sends `Input.dispatchMouseEvent` → Browser Tab (CDP)
6. Browser executes click, Extension returns success → MCP Server
7. MCP Server returns result → Claude

## Features

- **23 Browser Automation Tools** - Navigate, click, type, hover, drag, screenshot, and more
- **ARIA Accessibility Tree** - Structured page snapshots for AI understanding
- **Vue 3 Popup UI** - Modern, responsive extension interface with dark theme
- **Dual Connection Model** - Local MCP server + Remote Laravel Reverb WebSocket
- **Authentication** - Secure login with Laravel Sanctum token-based auth
- **Activity Logging** - Local action and status history without page payloads or credentials
- **Session Management** - Auto-restore sessions, heartbeat keep-alive, graceful offline handling
- **Tab Management** - Connect, switch, and manage browser tabs
- **Console Log Access** - Read browser console messages
- **Visual Debugging** - Highlight elements for debugging

## Copilot side panel

A Claude-style chat in Chrome's side panel whose agent acts on your tabs, without any MCP
client: open it with **Alt+J** (or "Abrir copiloto" in the popup), type a prompt, and the
agent drives the page with the same `browser_*` handlers the MCP path uses.

- **Sees the page by default**: every prompt carries a `<page_context>` block with the
  target tab, the open tabs and the target's `browser_state` (interactive elements with refs).
- **This tab or others**: the target follows the active tab (📌 pins it); the agent can
  `browser_switch_tab` / `browser_new_tab` to work elsewhere.
- **Modes** (Shift+Tab cycles them):
  - *Preguntar* — every page-changing action shows an approval card
    (Permitir / Siempre en este sitio / Denegar); reads run freely.
  - *Auto* — acts without asking.
  - *Plan* — read-only investigation, then a plan card; approve it to run in Auto or
    Preguntar, or send feedback and it re-plans.
- **Interaction**: the agent can `ask_user` (options or free text) and keeps a live
  checklist with `update_plan`, pinned above the composer.
- **Model selector** fed by `GET {endpoint}/models` (embeddings/audio/image filtered out).
- Streamed answers (text and reasoning) rendered as safe Markdown (everything escaped,
  http(s) links only); tool steps collapse into "N pasos" blocks.
- Conversations are saved (✚ new, 🕘 history). Endpoint, key, step cap, vision and the
  per-site permissions live in ⚙ (`chrome.storage.local`, trusted contexts only).
- `index.html?windowId=N` runs the panel detached, following window N's active tab.
- The loop runs in the service worker (`src/background/agent/`); the panel
  (`src/sidepanel/`) only renders it and answers its requests. Stop / Esc aborts.

## Installation

### Load as Unpacked Extension

1. Clone this repository:
   ```bash
   git clone https://github.com/SnakeO/agent-jake-browser-mcp-extension.git
   cd agent-jake-browser-mcp-extension
   ```

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Open Chrome and go to `chrome://extensions/`

4. Enable "Developer mode" (toggle in top right)

5. Click "Load unpacked" and select the `dist/` folder

6. The extension icon should appear in your toolbar

## Usage

1. **Login** - Click the extension icon and enter your credentials to authenticate with the Laravel backend

2. **Connect to Server** - The extension automatically connects to Reverb WebSocket on successful login

3. **Select a Tab** - Choose a browser tab to automate from the popup

4. **Monitor Status** - The popup shows connection state and activity log

### Network inspection

`browser_network_requests` and `browser_network_request` show only the URL origin.
`browser_network_request` shows validated MIME type, content length and cache
directives; other header values are redacted. There is currently no option to
reveal redacted header values or removed URL details. Without `part`, it returns metadata and
headers only. Request and response bodies require an explicit `part` value and
may contain credentials, so request them only when needed.

### Connection Indicators

| Indicator | Meaning |
|-----------|---------|
| SERVER: ONLINE (cyan) | Connected to Reverb WebSocket |
| SERVER: SYNC (yellow) | Connecting to server |
| SERVER: RETRY (yellow) | Reconnecting after disconnect |
| SERVER: ERROR (red) | Connection failed |
| SERVER: OFFLINE (gray) | Not connected |
| TAB: [title] (green) | Tab connected and ready |
| TAB: Pick a tab (gray) | No tab selected |

## Development

```bash
# Install dependencies
npm install

# Development build with watch
npm run dev

# Production build
npm run build

# Type checking
npm run typecheck

# Run E2E tests with Playwright
npm test

# Run unit tests with Vitest
npm run test:unit

# Watch unit tests
npm run test:unit:watch
```

## Project Structure

```
src/
├── background/              # Service worker (Manifest V3)
│   ├── index.ts             # Entry point, message routing
│   ├── ws-client.ts         # Local MCP WebSocket client
│   ├── reverb-client.ts     # Laravel Reverb WebSocket client
│   ├── auth-service.ts      # Authentication & session management
│   ├── api-client.ts        # HTTP API client
│   ├── tab-manager.ts       # Chrome Debugger API integration
│   ├── tool-handlers.ts     # Tool implementations
│   ├── activity-log.ts      # Action logging to Chrome storage
│   ├── connection-state.ts  # Connection state with backoff
│   └── tools/               # Tool schemas & utilities
├── popup/                   # Vue 3 popup UI
│   ├── App.vue              # Root component
│   ├── main.ts              # Vue app initialization
│   ├── components/          # UI components
│   │   ├── AuthForm.vue     # Login form
│   │   ├── UserCard.vue     # User profile display
│   │   ├── ConnectionStatus.vue  # Connection indicators
│   │   ├── TabSelector.vue  # Tab selection
│   │   ├── ActivityLog.vue  # Recent activity
│   │   └── ActivityModal.vue # Activity details modal
│   ├── stores/              # Pinia state management
│   │   ├── auth.ts          # Authentication state
│   │   ├── status.ts        # Connection & tab state
│   │   └── activity.ts      # Activity log state
│   ├── composables/         # Vue composables
│   ├── constants/           # UI constants
│   └── styles/              # CSS variables & base styles
├── content/                 # Content script (injected into pages)
│   ├── index.ts             # Entry point
│   ├── aria-tree.ts         # ARIA accessibility tree builder
│   ├── selector.ts          # Element reference system
│   └── aria/                # ARIA role mappings
├── types/                   # Shared TypeScript types
├── constants/               # Configuration constants
└── utils/                   # Utilities
```

## Tech Stack

- **TypeScript** - Type-safe development
- **Vue 3** - Popup UI framework with Composition API
- **Pinia** - Vue state management
- **Vite + CRXJS** - Fast Chrome extension builds
- **Laravel Echo + Pusher** - Reverb WebSocket client
- **Zod** - Runtime schema validation
- **Vitest** - Unit testing
- **Playwright** - E2E testing
- **Chrome Debugger API** - Browser automation via CDP

## Configuration

Key configuration values in `src/types/config.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `WS_PORT` | 8765 | Local MCP server WebSocket port |
| `REVERB_PORT` | 8085 | Laravel Reverb WebSocket port |
| `REVERB_HOST` | localhost | Reverb server host |
| `API_URL` | http://localhost:8000 | Laravel backend URL |
| `RECONNECT_INTERVAL_MS` | 5000 | WebSocket reconnect interval |
| `DOM_STABILITY_MS` | 1000 | Wait time after DOM actions |

## Available Tools

The extension exposes 23 browser automation tools:

| Tool | Description |
|------|-------------|
| `navigate` | Navigate to a URL |
| `click` | Click an element |
| `type` | Type text into an element |
| `hover` | Hover over an element |
| `drag` | Drag and drop elements |
| `scroll` | Scroll the page |
| `screenshot` | Capture screenshot |
| `snapshot` | Get ARIA accessibility tree |
| `evaluate` | Execute JavaScript |
| `select` | Select dropdown option |
| `wait` | Wait for element/condition |
| `highlight` | Highlight element visually |
| ... | And more |

### Closing Tabs By ID

`browser_list_tabs` advertises `closeById: true`. `browser_close_tab` accepts an
optional positive integer `tabId` and returns `{ closed: true, tabId }` with the
ID actually closed. An invalid explicit ID is rejected before any tab is closed;
only an omitted ID selects the connected tab. Closing another tab preserves the
connected tab. This contract lets the server clean up its agent-created tabs.

Run `npx playwright test tests/tab-close.spec.ts` after building to exercise
this contract through WebSocket and real Chromium with disposable tabs.

Manual and packaged URLs can target a dedicated WebSocket listener. An HTTP
capability probe returning `426 Upgrade Required` means authentication metadata
is unavailable, so the WebSocket handshake decides access. A server advertising
`authEnabled: true` still waits for a token or pairing, and other probe errors
remain errors.

## Secret Typing Privacy

When `browser_type` receives `secret: true`, the extension returns operation
metadata and optional field length verification, without the typed value or
remote error text. Diagnostic logging is redacted and page console/network
content capture is suspended while the operation runs, including its DOM
stability wait. Debugger events needed for navigation, dialogs and file chooser
waiters continue to work.

This protection applies to events received during the secret operation. A page
can emit delayed console messages or network events after the operation ends;
those events can be captured normally. The page receives the secret, and other
tools can intentionally inspect DOM values, screenshots, console or network
data. Secret typing does not provide isolation from the page or prevent later
reads by other tools.

Run the focused real-Chromium test with `npm run build`,
`npx playwright install chromium`, then
`npx playwright test tests/secret-fill.spec.ts`. It uses a temporary profile,
loopback HTTP/WebSocket fixtures and fake secrets, with no 1Password account.

## Related Projects

- [agent-jake-browser-mcp-server](https://github.com/SnakeO/agent-jake-browser-mcp-server) - Node.js MCP server that exposes browser tools to AI agents
- [ai-email-sorter-app](https://github.com/SnakeO/ai-email-sorter-app) - Laravel backend with Reverb WebSocket support

## License

MIT - See [LICENSE](LICENSE)
