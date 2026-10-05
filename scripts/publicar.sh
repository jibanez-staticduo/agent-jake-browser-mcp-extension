#!/usr/bin/env bash
# Builds the neutral extension from HEAD, signs update-files.json and (real mode) uploads zip +
# latest.json to the agentjake-browser pod. Needs only bash, node, git, curl and kubectl (no jq/python).
#
#   bash scripts/publicar.sh            real: signs with AJB_UPDATE_SIGNING_KEY and uploads
#   bash scripts/publicar.sh --dry-run  signs with an ephemeral key, verifies, uploads nothing
set -euo pipefail

dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  "") ;;
  *) echo "uso: publicar.sh [--dry-run]" >&2; exit 2 ;;
esac

fail() { echo "publicar: $*" >&2; exit 1; }

# Capture the signing key and drop it from the environment at once: vite, kubectl and curl must never inherit it.
signing_key="${AJB_UPDATE_SIGNING_KEY:-}"
unset AJB_UPDATE_SIGNING_KEY

repo="$(git rev-parse --show-toplevel)"
cd "$repo"

NS=agentjake-browser
PUB_DIR=/data/extension
PUBLIC_LATEST="${AGENT_BROWSER_PUBLIC_LATEST:-https://browser-mcp.lan.e-dani.com/download/latest.json}"

# A test public key baked into a published build would make every browser trust the wrong signer.
if [[ $dry -eq 0 && -n "${VITE_UPDATE_PUBLIC_KEY:-}" ]]; then
  fail "VITE_UPDATE_PUBLIC_KEY esta definida: no se publica con una clave de prueba"
fi

build="$(git rev-list --count HEAD)"
sha="$(git rev-parse --short HEAD)"
PINNED="$(sed -n "s/^export const PINNED_UPDATE_PUBLIC_KEY = '\([^']*\)';.*/\1/p" src/config/update-key.ts)"
[[ -n "$PINNED" ]] || fail "no se pudo leer PINNED_UPDATE_PUBLIC_KEY de src/config/update-key.ts"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/src"

# From git archive: the checkout's .env.local (tokens) never reaches the build.
git archive HEAD | tar -x -C "$tmp/src"
ln -s "$repo/node_modules" "$tmp/src/node_modules"

( cd "$tmp/src" && env -u VITE_WS_HOST -u VITE_WS_PORT -u VITE_WS_PATH -u VITE_WS_SECURE -u VITE_WS_TOKEN \
    -u VITE_COPILOT_BASE_URL -u VITE_COPILOT_API_KEY -u VITE_UPDATE_PUBLIC_KEY -u AJB_UPDATE_SIGNING_KEY \
    VITE_BUILD_NUMBER="$build" VITE_BUILD_SHA="$sha" \
    VITE_LATEST_URL="$PUBLIC_LATEST" \
    npx vite build --outDir "$tmp/dist" --emptyOutDir ) >"$tmp/build.log" 2>&1 \
  || { tail -30 "$tmp/build.log" >&2; fail "build neutra fallida"; }

# Stamp manifest.version = <x.y.z>.<build> (node: no jq).
version="$(node -e '
const fs = require("fs");
const p = process.argv[1] + "/manifest.json";
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.version = m.version.split(".").slice(0, 3).join(".") + "." + process.argv[2];
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
process.stdout.write(m.version);
' "$tmp/dist" "$build")"

