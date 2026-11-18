"""Exercise the release startup boundary against omitted or changed files."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "release_artifacts", REPO / "app/deploy/release_artifacts.py"
)
artifacts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifacts)


class ReleaseArtifacts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="velon-artifacts-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in artifacts.REQUIRED | {"app/node_modules/package/index.js"}:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original release bytes\n")
        self.manifest = artifacts.describe(self.root, "a" * 40)
        self.save(self.manifest)

    def save(self, manifest):
        (self.root / "artifacts.json").write_text(json.dumps(manifest))

    def test_complete_release_survives_mutable_evidence_and_logs(self):
        for name in ("app/.data/observations.db", "app/.data/observations.db-wal", "logs/app.log"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"retained mutable evidence")
        self.assertEqual(artifacts.verify(self.root), self.manifest)

    def test_empty_omitted_duplicate_and_malformed_manifests_are_rejected(self):
        entries = self.manifest["artifacts"]
        bad = [
            {**self.manifest, "artifacts": []},
            {**self.manifest, "artifacts": entries[1:]},
            {**self.manifest, "artifacts": entries + entries[:1]},
            {**self.manifest, "revision": "z" * 40},
            {**self.manifest, "format": 1},
            [],
        ]
        for manifest in bad:
            with self.subTest(manifest=manifest):
                self.save(manifest)
                with self.assertRaises(ValueError):
                    artifacts.verify(self.root)

    def test_application_dependency_and_permission_changes_are_detected(self):
        for name in ("bin/bun", "app/scripts/demo.ts", "app/node_modules/package/index.js"):
            path = self.root / name
            original = path.read_bytes()
            with self.subTest(path=name):
                path.write_bytes(original + b"changed")
                with self.assertRaisesRegex(ValueError, "does not match"):
                    artifacts.verify(self.root)
                path.write_bytes(original)
        path.chmod(0o700)
        with self.assertRaisesRegex(ValueError, "does not match"):
            artifacts.verify(self.root)

    def test_added_files_and_omitted_required_files_are_detected(self):
        (self.root / "app/injected.js").write_text("injected code")
        with self.assertRaisesRegex(ValueError, "does not match"):
            artifacts.verify(self.root)
        (self.root / "bin/bun").rename(self.root / "bin/renamed-bun")
        with self.assertRaisesRegex(ValueError, "Missing required"):
            artifacts.describe(self.root, "a" * 40)

    def test_internal_links_are_bound_and_external_or_mutable_links_are_rejected(self):
        link = self.root / "app/package-link"
        link.symlink_to("node_modules/package", target_is_directory=True)
        self.save(artifacts.describe(self.root, "a" * 40))
        artifacts.verify(self.root)
        other = self.root / "app/other-link"
        other.symlink_to("../..", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes immutable"):
            artifacts.describe(self.root, "a" * 40)

    def test_private_configuration_is_not_packaged(self):
        (self.root / "app/.env.local").write_text("disposable fixture only")
        with self.assertRaisesRegex(ValueError, "Private configuration"):
            artifacts.describe(self.root, "a" * 40)

    def test_source_links_cannot_target_mutable_evidence(self):
        data = self.root / "app/.data"
        data.mkdir()
        (self.root / "app/mutable-link").symlink_to(".data", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes immutable"):
            artifacts.describe(self.root, "a" * 40)

    def test_actual_supervisor_rejects_empty_manifest_before_launch(self):
        self.save({**self.manifest, "artifacts": []})
        result = subprocess.run(
            [sys.executable, "-B", str(REPO / "app/deploy/supervisor.py")],
            env={**os.environ, "VELON_ROOT": str(self.root)},
            capture_output=True, text=True, timeout=10,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Release artifact manifest does not match release files", result.stderr)
        self.assertFalse(list((self.root / "logs").glob("*.log")))


class SourceIdentity(unittest.TestCase):
    def test_real_runner_rejects_wrong_revision_and_dirty_source_before_build(self):
        with tempfile.TemporaryDirectory(prefix="velon-source-identity-") as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            script = root / "scripts/validate.sh"
            script.write_text((REPO / "scripts/validate.sh").read_text())
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(
                ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@invalid",
                 "commit", "--quiet", "-m", "fixture"], cwd=root, check=True,
            )
            revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            for supplied, dirty, message in [
                ("0" * 40, False, "Source checkout does not match"),
                (revision, True, "Source checkout has uncommitted files"),
            ]:
                if dirty:
                    (root / "untracked-source.ts").write_text("changed build input")
                result = subprocess.run(
                    ["bash", str(script)],
                    env={**os.environ, "VELON_REVISION": supplied, "RAILWAY_GIT_COMMIT_SHA": ""},
                    capture_output=True, text=True, timeout=10,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertIn("STAGE=identity", result.stdout)
                self.assertNotIn("rustc", result.stdout)


if __name__ == "__main__":
    unittest.main()
