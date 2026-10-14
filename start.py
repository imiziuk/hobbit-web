"""One-command launcher for Hobbit Web (The Hobbit 2003, recompiled to WebAssembly, running in Chrome).

    python start.py                                   finds the game by itself (or asks), remembers it in config.json
    python start.py --game "D:\\Games\\The Hobbit"     use this folder (also remembered)
    python start.py --find                            forget the saved folder and search again
    python start.py --rebuild                         force re-translation + rebuild
    python start.py --no-browser --port 5190
    python start.py --mp                              multiplayer (docs/MULTIPLAYER.md): relay on port+2
    python start.py --mp --lan                        ... reachable from the LAN / Tailscale
    python start.py --single                          ONE port: page at /, game data at /data/, relay at /relay
                                                      (default in Docker; needed behind Cloudflare Tunnel + Access)

What it does, in order:
 1. finds your game folder (find_game: --game, config.json, HOBBIT_GAME_DIR, a game/ folder next to this repo,
    the Windows uninstall registry, common install folders; otherwise it asks) and checks Meridian.exe + archives,
 2. creates .venv with capstone + pefile (translator dependencies),
 3. downloads wasi-sdk 34 (clang for WebAssembly) into tools/ if WASI_SDK is not set,
 4. translates Meridian.exe to C and compiles recomp/out/hobbit_flat.wasm (first run: a few minutes),
 5. serves this folder on 127.0.0.1:<port> and your game folder READ-ONLY on 127.0.0.1:<port+1> (relay: port+2),
    or with --single everything on <port> (/data/ = game folder, /relay = WebSocket relay),
 6. opens http://127.0.0.1:<port>/web/game.html (Chrome/Edge 137+ needed: WebAssembly JSPI).
Nothing is ever written to the game folder. Game files are never copied into this repo.
"""
import argparse, email.utils, gzip, hashlib, http.server, json, os, platform, shutil, subprocess, sys, tarfile
import threading, urllib.parse, urllib.request, webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
DEV_TREE = not os.path.isdir(os.path.join(HERE, "recomp"))      # run from Hobbit-Decomp/webrepo/ in the source tree:
if DEV_TREE:                                                     # serve the parent, never save config.json
    HERE = os.path.dirname(HERE)
KNOWN_MD5 = {"3e351efeea5c7e1eb55095d8f5b12fab": "retail PC v1.0 (the version this port is verified on)"}
WASI_VER = "34"
OUT = os.path.join(HERE, "recomp", "out")
WASM = os.path.join(OUT, "hobbit_flat.wasm")


def say(msg):
    print("[hobbit-web] " + msg, flush=True)


def die(msg):
    say("ERROR: " + msg)
    sys.exit(1)


def find_exe(game):
    for name in os.listdir(game):
        if name.lower() == "meridian.exe":
            return os.path.join(game, name)
    return None


def game_problem(game):
    """None if `game` is an installed game folder, else the reason it is not."""
    if not game or not os.path.isdir(game):
        return "folder not found"
    try:
        names = [n.lower() for n in os.listdir(game)]
    except OSError as e:
        return str(e)
    if "meridian.exe" not in names:
        return "no Meridian.exe in it"
    if "common.dfs" not in names:
        return "no common.DFS in it (point at the installed game folder, not the CD or the installer)"
    return None


def _registry_installs():
    """InstallLocation of every uninstall entry whose name contains 'Hobbit' (Windows only)."""
    out = []
    try:
        import winreg
    except ImportError:
        return out
    keys = ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
    for root, key in keys:
        try:
            h = winreg.OpenKey(root, key)
        except OSError:
            continue
        for i in range(winreg.QueryInfoKey(h)[0]):
            try:
                sub = winreg.OpenKey(h, winreg.EnumKey(h, i))
                if "hobbit" not in str(winreg.QueryValueEx(sub, "DisplayName")[0]).lower():
                    continue
            except OSError:
                continue
            for v in ("InstallLocation", "InstallDir", "DisplayIcon"):
                try:
                    val = str(winreg.QueryValueEx(sub, v)[0]).strip('"').split(",")[0]
                except OSError:
                    continue
                out.append(os.path.dirname(val) if val.lower().endswith(".exe") else val)
    return out


