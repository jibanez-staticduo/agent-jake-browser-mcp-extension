# Browser Harness M1B extension proposal

Date: 2026-10-01. Design only; no runtime, dependency, publishing or rollout change.
Base: canonical extension `master` merge
`cc3b59204f1864c4cff2c9be1f7cc8bcf83d6dc0` (M1A PR #2, verified on GitHub).

The authoritative shared protocol proposal is the paired canonical server document:
[M1B shared design](https://github.com/jibanez-staticduo/agent-jake-browser-mcp-server/blob/cf4a2297dab5e47c10b29b19ff112f0ded70163e/docs/superpowers/specs/2026-10-01-browser-harness-m1b-design.md).
The immutable proposal SHA is `cf4a2297dab5e47c10b29b19ff112f0ded70163e`. Before implementation,
record the accepted merged design SHA and update this pin if the shared proposal
changes. Do not duplicate wire definitions in this repository or use a mutable
branch as provenance.

## Outcome and agreed boundaries to preserve

Negotiate before declaring connected or invoking any tool; preserve executable
M1A wire guards on an explicitly legacy fixture. New mode never silently downgrades
or guesses a different endpoint after an incompatible hello. Current installation
URLs/domains, tokens, pairing, explicit empty values and UUID survive migration and
protocol failures. Preserve Chrome storage privacy, Copilot traffic gate/lease,
unsafe-code denial and pinned-directory protections. Core has no house integrations.

Canonical product `master`, the StaticDuo product `main` forks and installed services
are separate. This design does not update them. Runtime implementation follows
agreement with Oppo; the separately recorded explicit Dani OK remains necessary
before any new image rollout.

## Shared contract consumption

Propose `@agent-jake-browser/protocol`, canonical source in server `packages/protocol`,
experimental package `0.1.0`, negotiated integer wire `1`. The existing legacy wire
has no negotiated version and is not a member of `[1]`. Consume one generated TGZ
at `vendor/protocol/agent-jake-browser-protocol-0.1.0.tgz`, with an exact local
dependency path and lock integrity, not a sibling checkout or floating version.

Provenance records canonical source SHA, source lock digest, package/toolchain
versions, wire versions, canonical catalog digest and SHA-256 of the exact TGZ.
Verify before installation and in CI; include textual source diff and pack-content
inspection. Server integration builds the recorded source and proves consumer
equivalence; it does not independently redefine the messages. The initial catalog
policy requires exact shared `sha256:<hex>` equality. Package semver, wire version,
MCP protocol date and artifact hash are distinct. No registry/release is published
by these PRs.

Protocol includes strict runtime schemas/inferred types and descriptors for browser
tools, risk and capabilities. Reexport is fine; hand-maintained duplicate schemas
in `types/tool-schemas.ts` or `agent/tools-catalog.ts` are removed only when the
shared projections are implemented and verified. Copilot mode/vision derives a
subset; `ask_user`, `update_plan`, `present_plan` remain extension-local. No Node or
house imports/polyfills in protocol; execute it in a real MV3 worker as well as a
Vite bundle.

## Client lifecycle and identity

Current `ws-client.ts` treats socket OPEN as ready and sends an operation's response
through `this.socket`, which may have changed. Replace these semantics only in
future implementation PRs with the following state machine:

`DISCONNECTED -> CONNECTING -> NEGOTIATING -> READY`; transient failures enter
`RETRY_WAIT`, explicit auth/protocol/catalog errors enter `BLOCKED`. The outer loop
respects BLOCKED and explicit disconnect. A browser's opaque upgrade failure is
shown as connection/auth-unconfirmed rather than inventing its exact cause.

OPEN sends exactly one shared `ClientHello`. It advertises bounded supported wire
versions, protocol package/catalog version, client version, persistent installation
UUID, profile epoch, platform and implemented capabilities. Platform is a hint,
never house/permission authority. No heartbeat or tool dispatch before ack.
Shared `ServerHello` adds server-selected version, package/catalog version, logical
`browserId`, new live `connectionId`, authoritative house and effective capabilities.
Validate all fields/state; reject an unoffered version, digest mismatch, malformed
or duplicate ack. Greatest common version is selected by server, with no fallback
when there is no common version. Proposed hello deadline is 5 seconds, heartbeat
20 seconds after READY. Runtime `isConnected` means READY only.

The shared union also specifies tool_request/tool_result, heartbeat/ack,
session_close and best-effort request_cancel. Results echo id/sessionId/connectionId
and authoritative house. Every request captures originating socket+local generation
before awaits. Validate session/connection/target, and send completion only through
that same still-READY socket. Ignore obsolete callbacks and late/duplicate results;
never send a previous operation to a replacement socket or replay it automatically.
Cancellation prevents later steps and response delivery where possible, without
claiming undo of effects already executed. Session-close releases only that session.

Connect settles once on all close/error paths, including close before OPEN or ack.
Clear timers, pending calls, negotiated metadata and ephemeral contexts on socket
loss/reload/disconnect. Persisted data never implies READY after a worker restart.
UI reports negotiation/version/errors and sanitized URL; raw query tokens never
enter logs, status, prompts or chat.

Migrate existing `ajb.connectionId` as installationId alias without regeneration.
Separate the server-issued browserId and per-socket connectionId; neither is the
old persistent UUID. Persist profileEpoch in session storage for the current browser
session; a new profile epoch invalidates handles. Existing pairing metadata is not
proof of authenticated installation ownership: the server defines enrollment and
ACL. Shared static tokens plus arbitrary UUIDs cannot authorize live replacement
or reconnect continuity. The migration must retain old stores and rollback, with
trusted re-enrollment where needed, not reset credentials to make a test pass.

## Session and tab targets

Server binding is per verified MCP session. The existing `connection` selector
becomes persistent for that session: zero browsers unavailable, one atomic auto-bind,
multiple explicit selection required. Global last-used/default selection is removed
in the negotiated implementation. Reselection while calls run fails session_busy;
disconnect fails pending calls and never chooses a different remaining browser.
Only proven reconnect of the same logical browser permits a subsequent call to use
the new generation; old operations are never replayed.

Extension request contexts are separated by trusted sessionId and captured live
connection; args cannot override them. The server is the authority over these IDs,
but the client still validates envelope state and rejects mismatches before handlers.
Session-close/reselection clears ephemeral session state, without closing the shared
socket. Resource caps/deadlines must bound leaked contexts when close cannot arrive.

The wider M1B target is an opaque TabHandle scoped to authorized session, browser,
profile epoch and live tab incarnation. Pass an explicit validated tab target to
handlers; no shared TabManager/active-tab fallback. Numeric tabId is local transport
detail. Navigate preserves a handle; close/profile restart invalidates it. A handle
from another session/profile returns tab_handle_invalid before CDP.

Ordinary reconnect preserves handles only with proven identity/epoch/live incarnation.
Worker recovery requires session storage and live-tab validation; `tabs.get(tabId)`
alone cannot prove an unobserved close/reuse did not happen. The incarnation/recovery
algorithm needs a specific design agreement before M1B.3 implementation. Conservatively
invalidate unproven handles, and explicitly resolve any continuity requirement that
this cannot meet. This document does not claim an implemented CDP scope proxy.

## Compatibility and optional capabilities

Recommend dedicated configurable negotiated endpoint `/ws/harness`; existing legacy
service unchanged until an authorized transition. Proposed future local port 18766
is not protocol detection. Infrastructure owns the actual WSS URL and TLS mapping.
New compositions default negotiated-only; legacy is isolated and temporarily enabled
by operator with retirement ownership. Never rewrite manual domains/URLs to loopback.

| Pair/condition | Expected behavior |
| --- | --- |
| New/new, shared catalog and common wire | READY then real session-targeted tool |
| Disjoint wire / catalog mismatch | Explicit error, BLOCKED, zero actions |
| New extension / old server | Early legacy frames rejected, timeout/incompatibility visible, no fallback |
| Old extension / negotiated server | hello_required/hello_timeout server rejection, no legacy action |
| Old extension / explicit legacy service | Exact M1A wire guards pass; no new ownership guarantees claimed |
| Existing installed old/old pair | Unchanged pending separate rollout |
| Stale socket / foreign session or handle | No handler execution or delivery on a replacement socket |

Protocol rejection names/codes and payload bounds are frozen in the shared proposal;
proposed private close codes are 4400 invalid, 4406 incompatible and 4408 timeout.
Hello tests coexist with both old wire guards, as agreed in Oppo message 1400.

Optional op-safe/browser_fillsecret and safe Linux-descriptor file operations derive
from shared catalog and actual adapters. Absence => capability_unavailable before
action; backend failure has a different execution error. Client capabilities never
grant permissions. Keep unsafe default blocked; no insecure macOS fallback, no
secret in prompts/logs/chats, and no house-specific provider in core.

## Proposal acceptance and remaining agreement

Accept this design pair only after the authoritative server contract and this
consumer plan match at exact heads. Ask Oppo to confirm/amend endpoint/legacy
retirement, TGZ namespace/version, hello additions/result echoes, trusted MCP
boundary/enrollment, selector/reconnect, limits and tab recovery proof. No runtime
tests are claimed for a document-only PR. Implementation checks are in the paired
[extension plan](../plans/2026-10-01-browser-harness-m1b-extension.md).

Research used the M1A source and official Chrome WS/worker lifecycle, Vite browser
purity, npm pack/install and MCP security documentation via LazyMCP/Context7. The
minimum Chrome 116 supports the proposed WS heartbeat behavior. Real worker sleep/
restart, minimum Chrome and both houses need implementation QA; a mock state machine
or baseline green build is insufficient evidence of those runtime properties.
