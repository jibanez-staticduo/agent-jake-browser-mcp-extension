# M1A extension extraction

Base: `97f1a75fec6339a78b4fd32ee5a3db7ee77c95e2`, extension 2.4.0.

| Original | Product location |
| --- | --- |
| src/ | packages/core/src/ |
| icons/, manifest.json | packages/core/icons/, packages/core/manifest.json |
| Vite, preview, TS and unit-test configs | packages/core/ |
| tests/unit/ | packages/core/tests/unit/ |
| tests/extension.spec.ts | tests/integration/extension.spec.ts |
| scripts/generate-icons.js | packages/core/scripts/generate-icons.js |

Core owns generic Copilot, pairing, persistent installation UUID, configuration,
URL resolution, connection routing and all traffic/safety gates. The two private
house packages consume the same importable composition API and add only identity.
There is no evidence of a distinct Pocharlies integration to implement here.
The manifest starts the unchanged background/content entrypoints in Chrome;
importing the public API starts no sockets or Chrome listeners.

One root npm lockfile installs all private workspaces. Root commands retain their
names. Vite resolves manifest/assets/HTML inside core and builds root dist/;
installed routes contain no packages/core prefix. E2E accepts EXTENSION_DIST and
uses a local fixture server. CI performs product checks only, without publication
or deployment. Infrastructure migration is owned separately and is not included
in this branch.

Baseline: 244 tests / 17 files. Extraction adds two composition tests (import safety and runtime configuration).
The wire format, local port 8765, runtime configuration precedence and existing
storage keys are preserved. M1B negotiation, session binding and new port are
explicitly deferred, as is the M2 new_tab fix. Real Chrome verification must be
recorded separately from unit tests and asset inspection.
