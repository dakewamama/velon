#!/usr/bin/env bash
# Assembles the container context for the mainnet console into $1.
# The runtime binary must already be built from the committed tree.
set -euo pipefail
out=${1:?usage: build.sh <dir>}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
revision=$(git -C "$repo" rev-parse HEAD)
test -z "$(git -C "$repo" status --porcelain -- runtime sdk arm app)" || { echo "commit first" >&2; exit 1; }
binary=$repo/runtime/target/release/authorization-api
grep -qaF "$revision" "$binary" || { echo "rebuild the runtime at $revision" >&2; exit 1; }
rm -rf "$out" && mkdir -p "$out/bin"
git -C "$repo" archive HEAD app runtime | tar -x -C "$out"
mv "$out/runtime" "$out/cataloger"
cp "$repo/app/deploy/supervisor.py" "$repo/app/deploy/space/Dockerfile" "$out/"
cp "$binary" "$out/bin/"
(cd "$repo/app" && npm ci --omit=dev --ignore-scripts --prefix "$out/app" >/dev/null)
python3 - "$out" "$revision" <<'PY'
import hashlib, json, pathlib, sys
out, revision = pathlib.Path(sys.argv[1]), sys.argv[2]
binary = out / "bin/authorization-api"
artifacts = [
    {"name": "authorization-api", "size": binary.stat().st_size, "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()},
    {"name": "bun", "size": 92752752, "sha256": "9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74"},
]
(out / "artifacts.json").write_text(json.dumps({"revision": revision, "artifacts": artifacts}, indent=2) + "\n")
PY
cat > "$out/README.md" <<'MD'
---
title: Velon console runtime
sdk: docker
app_port: 7860
---
Backend for console.velonsecure.xyz. Source: https://github.com/dakewamama/velon
MD
