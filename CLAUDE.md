# Agent Jake Browser

The product tracks the complete Pocharlies feature set with StaticDuo runtime configuration and security overlays. See docs/full-parity-20261017.md.

- Validate changes with npm run typecheck, npm run test:unit, npm run build and scripts/check-deltas.sh. Use disposable Chromium profiles for browser QA.
- Keep secrets out of Git, diagnostics and build inputs. Secret writing requires explicit deployment configuration.
- Publish custom Docker images to docker.staticduo.com and verify their digest before deployment.
- Build signed extension bundles with scripts/release-staticduo.mjs from committed source. The private signing key remains outside the repository.
- CI runners and production release/deployment belong to each installation. This fork must not invoke Pocharlies kubectl contexts, host sync scripts or organization-secret workflows.
