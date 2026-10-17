# StaticDuo signed extension releases

One neutral signed ZIP is shared by Main, Ari and Fedora. Runtime server settings are
added only to the initial `/download` ZIP as `config.json`, never to the signed file
list. The auto-update route serves the original bytes at `/download/artifact.zip`.
The installed `config.json` and Chrome local storage survive an update.

## Build and verify

Run from the committed extension repository with installed npm dependencies. The
release is made from `git archive HEAD`, so local `.env` files and uncommitted source
are not published. All `VITE_*` inputs are removed before the build, and the release
sets no feed URL: each install uses its configured WebSocket server's HTTP origin.

```sh
node scripts/release-staticduo.mjs \
  --key-file /volume2/docker-data/mcp/_agent-jake/update-signing/ed25519-private.pem \
  --out /secure/releases/extension-$(git rev-parse --short HEAD) \
  --previous /secure/releases/current/latest.json
node scripts/release-staticduo.mjs --verify /secure/releases/extension-COMMIT
```

The private file must be outside Git and mode 0600 or stricter; run with a user that
can read it (parent deployment uses sudo). It is never supplied as an environment
variable or key contents in process arguments, and is read after Vite exits. The
signer must match `src/config/update-key.ts`. Do not reuse another household's key.

Build is the HEAD commit count; version is `2.6.0.<build>`. `--previous` enforces a
strictly newer publication. Each Chrome version component is limited to 65535; bump
the base version and plan a build-number migration before the counter reaches this
limit. A history rewrite must never lower the build counter.

Output is a new immutable directory, containing:

- `agent-jake-browser-extension.zip`: extension, signed `update-files.json`, `.sig`.
- `latest.json`: `version`, integer `build`, git `sha`, ISO `publishedAt`, ZIP
  `sha256`, and `download: "/download/artifact.zip"`.

Signature is Ed25519 over the exact `update-files.json` bytes. Each listed file has
SHA-256 and size. Neither `config.json` nor credentials belong in the neutral ZIP.
The builder verifies signature, all hashes/sizes, file completeness, Chrome version,
and latest/signed identity before publishing the output directory.

## Server and bundle switch

Mount a persistent parent directory read-only in all server instances, and set
`BROWSER_EXTENSION_DIR=/mount/current`. Prepare version directories in that parent,
then replace the `current` symlink with a same-filesystem atomic rename. Do not mount
the symlink target as a Docker bind directly: that pins the old target inode.

The server must return `latest.json` with no-store caching, serve the raw artifact
without modifying it, and preserve `/download` as the initial ZIP route adding only
instance-specific `config.json`. A switch must not overwrite either file in place.
Retain previous directories for server rollback. Pointing the server back does not
downgrade already updated browsers: their updater accepts only a greater build.
Publish a new higher build for browser recovery.

## Isolated Chromium checks

These use fresh profile/download directories and an ephemeral signing key; no user
browser or production key is used. The override remains test-only.

```sh
docker run --rm --shm-size=1g \
  -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.57.0-noble \
  node scripts/release-staticduo-e2e.mjs
# Repeat with --tamper, --wrong-key, --identity, and --prompt.
```

Success checks real A -> B -> C reloads, per-file disk hashes, tracked asset cleanup,
and byte-identical runtime config. Rejection checks keep the original install bytes.
Chrome must support Ed25519; this updater retains upstream eligibility requirements:
unpacked installation in Downloads/agent-jake-browser, developer mode on, and the
"ask where to save" setting off. It waits for tool inactivity, limits retries,
restores the downloads UI, and reports failures. It is not a Web Store updater.

`--test --working-tree --build N --latest-url http://127.0.0.1:PORT/download/latest.json`
on the release builder is available only for local fixtures. Such builds must never
be published; the normal release path rejects these flags and public-key env overrides.
