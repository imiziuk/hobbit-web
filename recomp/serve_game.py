"""Read-only HTTP server for the game folder (used by web/game.html): GET/HEAD only, HTTP Range, CORS, and a manifest.

    python recomp/serve_game.py [--port 5191] [--root "../The.Hobbit.-.Clean/The Hobbit - Clean"]

Binds 127.0.0.1 only. Nothing is ever written; the data is not copied anywhere.
GET /__manifest -> {"files": [["Common/i18n.txt", size], ...]}
"""
import argparse, json, os, re, sys, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.environ.get("HOBBIT_GAME_DIR") or os.path.normpath(os.path.join(HERE, "..", "..", "The.Hobbit.-.Clean", "The Hobbit - Clean"))
SKIP = re.compile(r"(^|/)(shadow_fail[^/]*|\.git)(/|$)|\.log$|\.dll\.", re.I)


class Handler(BaseHTTPRequestHandler):
    root = DEFAULT_ROOT
    manifest = None
    overlay = {}          # {relative path (lower case): virtual file with .size and .read(lo, n)} from mp_assets.py

    def log_message(self, fmt, *args):
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_HEAD(self):
        self.serve(head=True)

    def do_GET(self):
        self.serve(head=False)

    def serve(self, head):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path == "/__manifest":
            if Handler.manifest is None:
                files = []
                for d, _, fs in os.walk(self.root):
                    for f in fs:
                        rel = os.path.relpath(os.path.join(d, f), self.root).replace("\\", "/")
                        if not SKIP.search(rel):
                            v = Handler.overlay.get(rel.lower())
                            files.append([rel, v.size if v else os.path.getsize(os.path.join(d, f))])
                Handler.manifest = json.dumps({"files": files}).encode()
            body = Handler.manifest
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        virt = Handler.overlay.get(path.lstrip("/").lower())
        full = os.path.normpath(os.path.join(self.root, path.lstrip("/")))
        if not virt and (not full.startswith(self.root + os.sep) or not os.path.isfile(full)):
            self.send_error(404)
            return
        size = virt.size if virt else os.path.getsize(full)
        lo, hi = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
        partial = bool(m)
        if m:
            if m.group(1):
                lo = int(m.group(1))
                hi = int(m.group(2)) if m.group(2) else size - 1
            else:
                lo = max(0, size - int(m.group(2)))
            hi = min(hi, size - 1)
            if lo > hi:
                self.send_response(416)
                self.cors()
                self.send_header("Content-Range", "bytes */%d" % size)
                self.end_headers()
                return
        self.send_response(206 if partial else 200)
        self.cors()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(hi - lo + 1))
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (lo, hi, size))
        self.end_headers()
        if head:
            return
        if virt:
            self.wfile.write(virt.read(lo, hi - lo + 1))
            return
        with open(full, "rb") as f:
            f.seek(lo)
            left = hi - lo + 1
            while left:
                chunk = f.read(min(left, 1 << 20))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)


def enable_mp(root, cache=None):
    """Add the multiplayer overlay (virtual patched DFS archives, see mp_assets.py). Never writes to the game folder."""
    sys.path.insert(0, HERE)
    import mp_assets
    syn = mp_assets.fetch_release(cache or os.path.join(os.path.dirname(HERE), "cache", "synchrony"))
    overlay, report = mp_assets.build_overlay(root, syn)
    Handler.overlay = {k.lower(): v for k, v in overlay.items()}
    Handler.manifest = None
    print("multiplayer assets: %d virtual archives" % (len(overlay) // 2), flush=True)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5191)
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--mp", action="store_true", help="serve virtual archives with the multiplayer (Synchrony) assets")
    a = ap.parse_args()
    Handler.root = os.path.normpath(os.path.abspath(a.root))
    if a.mp:
        enable_mp(Handler.root)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print("serving %s read-only on http://127.0.0.1:%d" % (Handler.root, a.port), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
