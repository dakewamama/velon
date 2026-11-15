"""Regression tests for production evidence persistence gates."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

module_path = Path(__file__).resolve().parents[1] / "app/deploy/evidence_storage.py"
spec = importlib.util.spec_from_file_location("evidence_storage", module_path)
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class EvidenceStorage(unittest.TestCase):
    def test_existing_mounted_initialized_database_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory)
            database = mount / "observations.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE authority_snapshots (id TEXT PRIMARY KEY)")
            environment = {
                "DATABASE_URL": f"sqlite://{database}",
                "VELON_EVIDENCE_MOUNT": str(mount),
            }
            self.assertEqual(
                storage.require_persistent_database(environment, mounted=lambda path: path == mount),
                database.resolve(),
            )

    def test_missing_config_mount_and_database_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory)
            database = mount / "observations.db"
            environment = {
                "DATABASE_URL": f"sqlite://{database}",
                "VELON_EVIDENCE_MOUNT": str(mount),
            }
            invalid = [
                {},
                {"DATABASE_URL": environment["DATABASE_URL"]},
                {"VELON_EVIDENCE_MOUNT": environment["VELON_EVIDENCE_MOUNT"]},
                {**environment, "DATABASE_URL": "sqlite::memory:"},
                {**environment, "DATABASE_URL": "sqlite:///tmp/observations.db"},
                {**environment, "DATABASE_URL": "https://example.com/db"},
                {**environment, "DATABASE_URL": environment["DATABASE_URL"] + "?mode=rwc"},
            ]
            for case in invalid:
                with self.subTest(case=case):
                    with self.assertRaises(RuntimeError):
                        storage.require_persistent_database(case, mounted=lambda path: path == mount)
            self.assertFalse(database.exists(), "Checking missing evidence must not create it.")
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE authority_snapshots (id TEXT PRIMARY KEY)")
            with self.assertRaises(RuntimeError):
                storage.require_persistent_database(environment, mounted=lambda path: False)

    def test_corrupt_uninitialized_and_symlinked_database_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            mount = Path(directory)
            database = mount / "observations.db"
            environment = {
                "DATABASE_URL": f"sqlite://{database}",
                "VELON_EVIDENCE_MOUNT": str(mount),
            }
            mounted = lambda path: path == mount
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE unrelated (id TEXT)")
            with self.assertRaisesRegex(RuntimeError, "initialized Velon"):
                storage.require_persistent_database(environment, mounted=mounted)
            database.write_bytes(b"not a sqlite database")
            with self.assertRaisesRegex(RuntimeError, "valid SQLite"):
                storage.require_persistent_database(environment, mounted=mounted)
            database.unlink()
            outside = mount.parent / f"{mount.name}-outside.db"
            try:
                with sqlite3.connect(outside) as connection:
                    connection.execute("CREATE TABLE authority_snapshots (id TEXT PRIMARY KEY)")
                database.symlink_to(outside)
                with self.assertRaisesRegex(RuntimeError, "regular file"):
                    storage.require_persistent_database(environment, mounted=mounted)
            finally:
                outside.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
