#!/usr/bin/env bash
# Publica en el servidor MCP (pod agentjake-browser) la build de este checkout de main:
#   - el zip neutro que sirve /download (el servidor le inyecta su config.json al servirlo);
#   - latest.json (versión, build = nº de commits, sha, fecha), que las extensiones instaladas
#     leen al arrancar el navegador y cada 30 min para avisar de que hay versión nueva.
# Lo llama el job `desplegar` del CI DESPUÉS de instalar en x86 y Mac, así esos dos ya están en
# esta build cuando se anuncia. Necesita git con historia completa, node_modules, kubectl.
set -euo pipefail
cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
NS=agentjake-browser
DIR="${PUBLISH_DIR:-/data/extension}"   # PUBLISH_DIR solo para probar el script sin anunciar nada
PUBLIC_LATEST="${PUBLIC_LATEST:-https://browser-mcp.lan.e-dani.com/download/latest.json}"

build=$(git rev-list --count HEAD)
sha=$(git rev-parse --short HEAD)
version="$(jq -r .version manifest.json | cut -d. -f1-3).$build"
out=$(mktemp -d); trap 'rm -rf "$out"' EXIT

VITE_BUILD_NUMBER=$build VITE_BUILD_SHA=$sha npx vite build --outDir "$out/dist" --emptyOutDir >"$out/build.log" 2>&1 \
  || { tail -20 "$out/build.log"; echo "FALLO: build"; exit 1; }
jq --arg v "$version" '.version = $v' "$out/dist/manifest.json" >"$out/m.json" && mv "$out/m.json" "$out/dist/manifest.json"
python3 -c 'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])' "$out/agent-jake-browser-extension" "$out/dist"
jq -n --arg v "$version" --argjson b "$build" --arg s "$sha" --arg t "$(date -u +%FT%TZ)" \
  '{version: $v, build: $b, sha: $s, publishedAt: $t}' >"$out/latest.json"

pod=$(kubectl get pod -n "$NS" -l app.kubernetes.io/name=agentjake-browser -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n "$NS" "$pod" -- mkdir -p "$DIR"
kubectl cp "$out/agent-jake-browser-extension.zip" "$NS/$pod:$DIR/.zip.tmp"
kubectl cp "$out/latest.json" "$NS/$pod:$DIR/.latest.tmp"
# El zip primero: cuando latest.json anuncia la build, /download ya la sirve.
kubectl exec -n "$NS" "$pod" -- sh -c "mv $DIR/.zip.tmp $DIR/agent-jake-browser-extension.zip && mv $DIR/.latest.tmp $DIR/latest.json"

[ -n "${SKIP_VERIFY:-}" ] && { echo "publicada $version ($sha) en $DIR (sin verificar)"; exit 0; }
got=$(curl -fsS -m 15 "$PUBLIC_LATEST" | jq -r .build) || { echo "FALLO: $PUBLIC_LATEST no responde"; exit 1; }
[ "$got" = "$build" ] || { echo "FALLO: $PUBLIC_LATEST anuncia la build $got, no la $build"; exit 1; }
echo "publicada $version ($sha) en $PUBLIC_LATEST"