def candidates():
    """Places a Hobbit install usually lives, most specific first."""
    seen, out = set(), []

    def add(p):
        if p:
            p = os.path.normpath(os.path.expandvars(os.path.expanduser(p)))
            if p.lower() not in seen:
                seen.add(p.lower())
                out.append(p)

    add(os.environ.get("HOBBIT_GAME_DIR"))
    for base in (HERE, os.path.dirname(HERE)):          # a game/ (or similar) folder inside or next to the repo
        for n in ("game", "Game", "The Hobbit", "Hobbit", "hobbit"):
            add(os.path.join(base, n))
    drives = []
    if os.name == "nt":
        for p in _registry_installs():                  # installers record where they put the game
            add(p)
        drives = [d + ":\\" for d in "CDEFGH" if os.path.exists(d + ":\\")]
        for d in drives:
            for rel in (r"Program Files (x86)\Sierra\The Hobbit", r"Program Files\Sierra\The Hobbit",
                        r"Program Files (x86)\Vivendi Universal Games\The Hobbit", r"Program Files (x86)\The Hobbit",
                        r"Program Files\The Hobbit", r"Games\The Hobbit", r"Games\Hobbit", "The Hobbit"):
                add(os.path.join(d, rel))
    else:                                               # Wine / CrossOver prefixes on Linux and macOS
        for pre in ("~/.wine/drive_c", "~/Games"):
            for rel in ("Program Files (x86)/Sierra/The Hobbit", "Program Files/Sierra/The Hobbit", "The Hobbit"):
                add(os.path.join(pre, rel))
    # two levels under the usual roots: any folder whose name contains "hobbit", and its subfolders
    roots = [os.path.join(os.path.expanduser("~"), n) for n in ("Downloads", "Games", "Desktop", "Documents")]
    roots += [os.path.join(d, n) for d in drives for n in ("Games", "Program Files (x86)", "Program Files")]
    for r in roots:
        try:
            names = os.listdir(r)
        except OSError:
            continue
        for n in names:
            if "hobbit" not in n.lower():
                continue
            add(os.path.join(r, n))
            try:
                for m in os.listdir(os.path.join(r, n)):
                    add(os.path.join(r, n, m))
            except OSError:
                pass
    return out


def find_game(given, saved, refind):
    """--game > config.json > automatic search > ask. Returns the game folder."""
    if given:
        game = os.path.abspath(given)
        why = game_problem(game)
        if why:
            die(f"--game {game}: {why}")
        return game
    if saved and not refind:
        why = game_problem(saved)
        if not why:
            return saved
        say(f"the saved game folder {saved} is not usable any more ({why}); searching again")
    say("looking for The Hobbit...")
    found = [c for c in candidates() if not game_problem(c)]
    if len(found) == 1:
        say(f"found the game: {found[0]}")
        return found[0]
    if found:
        say("found more than one game folder:")
        for i, f in enumerate(found, 1):
            say(f"  {i}. {f}")
    else:
        say("could not find it automatically.")
    if not sys.stdin or not sys.stdin.isatty():
        die('run:  python start.py --game "<folder that contains Meridian.exe>"')
    while True:
        prompt = "Type a number or a folder path: " if found else "Where is The Hobbit installed? (folder with Meridian.exe): "
        ans = input("[hobbit-web] " + prompt).strip().strip('"')
        if found and ans.isdigit() and 1 <= int(ans) <= len(found):
            return found[int(ans) - 1]
        game = os.path.abspath(os.path.expanduser(ans)) if ans else ""
        why = game_problem(game)
        if not why:
            return game
        say(f"  {game or '(nothing typed)'}: {why}")


def check_game(game):
    exe = find_exe(game)
    dfs = [f for f in os.listdir(game) if f.lower().endswith(".dfs")]
    md5 = hashlib.md5(open(exe, "rb").read()).hexdigest()
    if md5 in KNOWN_MD5:
        say(f"Meridian.exe OK ({KNOWN_MD5[md5]}), {len(dfs)} archives")
    else:
        say(f"WARNING: Meridian.exe md5 {md5} is not the verified version 3e351efe...; translation may not match")
    return exe


