"""Check packaged files and native recovery without RPC or retained production data."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def run(root):
    root = Path(root).resolve(strict=True)
    sys.path.insert(0, str(root))
    from release_artifacts import verify

    manifest = verify(root)
    binary = root / "bin/authorization-api"
    fixtures = root / "cataloger/services/catalyst-indexer/tests/fixtures"
    bun = subprocess.check_output([str(root / "bin/bun"), "--version"], text=True, timeout=10).strip()
    if bun != "1.3.14":
        raise ValueError("Packaged Bun version differs from the declared toolchain")
    with tempfile.TemporaryDirectory(prefix="velon-image-check-") as temporary:
        directory = Path(temporary)
        database = directory / "source.sqlite"
        env = {key: value for key, value in os.environ.items()
               if key not in ("RPC_URL", "UPSTREAM_RPC_URL", "MAINNET_RPC_URL", "DEVNET_RPC_URL")}
        env["DATABASE_URL"] = f"sqlite://{database}"

        def native(*arguments):
            return json.loads(subprocess.check_output(
                [str(binary), *arguments], env=env, text=True, timeout=120,
            ))

        record = native("import", str(fixtures / "catalog.json"), str(fixtures / "spl-snapshot.json"))
        if record["sdk_revision"] != manifest["revision"]:
            raise ValueError("Packaged native revision differs from the release manifest")
        if native("replay", record["id"]) != record:
            raise ValueError("Packaged native evidence did not replay exactly")
        tool = root / "tools/evidence_backup.py"
        backup = directory / "backup"
        restored = directory / "restored.sqlite"
        for arguments in (("backup", database, backup), ("verify", backup), ("restore", backup, restored)):
            subprocess.run(
                [sys.executable, "-B", str(tool), *map(str, arguments)],
                env=env, stdout=subprocess.PIPE, check=True, timeout=120,
            )
        env["DATABASE_URL"] = f"sqlite://{restored}"
        if native("replay", record["id"]) != record:
            raise ValueError("Packaged restore did not reproduce native evidence")
    result = {
        "revision": manifest["revision"], "manifest_format": manifest["format"],
        "verified_artifacts": len(manifest["artifacts"]), "bun": bun,
        "native_fixture_replayed": True, "backup_restored_and_replayed": True,
        "public_chain_actions_tested": False,
    }
    print("VELON_RELEASE_IMAGE_RESULT=" + json.dumps(result, separators=(",", ":")))
    print("VELON_RELEASE_IMAGE_PASS")
    return result


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) == 2 else "/opt/velon")
