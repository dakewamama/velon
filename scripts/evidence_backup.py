"""Coherent SQLite backup and non-overwriting restore. No service credentials needed."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def check(database):
    # sqlite3.Connection's context manager commits/rolls back; it does not close.
    # In particular, a checked restore candidate must be closed before linking its
    # inode under the destination name, whose WAL/SHM filenames are different.
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("SQLite integrity check failed")
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("SQLite foreign key check failed")
        return connection.execute(
            "SELECT version, description, success, hex(checksum) "
            "FROM _sqlx_migrations ORDER BY version"
        ).fetchall()


def sync(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def backup(source, destination):
    source, destination = Path(source), Path(destination)
    # mode=ro prevents a mistyped source path from creating an empty database.
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as original:
        destination.mkdir(mode=0o700)  # Existing artifacts are never overwritten.
        database = destination / "evidence.sqlite"
        with closing(sqlite3.connect(database)) as target:
            original.backup(target)
    migrations = check(database)
    manifest = {
        "format": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "sha256": digest(database),
        "bytes": database.stat().st_size,
        "migrations": migrations,
    }
    sync(database)
    # A manifest is the completion marker; an interrupted backup lacks one.
    marker = destination / "manifest.next"
    marker.write_text(json.dumps(manifest, indent=2) + "\n")
    sync(marker)
    marker.rename(destination / "manifest.json")
    sync(destination)
    sync(destination.parent)
    return manifest


def verify(artifact):
    artifact = Path(artifact)
    manifest = json.loads((artifact / "manifest.json").read_text())
    database = artifact / "evidence.sqlite"
    if manifest["format"] != 1 or digest(database) != manifest["sha256"]:
        raise ValueError("Backup checksum mismatch")
    if database.stat().st_size != manifest["bytes"]:
        raise ValueError("Backup size mismatch")
    if json.loads(json.dumps(check(database))) != manifest["migrations"]:
        raise ValueError("Backup migration metadata mismatch")
    return manifest


def restore(artifact, destination):
    artifact, destination = Path(artifact), Path(destination)
    manifest = verify(artifact)
    # Also refuse old WAL/SHM files: they may belong to retained live evidence.
    if any(Path(str(destination) + suffix).exists() for suffix in ("-wal", "-shm")):
        raise FileExistsError("Destination has SQLite sidecar files")
    with tempfile.TemporaryDirectory(prefix=".velon-restore-", dir=destination.parent) as temporary:
        candidate = Path(temporary) / "evidence.sqlite"
        with candidate.open("xb") as target:
            with (artifact / "evidence.sqlite").open("rb") as source:
                shutil.copyfileobj(source, target)
            target.flush()
            os.fsync(target.fileno())
        candidate.chmod(0o600)
        if digest(candidate) != manifest["sha256"]:
            raise ValueError("Restored checksum mismatch")
        check(candidate)
        # Publish only verified bytes; link fails atomically if the target exists.
        os.link(candidate, destination)
    sync(destination.parent)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("backup", "restore"):
        sub = commands.add_parser(command)
        sub.add_argument("source", type=Path)
        sub.add_argument("destination", type=Path)
    sub = commands.add_parser("verify")
    sub.add_argument("source", type=Path)
    args = parser.parse_args()
    if args.command == "verify":
        result = verify(args.source)
    else:
        result = globals()[args.command](args.source, args.destination)
    print(json.dumps(result))