def venv_python():
    vdir = os.path.join(HERE, ".venv")
    py = os.path.join(vdir, "Scripts", "python.exe") if os.name == "nt" else os.path.join(vdir, "bin", "python")
    if not os.path.exists(py):
        say("creating .venv (capstone, pefile)")
        subprocess.check_call([sys.executable, "-m", "venv", vdir])
    try:
        subprocess.check_call([py, "-c", "import capstone, pefile"], stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        subprocess.check_call([py, "-m", "pip", "install", "-q", "capstone", "pefile"])
    return py


def wasi_sdk():
    if os.environ.get("WASI_SDK"):
        return os.environ["WASI_SDK"]
    arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x86_64"
    osname = {"Windows": "windows", "Darwin": "macos"}.get(platform.system(), "linux")
    name = f"wasi-sdk-{WASI_VER}.0-{arch}-{osname}"
    for base in (os.path.join(HERE, "tools"), r"C:\tools"):
        if os.path.isdir(os.path.join(base, name)):
            return os.path.join(base, name)
    tools = os.path.join(HERE, "tools")
    os.makedirs(tools, exist_ok=True)
    url = f"https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-{WASI_VER}/{name}.tar.gz"
    tgz = os.path.join(tools, name + ".tar.gz")
    say(f"downloading {url} (~120 MB, once)")
    urllib.request.urlretrieve(url, tgz)
    with tarfile.open(tgz) as t:
        t.extractall(tools, filter="data") if sys.version_info >= (3, 12) else t.extractall(tools)
    os.remove(tgz)
    return os.path.join(tools, name)


def build(exe, rebuild):
    if os.path.exists(WASM) and not rebuild:
        say("using existing recomp/out/hobbit_flat.wasm (pass --rebuild to rebuild)")
        return
    env = dict(os.environ, HOBBIT_EXE=exe, WASI_SDK=wasi_sdk())
    py = venv_python()
    say("translating Meridian.exe -> C (about 1 min)")
    subprocess.check_call([py, os.path.join(HERE, "recomp", "x86c.py")], cwd=HERE, env=env)
    say("compiling C -> WebAssembly (a few minutes the first time)")
    subprocess.check_call([sys.executable, os.path.join(HERE, "recomp", "build.py"), "--flat"], cwd=HERE, env=env)


GZIP_TYPES = (".wasm", ".mjs", ".js", ".json", ".txt", ".html", ".css", ".svg", ".tsv", ".md")


def ensure_wasm_gz(path=None):
    """Precompress hobbit_flat.wasm -> .wasm.gz (34.7 MB -> ~6.4 MB) if missing or older than the wasm."""
    path = path or WASM
    gz = path + ".gz"
    if not os.path.exists(path):
        return
    if os.path.exists(gz) and os.path.getmtime(gz) >= os.path.getmtime(path):
        return
    if not os.access(os.path.dirname(path), os.W_OK):               # read-only deploy: ship the .gz prebuilt
        say(f"note: {os.path.basename(gz)} missing or stale and the build folder is read-only; serving uncompressed")
        return
    say(f"compressing {os.path.basename(path)} for download (gzip, once per build)")
    with open(path, "rb") as f:
        data = gzip.compress(f.read(), compresslevel=9, mtime=0)
    with open(gz + ".part", "wb") as f:
        f.write(data)
    os.replace(gz + ".part", gz)
    say(f"  {os.path.getsize(path) / 1e6:.1f} MB -> {len(data) / 1e6:.1f} MB")


class StaticHandler(http.server.SimpleHTTPRequestHandler):
    """This repo, read-only. Text and wasm go out gzip-compressed when the browser accepts it (the wasm from the
    precompressed .wasm.gz next to it); every file has an ETag + Last-Modified and `Cache-Control: no-cache`, so a
    reload costs one 304 per file instead of the download."""
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    gz_cache = {}                  # path -> (mtime_ns, size, gzip bytes) for small text files
    gz_lock = threading.Lock()

    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, *a):
        pass

    def do_GET(self):
        self.static(head=False)

    def do_HEAD(self):
        self.static(head=True)

    def gz_body(self, full, st):
        """(gzip bytes, None) or (None, path of a precompressed .gz) or (None, None) = send it uncompressed."""
        if full.endswith(".wasm"):
            gz = full + ".gz"
            return (None, gz) if os.path.exists(gz) and os.path.getmtime(gz) >= st.st_mtime else (None, None)
        if st.st_size > (8 << 20):
            return None, None
        with self.gz_lock:
            hit = self.gz_cache.get(full)
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2], None
        with open(full, "rb") as f:
            data = gzip.compress(f.read(), compresslevel=6, mtime=0)
        with self.gz_lock:
            self.gz_cache[full] = (st.st_mtime_ns, st.st_size, data)
        return data, None

    def static(self, head):
        full = self.translate_path(self.path)
        if not os.path.isfile(full):
            return super().do_HEAD() if head else super().do_GET()      # directory listing / index.html / 404
        st = os.stat(full)
        ext = os.path.splitext(full)[1].lower()
        body, gz_file = None, None
        if ext in GZIP_TYPES and st.st_size > 1024 and "gzip" in self.headers.get("Accept-Encoding", ""):
            body, gz_file = self.gz_body(full, st)
        use_gz = body is not None or gz_file is not None
        etag = '"%x-%x%s"' % (st.st_size, st.st_mtime_ns, "-gz" if use_gz else "")
        common = [("ETag", etag), ("Cache-Control", "no-cache"), ("Vary", "Accept-Encoding"),
                  ("Last-Modified", email.utils.formatdate(st.st_mtime, usegmt=True))]
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            for k, v in common:
                self.send_header(k, v)
            self.end_headers()
            return
        length = len(body) if body is not None else os.path.getsize(gz_file) if gz_file else st.st_size
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(full))
        self.send_header("Content-Length", str(length))
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
        for k, v in common:
            self.send_header(k, v)
        self.end_headers()
        if head:
            return
        if body is not None:
            self.wfile.write(body)
            return
        with open(gz_file or full, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1 << 20)


