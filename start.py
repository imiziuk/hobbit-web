"""One-command launcher for Hobbit Web (The Hobbit 2003, recompiled to WebAssembly, running in Chrome).

    python start.py --game "D:\\Games\\The Hobbit"     first run: remembers the folder in config.json
    python start.py                                   later runs
    python start.py --rebuild                         force re-translation + rebuild
    python start.py --no-browser --port 5190

What it does, in order:
 1. checks your game folder (Meridian.exe + the .DFS archives) and the exe's checksum,
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


def check_game(game):
    if not game or not os.path.isdir(game):
        die("game folder not found. Run:  python start.py --game \"<folder that contains Meridian.exe>\"")
    exe = find_exe(game)
    if not exe:
        die(f"no Meridian.exe in {game}")
    dfs = [f for f in os.listdir(game) if f.lower().endswith(".dfs")]
    if not any(f.lower() == "common.dfs" for f in dfs):
        die(f"{game} has no common.DFS: point --game at the installed game folder")
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


def serve(game, port, open_browser):
    sys.path.insert(0, os.path.join(HERE, "recomp"))
    import serve_game
    serve_game.Handler.root = game
    data = http.server.ThreadingHTTPServer(("127.0.0.1", port + 1), serve_game.Handler)
    web = http.server.ThreadingHTTPServer(("127.0.0.1", port), StaticHandler)
    threading.Thread(target=data.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/web/game.html" + ("" if port == 5190 else f"?data=http://127.0.0.1:{port + 1}")
    say(f"game data (read-only): http://127.0.0.1:{port + 1}  <- {game}")
    say(f"PLAY: {url}   (Chrome/Edge 137+; Ctrl+C here to stop)")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        web.serve_forever()
    except KeyboardInterrupt:
        say("stopped")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", help="installed game folder (contains Meridian.exe and *.DFS)")
    ap.add_argument("--port", type=int, default=5190)
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    game = os.path.abspath(a.game) if a.game else cfg.get("game_dir")
    exe = check_game(game)
    if a.game:
        json.dump({"game_dir": game}, open(CONFIG, "w"), indent=2)
    if not shutil.which("node"):
        say("note: Node.js is optional (only for the headless runner recomp/boot_node.mjs)")
    build(exe, a.rebuild)
    serve(game, a.port, not a.no_browser)


if __name__ == "__main__":
    main()
