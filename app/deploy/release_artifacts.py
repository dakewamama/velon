"""Bind immutable release files to one manifest; journals and logs stay mutable."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat


REQUIRED = {
    "bin/authorization-api", "bin/bun", "supervisor.py", "evidence_storage.py",
    "release_artifacts.py", "tools/evidence_backup.py", "tools/operations_report.py", "tools/verify_release_image.py", "app/package.json",
    "app/scripts/demo.ts", "app/deploy/gateway.ts", "app/src/server.ts",
    "cataloger/Cargo.toml",
}


def mutable(path):
    return path.parts[:1] == ("logs",) or path.parts[:2] == ("app", ".data")


def describe(root, revision):
    root = Path(root).resolve(strict=True)
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Release revision must be a forty-character lowercase Git SHA")
    if any(not (root / name).is_file() or (root / name).is_symlink() for name in REQUIRED):
        raise ValueError("Missing required release artifacts")
    artifacts = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if relative.as_posix() == "artifacts.json" or mutable(relative):
            continue
        if any(part.startswith(".env") or part in (".vercel", "__pycache__") for part in relative.parts):
            raise ValueError("Private configuration or bytecode cache included in release")
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(root) or mutable(target.relative_to(root)):
                raise ValueError("Release symlink escapes immutable release files")
            artifacts.append({"path": relative.as_posix(), "symlink": os.readlink(path)})
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            info = path.stat()
            artifacts.append({"path": relative.as_posix(), "size": info.st_size,
                              "mode": stat.S_IMODE(info.st_mode), "sha256": digest.hexdigest()})
        elif not path.is_dir():
            raise ValueError("Unsupported release artifact file type")
    return {"format": 2, "revision": revision, "artifacts": artifacts}


def verify(root):
    root = Path(root)
    if (root / "artifacts.json").is_symlink():
        raise ValueError("Release manifest must not be a symlink")
    manifest = json.loads((root / "artifacts.json").read_text())
    if not isinstance(manifest, dict) or manifest.get("format") != 2:
        raise ValueError("Unsupported release artifact manifest")
    if manifest != describe(root, manifest.get("revision")):
        raise ValueError("Release artifact manifest does not match release files")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("revision")
    args = parser.parse_args()
    print(json.dumps(describe(args.root, args.revision), indent=2))