class SiteHandler(StaticHandler):
    """Single-origin mode (--single): one port for everything, so one login (Cloudflare Access) covers it all.
        /__mode        {"single": true, "data": "data", "relay": "relay" or null}   (web/game.mjs reads it)
        /data/...      the game folder, read-only (recomp/serve_game.py: Range, manifest, multiplayer overlay)
        /relay         the multiplayer WebSocket relay (recomp/mp_relay.py), with --mp
        anything else  this repo (StaticHandler)"""
    relay = None
    protocol_version = "HTTP/1.1"          # keep-alive: the game makes many small Range requests

    def cors(self):
        pass                               # same origin: no CORS headers needed

    def route(self, head):
        import serve_game, mp_relay
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path == "/__mode":
            body = json.dumps({"single": True, "data": "data", "relay": "relay" if self.relay else None}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        if path == "/data" or path.startswith("/data/"):
            serve_game.serve_path(self, path[5:] or "/", head)
            return
        if path == "/relay":
            if self.relay and not head and mp_relay.serve_upgrade(self, self.relay):
                return
            body = b"Hobbit Web multiplayer relay (WebSocket)" + (b"" if self.relay else b": off (start with --mp)") + b"\n"
            self.send_response(200 if self.relay else 404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return
        self.static(head)

    def do_GET(self):
        self.route(head=False)

    def do_HEAD(self):
        self.route(head=True)


def local_ips():
    """LAN / Tailscale IPv4 addresses of this machine (best effort, stdlib only)."""
    import socket
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


def serve(game, port, open_browser, mp=False, lan=False, single=False, legacy_ports=False):
    sys.path.insert(0, os.path.join(HERE, "recomp"))
    import serve_game, mp_relay
    serve_game.Handler.root = os.path.normpath(os.path.abspath(game))
    host = "0.0.0.0" if lan else "127.0.0.1"
    ensure_wasm_gz()
    relay = None
    if mp:
        for line in serve_game.enable_mp(game, os.path.join(HERE, "cache", "synchrony")):
            say("  " + line)
        relay = mp_relay.Relay(log=lambda s: say(s))
    servers = []
    if single:
        SiteHandler.relay = relay
        web = http.server.ThreadingHTTPServer((host, port), SiteHandler)
    else:
        web = http.server.ThreadingHTTPServer((host, port), StaticHandler)
    if not single or legacy_ports:          # separate data + relay ports (3-port layout; Tailscale serve 8443 / 10000)
        servers.append(http.server.ThreadingHTTPServer((host, port + 1), serve_game.Handler))
        if mp:
            servers.append(mp_relay.make_server(host, port + 2, relay=relay))   # same rooms as /relay
    for srv in servers:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/web/game.html"
    if not single and port != 5190:
        url += f"?data=http://127.0.0.1:{port + 1}"
    if single:
        say(f"single-origin server http://{host}:{port}: page /, game data /data/ (read-only <- {game})"
            + (", relay /relay" if mp else ""))
        if legacy_ports:
            say(f"  also on the old ports: data {port + 1}" + (f", relay {port + 2}" if mp else ""))
    else:
        say(f"game data (read-only): http://{host}:{port + 1}  <- {game}")
        if mp:
            say(f"multiplayer relay: ws://{host}:{port + 2}  (assets: Synchrony v1.0 fake-Bilbo layer, served as virtual archives)")
    say(f"PLAY: {url}   (Chrome/Edge 137+; Ctrl+C here to stop)")
    if lan and os.environ.get("HOBBIT_IN_DOCKER"):
        say(f"in Docker: open http://127.0.0.1:{port}/web/game.html on this machine")
        say("  friends (Tailscale node 'hobbit-web', see docker-compose.yml): https://hobbit-web.<your-tailnet>.ts.net/web/game.html")
        if single:
            say(f"  Cloudflare Tunnel (docker compose --profile cloudflare up -d): public hostname service = http://127.0.0.1:{port}")
        lan = False
    if lan:
        for ip in local_ips():
            if single:
                say(f"  from another device: http://{ip}:{port}/web/game.html")
            else:
                say(f"  from another device: http://{ip}:{port}/web/game.html?data=http://{ip}:{port + 1}" + (f"&mp={ip}:{port + 2}" if mp else ""))
        if mp:
            say("  friends with their own copy: run start.py --mp and put "
                + (f"<this IP>:{port}/relay" if single else f"<this IP>:{port + 2}") + " in the Server field")
        say("  --lan: anyone who can reach this machine can open the page and read the game files; use it on trusted networks")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        web.serve_forever()
    except KeyboardInterrupt:
        say("stopped")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", help="installed game folder (contains Meridian.exe and *.DFS); default: saved or auto-detected")
    ap.add_argument("--find", action="store_true", help="ignore the saved folder and search for the game again")
    ap.add_argument("--port", type=int, default=5190)
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--mp", action="store_true", help="multiplayer: fake-Bilbo assets from the Synchrony release (downloaded "
                    "once into cache/) + WebSocket relay on port+2")
    ap.add_argument("--lan", action="store_true", help="listen on all interfaces (LAN / Tailscale) instead of 127.0.0.1")
    ap.add_argument("--single", action="store_true", default=None, help="one port: page /, game data /data/, relay /relay "
                    "(default in Docker; what Cloudflare Tunnel + Access needs)")
    ap.add_argument("--multi-port", dest="single", action="store_false", help="the 3-port layout: page, data port+1, relay port+2")
    ap.add_argument("--legacy-ports", action="store_true", default=None, help="with --single: also serve the data on port+1 "
                    "and the relay on port+2 (default in Docker, for the Tailscale serve ports 8443 / 10000)")
    a = ap.parse_args()
    docker = bool(os.environ.get("HOBBIT_IN_DOCKER"))
    single = docker if a.single is None else a.single
    legacy = single and (docker if a.legacy_ports is None else a.legacy_ports)
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    game = find_game(a.game, cfg.get("game_dir"), a.find)
    exe = check_game(game)
    if game != cfg.get("game_dir") and not DEV_TREE:
        try:
            with open(CONFIG, "w") as f:
                json.dump({"game_dir": game}, f, indent=2)
            say("remembered in config.json (change it with --game or --find)")
        except OSError:                                              # read-only container (docker-compose.server.yml)
            pass
    if not shutil.which("node"):
        say("note: Node.js is optional (only for the headless runner recomp/boot_node.mjs)")
    build(exe, a.rebuild)
    serve(game, a.port, not a.no_browser, mp=a.mp, lan=a.lan, single=single, legacy_ports=legacy)


if __name__ == "__main__":
    main()
