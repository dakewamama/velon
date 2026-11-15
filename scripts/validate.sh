#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
validation_stage=identity
trap 'validation_exit=$?; printf "VELON_VALIDATION_EXIT=%s STAGE=%s\n" "$validation_exit" "$validation_stage"; exit "$validation_exit"' EXIT
export VELON_REVISION="${RAILWAY_GIT_COMMIT_SHA:-${VELON_REVISION:-}}"
[[ "$VELON_REVISION" =~ ^[a-f0-9]{40}$ ]] || { echo "An exact source commit is required" >&2; exit 1; }
printf 'VELON_VALIDATION_REVISION=%s\n' "$VELON_REVISION"
rustc --version
node --version
bun --version
unset RPC_URL UPSTREAM_RPC_URL PUBLIC_RPC_URL MAINNET_RPC_URL DEVNET_RPC_URL
export CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=2
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/.validation/target}"
validation_stage=squads-fixture
(cd sdk && bun run fixture:squads)
for component in arm sdk runtime; do
    validation_stage="$component-rust"
    (
        cd "$component"
        cargo fmt --all --check
        cargo clippy --locked --workspace --all-targets -- -D warnings
        cargo test --locked --workspace
    )
done
validation_stage=sdk-typescript
(cd sdk && bun run typecheck && bun test)
validation_stage=app
(cd app && bun run typecheck && bun run format:check && bun run test && bun run build)
validation_stage=runtime-artifact
(cd runtime && cargo build --locked -p catalyst-indexer --bin authorization-api)
export AUTHZ_BIN="$CARGO_TARGET_DIR/debug/authorization-api"
export CATALOGER_DIR="$PWD/runtime" CATALOGER_REVISION="$VELON_REVISION"
validation_stage=recovery
python3 -m unittest discover -s scripts -p 'test_*.py' -v
validation_stage=browser
(cd app && bun run test:e2e --workers=2)
validation_stage=hosted-export
(cd app && HOSTED_RUNTIME=1 CONSOLE_ROOT=1 bun run export)
python3 - <<'PY'
import hashlib, json, os, pathlib, subprocess
root = pathlib.Path.cwd()
revision = os.environ['VELON_REVISION']
html = (root / 'app/site/index.html').read_text()
assert f'name="velon-backend-revision" content="{revision}"' in html
files = [path for path in (root / 'app/site').iterdir() if path.suffix in ('.js', '.css', '.html')]
files += [pathlib.Path(os.environ['AUTHZ_BIN']), root/'runtime/Cargo.lock', root/'sdk/Cargo.lock', root/'arm/Cargo.lock', root/'app/package-lock.json', root/'sdk/bun.lock']
artifacts = {(str(path.relative_to(root)) if path.is_relative_to(root) else 'runtime/'+path.name):
             hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
result = {'commit': revision, 'result': 'passed', 'rust': subprocess.check_output(['rustc', '--version'], text=True).strip(),
          'runtime_profile': 'debug',
          'arm_schema': '0.1', 'control_api': '1', 'database_migration': max(path.name.split('_')[0] for path in (root/'runtime/services/catalyst-indexer/migrations').glob('*.sql')),
          'artifacts': artifacts, 'public_chain_actions_tested': False}
(root/'.validation').mkdir(exist_ok=True)
(root/'.validation/results.json').write_text(json.dumps(result, indent=2)+'\n')
print('VELON_VALIDATION_RESULT='+json.dumps(result, separators=(',', ':')))
PY
validation_stage=complete
echo VELON_VALIDATION_PASS
