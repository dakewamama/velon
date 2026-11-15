"""Fail-closed production journal preflight.

This checks that the configured SQLite journal is an existing, readable database
on an explicitly mounted filesystem. It is not proof of remote backup or
archival completeness; those are separate operational release gates.
"""
import os
from pathlib import Path
import sqlite3
from urllib.parse import urlsplit


def require_persistent_database(environment, mounted=os.path.ismount):
    url = environment.get("DATABASE_URL", "")
    configured_mount = environment.get("VELON_EVIDENCE_MOUNT", "")
    if not url or not configured_mount:
        raise RuntimeError(
            "Mainnet requires DATABASE_URL and VELON_EVIDENCE_MOUNT; "
            "refusing an ephemeral evidence journal."
        )

    parsed = urlsplit(url)
    if (
        not url.startswith("sqlite:///")
        or parsed.scheme != "sqlite"
        or parsed.netloc
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
    ):
        raise RuntimeError("Mainnet DATABASE_URL must name one absolute SQLite file.")

    mount = Path(configured_mount)
    if (
        not mount.is_absolute()
        or mount.is_symlink()
        or not mount.is_dir()
        or not mounted(mount)
        or any(mount == forbidden or mount.is_relative_to(forbidden) for forbidden in (
            Path("/tmp"), Path("/var/tmp"), Path("/run"), Path("/dev/shm"), Path("/opt/velon")
        ))
        or mount == Path("/")
    ):
        raise RuntimeError("Mainnet evidence directory must be an active non-temporary mount.")

    database = Path(parsed.path)
    if database.is_symlink() or not database.resolve().is_relative_to(mount.resolve()):
        raise RuntimeError("Mainnet journal must be a regular file inside the evidence mount.")
    if not database.is_file():
        raise RuntimeError(
            "Mainnet journal is missing. Restore and verify previous evidence "
            "before starting the new release."
        )

    try:
        with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
            if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise RuntimeError("Mainnet journal integrity check failed.")
            if connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='authority_snapshots'"
            ).fetchone() is None:
                raise RuntimeError("Mainnet journal is not an initialized Velon evidence database.")
    except sqlite3.DatabaseError as error:
        raise RuntimeError("Mainnet journal cannot be read as a valid SQLite database.") from error

    return database.resolve()
