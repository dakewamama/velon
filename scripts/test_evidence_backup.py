import importlib.util
import gc
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("evidence_backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class Recovery(unittest.TestCase):
    def test_restored_legacy_schema_sees_external_native_migrations_in_same_process(self):
        root = Path(__file__).resolve().parents[1]
        binary = Path(os.environ.get("AUTHZ_BIN", root / "runtime/target/debug/authorization-api"))
        self.assertTrue(binary.is_file(), "Build authorization-api before running recovery tests")
        migrations = sorted((root / "runtime/services/catalyst-indexer/migrations").glob("*.sql"))
        legacy = [path for path in migrations if int(path.name.split("_")[0]) <= 20261105000000]
        self.assertEqual(len(legacy), 8)
        expected = [int(path.name.split("_")[0]) for path in migrations]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = directory / "legacy.sqlite"
            # Build the actual eight-migration schema, including SQLx's native checksums.
            with closing(sqlite3.connect(source)) as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, "
                                   "description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "
                                   "success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)")
                for path in legacy:
                    version, description = path.stem.split("_", 1)
                    sql = path.read_text()
                    connection.executescript(sql)
                    connection.execute("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) "
                                       "VALUES (?,?,1,?,0)", (int(version), description.replace("_", " "),
                                                             hashlib.sha384(sql.encode()).digest()))
                    connection.commit()
                connection.execute("CREATE TABLE recovery_probe(amount TEXT NOT NULL)")
                connection.execute("INSERT INTO recovery_probe VALUES ('18446744073709551615')")
                connection.commit()
            # GC timing must not determine when SQLite stops using the temporary candidate alias.
            collecting = gc.isenabled()
            gc.disable()
            handles = []
            connect = sqlite3.connect

            class TrackedConnection(sqlite3.Connection):
                closed = False

                def close(self):
                    super().close()
                    self.closed = True

            def tracked_connect(*args, **kwargs):
                kwargs["factory"] = TrackedConnection
                connection = connect(*args, **kwargs)
                handles.append(connection)
                return connection

            try:
                with patch.object(backup.sqlite3, "connect", tracked_connect):
                    backup.backup(source, directory / "backup")
                    restored = directory / "restored.sqlite"
                    backup.restore(directory / "backup", restored)
                env = {key: value for key, value in os.environ.items()
                       if key not in ("RPC_URL", "UPSTREAM_RPC_URL", "MAINNET_RPC_URL", "DEVNET_RPC_URL")}
                env["DATABASE_URL"] = f"sqlite://{restored}"
                subprocess.run([str(binary), "history", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
                                "11111111111111111111111111111111"], env=env, check=True, stdout=subprocess.PIPE)
                independent = subprocess.check_output([
                    sys.executable, "-B", "-c",
                    "import json,sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); "
                    "print(json.dumps([r[0] for r in c.execute('SELECT version FROM _sqlx_migrations ORDER BY version')])); c.close()",
                    str(restored),
                ], text=True)
                self.assertEqual(json.loads(independent), expected)
                for _ in range(2):
                    with closing(sqlite3.connect(restored)) as connection:
                        self.assertEqual([row[0] for row in connection.execute(
                            "SELECT version FROM _sqlx_migrations ORDER BY version")], expected)
                        self.assertEqual(connection.execute("SELECT amount FROM recovery_probe").fetchall(),
                                         [("18446744073709551615",)])
                        self.assertEqual(connection.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
                        self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertTrue(all(handle.closed for handle in handles),
                                "Backup/restore retained SQLite handles across alias publication and external migration")
            finally:
                for handle in handles:
                    handle.close()
                if collecting:
                    gc.enable()
                gc.collect()

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
