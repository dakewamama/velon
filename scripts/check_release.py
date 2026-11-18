"""Compare deployed console bytes and backend identity with a trusted exported manifest."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def check(origin, manifest):
    url = urllib.parse.urlsplit(origin)
    if (url.scheme not in ("http", "https") or not url.netloc or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("Expected an origin without credentials, path or query")
    if (manifest.get("format") != 1 or manifest.get("apiVersion") != "1"
            or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("revision", ""))):
        raise ValueError("Unsupported release manifest")
    assets = manifest.get("assets", [])
    names = [entry.get("name", "") for entry in assets]
    if not assets or "index.html" not in names or not any(n.endswith(".js") for n in names):
        raise ValueError("Console HTML and script are required")
    if len(names) != len(set(names)):
        raise ValueError("Duplicate assets")
    console_file = manifest.get("consoleFile")
    if console_file not in ("index.html", "app.html") or console_file not in names:
        raise ValueError("Missing console page identity")
    for entry in assets:
        if (not re.fullmatch(r"[\w.-]+\.(html|js|css|png|svg|webp|jpg|woff2)", entry["name"])
                or not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", ""))
                or type(entry.get("bytes")) is not int or not 0 < entry["bytes"] <= 8_000_000):
            raise ValueError("Invalid asset identity")
    opener = urllib.request.build_opener(NoRedirect)

    def get(path, limit=1_000_000):
        request = urllib.request.Request(origin.rstrip("/") + path,
                                         headers={"Cache-Control": "no-cache"})
        with opener.open(request, timeout=15) as reply:
            body = reply.read(limit + 1)
        if len(body) > limit:
            raise ValueError("Response exceeds its declared size")
        return body

    if json.loads(get("/release.json")) != manifest:
        raise ValueError("Deployed manifest differs from the trusted export")
    control = json.loads(get("/api/control"))
    if (not isinstance(control, dict) or control.get("revision") != manifest["revision"]
            or control.get("apiVersion") != manifest["apiVersion"]):
        raise ValueError("Backend release or API version differs from the frontend")
    for entry in assets:
        path = {"index.html": "/", "app.html": "/app"}.get(entry["name"], "/" + entry["name"])
        body = get(path, entry["bytes"])
        if len(body) != entry["bytes"] or hashlib.sha256(body).hexdigest() != entry["sha256"]:
            raise ValueError("Deployed asset checksum mismatch: " + entry["name"])
        if entry["name"] == console_file:
            pin = f'name="velon-backend-revision" content="{manifest["revision"]}"'
            if pin.encode() not in body:
                raise ValueError("Console does not pin the reviewed backend revision")
    return {"status": "matched", "revision": manifest["revision"], "apiVersion": manifest["apiVersion"],
            "verified_assets": len(assets), "cluster": control.get("cluster"),
            "network": control.get("network"), "scope": "release identity; not evidence health"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("manifest", type=Path, help="Trusted local export's release.json")
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.origin, json.loads(args.manifest.read_text()))))
    except (ValueError, KeyError, TypeError, OSError, urllib.error.URLError):
        # Provider exceptions can contain signed URLs or other private connection details.
        print(json.dumps({"status": "failed", "reason": "Release metadata, asset bytes or reachability did not verify"}))
        raise SystemExit(1)
