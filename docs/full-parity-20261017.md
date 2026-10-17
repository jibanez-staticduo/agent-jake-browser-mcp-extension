# Full Pocharlies product adoption

Baseline: StaticDuo `070c1fe` and Pocharlies `da18a7e` (2026-10-17).
This integration merges both histories and adopts the complete upstream product.
PRs outside that upstream main are not implicitly adopted. The corrected internal
reader from own `a6c52a6` is explicitly included for `browser_save_secret` compatibility;
this is an own integration addition, not a claim that upstream PR 31 is merged. Real secret writing remains gated by server configuration.

| Capability | Integrated implementation | Evidence and limits |
| --- | --- | --- |
| Unified panel and per-tab toolbar opening | Upstream App, OptionsView, panel-open | Chromium panel/configuration and unit panel-open tests; old popup entry removed |
| Ask/Auto/Plan, streaming, chats, task requests | Upstream agent loop, bridge, chats | Agent loop/modes/lease/traffic-gate and chat scope tests; real provider account needs external QA |
| Model selection and costs | Upstream ModelPicker and chat models | Model and settings unit tests; provider catalogue requires external QA |
| File/image attachments and paste | Upstream attachments and App | Attachment tests cover conversion, limits and payloads; real provider multimodal output requires QA |
| Dictation and transcription | Upstream App and attachments, microphone permission | Transcription request unit tests; physical microphone and speech quality require human QA |
| Build/runtime provision | Upstream provision and setup | Provision and setup tests; no provider credentials embedded in the neutral release |
| Paseo and external MCP plugins | Upstream agent/mcp-server, tool catalogue | MCP discovery/call and bridge tests; live Paseo/plugin endpoint requires external QA |
| Passkey vault and native ceremony guard | Upstream passkey-vault, TabSession WebAuthn | Vault, passkey interaction, guard unit tests; real relying-party enrollment requires QA |
| Parallel sessions, sticky target tabs | Upstream CallTab and per-tab TabSession | Real Chromium two-session navigation/type/state/distinct screenshots; both debuggers remain attached |
| Background input, focus emulation | Upstream CDP focus emulation, native setter repair | Chromium typing and session windows; active tab within an unfocused agent window is expected |
| Bounded loaded navigation | Upstream timeouts, loaded flag and immediate injection | Slow-page and navigation unit tests; real Chromium slow-page sweep passed |
| Find tabs | Complete upstream find-tab handler/schema/catalogue | Find-tab unit cases; read-only and no debugger attachment |
| Signed automatic update | Upstream updater plus StaticDuo pinned key and release scripts | Signature/tamper/key/identity/config tests; portable update E2E maintained in release-staticduo-e2e.mjs |
| Instance configuration survives updates | config.json excluded from signed files; raw artifact route | Version/SHA/manifest identity validation; config.json rejected in signed list; /download/artifact.zip |
| Password masking | Upstream compact-state password masking | Compact-state tests; snapshots of ordinary fields retain normal product semantics |
| Browser label and runtime authentication | StaticDuo runtime/ws-client/store overlays | Label persistence, token preflight, WS-only HTTP 426 and credential-free diagnostics tests |
| Secret typed/verified response | StaticDuo contract adapted to pinned CallTab | Synthetic selector/ref/clear/append/navigation/error tests; Chromium fake-secret typing and capture checks |
| Secret log and capture boundary | StaticDuo scoped logger and PageEventLog sink | Overlapping scope, routing, WebSocket, status error and CDP waiter tests; fake data only |
| Agent window provenance and close API | StaticDuo AgentWindows over per-tab debugger | Live Chrome target UUID witnesses; Chromium reload, moved user tab, selective close and focus tests |
| Internal secret read for save_secret | Corrected own RE2JS 2.8.6 reader, pinned CallTab, closed errors and hidden copilot/plugin name | Synthetic selector/ref/iframe/identity/regex/limit/canary tests; no real secret writes |
| Strict close IDs and trusted storage | StaticDuo positive-ID validation and storage privacy | Unit invalid-ID cases, Chromium closeById and storage tests |

## Reproducible local checks

`npm run typecheck`, `npm run build`, `npm run test:unit`, and
`bash scripts/check-deltas.sh`. Chromium runs use
`mcr.microsoft.com/playwright:v1.57.0-noble`, with `AJB_HEADLESS=1` for the
complete Playwright suite and `scripts/e2e-two-sessions.mjs` /
`scripts/e2e-background-tab.mjs`. The host Chromium exits with SIGTRAP before
loading the extension; Docker supplies a working browser runtime.

The integrated product is kept intact: `src/sidepanel` is the upstream tree;
security and instance-specific changes are confined to the documented overlays.
Live provider credentials, real secrets, remote deployment and user microphone
consent are not part of these synthetic checks.

## Validated candidate

- Typecheck and production build passed.
- 660 unit tests across 55 files passed.
- Complete Chromium Playwright suite including internal reader: 13/13 passed.
- Real two-session CDP/DOM/state/screenshots: all passed.
- Background typing, controlled fields, native setter repair, minimized and
  unfocused windows: all passed.
- Slow-page Chromium sweep, including loaded:false and bounded reload/navigation: all passed.
- Independent focused internal-reader review: 40/40 passed, no blocking findings.
- All fork delta checks passed.

Publication and deployment belong to the external StaticDuo release flow. The
product does not depend on Pocharlies Kubernetes runners, namespaces or hosts.
