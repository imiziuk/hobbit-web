"""One-command launcher for Hobbit Web (The Hobbit 2003, recompiled to WebAssembly, running in Chrome).

    python start.py                                   finds the game by itself (or asks), remembers it in config.json
    python start.py --game "D:\\Games\\The Hobbit"     use this folder (also remembered)
    python start.py --find                            forget the saved folder and search again
    python start.py --rebuild                         force re-translation + rebuild
    python start.py --no-browser --port 5190
    python start.py --mp                              multiplayer (docs/MULTIPLAYER.md): relay on port+2
    python start.py --mp --lan                        ... reachable from the LAN / Tailscale

What it does, in order:
 1. finds your game folder (find_game: --game, config.json, HOBBIT_GAME_DIR, a game/ folder next to this repo,
    the Windows uninstall registry, common install folders; otherwise it asks) and checks Meridian.exe + archives,
 2. creates .venv with capstone + pefile (translator dependencies),
 3. downloads wasi-sdk 34 (clang for WebAssembly) into tools/ if WASI_SDK is not set,
 4. translates Meridian.exe to C and compiles recomp/out/hobbit_flat.wasm (first run: a few minutes),
 5. serves this folder on 127.0.0.1:<port> and your game folder READ-ONLY on 127.0.0.1:<port+1>,
 6. opens http://127.0.0.1:<port>/web/game.html (Chrome/Edge 137+ needed: WebAssembly JSPI).
Nothing is ever written to the game folder. Game files are never copied into this repo.
"""
import argparse, hashlib, http.server, json, os, platform, shutil, subprocess, sys, tarfile, threading, urllib.request, webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "config.json")
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


class StaticHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


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


def serve(game, port, open_browser, mp=False, lan=False):
    sys.path.insert(0, os.path.join(HERE, "recomp"))
    import serve_game
    serve_game.Handler.root = game
    host = "0.0.0.0" if lan else "127.0.0.1"
    if mp:
        import mp_relay
        for line in serve_game.enable_mp(game, os.path.join(HERE, "cache", "synchrony")):
            say("  " + line)
        relay = mp_relay.make_server(host, port + 2, log=lambda s: say(s))
        threading.Thread(target=relay.serve_forever, daemon=True).start()
    data = http.server.ThreadingHTTPServer((host, port + 1), serve_game.Handler)
    web = http.server.ThreadingHTTPServer((host, port), StaticHandler)
    threading.Thread(target=data.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/web/game.html" + ("" if port == 5190 else f"?data=http://127.0.0.1:{port + 1}")
    say(f"game data (read-only): http://{host}:{port + 1}  <- {game}")
    if mp:
        say(f"multiplayer relay: ws://{host}:{port + 2}  (assets: Synchrony v1.0 fake-Bilbo layer, served as virtual archives)")
    say(f"PLAY: {url}   (Chrome/Edge 137+; Ctrl+C here to stop)")
    if lan:
        for ip in local_ips():
            say(f"  from another device: http://{ip}:{port}/web/game.html?data=http://{ip}:{port + 1}" + (f"&mp={ip}:{port + 2}" if mp else ""))
        if mp:
            say(f"  friends with their own copy: run start.py --mp and put <this IP>:{port + 2} in the Server field")
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
    a = ap.parse_args()
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    game = find_game(a.game, cfg.get("game_dir"), a.find)
    exe = check_game(game)
    if game != cfg.get("game_dir"):
        json.dump({"game_dir": game}, open(CONFIG, "w"), indent=2)
        say("remembered in config.json (change it with --game or --find)")
    if not shutil.which("node"):
        say("note: Node.js is optional (only for the headless runner recomp/boot_node.mjs)")
    build(exe, a.rebuild)
    serve(game, a.port, not a.no_browser, mp=a.mp, lan=a.lan)


if __name__ == "__main__":
    main()
