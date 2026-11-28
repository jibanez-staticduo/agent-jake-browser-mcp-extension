# Lote 3: reconciliation and native click review

Date: 2026-11-05. Candidate base: fd765cc4013722bced2a61a852240a5a17a5bb3e.
Canonical extension: 6b5d135c5c831480beee130df5df77d784630922.
Canonical server: f051f5506e7ba8cb938113d5cce47cbf8d2838b1.

This candidate fixes a Lote 1 regression: close_window could continue removing
tabs after the traffic gate timeout released the next caller. The caller's
AbortSignal now reaches the window close and fences subsequent disconnect and
remove operations. A Chrome remove already issued before cancellation cannot
be revoked. Non-cancellable Chrome reads may retain the internal registry queue
until they settle; their continuations cannot issue new removals after abort.

Tests cover the actual bridge/handler/manager/window chain with 16 frozen tabs,
late detach rejection, cancellation while queued or waiting for disconnect,
and cancellation during final tab/target UUID lookup. Activity history also
has a 105-entry passkey test proving the newest 100 entries retain only numeric
metadata and omit nonce, rpId, key and user-handle canaries.

No passkey guard or native click runtime is changed. The ceded host package is
preserved externally, SHA256
60eae84e43348783aeed20e6d99f6b138f3e3bd0d0e2090bbff3c4003b3fcffe.
Its Python block is byte-identical to the supplied artifact, SHA256
6a5b55af74eb1256de3908abad14c4d175fad1609fde28836e9042a35fe0911a.
Infrastructure, native registration and deployment remain outside this product.

## Native click remains blocked

Isolated characterization reproduces six unresolved issues:

1. A page-controlled custom element and blue pixels do not authenticate a
   1Password extension prompt.
2. captureVisibleTab may capture a different active tab than the probed document.
3. Separate title/focus/geometry/pointer checks do not atomically bind the OS
   click to its intended destination.
4. Native error messages can expose an unrelated window title in console/tool
   output despite the activity log's independent redaction.
5. A persistent nonce title permits replay across processes; an in-flight native
   message does not receive the caller's cancellation. The Set is a marker;
   the traffic gate, not that Set, serializes normal calls until timeout.
6. Inconsistent viewport/window geometry can produce a click outside the window.

Framing also accepts a truncated body containing complete JSON; the protocol
uses uint32 native byte order, which is little-endian only on matching hosts.
37 passing characterization tests demonstrate these behaviors, not a security
approval. The complete INFRA-1171 report and Dani's decision are requested via
Hermes before changing the guard. Do not enable source 1password on this basis.

## Acceptance before a later enablement

- Resolve the design findings with security and implement approved fixes in an
  isolated candidate. No silent acceptance of residual input races.
- Keep AGENT_BROWSER_1P_PASSKEY_RPIDS empty until a named StaticDuo policy is
  approved. The supplier's google.com/shopify.com list is not local approval;
  banking/payment sites remain excluded. Source 1password supports use only.
- Measure the actual browser frame, viewport, DPR, zoom and monitor layout;
  do not assume a four-pixel frame. Verify X11/xdotool and the intended user
  display; unsupported Wayland environments must fail closed.
- Generate an exact-origin native manifest using the actual installed extension
  ID and own absolute host path. An isolated unpacked build ID is not a fleet ID.
- Prove real Chrome/1Password success and refusal cases, cancellation, changed
  tab/document/focus/geometry, replay, concurrency and zero sensitive log output
  on a disposable display and account before any production request.
- Preserve the StaticDuo updater trust anchor and independent secret/cookie gates.

No merge, deployment, native registration or feature enablement is authorized
by this report. Rollback this close-window patch only through another reviewed
candidate; do not restore a known late-removal path in production. Signed client
recovery requires a higher build or an explicit manual reinstall, not downgrade.
