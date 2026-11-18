import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest

from check_release import check


class ReleaseParity(unittest.TestCase):
    def test_mismatch_tampering_redirects_and_legacy_metadata_fail_closed(self):
        revision = "a" * 40
        html = f'<head><meta name="velon-backend-revision" content="{revision}"></head>'.encode()
        script = b"reviewed console bytes"
        manifest = {"format": 1, "revision": revision, "apiVersion": "1", "consoleFile": "index.html", "assets": [
            {"name": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
            for name, body in [("index.html", html), ("console.js", script)]]}
        replies = {"/": html, "/console.js": script, "/release.json": json.dumps(manifest).encode(),
                   "/api/control": json.dumps({"revision": revision, "apiVersion": "1"}).encode()}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = replies.get(self.path, b"missing")
                self.send_response(302 if body == b"redirect" else 200)
                if body == b"redirect":
                    self.send_header("Location", "/console.js")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = "http://127.0.0.1:" + str(server.server_port)
        try:
            self.assertEqual(check(origin, manifest)["status"], "matched")
            for path, body in [("/console.js", b"tampered"), ("/console.js", b"redirect"),
                               ("/api/control", b"{}"), ("/api/control", b'"legacy"'),
                               ("/api/control", json.dumps({"revision": "b" * 40, "apiVersion": "1"}).encode()),
                               ("/release.json", b"{}")]:
                with self.subTest(path=path, body=body):
                    original = replies[path]
                    replies[path] = body
                    with self.assertRaises((ValueError, OSError)):
                        check(origin, manifest)
                    replies[path] = original
            for name in ["../private.js", "https://private.js", "console.js?token=secret"]:
                changed = {**manifest, "assets": [*manifest["assets"], {"name": name, "bytes": 1, "sha256": "a" * 64}]}
                with self.assertRaises(ValueError):
                    check(origin, changed)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
