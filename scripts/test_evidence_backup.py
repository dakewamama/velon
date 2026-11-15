import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("evidence_backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class Recovery(unittest.TestCase):
    def test_native_journal_survives_backup_restore_and_replay(self):
        root = Path(__file__).resolve().parents[1]
        binary = Path(os.environ.get("AUTHZ_BIN", root / "runtime/target/debug/authorization-api"))
        self.assertTrue(binary.is_file(), "Build authorization-api before running recovery tests")
        fixtures = root / "runtime/services/catalyst-indexer/tests/fixtures"
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "source.sqlite"
            env = dict(os.environ, DATABASE_URL=f"sqlite://{source}")
            imported = subprocess.check_output([
                str(binary), "import", str(fixtures / "catalog.json"), str(fixtures / "spl-snapshot.json")
            ], env=env)
            import json
            record = json.loads(imported)
            # Keep a WAL writer open during the online backup.
            with sqlite3.connect(source) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("CREATE TABLE recovery_probe (amount TEXT NOT NULL)")
                writer.execute("INSERT INTO recovery_probe VALUES ('18446744073709551615')")
                writer.commit()
                backup.backup(source, directory / "backup")
            backup.verify(directory / "backup")
            restored = directory / "restored.sqlite"
            backup.restore(directory / "backup", restored)
            env["DATABASE_URL"] = f"sqlite://{restored}"
            replay = subprocess.check_output([str(binary), "replay", record["id"]], env=env)
            self.assertEqual(json.loads(replay), record)
            with sqlite3.connect(restored) as reader:
                self.assertEqual(reader.execute("SELECT amount FROM recovery_probe").fetchone()[0],
                                 "18446744073709551615")
            with self.assertRaises(FileExistsError):
                backup.restore(directory / "backup", restored)
            data = directory / "backup/evidence.sqlite"
            with data.open("r+b") as stream:
                stream.write(b"corrupted")
            with self.assertRaises(ValueError):
                backup.restore(directory / "backup", directory / "rejected.sqlite")
            self.assertFalse((directory / "rejected.sqlite").exists())

    def test_missing_source_and_incomplete_backup_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaises(sqlite3.OperationalError):
                backup.backup(directory / "missing.sqlite", directory / "artifact")
            self.assertFalse((directory / "missing.sqlite").exists())
            self.assertFalse((directory / "artifact").exists())
            directory.joinpath("interrupted").mkdir()
            with self.assertRaises(FileNotFoundError):
                backup.verify(directory / "interrupted")


if __name__ == "__main__":
    unittest.main()