# Guards on the compiled config.
shopt -s nullglob
cfgs=("$tmp"/dist/assets/config-*.js)
[[ ${#cfgs[@]} -gt 0 ]] || fail "no hay assets/config-*.js en la build"
grep -qE "BUILD_NUMBER:${build}[,}]" "${cfgs[@]}" || fail "la build no lleva BUILD_NUMBER:${build}: bucle de recarga en campo"
grep -qF "BUILD_SHA:\"${sha}\"" "${cfgs[@]}" || fail "la build no lleva BUILD_SHA:\"${sha}\""
grep -qF 'WS_TOKEN:""' "${cfgs[@]}" || fail "la build lleva un WS_TOKEN no vacio"
grep -qF 'COPILOT_API_KEY:""' "${cfgs[@]}" || fail "la build lleva una COPILOT_API_KEY no vacia"
grep -rqF -- "$PINNED" "$tmp/dist/assets" || fail "la clave pinneada no esta en la build"
shopt -u nullglob

rm -rf "$tmp/dist/.vite"

# Sign. The private key lives only in a variable / the CI env, never on disk.
if [[ $dry -eq 1 ]]; then
  eph="$(node -e '
const { generateKeyPairSync } = require("crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.stdout.write(JSON.stringify({
  pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  pub: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64"),
}));
')"
  sign_key="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).pem)' "$eph")"
  verify_pub="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).pub)' "$eph")"
  unset eph
else
  [[ -n "$signing_key" ]] || fail "AJB_UPDATE_SIGNING_KEY vacia"
  sign_key="$signing_key"
  verify_pub="$PINNED"
fi
AJB_UPDATE_SIGNING_KEY="$sign_key" node scripts/update-files.mjs sign "$tmp/dist" --version "$version" --build "$build" --sha "$sha"
unset sign_key
verified="$(node scripts/update-files.mjs verify "$tmp/dist" --pub "$verify_pub")"
echo "$verified"

# Zip (fflate) and latest.json.
node --input-type=module -e '
import { zipSync } from "fflate";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
const [dist, out, latest, version, build, sha] = process.argv.slice(1);
const entries = {};
const walk = (dir, prefix) => {
  for (const n of readdirSync(dir).sort()) {
    const full = join(dir, n), rel = prefix + n;
    if (statSync(full).isDirectory()) walk(full, rel + "/");
    else entries[rel] = readFileSync(full);
  }
};
walk(dist, "");
writeFileSync(out, zipSync(entries));
writeFileSync(latest, JSON.stringify({ version, build: Number(build), sha, publishedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") }) + "\n");
' "$tmp/dist" "$tmp/agent-jake-browser-extension.zip" "$tmp/latest.json" "$version" "$build" "$sha"

if [[ $dry -eq 1 ]]; then
  echo "dry-run: no se sube nada (version $version, build $build, sha $sha)"
  exit 0
fi

# Never lower the announced build (equal = re-publish). Unreachable = warn and go on.
announced="$(curl -fsS -m 15 "$PUBLIC_LATEST" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).build))}catch{}})' || true)"
if [[ "$announced" =~ ^[0-9]+$ ]]; then
  (( build >= announced )) || fail "$PUBLIC_LATEST anuncia la build $announced, mayor que la $build: no se baja"
else
  echo "publicar: aviso: no se pudo leer la build anunciada en $PUBLIC_LATEST; se continua" >&2
fi

export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
# One that is not terminating: during a rollout items[0] may be the outgoing pod.
pod="$(kubectl get pods -n "$NS" -l app.kubernetes.io/name="$NS" --field-selector=status.phase=Running -o json \
  | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const i = JSON.parse(s).items.filter((p) => !p.metadata.deletionTimestamp);
  process.stdout.write(i.length ? i[0].metadata.name : "");
});')"
[[ -n "$pod" ]] || fail "sin pod de $NS en marcha"

# Zip first: when latest.json announces the build, /download already serves it.
kubectl exec -n "$NS" "$pod" -- mkdir -p "$PUB_DIR" \
  && kubectl cp "$tmp/agent-jake-browser-extension.zip" "$NS/$pod:$PUB_DIR/.zip.tmp" \
  && kubectl cp "$tmp/latest.json" "$NS/$pod:$PUB_DIR/.latest.tmp" \
  && kubectl exec -n "$NS" "$pod" -- sh -c "mv $PUB_DIR/.zip.tmp $PUB_DIR/agent-jake-browser-extension.zip && mv $PUB_DIR/.latest.tmp $PUB_DIR/latest.json" \
  || fail "copiar al pod"

got="$(curl -fsS -m 15 "$PUBLIC_LATEST" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).build)))')" \
  || fail "$PUBLIC_LATEST no responde"
[[ "$got" == "$build" ]] || fail "$PUBLIC_LATEST anuncia la build $got, no la $build"
# What the public URL serves must verify against the pinned key, or browsers would reject it.
PUBLIC_ZIP="${PUBLIC_LATEST%/latest.json}"
curl -fsS -m 60 "$PUBLIC_ZIP" -o "$tmp/public.zip" || fail "$PUBLIC_ZIP no responde"
node --input-type=module -e '
import { unzipSync } from "fflate";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
const [zip, out] = process.argv.slice(1);
for (const [p, b] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) {
  if (p.endsWith("/")) continue;
  mkdirSync(dirname(join(out, p)), { recursive: true });
  writeFileSync(join(out, p), b);
}
' "$tmp/public.zip" "$tmp/public" || fail "no se pudo abrir el zip publicado"
node scripts/update-files.mjs verify "$tmp/public" --pub "$PINNED" || fail "el zip publicado NO verifica con la clave pinneada"
echo "publicada $version ($sha) en $PUBLIC_LATEST"
